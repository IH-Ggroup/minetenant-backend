# Username認証cutover runbook

この文書は、email認証からusername認証へ本番trafficを切り替える手順の正本です。
[B-CONTRACT-07 #96](https://github.com/IH-Ggroup/minetenant-backend/issues/96)が契約を確定し、
[B-AUTH-CUTOVER #118](https://github.com/IH-Ggroup/minetenant-backend/issues/118)が最初のusername cutover、
[B-AUTH-CONTRACT-CUTOVER #121](https://github.com/IH-Ggroup/minetenant-backend/issues/121)が互換削除releaseの
実行と証跡を担当します。
HTTP契約は[`api.md`](./api.md)、完成時schemaとbackfill規則は[`database.md`](./database.md)を正本とし、
この手順をIssue本文や口頭手順へ複製しません。

## 適用範囲と前提

このcutoverは短い全API maintenanceを伴います。endpoint単位の未実装switchや、旧instanceと新instanceが
同時に本番trafficを処理するrolling cutoverには依存しません。

開始前に次をすべて満たします。

- Backend #98〜#103、B-AUTH-SESSION #119、B-DB-STRICT-MODE #120が同じreleaseへ含まれ、全CIが
  成功している
- #98が旧5列を一時的にNULL可へ緩和し、下記versioned commandを提供している
- #101〜#103が同じ`USERNAME_AUTH_ENABLED`を使う。local / testでは欠落時`false`、
  `APP_ENV=production`では明示設定が必須である
- productionの欠落・空文字と、全環境の`true` / `false`以外ではprocessが起動しない
- production backupと復旧先を確認し、実行者・開始時刻・対象commitを#118へ記録している
- Frontend #94はまだusername-only trafficへ切り替わっていない

`USERNAME_AUTH_ENABLED=false`では現行email endpointと旧serializerだけを公開し、新認証codeへ
trafficを流しません。最初のcutover成功後から#106まではproduction設定を明示的な`true`へ固定し、
欠落または`false`の通常deployを失敗させます。#105 / #107、#108、#106のPRはそのcode順でmergeしますが、
途中commitをproductionへdeployしません。#106まで含む一つの互換削除maintenance releaseで、legacy
login / me / users / register、旧列access、最後のfalse branch、config、testを同時に削除します。

## Versioned catch-up command

#98はmigration本体と同じ共有実装を使う次のcommandを追加します。

```bash
npm run db:auth-backfill -- --mode=check
npm run db:auth-backfill -- --mode=apply
```

`--mode`を省略した場合は書き込まない`check`です。commandの起動には`0003_username_auth`の履歴記録と、
同migrationが作る列・旧5列のNULL許可・username UNIQUEが必要です。ただし処理済みかどうかを履歴だけで
判断せず、毎回全usersを走査するため、#98の記録後に旧registerや現行seedが追加した新3列すべてNULLの
行も対象になります。この期間のNULL行はAPI readiness failureではありませんが、`check`のnon-zeroは
username cutoverの準備が未完了であることを示します。

両modeは最初に専用`PoolConnection`を1本checkoutし、`SELECT DATABASE()`のUTF-8値をSHA-256にした
lowercase hex先頭16文字から`minetenant:auth-backfill:v1:<db-hash>`を作ります。同じconnectionで
`GET_LOCK(name, 0)`を実行し、1でなければnon-zeroで終了します。lock名はMySQLの64文字以内で、
同じserver上の別databaseを不必要にblockしません。named lock保持中はconnectionをpoolへ返さず、
sql mode確認、transactionまたはcheck、`RELEASE_LOCK`まで必ず同じconnectionを使います。

そのconnectionでbusiness queryより前に`SET SESSION time_zone = '+00:00'`を完了し、
`@@SESSION.time_zone = '+00:00'`と、`@@SESSION.sql_mode`へ`STRICT_TRANS_TABLES`または
`STRICT_ALL_TABLES`があることを検証します。どちらかを満たさなければ更新queryを実行せずnon-zeroで
終了します。`finally`で`RELEASE_LOCK(name)`が1であることを確認し、確認できない場合はpoolへ返さず
connectionをdestroyします。

`apply`は一つのtransaction内で`ORDER BY BINARY user_id FOR UPDATE`により全user行をlockし、
[`database.md`](./database.md)の決定的規則でNULLの新3列を埋めます。最初のcutover前は旧`password`を
正本として新`password_hash`をbyte変更せず同期します。validationまたは更新が1件でも失敗した場合は
transaction全体をrollbackし、部分更新を成功扱いしません。`INSERT IGNORE`、`UPDATE IGNORE`、
`REPLACE`は使いません。

`check`は同じnamed lockを使うread-only consistent transactionで、少なくとも次を検証します。

- 新3列のNULLが0件
- usernameの重複、形式違反、大文字、予約済み`demo` / `seller`の誤所有が0件。固定user IDが存在する
  場合は対応usernameとの双方向整合も確認するが、存在しない本番環境へdemo rowは作成しない
- ECMAScript trim後のdisplay_nameが空または120 code point超の行が0件
- `BINARY role NOT IN ('buyer','seller')`が0件
- `$2b$` / `$2y$`、cost 04〜16以外のpassword hashが0件
- 旧`password`と新`password_hash`のbyte差分が0件
- synthetic emailがuser_idとattempt 0〜99から再現でき、旧新の互換値が一致する

標準出力と通常logにはmode、対象件数、更新予定または更新済み件数、違反種別ごとの件数だけを出します。
password、password hash、email、session、CSRF tokenは出しません。修復対象の特定が必要な場合だけ
`--report-file=<absolute path>`を指定でき、既存fileを上書きせずmode `0600`で新規作成したJSON Linesへ
`userId`と固定の`violationCode`だけを書きます。commandは違反時にnon-zeroで終了し、reportの保存・削除は
operatorが監査手順に従います。

## 本番cutover

以下を一つのmaintenance windowで順番どおり実施します。

1. upstreamを全APIのmaintenance responseへ切り替える。
2. 旧instanceをroutingから外してdrainし、scale-to-zeroまたは停止する。deployment上の稼働instanceと
   DBのapplication user connectionがともに0件である証跡を残す。
3. `db:auth-backfill -- --mode=apply`、続けて`--mode=check`を実行する。どちらかがnon-zeroなら新releaseを
   公開せず、診断・復旧後に手順2から再開する。
4. maintenance routingを維持したまま、#101〜#103、#119、#120を含む全instanceを同一commitかつ
   `USERNAME_AUTH_ENABLED=true`で起動する。
5. 全instanceのcommit SHAとgate値を管理面から確認し、pre-#103 / pre-#119 / pre-#120 instanceが
   0件である証跡を残す。
6. `--mode=apply`と`--mode=check`をもう一度実行し、停止前に完了した旧runtimeの更新も吸収する。
7. 内部経路で`register -> me -> logout -> csrf-cookie -> username login`、旧email login、
   session rotate、CSRF、
   rate limit、CORS公開headerをsmoke testする。smoke test用dataは識別可能にし、まだ削除しない。
8. smoke test用userを残したまま`--mode=check`を再実行し、#103の新旧列互換writeとhash一致も検証する。
9. 成功後にだけsmoke dataを監査可能なcleanup手順で削除し、`--mode=check`を最後にもう一度実行する。
10. すべて成功した場合だけmaintenance routingを解除する。終了時刻、各commandの件数、対象commit、
    instance一覧、smoke test結果を#118へ残す。

#104のdemo seedはlocal / test専用で、本番runbookでは実行しません。Frontend #94の実API結合は手順10の
後に行います。保持対象がdemo account以外にもある場合は、
ログアウト中の利用者を含む全員が新usernameを確認済みになるまでusername-only UIを公開せず、#105で
email loginを停止しません。

## 互換削除release

#104 / Frontend #94の結合と全利用者のusername確認が完了後、`#105 / #107 -> #108 -> #106`のcode順で
PRをmergeします。#121は途中commitをproductionへdeployせず、次を一つのmaintenance windowで実施します。

1. 4 PRを含む同一releaseのCI成功、production backup、復旧先、対象commitを確認して#121へ記録する。
2. 本番cutoverと同じ方法で全APIをmaintenanceへ切り替え、旧instanceをdrain・停止し、稼働instanceと
   DB application user connectionが0件であることを記録する。
3. `db:auth-backfill -- --mode=check`を最後に実行し、さらに旧5列のいずれかがNULLの行が0件であることを
   明示的に確認する。どちらかに違反があれば新instanceを起動しない。
4. #105 / #107 / #108 / #106をすべて含むinstanceだけを起動し、commit SHAを確認する。
5. 識別可能な専用smoke userで
   `csrf-cookie -> username register -> me -> logout -> csrf-cookie -> username login`が成功し、その行の
   旧5列がNULLでも新列だけで再loginできることを確認する。legacy email login、legacy register、
   legacy field、`GET /users`がそれぞれ契約どおり422または404になることも内部経路で確認する。
6. production APIのruntime code pathと通常testに旧5列reader / writer、legacy serializerが0件で、
   feature gateの設定・参照・testがrepo全体で0件であることを確認する。#109まで残すversioned
   `db:auth-backfill` commandと専用testだけは、旧列readerの期限付きallowlistとする。
7. smoke userに紐づくsession、Store、Userを監査可能な順でcleanupし、旧5列のいずれかがNULLの残存行が
   0件であることを確認する。この確認まで外部trafficと他の新規writeを許可しない。
8. すべて成功した場合だけmaintenanceを解除する。cleanup失敗、NULL残存、またはsmoke以外で最初の
   #106 register writeが発生した時点をdata point-of-no-returnとし、maintenance中でもrelease全体を
   rollbackせずforward-fixする。

手順4以後に失敗しても、smoke以外の#106 writeがなく、smoke userと関連dataのcleanupに成功し、旧5列の
いずれかがNULLの残存行が0件ならmaintenance中のrollbackが可能です。新instanceをすべて停止し、smokeの
session、Store、Userを依存順にcleanupしてNULL残件0件を再確認した後、最後のlegacy-compatible releaseを
`USERNAME_AUTH_ENABLED=true`で起動します。全instanceのcommit SHAとgate値を確認し、内部smokeを通して
からmaintenanceを解除します。cleanup失敗、NULL残存、またはsmoke以外の#106 writeを一つでも確認した
場合はmaintenanceを継続し、旧releaseを起動せずforward-fixします。開始・終了、cleanup件数、NULL残件、
rollback先SHA、判断結果を#121へ残します。

このreleaseを別々にproduction deployしません。特に#105だけを先に公開して、emailで登録できるのに
emailではloginできない中間状態を作りません。#109はこのreleaseの安定確認後にだけ実施します。

## Password rehashと互換期間

password hashの正本は最初のcutoverまでは旧`password`、cutover成功後は新`password_hash`です。
#101のbinaryはgate falseでも、照合後にcostを上げる場合は旧`password`をbinary CAS条件にして、同じ
新hashを`password`と`password_hash`へ一つのtransactionで書きます。gate trueのloginは
`password_hash`をbinary CAS条件にして両列を同じhashへ更新します。CASが0件なら再読込・再照合し、
古いhashで新しいhashを上書きしません。#103のregisterも最初から両列へ同じhashを書きます。
#105まではloginが両列を更新し、#105で旧passwordのread / writeをloginから削除します。registerは
#106まで両列へ書き、#106で旧列writeを削除します。各endpointの期限より前に片方だけを更新しません。

## Rollback

- gate有効化前は`false`のまま中止し、診断後に本runbookの手順2から再開する
- #103のcutover後かつ互換削除releaseの本番適用開始前に戻す場合は、全API maintenanceへ切り替えてから
  gateを`false`にする。新request行は
  旧列互換値を持つためdata互換だが、logout済みのusername登録利用者はuser_id由来のsynthetic emailを
  知らず、旧email loginを透過的には再開できない
- 原則は認証maintenanceのままforward-fixする。やむを得ない場合だけoperatorが保存済みsynthetic
  emailを安全に検索して本人へ伝え、公開DTO・通常log・運用画面へ出さない
- 旧writerでregisterを再開した場合はNULL行やhash差分が再び増え得るため、次回は手順1から全工程を
  再実行する
- 互換削除releaseでtrafficを再開した後は旧auth全体へ戻さずforward-fixする

## 必須テストと証跡

#98〜#103、#119、#120、#118と、#105〜#108、#106、#121は、通常のunit / integration testに加えて
次を確認します。

- gate falseで現行register / login / meのrequestとresponseが変わらない
- 空DB、移行直後、#98記録後に追加されたNULL行、部分適用済みDB、連続applyでcommandが冪等に動く
- 同じdatabaseへの同時check / applyまたはapply / applyの片方がnamed lock取得に失敗し、別databaseは
  独立して実行できる。lock取得から解放まで同じconnectionを使い、解放確認失敗時はconnectionを破棄する
- strict SQL modeなし、UTC設定・確認失敗、予約username衝突、attempt 0〜99枯渇、不正hash、
  synthetic email不整合、display_name超過ではfail closedになる
- rehashのbinary CAS競合で古いhashを上書きせず、旧新hashがbyte一致する
- #118ではmaintenance、旧instance / DB connection 0件、全新instanceの同一commit / gate trueを
  証跡で確認する
- #118ではgate trueで新旧request、route-local adapter、session、CSRF、rate limit、CORSが契約どおり
  動くことを確認し、rollback rehearsalの開始・終了、対象commit、件数、判断結果を#118へ残す
- #121ではmaintenance、旧instance / DB connection 0件、全新instanceが#105 / #107 / #108 / #106を
  含む同一commitであることを証跡で確認する。`USERNAME_AUTH_ENABLED`の設定・参照・testが0件で、
  全endpointが新経路だけを使うことも確認する
- #121では#106経路で作った確認用userが旧5列NULLのままloginできること、確認用userの削除成功、
  旧5列NULL残件0件を順に記録する。開始・終了、対象commit SHA、smoke結果、削除結果、残件数、
  rollback可否の判断を#121へ残す

後続順は
`#104 / Front #94 -> (#105 / #107 -> #108 -> #106をmerge) -> #121で同時deploy -> #109`です。
#109は#121の証跡確認後に、旧列readerの期限付きallowlistである`db:auth-backfill` executable、package
script、専用testを削除し、production API・通常test・allowlistのすべてで旧列accessを0件にします。
