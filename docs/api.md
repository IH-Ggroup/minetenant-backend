# MineTenant API v1

開発URLは`http://localhost:8787`です。バックエンドはNode.js上のTypeScript / Honoで
動作し、MySQLへデータを保存します。JSONのキーはフロントのTypeScript型に合わせて
camelCaseで返します。

> **契約節の読み方**
> 「現行から確定契約への変更」と「一点物Product」から「Web購入」までの各節は、
> B-CONTRACT-01 / 02で確定した、B-PRODUCT / B-BUY / B-XP / B-BUILD Issueが実装する
> 最終契約です。2026-09-26時点の`develop` (`46235a9`)はB-PRODUCT-01 #49を取込み済みで、
> Product responseは`status`へ移行しました。一方、出品・購入writerは物理`stock`との互換期間中で、
> 店舗pointsも販売店舗だけへ加算するため、後続Issue完了までは一部の動作が異なります。
>
> 「認証とCSRF」はB-CONTRACT-07で確定したusername認証の最終契約です。同じ`develop`の
> runtimeはまだemail / `name`認証です。B-AUTH-01〜12、B-AUTH-CUTOVER #118、
> B-AUTH-SESSION #119、B-DB-STRICT-MODE #120、B-AUTH-CONTRACT-CUTOVER #121、
> Frontend F-AUTH-01の段階移行中は、
> この節の「移行順と互換期間」を併せて参照してください。取引履歴とFabric APIの認証・pathは
> 現行実装の説明です。ただし共有serializerが返すProductの形、店舗の成長表示、出品・購入に伴う
> 店舗pointsの加算規則は、どの対象endpointでも本契約へ統一します。

## 現行から確定契約への変更

| 対象           | 現行`develop`                                        | 確定契約                                                                |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Product        | `status: "available" \| "sold"`。物理`stock`は互換用 | 同じresponseを維持し、物理`stock`も削除                                 |
| 一覧・詳細     | `status`を含み売り切れも公開。soft deleteは未接続    | `available` / `sold`を公開し、soft delete済みは除外                     |
| 出品request    | 商品項目 + 必須`stock`。所有者・店舗も送信可能       | `requestId` + 数量なしの商品項目だけ。所有者・店舗・初期状態はAPIが確定 |
| 出品の再送     | 毎回別Productを作成                                  | 同じ利用者・ID・内容は同じProduct。異なる内容は409                      |
| Web購入request | 2つのpathで`buyerId` / `source`も送信可能            | 正規pathは本文`requestId`だけ。互換pathは`productId` + `requestId`だけ  |
| 購入時の状態   | `stock`を1減らし互換triggerが`status`を同期          | `available`から`sold`へ一度だけ変更                                     |
| 店舗points     | 販売店舗へ100 points                                 | 出品店舗へ10、buyer店舗へ50、販売店舗へ100                              |
| 店舗level      | 境界と表示計算が実装に直書き                         | 境界、最大Lv、最大到達後、表示値、丸めを共通契約として固定              |
| Webアカウント  | emailで認証し、`name`を表示                          | `username`で認証し、`displayName`を表示。emailは最終schemaに持たない    |

DB列、制約、index、`stock=0 / 1 / 2以上`の移行規則は
[`docs/database.md`](./database.md)を正本とします。

## 共通仕様

- ID: 文字列
- 価格: 日本円の整数
- 日時: ISO 8601
- Content-Type: `application/json`
- 正常時: 通常は`{ "data": ... }`。一覧は配列、詳細はオブジェクト
- CSRF Cookie初期化・ログアウト・商品削除: `204 No Content`、本文なし
- 未ログイン: `401 Unauthorized`
- 所有者・取引関係者以外の操作: `403 Forbidden`
- 入力エラー: `422 Unprocessable Entity`
- データなし: `404 Not Found`
- 在庫切れ・重複など: `409 Conflict`
- CSRFトークン不一致・期限切れ: `419`。Cookieを再取得し、必要なら再ログインする
- ログイン・登録の試行制限: `429 Too Many Requests`
- Web認証: MySQLに保存するCookieセッション
- WebのすべてのPOST・DELETEは、ログイン・登録も含めてCSRF検証の対象
- Minecraft専用APIは既存の未認証デモ仕様を維持。公開運用には対応していない
- メッセージ・チャットAPIは作らない

B-CONTRACT-01以後に作る出品・購入の`requestId`はcase-sensitiveな
`[A-Za-z0-9._:-]{1,100}`です。前後空白の除去や大文字小文字変換はせず、UUID v4を推奨します。
各routeは共通の文字列trim後ではなく、受信した未加工の`requestId`を検証します。現行`parseBody`を
使う場合はこのfieldだけtrim対象から外し、空白付きの新規値をtrimして受理せず422にします。

購入だけは、新規ID validationが全routeへ適用される前の旧routeなどですでに保存された形式外IDを、
値変更せず再生するgrandfather規則があります。文字列かつ255文字以下の形式外IDを受けた場合、lookup
時点で同じIDの既存Transactionがありproduct、認証済みbuyer、sourceが一致すれば200、一つでも違えば
409 `REQUEST_ID_CONFLICT`です。既存行がなければ422で、新しいTransactionは作りません。出品requestに
この例外はありません。
業務エラーの`code`はクライアントの分岐用に固定し、`message`の文面では分岐しません。

| Status | code                      | 発生条件                                           |
| ------ | ------------------------- | -------------------------------------------------- |
| 409    | `REQUEST_ID_CONFLICT`     | 同じ出品・購入`requestId`を異なる内容へ再利用      |
| 409    | `LISTING_REQUEST_RETIRED` | soft delete済み商品の出品`requestId`を同内容で再送 |
| 409    | `USER_STORE_NOT_READY`    | 認証ユーザーの所有店舗が存在しない                 |
| 409    | `OUT_OF_STOCK`            | `status='sold'`（legacyの`stock=0`を含む）         |
| 422    | `SELF_PURCHASE`           | 出品者本人が自分の商品を購入                       |

入力不正は現行どおり422の`{ "message", "errors" }`、存在しない商品は404の
`{ "message": "商品が見つかりません。" }`です。上表のエラーは`message`と`code`を必ず返し、
`REQUEST_ID_CONFLICT`と`SELF_PURCHASE`には該当入力の`errors`も返します。

## 店舗ポイント

店舗pointsは次の操作が初回成功したときだけ加算します。購入元がWeb / Minecraftのどちらでも、
加算対象とpointsは同じです。

| 成功操作 | 加算対象                          | 加算points |
| -------- | --------------------------------- | ---------: |
| 新規出品 | Productのsellerが所有する店舗     |         10 |
| 購入成立 | buyerが所有する店舗               |         50 |
| 販売成立 | Productのsellerが所有する販売店舗 |        100 |

上の値はWeb / Minecraftや実行環境によって変えない固定の契約値です。現行の
`STORE_SALE_POINTS`は移行前の互換設定であり、確定契約の100 pointsを上書きする用途には使いません。

新規出品の10 pointsは、`Asia/Tokyo`の暦日（00:00以上、翌日00:00未満）ごとに、各店舗で
初回成功した新規Productの先着3件だけへ加算し、1日最大30 pointsです。4件目以降も出品自体は
成功しますが、pointsは加算しません。日次判定にはProductの`created_at`を使い、DBへUTCで保存した
時刻をJSTの半開区間へ対応させます。

出品後にProductをsoft deleteしても、加算済みpointsは減算せず、その日の3件枠も戻しません。
入力不正、競合、所有店舗なし、存在しない商品、自己購入、売り切れ、またはDB transactionの失敗など、
操作が成立しなかった場合はpointsを加算せず、出品の日次件数にも数えません。

出品・購入とも、同じ内容の同じ`requestId`を再送して既存のProductまたはTransactionを返す場合は、
日付をまたいでもpointsを再加算しません。異なる内容への`requestId`再利用でも加算しません。
Productの作成と出品pointsの加算、ならびにProductの`sold`化、Transactionの作成、buyer店舗への
50 points、販売店舗への100 pointsは、それぞれ一つのDB transactionでcommitします。途中で
失敗した場合は関連する変更をすべてrollbackし、片方の店舗だけへpointsを加算しません。

### 店舗levelとAPI表示値

`points`は0以上の整数で保持する累計値であり、level計算の正本です。最大Lvへ到達してもpointsの
加算は続け、1,000で切り捨てません。`level`はpointsから導出して同じtransactionで保存する値で、
クライアント入力やWeb / Minecraftのsourceによって変更しません。

| level | 必要な累計points | そのlevelのpoints範囲 |
| ----: | ---------------: | --------------------- |
|     1 |                0 | 0〜99                 |
|     2 |              100 | 100〜299              |
|     3 |              300 | 300〜599              |
|     4 |              600 | 600〜999              |
|     5 |            1,000 | 1,000以上             |

最大はLv5です。`level`は「必要な累計pointsが現在値以下である最大のlevel」とします。登録直後は
`points: 0`、`level: 1`です。負数、少数、`NaN`、無限大をlevel計算へ渡して丸めてはいけません。
これらはAPI入力ではなくprogramming errorまたはDB不整合として扱い、保存しません。保存済みの
`points`と`level`が一致しない場合はpointsを正としてlevelを再計算します。

B-XP-01の共通計算はpointsだけを入力とし、`Number.isSafeInteger(points) && points >= 0`を
満たさない値には`RangeError`を送出します。文字列変換、切り捨て、0への丸めは行いません。
GETはpointsから計算した値を返すだけでDBを更新せず、保存levelの修復はmigrationまたは次の
正規なpoints更新transactionで行います。

APIはフロントとMODが再計算しなくてよいよう、次の値を共通計算から返します。

- `level`: 上表から求めた現在level
- `points`: 上限で切り捨てない累計points
- `nextLevelPoints`: 次のlevelまで「あと何pointsか」。最大Lvでは`0`
- `levelProgressPercent`: 現在levelの区間内の進捗率。最大Lvでは`100`
- `maxLevel`: この契約での最大level。常に`5`
- `isMaxLevel`: 現在levelが最大なら`true`。それ以外は`false`

最大Lv以外の進捗率は次の式を使い、小数点以下を切り捨てます。結果は`0〜99`です。

```text
floor((points - 現在levelの必要points) / (次levelの必要points - 現在levelの必要points) * 100)
```

`nextLevelPoints`は`次levelの必要points - points`です。最大Lvでは`level: 5`、`maxLevel: 5`、
`nextLevelPoints: 0`、`levelProgressPercent: 100`、`isMaxLevel: true`を返します。クライアントは
`nextLevelPoints: 0`や最大Lvの数値を独自に判定せず、`isMaxLevel`と`maxLevel`を使います。

#### 境界値の手計算

| points | level | nextLevelPoints | levelProgressPercent | isMaxLevel |
| -----: | ----: | --------------: | -------------------: | :--------- |
|      0 |     1 |             100 |                    0 | false      |
|      1 |     1 |              99 |                    1 | false      |
|     99 |     1 |               1 |                   99 | false      |
|    100 |     2 |             200 |                    0 | false      |
|    101 |     2 |             199 |                    0 | false      |
|    299 |     2 |               1 |                   99 | false      |
|    300 |     3 |             300 |                    0 | false      |
|    301 |     3 |             299 |                    0 | false      |
|    599 |     3 |               1 |                   99 | false      |
|    600 |     4 |             400 |                    0 | false      |
|    601 |     4 |             399 |                    0 | false      |
|    999 |     4 |               1 |                   99 | false      |
|  1,000 |     5 |               0 |                  100 | true       |
|  1,001 |     5 |               0 |                  100 | true       |

#### B-BUILD-03へ渡すlevel変更

初回成功するpoints更新ごとに、対象Storeをlockした後の値を`oldPoints`、加算後を`newPoints`とし、
それぞれから`oldLevel`と`newLevel`を計算します。複数店舗を更新する購入ではStoreごとに別々に
計算します。`oldLevel < newLevel`の結果だけをB-BUILD-03へ渡し、points、level、原因となる
ProductまたはTransaction、後続の建築jobを同じtransactionでcommitできるようにします。1回の加算で
複数境界を越えた場合に作るjobの単位と状態遷移はB-CONTRACT-06を正本とします。

同じ`requestId`の再送、入力不正、競合、rollbackでは新しいlevel変更結果を発生させません。
最大Lv到達後はpointsだけが増え、`oldLevel`と`newLevel`はともに5なのでlevel変更なしです。

ここでいう`level`、`oldLevel`、`newLevel`はpoints由来の論理的な成長levelで、Minecraftのworldへ
適用済みの建築levelではありません。登録時点ですでに`level: 1`なので、初回Lv1建築を
`oldLevel: 0`から`newLevel: 1`への成長として扱いません。建築済みlevelのfield名、Lv1建築、
対応templateがあるtarget levelだけをjob化する規則、Lv1完了前にLv2をclaimしない順序は
B-CONTRACT-06を正本とします。`oldLevel`と`newLevel`は内部serviceの受け渡し値であり、
`StoreGrowth`の公開fieldには含めません。

## Webエンドポイント一覧

ベースURLは`http://localhost:8787/api/v1`です。下表のパスを後ろにつなぎます。
ログイン必須のAPIにはセッションCookieが必要です。公開GETはログイン不要です。

| Method | パス                              | ログイン       | 用途・正常時                                                 |
| ------ | --------------------------------- | -------------- | ------------------------------------------------------------ |
| GET    | `/auth/csrf-cookie`               | 不要           | CSRF Cookie設定、204                                         |
| POST   | `/auth/register`                  | 不要           | ユーザー・所有店舗作成とログイン、201 `data: User`           |
| POST   | `/auth/login`                     | 不要           | ログイン、200 `data: User`                                   |
| GET    | `/auth/me`                        | 必須           | 現在のユーザー、200 `data: User`                             |
| POST   | `/auth/logout`                    | 必須           | セッション破棄、204                                          |
| GET    | `/users`                          | 必須           | 現行deprecated一覧、200。#108でrouteごと削除                 |
| GET    | `/products`                       | 不要           | 商品一覧・検索・店舗絞り込み、200 `data: Product[]`          |
| GET    | `/products/{productId}`           | 不要           | 商品詳細、200 `data: Product`                                |
| POST   | `/products`                       | 必須           | 本人の店舗へ冪等に出品、初回201・再送200 `data: Product`     |
| DELETE | `/products/{productId}`           | 必須           | 本人の未取引商品の削除、204                                  |
| POST   | `/purchases`                      | 必須           | 本文に商品IDを指定して購入、201または200 `data: Transaction` |
| POST   | `/products/{productId}/purchases` | 必須           | URLに商品IDを指定して購入、201または200 `data: Transaction`  |
| GET    | `/stores/{storeId}`               | 不要           | 公開店舗情報、200 `data: Store`                              |
| GET    | `/stores/{storeId}/growth`        | 不要           | 公開店舗成長情報、200 `data: StoreGrowth`                    |
| GET    | `/stores/{storeId}/dashboard`     | 所有者のみ     | 店舗集計、200 `data: Dashboard`                              |
| GET    | `/transactions`                   | 必須           | 本人の購入・販売履歴、200 `data: Transaction[]`              |
| GET    | `/transactions/{transactionId}`   | 取引関係者のみ | 取引詳細、200 `data: Transaction`                            |

`GET /api/hello`はv1の外にある疎通確認用APIです。商品編集・店舗編集・決済・
住所保存のAPIはこのPoCには含みません。

## 認証とCSRF

この節の「完成時契約」はB-CONTRACT-07の正本です。2026-09-26時点の`develop`はまだ
email / `name`認証なので、実装・deploy時は末尾の「移行順と互換期間」も参照してください。

### 完成時のSessionとCSRF

最初に`GET /api/v1/auth/csrf-cookie`を`credentials: 'include'`付きで呼びます。正常時は
`204 No Content`で本文を返しません。有効なsessionがなければ匿名のDB sessionを作り、
既存sessionがあれば認証状態を保ったまま期限を延長します。HttpOnlyのsession Cookieと、
JavaScriptから読める`XSRF-TOKEN` Cookieを設定します。セッションCookieの既定名は
`minetenant_hono_session`です。両Cookieは`Path=/`で、既定はhost-only、`SameSite=Lax`です。
公開HTTPS環境ではSecureを必須にします。

匿名sessionはこのCSRF bootstrapでだけ遅延作成します。Cookieなしのpublic GET / HEAD、401になる
認証必須GET / HEAD、404、OPTIONS、Minecraft routeではDB sessionもCookieも作りません。有効sessionなしの
書込みは新しいsessionを作らず419です。新規匿名sessionの作成はclient IPごとの60秒固定windowで10件までとし、
11件目は429です。有効sessionを同じCookieで再利用するCSRF再取得は作成limitを消費しません。
IPはSHA-256済みbucket keyだけを保存し、通常responseに`X-RateLimit-Limit / Remaining`、429に
`Retry-After / X-RateLimit-Reset`も返してCORSで公開します。このhardeningはB-AUTH-SESSION #119が
B-AUTH-CUTOVER #118より前に実装します。

`POST /auth/register`、`POST /auth/login`、`POST /auth/logout`は認証前の操作を含めて
CSRF検証の対象です。`XSRF-TOKEN`をURLデコードした値を`X-XSRF-TOKEN`ヘッダーへ設定し、
session Cookieと一緒に送信します。不一致・欠落は`419`です。

```json
{
  "message": "CSRF token mismatch."
}
```

registerとloginではsession IDとCSRF tokenの両方を再生成し、直前のsessionを同じDB transactionで
無効化します。logoutは認証済みsessionを削除してsession / XSRF Cookieを期限切れにし、新しい匿名
sessionを作りません。次の書込み前にCSRF bootstrapを再取得します。`GET /auth/me`はGETなので
CSRF token不要ですが、匿名・期限切れsessionは
`401`です。session期限は設定値（既定120分）のsliding expirationとし、認証responseは
`Cache-Control: no-store, private`にします。

session IDとCSRF tokenは`Set-Cookie`だけで渡し、JSON bodyやapplication logへ含めません。
password、passwordConfirmation、password hashもresponseやlogへ含めません。これらをlocalStorage、
sessionStorageへ保存せず、CSRF tokenは書き込みのたびにCookieから読み直します。419を受けた
フロントはCSRF Cookieを再取得できますが、register / login / logoutを自動再送せず、利用者へ
再操作を求めます。認証情報をBearer tokenとして送る方式ではありません。

Web session middlewareは`/api/v1/minecraft/**`へ適用しません。Minecraftへusername、
displayName、password、Cookie、CSRF tokenを渡さず、Web利用者との連携には内部
`users.user_id`だけを使います。

### 完成時のUser DTO

register、login、meは同じUser DTOを`{ "data": User }`で返します。キーは次の7個だけです。

```ts
type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'buyer' | 'seller';
  roleLabel: '購入者' | '出品者';
  avatarInitial: string;
  storeId: string | null;
};
```

- `id`はDBの`users.user_id`、`storeId`は`stores.store_id`を変換した公開名です。
  `user_id`や`userId`は追加しません。
- `roleLabel`は`buyer`なら`購入者`、`seller`なら`出品者`です。旧DBの`role_label`は使いません。
  未知のroleを別labelへ黙ってfallbackせず、DB不整合として扱います。
- `avatarInitial`はtrim済み`displayName`の先頭extended grapheme clusterを、Node.jsの
  `Intl.Segmenter`（`granularity: 'grapheme'`）で導出します。フロントは再計算しません。
  例えば`👩🏽‍💻 開発者`の`avatarInitial`は`👩🏽‍💻`です。
- `storeId`は店舗がない既存利用者では`null`です。register成功時は初期店舗を同時作成するため、
  必ずstringです。フロントは`null`なら出品・店舗管理の導線を隠し、URL直入力時もrouteと
  API呼び出しの両方をblockします。
- email、汎用的な`name`、password、passwordHash、session情報は完成時DTOへ含めません。

### 完成時の入力とvalidation

registerとloginは`application/json`または`application/*+json`だけを受理します。Content-Typeの
欠落、form-urlencoded、multipart、その他のmedia typeは`415 Unsupported Media Type`です。

```json
{
  "message": "Content-Type must be application/json."
}
```

空のJSON bodyは`{}`としてfield validationの422、壊れたJSONは400です。`username`、`password`、
送信時の`passwordConfirmation`はJSON stringだけを受理します。`displayName`だけは省略・string・
`null`を受理し、その他の型は対応fieldの422です。usernameとdisplayNameの前後空白除去はECMAScriptの
`String.prototype.trim()`と同じ文字集合を使い、文字数はUnicode code point数で数えます。
全API共通の1 MiB body limitを超えた場合は最初に413となります。その上限内ではCSRF header検証を
media type・JSON parseより先に行うため、token欠落・不一致はbodyの形式にかかわらず419です。
共通のbody parserが先に別の文字集合を除去しないよう、B-AUTH-04 #101とB-AUTH-06 #103のrouteが
`username`、`displayName`、`password`、`passwordConfirmation`の未加工値をB-AUTH-02 #99の
認証用validatorへ渡します。
特にcamelCaseの`passwordConfirmation`もpasswordと同じくtrim対象外です。

| field                  | endpoint         | 正規化と規則                                                                                              |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `username`             | register / login | 必須。前後のUnicode空白を除去してASCII `A-Z`だけを小文字化後、`^[a-z0-9_]{3,32}$`。正規化後の値で一意判定 |
| `displayName`          | register         | 任意。前後のUnicode空白を除去して1〜120文字。省略、`null`、空白だけなら正規化済みusername                 |
| `password`             | register / login | 必須。正規化・trimをせず8文字以上、UTF-8で72 bytes以下、NUL禁止                                           |
| `passwordConfirmation` | register         | 任意。送信された場合は正規化・trimをせず、未加工の`password`と完全一致。保存・記録しない                  |

公式WebフロントではpasswordConfirmationを必須入力にして常に送ります。APIではCLI等との互換のため
省略可能です。パスワード前後の空白も値の一部であり、勝手に除去しません。保存済みbcrypt hashは
60文字の`$2b$`または`$2y$`、cost 04〜16だけを受理します。`$2y$`は`$2b$`へprefix変換して
`bcrypt.getRounds`と`bcrypt.compare`へ渡し、保存済みcostが設定roundsより低い場合だけlogin成功後に
`$2b$`へrehashします。保存済みcostの方が高い場合は弱い設定へ下げません。`$2a$`や壊れたhashは
移行preflightで停止し、login中に例外を出させません。

主な境界例は次のとおりです。

| 入力・状態                                                                | 結果                                    |
| ------------------------------------------------------------------------- | --------------------------------------- |
| username `" Demo_User "`                                                  | `demo_user`として受理                   |
| username `abc` / 32文字の小文字ASCII                                      | 受理                                    |
| username `ab` / 33文字                                                    | 422 `errors.username`                   |
| username `demo-user` / `利用者` / 内部空白                                | 422 `errors.username`                   |
| usernameにASCIIへcase foldされる非ASCII文字（例: U+212A KELVIN SIGN `K`） | 422 `errors.username`                   |
| username `demo` / `seller`                                                | 予約済みとして422 `errors.username`     |
| 既存`demo_user`に対する`" DEMO_USER "`                                    | 正規化後重複として422 `errors.username` |
| password 7文字 / 8文字                                                    | 422 / 受理                              |
| ASCII password 72 bytes / 73 bytes                                        | 受理 / 422 `errors.password`            |
| passwordにJSON escapeの`\u0000`を含む                                     | 422 `errors.password`                   |
| displayName 1文字 / 120文字 / 121文字                                     | 受理 / 受理 / 422 `errors.displayName`  |
| confirmation省略 / 完全一致                                               | 受理                                    |
| passwordとconfirmationが同じ`" password "`                                | 空白を値の一部として受理                |
| `password`が`"password"`、confirmationが`" password "`                    | 422 `errors.passwordConfirmation`       |
| confirmationの大文字小文字だけが異なる                                    | 422 `errors.passwordConfirmation`       |
| username / password / confirmationがnull・number・object                  | 対応fieldの422                          |
| displayNameがnumber・object                                               | 422 `errors.displayName`                |

### 完成時の新規登録

```http
POST /api/v1/auth/register
Content-Type: application/json
X-XSRF-TOKEN: CookieをURLデコードした値
```

```json
{
  "username": " Demo_User ",
  "displayName": "  山田 みどり  ",
  "password": "demo-password-123",
  "passwordConfirmation": "demo-password-123"
}
```

displayNameの保存結果は次で固定します。

| requestの`displayName` | 保存する`display_name` |
| ---------------------- | ---------------------- |
| `"  山田 みどり  "`    | `山田 みどり`          |
| field省略              | `demo_user`            |
| `null`                 | `demo_user`            |
| `"　 "`                | `demo_user`            |

利用者と初期店舗を一つのDB transactionで作り、sessionをrotateして`201 Created`を返します。
登録roleは`buyer`です。初期店舗の`name`は保存済みdisplayName + `"の店舗"`、`description`は
空文字、`level: 1`、`points: 0`、`syncStatus: "offline"`で固定します。

```json
{
  "data": {
    "id": "018f0f37-8f42-7d4a-a8a1-2b7e45897290",
    "username": "demo_user",
    "displayName": "山田 みどり",
    "role": "buyer",
    "roleLabel": "購入者",
    "avatarInitial": "山",
    "storeId": "018f0f37-a683-7f6f-8834-7d6f3608db33"
  }
}
```

同じusernameの同時登録はDBのUNIQUE制約を正本として一方だけ成功させ、敗者も事前重複と同じ
`422`と`errors.username`にします。利用者だけ、または店舗だけを残しません。

```json
{
  "message": "このユーザー名は既に登録されています。",
  "errors": {
    "username": ["このユーザー名は既に登録されています。"]
  }
}
```

### 完成時のログイン

```http
POST /api/v1/auth/login
Content-Type: application/json
X-XSRF-TOKEN: CookieをURLデコードした値
```

```json
{
  "username": " DEMO_USER ",
  "password": "demo-password-123"
}
```

成功時はsessionをrotateし、`200 OK`と同じUser DTOを返します。

```json
{
  "data": {
    "id": "018f0f37-8f42-7d4a-a8a1-2b7e45897290",
    "username": "demo_user",
    "displayName": "山田 みどり",
    "role": "buyer",
    "roleLabel": "購入者",
    "avatarInitial": "山",
    "storeId": "018f0f37-a683-7f6f-8834-7d6f3608db33"
  }
}
```

形式が正しい未登録usernameとpassword不一致は、status・body・headerで存在有無を区別せず、
どちらも次のform-level `401`にします。未知の利用者でもbcrypt dummy hashをcompareし、
timing差を縮小します。`errors.username`は付けません。

```json
{
  "message": "ユーザー名またはパスワードが正しくありません。"
}
```

### 完成時の状態復元とログアウト

```http
GET /api/v1/auth/me
Cookie: session Cookie
```

認証済みなら`200 OK`と同じUser DTOを返します。

```json
{
  "data": {
    "id": "018f0f37-8f42-7d4a-a8a1-2b7e45897290",
    "username": "demo_user",
    "displayName": "山田 みどり",
    "role": "buyer",
    "roleLabel": "購入者",
    "avatarInitial": "山",
    "storeId": "018f0f37-a683-7f6f-8834-7d6f3608db33"
  }
}
```

匿名・期限切れ・削除済み利用者のsessionは、どれも次の`401`です。

```json
{
  "message": "Unauthenticated."
}
```

`POST /api/v1/auth/logout`は認証とCSRFの両方が必要です。成功時はsessionを削除して両Cookieを
期限切れにし、`204 No Content`で本文を返しません。

### 完成時のError response

JSON構文不正は400、field validationとusername重複は422です。422はcamelCaseのrequest field名を
`errors`へ使います。message文面では分岐せず、HTTP statusと`errors`のfield名で分岐します。

```json
{
  "message": "ユーザー名は小文字英数字と_で3〜32文字にしてください。",
  "errors": {
    "username": ["ユーザー名は小文字英数字と_で3〜32文字にしてください。"]
  }
}
```

複数fieldが不正な場合も全fieldを`errors`へ返します。top-level `message`は人向けの要約であり、
複数error数を追記する場合があるため、フロントの分岐や入力欄対応には使いません。

| endpoint      | 正常時           | 想定するerror                           |
| ------------- | ---------------- | --------------------------------------- |
| `csrf-cookie` | 204、本文なし    | 429                                     |
| `register`    | 201 `data: User` | 400 / 413 / 415 / 419 / 422 / 429       |
| `login`       | 200 `data: User` | 400 / 401 / 413 / 415 / 419 / 422 / 429 |
| `me`          | 200 `data: User` | 401                                     |
| `logout`      | 204、本文なし    | 401 / 419                               |

### 完成時のRate limit

registerとloginは同じ二つの60秒固定windowを共有します。

| bucket                        | 上限 | 429になる試行 |
| ----------------------------- | ---: | ------------: |
| client IP                     |   30 |        31回目 |
| canonical account + client IP |    5 |         6回目 |

routeへ到達した成功・401・422の試行をどちらも消費します。CSRFでrouteへ到達しないrequestは
消費しません。一方のbucketですでに拒否されたrequestは、もう一方の残数を消費しません。
usernameがstringなら形式不正でもtrimしてASCII `A-Z`だけを小文字化し、欠落またはstring以外なら
空identifierを作ります。
canonical account keyは`username:<normalized username>`です。未登録usernameも同じkeyを使うため、
成功したregisterの直後にloginしても別bucketへ切り替わりません。DBで既存利用者へ解決できた
legacy real emailとsynthetic emailは、その行の保存済みusernameへ写像します。未知emailだけ
`email:<normalized email>`、identifier欠落は`empty`を使います。新旧fieldが混在するrequestは
username string、email string、emptyの優先順で一つのkeyを決めます。これにより同じ利用者の
usernameとemailを交互に使って5回制限を迂回できません。不正入力もIP bucketと空または正規化済み
identifier bucketを消費します。

email aliasのlookupはlegacy loginを受ける#105まで、legacy registerのemail key生成は#106までの
期限付き互換です。#121の互換削除release後はproduction API runtimeから旧email readerをなくし、
usernameと空identifierだけで同じrate-limit規則を維持します。

account解決queryの前にIP bucketがblock済みかを確認し、block済みならalias lookupもaccount bucketの
更新も行いません。未blockならaliasを解決した後、一つのtransactionでIP bucketを再checkして両bucketを
lockします。どちらかが上限なら両方とも増やさず、両方に余裕がある場合だけ両方を1回ずつ増やします。
永続的なaccount lock、`423 Locked`、unlock APIは設けません。429はform-levelで表示し、
フロントは`Retry-After`が示すwindow終了まで再送を抑止します。

rate-limit keyにはpasswordを絶対に含めません。canonical username（既知accountまたはusername候補）、
type prefix付きの未知email、emptyのいずれかとIPを組み立てたbucket keyはSHA-256にしてからDBへ保存し、
生値をDBやlogへ残しません。通常responseには現在の最も厳しいbucketの
`X-RateLimit-Limit`と`X-RateLimit-Remaining`を返します。429にはさらに秒数の`Retry-After`と
Unix秒の`X-RateLimit-Reset`を返します。
直接別originから接続するFrontもこれらを読めるよう、#101でCORSの
`Access-Control-Expose-Headers`へ4 headerを追加し、preflightと実responseをtestします。

```json
{
  "message": "Too Many Attempts."
}
```

### 現行runtime（username移行前）

以下は移行開始前の接続確認用で、完成時の公開契約ではありません。

最初に`GET /api/v1/auth/csrf-cookie`を`credentials: 'include'`付きで呼びます。
ブラウザへセッションCookieと`XSRF-TOKEN` Cookieが設定されます。
POST・DELETE時には`XSRF-TOKEN`をURLデコードした値を`X-XSRF-TOKEN`ヘッダーへ
設定し、`credentials: 'include'`でセッションCookieも送信します。

ログイン・登録でセッションが更新され、ログアウトでは破棄されます。
CSRFトークンを固定の変数へ保存せず、書き込みのたびにCookieを読み直してください。
認証情報をBearerトークンとして送る方式ではありません。

セッションCookieの既定名は`minetenant_hono_session`です。保存済みのbcryptパスワードは
`$2b$`・`$2y$`のどちらも照合できます。`XSRF-TOKEN` Cookieと
`X-XSRF-TOKEN`ヘッダーを組み合わせてCSRFを検証します。

#### 現行の新規登録

```http
POST /api/v1/auth/register
Content-Type: application/json
X-XSRF-TOKEN: CookieをURLデコードした値
```

```json
{
  "name": "山田 みどり",
  "email": "new-user@example.test",
  "password": "demo-password-123",
  "password_confirmation": "demo-password-123"
}
```

`name`は必須で120文字以内、`email`は必須で255文字以内・重複不可です。
メールアドレスは前後の空白を除き、小文字にして扱います。パスワードは8文字以上・
72バイト以内です。`password_confirmation`は省略できますが、送る場合は一致が必要です。

成功時はユーザーと、その人が所有する店舗を同時に作り、ログイン状態で
`201 Created`と`data: User`を返します。店舗は`level: 1`、0 points、`offline`から
始まります。登録ユーザーの`role`は`buyer`ですが、自分の店舗に出品できます。

#### 現行のログイン・状態復元・ログアウト

```http
POST /api/v1/auth/login
Content-Type: application/json
X-XSRF-TOKEN: CookieをURLデコードした値
```

```json
{
  "email": "demo@minetenant.jp",
  "password": "password"
}
```

ログイン成功時と`GET /auth/me`は、次の形でユーザーを返します。

```json
{
  "data": {
    "id": "user-buyer",
    "name": "山田 みどり",
    "role": "buyer",
    "roleLabel": "購入者デモ",
    "avatarInitial": "山",
    "storeId": "store-yamada"
  }
}
```

`GET /auth/me`が401なら未ログインです。パスワードが違うログインは
422と`errors.email`を返します。`POST /auth/logout`成功時は204で本文がありません。
ログイン・登録には、IPごとに毎分30回、メールアドレスとIPの組み合わせごとに
毎分5回の制限があります。

### 移行順と互換期間

完成時request / responseと、移行のためだけのlegacy互換を混同しません。

| 段階 | Issue                    | deploy可能な状態                                                             |
| ---: | ------------------------ | ---------------------------------------------------------------------------- |
|    1 | Backend #98              | 新列をNULL可で追加・backfillし、旧5列も一時的にNULL可へ緩和。旧APIだけを稼働 |
|    2 | Backend #99 / #100       | 純粋validatorと新serializerを追加。endpointはまだ切り替えない                |
|    3 | Backend #101〜#103       | 各endpoint実装とCIを完了するが、認証cutoverまで本番trafficへ公開しない       |
|    4 | Backend #119 / #120      | lazy sessionとstrict DB connectionをcutover releaseへ含める                  |
|    5 | Backend #118             | 全API maintenance・catch-up後に#101〜#103 / #119 / #120を同時公開            |
|    6 | Backend #104 / Front #94 | 非production demo seedを更新し、Frontをusername / displayNameへ切替          |
|    7 | Backend #105 / #107      | login / me互換削除をmergeするが、単独ではproduction deployしない             |
|    8 | Backend #108             | `GET /users`削除をmergeするが、単独ではproduction deployしない               |
|    9 | Backend #106             | register互換・gate削除をmergeするが、単独ではproduction deployしない         |
|   10 | Backend #121             | #105 / #107 / #108 / #106を一つのmaintenance releaseとして同時公開           |
|   11 | Backend #109             | 旧DB列を削除し、新列をNOT NULL化して完成時schemaを検証                       |

#98のdeploy後も旧registerは新3列へ書かないため、#98以後かつ#103以前に作成された行には
`username`、`display_name`、`password_hash`のNULLが残り得ます。新serializerをその行へ適用すると
契約違反になるため、#101 / #102を単独で本番trafficへ公開しません。このcutoverは現行#103の
register route scopeに含まれないため、[B-AUTH-CUTOVER #118](https://github.com/IH-Ggroup/minetenant-backend/issues/118)
で追跡します。全API maintenance、versioned catch-up、instance切替、preflight、rollbackの唯一の
運用手順は[`auth-cutover.md`](./auth-cutover.md)です。#103の二重書き込みが有効になる前に#101 / #102へ
trafficを流さず、#109の最終backfillをcutover確認の代わりにしません。

#101で`USERNAME_AUTH_ENABLED`を追加し、#102 / #103も同じgateを使います。local / testでは欠落時
`false`、`APP_ENV=production`では明示設定を必須とし、欠落・空文字・`true` / `false`以外は設定errorで
起動しません。`false`では現行email endpointと旧serializerだけを実行し、新認証codeへtrafficを
流しません。#103はcutover後の新旧register
requestを新旧列へ互換書き込みします。cutover後のrollbackはdata互換でも、logout済みのusername登録
利用者へ旧email loginを透過的に提供できないため、runbookどおりmaintenanceとforward-fixを優先します。

認証cutover後も、旧login `{ email, password }`は#105が完了するまで、旧register
`{ name, email, password, password_confirmation? }`は#106が完了するまで受理します。新旧fieldを
一つのrequestに混在させた場合は422とし、混在した新旧固有fieldをそれぞれ`errors`へ返します。
legacy requestのvalidation errorだけは旧Frontが表示できる旧field名を返し、新requestは常に
camelCaseの新field名を返します。#105後のloginで`email`、#106後のregisterで`name`、`email`、
`password_confirmation`が一つでも送られた場合は、他のfieldが正しくても422とし、送られた旧field名を
`errors`へ返します。削除済みfieldをunknown keyとして黙って無視しません。

#105 / #107はlogin / meの旧branchを削除し、#108は`GET /users`を削除しますが、3 PRを単独では
production deployしません。#106がlegacy register、旧列write、最後のfalse branch、config、testを
削除したcommitまでを[B-AUTH-CONTRACT-CUTOVER #121](https://github.com/IH-Ggroup/minetenant-backend/issues/121)
が一つのmaintenance releaseとして同時にdeployします。#105だけを先に公開して、
emailで登録できるのにemailではloginできない中間状態を作りません。#108時点ではregister互換だけが
既知の旧列accessとして残り、#106でruntime旧列reader / writerを0件にします。

#100は完成時User DTOの7 fieldだけを返す`serializeSessionUser`を新設し、現行`GET /users`が使う
legacy `serializeUser`を変更しません。この期間のregister / login / me routeは前者の結果へ
`"name": dto.displayName`を足す薄いlegacy adapterをそれぞれ持ち、deprecated fieldを**必ず**
併記します。#105、#106、#107は対象endpointのadapterだけを削除し、他endpointの
互換responseを変えません。#108は利用者列挙を避けるため`GET /users`と参照・test・docsを削除します。emailと
秘密情報は互換期間中もresponseへ返しません。

password rehashの正本切替、binary CAS、旧新両列の同一transaction更新も
[`auth-cutover.md`](./auth-cutover.md)を正本とします。loginは#105まで、registerは#106まで片方だけを
更新しません。

#103から#106まで、新requestで作る行も旧runtimeへrollbackできるよう、同じtransactionで旧列へ
次の互換値を書きます。legacy requestは利用者が送った旧`name` / `email`とpassword hashを旧列へ
書きつつ、新列も確定します。

| 旧列             | 新requestから書く互換値                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `name`           | 正規化・保存済み`display_name`                                               |
| `email`          | 下記の`legacy+<hash>@legacy.invalid`。予約namespaceの一時identifier          |
| `password`       | `password_hash`と同じbcrypt hash                                             |
| `role_label`     | `buyer -> 購入者`、`seller -> 出品者`                                        |
| `avatar_initial` | `display_name`の先頭Unicode code point。旧`VARCHAR(8)`へ必ず収まる互換表示値 |

synthetic emailは`legacy+` + `SHA-256(user_id + ":" + attempt)`のlowercase hex先頭48文字 +
`@legacy.invalid`です。hash入力の規則は後述のusername生成と同じで、`attempt=0`から始め、
UNIQUE競合時だけ99まで増やします。100候補すべてが衝突した場合はtransactionをrollbackし、
秘密値を出さない内部errorとして停止します。cutover後のlegacy registerは
`^legacy\+[0-9a-f]{48}@legacy\.invalid$`を422 `errors.email`で予約します。

#98 / #118のpreflightは、このnamespaceに一致する既存行ごとに同じuser_idのattempt 0〜99を再計算します。
emailがいずれかの候補と一致し、`name / password / role_label / avatar_initial`も新列から導出した
互換値と一致する正規generated行だけは、cutover再実行のため許可します。100候補で再現できない値や
互換列が不整合な値は、自動変更せず`user_id`を内部向け診断へ出して停止します。

synthetic emailは公開DTO、通常のUI、logへ出しません。synthetic emailによる旧loginも、DBで対応する
保存済みusernameを取得し、usernameやreal legacy emailと同じcanonical account rate-limit bucketを
消費します。
pre-#106 runtimeへの緊急rollbackで必要な場合だけ、operatorがusernameから保存済みemailを検索します。
#105 / #107をmergeし、#108で`GET /users`を削除して残る旧列accessがregister互換だけであることを
確認してから、#106を最後にmergeします。#106はregisterの旧branchと旧列writeに加え、
`USERNAME_AUTH_ENABLED`のconfig・残ったregister false branch・testを削除し、新requestの旧5列を
NULLのままにします。runbookの専用smoke userだけはcleanupとNULL残件0件を確認できればrollback可能ですが、
その条件を外れた最初の#106 writeがdata point-of-no-returnです。4 PRを別々にproduction deployせず、
backupと全API maintenanceの下で#121が同じreleaseとして切り替えます。再開後はpre-#106 runtimeへ
戻さずforward-fixします。

既存利用者とlegacy registerでusername入力がない行は、`user-buyer`が存在する場合だけ`demo`、
`user-seller`が存在する場合だけ`seller`へ固定し、それ以外を次の規則で生成します。`demo`と`seller`は
system usernameとして全環境で予約し、public registerは常に422 `errors.username`で拒否します。
#104のdemo seedだけがlocal / testで固定user IDとの組合せを作成でき、本番cutoverでは実行しません。

1. `attempt=0`から始め、`u_` + `SHA-256(user_id + ":" + attempt)`のlowercase hex先頭30文字を
   候補にする。hash入力は文字列全体のUTF-8 bytesで、attemptは先頭0なしのASCII 10進表記にする。
   attempt 0〜99がすべて衝突した場合は自動生成を停止し、対象`user_id`を内部向け診断へ出す。
2. 既存行のbackfillは`user_id`のbinary昇順で行い、候補が予約済みまたは重複ならattemptを1増やす。
3. 同じ`user_id`からは同じ候補列を作り、すでに設定済みのvalidなusernameを再実行で上書きしない。
   ただし`user-buyer` / `user-seller`に対応する固定値以外が設定済みなら停止する。
4. legacy registerでも先に不変の`user_id`を作り、同じ規則とUNIQUE制約でusernameを確定する。

emailや表示名からusernameを作りません。username-onlyのFrontend #94をdeployする**前**に、
保持対象が`demo` / `seller`などの破棄可能なdemo accountだけであることを証明するか、ログアウト中の
利用者も含めて全員へ新usernameを伝達・確認します。認証後しか読めない`/me`だけを移行導線には
できません。確認できない利用者が一人でもいる状態ではusername-only画面をdeployせず、#105で
email loginも停止しません。password reset、email recovery、SNS loginはこの契約の対象外です。

## 疎通確認

```http
GET /api/hello
```

```text
MineTenant API is running.
```

既存Fabric MODの`/callapi`が利用する互換用エンドポイントです。

## 開発用ユーザー一覧

```http
GET /api/v1/users
```

ログイン必須です。初期デモユーザーと新規登録したユーザーを含む一覧です。
この一覧からユーザーIDを選ぶだけでは、ログインや他人としての操作はできません。
通常の画面では`GET /auth/me`を使って本人を取得してください。

Front / MODに利用箇所がなく、認証済みなら全usernameを列挙できるため、完成時にはBackend #108で
route・参照・test・このlegacy契約を削除します。auth専用`serializeSessionUser`へ接続しません。
削除までは次の現行legacy responseだけを維持し、新列やemail、秘密情報を追加しません。

```json
{
  "data": [
    {
      "id": "user-buyer",
      "name": "山田 みどり",
      "role": "buyer",
      "roleLabel": "購入者デモ",
      "avatarInitial": "山",
      "storeId": "store-yamada"
    }
  ]
}
```

## 一点物Product

一覧、詳細、出品成功で返すProductは次のフィールドだけです。`status`は小文字の
`available` / `sold`で、`available`から`sold`への一方向だけです。数量を表す`stock`、内部用の
`listingRequestId`、fingerprint、`deletedAt`、`updatedAt`は返しません。既存行の`created_at`が
NULLの場合だけ`createdAt`もNULLです。

```ts
type ProductStatus = 'available' | 'sold';

type Product = {
  id: string;
  storeId: string;
  sellerId: string;
  name: string;
  description: string;
  price: number;
  status: ProductStatus;
  category: 'fashion' | 'interior' | 'hobby' | 'accessory' | 'tool';
  theme: 'ocean' | 'forest' | 'amethyst' | 'sunset' | 'sand' | 'moss';
  emoji: string;
  createdAt: string | null;
};
```

```json
{
  "id": "product-hoodie",
  "storeId": "store-mine",
  "sellerId": "user-seller",
  "name": "コバルトブルーのパーカー",
  "description": "深い青色と、ゆったりしたシルエットが特徴のパーカーです。普段使いしやすい厚さに仕上げました。",
  "price": 6800,
  "status": "available",
  "category": "fashion",
  "theme": "ocean",
  "emoji": "🧥",
  "createdAt": "2026-07-18T09:00:00.000000Z"
}
```

このProduct DTOは`serializeProduct`を共有する商品一覧・詳細・出品だけでなく、
`Dashboard.products`と現行`GET /minecraft/catalog`にも適用します。endpointごとに`stock`付きの別DTOは
作りません。Dashboardの内部集計は物理`stock`を削除する前に新規Issue
[B-DASHBOARD-PRODUCT-01 (#92)](https://github.com/IH-Ggroup/minetenant-backend/issues/92)で移行し、
Minecraft APIの認証・最終pathはB-CONTRACT-05以降で扱います。

## 商品一覧

```http
GET /api/v1/products
GET /api/v1/products?storeId=store-mine
GET /api/v1/products?keyword=%E6%9C%A8
GET /api/v1/products?storeId=store-mine&keyword=%E6%9C%A8
```

`keyword`は商品名・商品説明の部分一致検索です。前後の空白を除き、最大120文字、
空なら全件を返します。`%`と`_`も文字として検索します。`storeId`と併用できます。
結果は作成日時の新しい順です。`available`と`sold`をどちらも含み、soft delete済み商品だけを
除外します。0件は404ではなく`200 { "data": [] }`です。

```json
{
  "data": [
    {
      "id": "product-stool",
      "storeId": "store-mine",
      "sellerId": "user-seller",
      "name": "森の木製スツール",
      "description": "天然木の表情を残して仕上げた小さなスツールです。椅子としても飾り台としても使えます。",
      "price": 4200,
      "status": "sold",
      "category": "interior",
      "theme": "forest",
      "emoji": "🪵",
      "createdAt": "2026-07-17T04:30:00.000000Z"
    }
  ]
}
```

## 商品詳細

```http
GET /api/v1/products/product-stool
```

`available`と`sold`をどちらも`200 { "data": Product }`で返します。soft delete済み、または
存在しない商品は404です。

```json
{
  "message": "商品が見つかりません。"
}
```

## 商品出品

ログインとCSRFトークンが必要です。本文で受け付けるキーは次の7個だけです。
画面は出品操作の開始時に`requestId`を一度だけ生成し、結果が不明な通信失敗・timeout・再読み込み後も
同じ内容には同じIDを使います。内容を変更した新しい出品操作では新しいIDを使います。

```http
POST /api/v1/products
Content-Type: application/json
X-XSRF-TOKEN: CookieをURLデコードした値
```

```json
{
  "requestId": "7070b23f-7be8-4dc5-a85b-2570a7467557",
  "name": "鉱石モチーフのペンダント",
  "description": "青い鉱石をイメージした手作りペンダントです。",
  "price": 3200,
  "category": "accessory",
  "theme": "ocean",
  "emoji": "💎"
}
```

`sellerId`と`storeId`はWebセッションの本人とその所有店舗、初期`status`は`available`にAPIが
固定します。`stock`、`status`、`sellerId`、`storeId`を含む未許可キーは、値にかかわらず422で
拒否し、無視しません。認証ユーザーの所有店舗が存在しないDB不整合は409
`USER_STORE_NOT_READY`です。

`requestId`は共通仕様の形式で必須です。`name`、`description`、`emoji`は前後のUnicode whitespaceを
除き、Unicode NFCへ正規化した後にそれぞれ1〜120、1〜2,000、1〜16 code pointとします。`price`は
JSON numberの整数1〜99,999,999です。`category`は`fashion` / `interior` / `hobby` /
`accessory` / `tool`、`theme`は`ocean` / `forest` / `amethyst` / `sunset` / `sand` /
`moss`です。`category`と`theme`も前後のUnicode whitespaceを除いてから、case-sensitiveな値として
検証します。正規化後の文字列をProductへ保存し、responseにも同じ値を返します。

正規化後の`name, description, price, category, theme, emoji`をこの順でobjectへ入れ、Node.jsの
`JSON.stringify`結果をUTF-8化してSHA-256 fingerprintを作ります。`requestId`、所有者、店舗、状態は
fingerprintへ含めません。DB上の保存形式と一意制約は
[`docs/database.md`](./database.md#出品fingerprint)を参照してください。
出品`requestId`の一意性は認証ユーザー単位で、別ユーザーが同じ文字列を使うことはできます。

初回成功は`201 { "data": Product }`です。同じ利用者が同じ`requestId`と同じfingerprintを再送すると
`200`で同じProduct IDを返し、行を追加しません。その間に商品が購入されていれば、再送responseは
現在値の`status: "sold"`です。同内容を同時送信してもProductは1行、201は1requestだけで、残りは
すべて200です。

初回の新規Product作成時だけ、[店舗ポイント](#店舗ポイント)の規則に従ってsellerの店舗へ
10 pointsを加算します。同じ`requestId`の再送で200を返す場合は再加算しません。

初回の201 responseです。

```json
{
  "data": {
    "id": "28f72634-2ee2-4ac7-9a25-6968660f8a67",
    "storeId": "store-yamada",
    "sellerId": "user-buyer",
    "name": "鉱石モチーフのペンダント",
    "description": "青い鉱石をイメージした手作りペンダントです。",
    "price": 3200,
    "status": "available",
    "category": "accessory",
    "theme": "ocean",
    "emoji": "💎",
    "createdAt": "2026-09-16T05:00:00.000000Z"
  }
}
```

購入後に同じ出品requestを再送した200 responseです。IDは初回と同じで、現在の状態だけが`sold`です。

```json
{
  "data": {
    "id": "28f72634-2ee2-4ac7-9a25-6968660f8a67",
    "storeId": "store-yamada",
    "sellerId": "user-buyer",
    "name": "鉱石モチーフのペンダント",
    "description": "青い鉱石をイメージした手作りペンダントです。",
    "price": 3200,
    "status": "sold",
    "category": "accessory",
    "theme": "ocean",
    "emoji": "💎",
    "createdAt": "2026-09-16T05:00:00.000000Z"
  }
}
```

異なる内容への再利用は409です。

```json
{
  "message": "同じrequestIdが別の出品内容ですでに使用されています。",
  "code": "REQUEST_ID_CONFLICT",
  "errors": {
    "requestId": ["別の出品操作には新しいrequestIdを使用してください。"]
  }
}
```

元の商品をsoft deleteした後に同じ内容を再送しても、商品を復活・再作成しません。

```json
{
  "message": "このrequestIdで作成した商品は削除済みです。新しい出品操作を開始してください。",
  "code": "LISTING_REQUEST_RETIRED"
}
```

同じ削除済みrequest IDを異なる内容へ使った場合は、内容競合を優先して
`REQUEST_ID_CONFLICT`を返します。

## 商品削除

```http
DELETE /api/v1/products/{productId}
```

ログインとCSRFトークンが必要です。商品の出品者本人だけが削除でき、他人なら403です。
`sold`または一度でも取引された商品は履歴を保持するため409を返し、削除しません。この409は
`{ "message": "売却済みの商品は削除できません。" }`だけで、固定`code`は付けません。
未取引かつ`available`な商品の削除が成功した場合は204です。出品requestの冪等性を削除後も
維持するため、DB上は物理削除せずsoft deleteします。存在しない、またはsoft delete済みなら404です。
購入と同じProduct行をlockし、購入が先にcommitすればDELETEは409、DELETEが先にcommitすれば購入は
404にします。

## Web購入

ログインとCSRFトークンが必要です。`requestId`は購入操作を始めるときに一つ生成し、
その操作の結果が確定するまで保持してください。タイムアウトなどで結果が不明な場合も、
同じ購入の再送には同じ値を使います。新しいIDは別の購入として扱われます。

新規フロントが使う正規の入口は商品IDをpathに持ち、本文は`requestId`だけです。

```http
POST /api/v1/products/product-hoodie/purchases
Content-Type: application/json
X-XSRF-TOKEN: CookieをURLデコードした値
```

```json
{
  "requestId": "3cb3f539-01ee-4f38-8f85-f1f0862755e1"
}
```

`POST /api/v1/purchases`はv1互換入口として残し、同じ購入serviceへ接続します。この入口だけは
本文に`productId`と`requestId`を指定します。

```http
POST /api/v1/purchases
Content-Type: application/json
```

```json
{
  "productId": "product-hoodie",
  "requestId": "3cb3f539-01ee-4f38-8f85-f1f0862755e1"
}
```

正規入口では上記以外の本文キー、互換入口では`productId` / `requestId`以外のキーを422で拒否します。
`buyerId`、`source`、`sellerId`、`price`、`status`をクライアント入力として受け取りません。buyerは
Webセッション、sourceは`web`、sellerとamountはlock後のProductからAPIが確定します。
`requestId`は共通仕様の形式で必須です。購入`requestId`は正規・互換・Minecraftの入口をまたいで
globalに一意です。lookup時点ですでに存在する形式外IDだけは共通仕様のgrandfather規則で再生でき、
未使用の形式外IDを新規購入には使えません。

購入直前の商品が次の状態だったとします。

```json
{
  "data": {
    "id": "product-hoodie",
    "storeId": "store-mine",
    "sellerId": "user-seller",
    "name": "コバルトブルーのパーカー",
    "description": "深い青色と、ゆったりしたシルエットが特徴のパーカーです。普段使いしやすい厚さに仕上げました。",
    "price": 6800,
    "status": "available",
    "category": "fashion",
    "theme": "ocean",
    "emoji": "🧥",
    "createdAt": "2026-07-18T09:00:00.000000Z"
  }
}
```

初回成功は201で、次のTransactionを返します。

```json
{
  "data": {
    "id": "transaction-example",
    "productId": "product-hoodie",
    "buyerId": "user-buyer",
    "sellerId": "user-seller",
    "source": "web",
    "amount": 6800,
    "status": "paid",
    "createdAt": "2026-09-04T02:00:00.000000Z"
  }
}
```

同じ購入requestを再送した200 responseは同じTransaction IDとproduct / buyer / seller / source /
amountを返します。その後に配送状態が進んでいれば、`status`だけは現在の`shipping` / `complete`です。

Productの`sold`化とTransaction作成は一つのDB transactionでcommitします。成功後に同じ商品を
GETするとIDや価格を保ったまま次の状態です。

初回の購入成立時だけ、buyerが所有する店舗へ50 points、Productの販売店舗へ100 pointsを加算します。
両店舗の加算はProductの`sold`化とTransaction作成と同じDB transactionで行い、片方でも更新できない
場合は購入全体をrollbackします。

```json
{
  "data": {
    "id": "product-hoodie",
    "storeId": "store-mine",
    "sellerId": "user-seller",
    "name": "コバルトブルーのパーカー",
    "description": "深い青色と、ゆったりしたシルエットが特徴のパーカーです。普段使いしやすい厚さに仕上げました。",
    "price": 6800,
    "status": "sold",
    "category": "fashion",
    "theme": "ocean",
    "emoji": "🧥",
    "createdAt": "2026-07-18T09:00:00.000000Z"
  }
}
```

同じ`requestId`、product ID、認証済みbuyer、sourceで再送すると、商品状態の検査より先に既存購入を
再生し、`200`で最初と同じTransaction IDを返します。これは保存済みの形式外IDにも適用します。
`sold`を再度更新せず、Transactionや店舗pointsも増やしません。同じ`requestId`でもproduct ID、buyer、
sourceのいずれかが異なる場合は409です。

```json
{
  "message": "同じrequestIdが別の購入内容ですでに使用されています。",
  "code": "REQUEST_ID_CONFLICT",
  "errors": {
    "requestId": ["別の購入操作には新しいrequestIdを使用してください。"]
  }
}
```

別の`requestId`で`sold`の商品を購入すると、互換codeを維持して次の409を返します。

```json
{
  "message": "この商品は売り切れのため購入できません。",
  "code": "OUT_OF_STOCK"
}
```

自己購入は商品が`sold`かどうかより先に判定し、422です。

```json
{
  "message": "自分が出品した商品は購入できません。",
  "code": "SELF_PURCHASE",
  "errors": {
    "buyerId": ["自分が出品した商品は購入できません。"]
  }
}
```

認証・CSRF・JSON parse・本文shapeと`requestId`の型・255文字上限を検証した後、最終形式のIDは通常の
入力validationへ進みます。形式外IDは先に既存Transactionをexact lookupし、同内容なら200、競合なら
409、未使用なら422です。新規作成可能なIDでは、(1)同じ`requestId`の再送/競合、(2)商品存在、
(3)自己購入、(4)`sold`の順で判定します。存在しない、またはsoft delete済みの商品は404です。
WebとMinecraftが別の`requestId`で同じ商品を同時購入しても、成功とTransactionは1件だけで、敗者は
`OUT_OF_STOCK`です。途中で失敗した場合はProduct、Transaction、店舗pointsをすべてrollbackします。

返るのは取引情報です。フロントの`{ ok, transactionId }`形式ではありません。`data.id`が購入完了
画面へ渡す取引IDです。最新の状態は購入成功後に商品詳細をもう一度GETして表示します。実際の決済・
配送処理は行いません。

## 店舗

Dashboardの`products`にも共通の一点物Productを返します。集計field自体は現行互換で残しますが、
`availableProductCount`と`soldOutProductCount`は`status`で判定します。移行中の`totalStock`は
一点物の購入可能数、つまり`availableProductCount`と同じ値です。Dashboard内部の集計が`status`へ
移るまでは、DBの互換`stock`を0 / 1へ同期します。

```http
GET /api/v1/stores/store-mine
GET /api/v1/stores/store-mine/growth
GET /api/v1/stores/store-mine/dashboard
```

店舗情報は公開GETです。ダッシュボードはログイン済みの所有者だけが取得でき、
他人の店舗なら403です。

ダッシュボードでは、出品数、売り切れ数、販売数、売上、Web/Fabric別の購入数、
次のレベルまでのポイント、最近の取引を返します。
フロントとMinecraft MODはpointsからlevelや進捗率を再計算せず、APIの値をそのまま表示します。

```json
{
  "data": {
    "store": {
      "id": "store-mine",
      "ownerId": "user-seller",
      "name": "BLUE ORE STUDIO",
      "description": "青い鉱石を目印に、暮らしの道具と出会う店。",
      "level": 3,
      "points": 420,
      "syncStatus": "connected"
    },
    "products": [
      {
        "id": "product-hoodie",
        "storeId": "store-mine",
        "sellerId": "user-seller",
        "name": "コバルトブルーのパーカー",
        "description": "深い青色と、ゆったりしたシルエットが特徴のパーカーです。",
        "price": 6800,
        "status": "available",
        "category": "fashion",
        "theme": "ocean",
        "emoji": "🧥",
        "createdAt": "2026-07-18T09:00:00.000000Z"
      }
    ],
    "stats": {
      "productCount": 3,
      "availableProductCount": 1,
      "soldOutProductCount": 2,
      "totalStock": 1,
      "salesCount": 1,
      "salesAmount": 4200,
      "webSalesCount": 0,
      "minecraftSalesCount": 1,
      "nextLevelPoints": 180,
      "levelProgressPercent": 40,
      "maxLevel": 5,
      "isMaxLevel": false
    },
    "recentTransactions": [
      {
        "id": "transaction-demo",
        "productId": "product-stool",
        "buyerId": "user-buyer",
        "sellerId": "user-seller",
        "source": "minecraft",
        "amount": 4200,
        "status": "shipping",
        "createdAt": "2026-07-21T08:30:00.000000Z"
      }
    ]
  }
}
```

店舗成長だけを取得する`GET /api/v1/stores/{storeId}/growth`は、公開Storeですでに公開している
`level`と`points`から作る読み取り専用の公開GETです。認証は不要で、呼び出してもpointsやlevelを
変更しません。存在しないStoreには404を返します。Storeとdashboardも同じ共通計算を利用します。

このpathは`storeId`を知っているWeb向けの公開GETです。接続中playerのMinecraft UUIDからStoreを
解決するFabric Server向けpath・認証・未連携時のerrorは本Issueでは決めず、Minecraft連携・認証の
契約Issueを正本とします。MODはowner限定dashboardを流用したり、UUID用pathを推測したりしません。

```ts
type StoreGrowth = {
  storeId: string;
  level: number;
  points: number;
  nextLevelPoints: number;
  levelProgressPercent: number;
  maxLevel: number;
  isMaxLevel: boolean;
};
```

```json
{
  "data": {
    "storeId": "store-mine",
    "level": 3,
    "points": 420,
    "nextLevelPoints": 180,
    "levelProgressPercent": 40,
    "maxLevel": 5,
    "isMaxLevel": false
  }
}
```

上の配列は読みやすさのため各1件だけ掲載しています。実際の`products`には店舗の
全商品、`recentTransactions`には新しい順で最大5件が入ります。

## 取引履歴

```http
GET /api/v1/transactions
GET /api/v1/transactions/{transactionId}
```

一覧はログインした本人が購入者または出品者として関係する取引だけを、新しい順に
返します。互換用の`?userId=...`は省略可能で、指定する場合も本人のID以外は422です。
詳細は取引の購入者・出品者だけが取得でき、他人の取引なら403です。
購入完了画面の再読み込み時には、URLの取引IDから詳細を取得できます。

## Webフロントの接続例

### 接続先とCookie

フロントの`.env.local`を次のように設定し、Viteを再起動します。

```dotenv
VITE_API_BASE_URL=http://localhost:8787/api/v1
```

ローカルHTTPではフロントを`http://localhost:5173`、APIを
`http://localhost:8787`にそろえてください。Cookieはポートをまたいで使えますが、
`localhost`と`127.0.0.1`は別ホストなので混ぜないでください。API側の
`CORS_ALLOWED_ORIGINS`にはフロントの正確なOriginを指定します。

既定の起動設定はループバック限定です。別PCにあるAPIへURLだけを変更しても
接続できません。Cookie用のホスト名と開発環境の通信経路もそろえる必要があります。
Minecraft側に未認証APIが残るため、このPoCをインターネットに公開しないでください。

### fetchヘルパー

以下はフロント側へ追加する例です。書き込みは自動再送しません。419ではCSRF Cookieを
再取得して画面に再操作を求め、401では未ログイン表示に戻してください。購入の再操作では
同じ`requestId`を保持します。Cookieはログイン等で変わるため、毎回読み直します。

```ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL.replace(/\/$/, '');

type ApiErrorBody = {
  message?: string;
  code?: string;
  errors?: Record<string, string[]>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errors: Record<string, string[]>;

  constructor(
    status: number,
    message: string,
    errors: Record<string, string[]> = {},
    code?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

function csrfToken(): string | undefined {
  const cookie = document.cookie
    .split('; ')
    .find((item) => item.startsWith('XSRF-TOKEN='));
  return cookie
    ? decodeURIComponent(cookie.slice('XSRF-TOKEN='.length))
    : undefined;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (payload ?? {}) as ApiErrorBody;
    throw new ApiError(
      response.status,
      problem.message ?? `APIへの接続に失敗しました (${response.status})`,
      problem.errors ?? {},
      problem.code,
    );
  }
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    throw new Error('APIから予期しない形式の応答を受け取りました。');
  }
  return payload.data as T;
}

export async function refreshCsrf(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/auth/csrf-cookie`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  await readResponse<void>(response);
}

export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const writes = method !== 'GET';
  const headers = new Headers({ Accept: 'application/json' });

  if (writes) {
    if (!csrfToken()) await refreshCsrf();
    const token = csrfToken();
    if (!token)
      throw new Error(
        'CSRF Cookieを取得できません。接続先を確認してください。',
      );
    headers.set('X-XSRF-TOKEN', token);
  }
  if (options.body !== undefined)
    headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return readResponse<T>(response);
}
```

完成時契約の使用例です。`SessionUser`は「完成時のUser DTO」、`Product`はこの文書の
一点物Product型へ更新し、`Transaction`はフロントの既存型を使います。

```ts
await refreshCsrf();
const user = await api<SessionUser>('/auth/login', {
  method: 'POST',
  body: { username: 'demo', password: 'password' },
});
const products = await api<Product[]>(
  `/products?${new URLSearchParams({ keyword: '木' })}`,
);

// 確認画面のstate/ref等で保持し、結果不明の再送で作り直さない。
const pendingPurchase = {
  productId: 'product-hoodie',
  requestId: crypto.randomUUID(),
};
const transaction = await api<Transaction>(
  `/products/${encodeURIComponent(pendingPurchase.productId)}/purchases`,
  {
    method: 'POST',
    body: { requestId: pendingPurchase.requestId },
  },
);
const product = await api<Product>(
  `/products/${encodeURIComponent(transaction.productId)}`,
);
// 完了画面のIDはtransaction.id、最新の販売状態はproduct.status。

await api<void>('/auth/logout', { method: 'POST' });
```

### フロント側の接続実装

フロントも最新mainへ更新してください。古い仮ログイン版では認証必須のAPIを利用できません。

1. `src/api/client.ts`がCookie・CSRF・`data`の取り出し・204・HTTPエラーを共通処理します。
2. `src/api/auth.ts`が登録・ログイン・ログアウト・`GET /auth/me`に接続します。
   登録画面はusername・任意のdisplayName・password・必須のpasswordConfirmationをcamelCaseで送り、
   ログイン画面はusernameとpasswordを送ります。
3. `DemoStoreProvider`はログイン状態をAPIから復元します。セッションCookieはブラウザが管理し、
   パスワードやトークンはlocalStorageへ保存しません。利用者名は`displayName`を表示し、
   `storeId === null`なら出品・店舗管理の導線を隠し、直URLからのroute遷移とAPI呼び出しも
   blockします。
4. 出品では保持した`requestId`と数量なしの商品情報を送信し、`sellerId`・`storeId`・`status`は
   API側で決定します。
5. 購入は`POST /products/{productId}/purchases`へ保持した`requestId`を送信します。
   `transaction.id`で完了画面へ進み、商品を再GETして販売状態を表示します。
6. マイページ・購入完了画面では`GET /transactions`から本人の取引を取得し、
   店舗管理では本人の店舗ダッシュボードを使います。クライアントから本人IDを指定しません。
7. 登録・ログインの422はcamelCaseの`errors`を入力欄に表示します。loginの401はform-levelの
   認証失敗として表示し、`GET /auth/me`など認証必須requestの401では認証状態をクリアします。
   419や通信失敗では操作を自動再送せず、ユーザーへ再操作を案内します。

Frontend #94はこの契約を前提に実API接続するため、結合時に次を確認します。

- `SessionUser`をこの文書の7 fieldへexactに揃え、`storeId`を`string | null`として扱う。
- loginの未知username / password不一致testを、`errors.username`のないform-level 401へ更新する。
  構文・field validationだけを422として入力欄へ表示する。
- username欄は`autoComplete="username"`、`autoCapitalize="none"`と「小文字英数字・underscoreの
  3〜32文字」のhintを持ち、trimしてASCII `A-Z`だけを小文字化した値へ`^[a-z0-9_]{3,32}$`を適用する。raw inputへ
  `maxLength={32}`を付けると空白付き32文字を入力途中で壊すため、stateを先に正規化する実装でだけ
  native min/maxを使い、前後空白付き32文字の境界testを持つ。
- Frontでも文字数・byte数を補助表示または事前検証する場合は、displayNameを
  `Array.from(value.trim()).length`、未加工passwordを`Array.from(value).length`、UTF-8 byte数を
  `new TextEncoder().encode(value).length`で数える。Frontで同じ検証を重ねること自体は#94の
  必須範囲とせず、Backendの422を最終判定とする。
- 429はfieldへ割り当てずform-levelで表示し、`Retry-After`中は再送を抑止する。423や恒久lockの
  UI、unlock flowは作らない。
- fixture、test、READMEをBackend #104へ合わせ、usernameを`demo` / `seller`にする。
  `roleLabel`と`avatarInitial`を旧fixtureでhard-codeせずAPI responseを使い、emailログイン案内を
  完成時のREADMEへ残さない。

## Fabric商品一覧

以下のMinecraft専用APIの認証・pathは今回変更していません。Webのセッション認証・CSRF検証は
適用されず、開発用の未認証APIです。responseの各商品は共有の一点物Productなので、`stock`ではなく
`status`を返し、`status: "sold"`の商品は購入できません。Minecraft側の認証・最終pathは
B-CONTRACT-05の範囲です。Web画面からはこちらを使わないでください。

```http
GET /api/v1/minecraft/catalog
```

Webと同じ商品を、`sold`も含めてFabric側へ返します。

## Fabric購入

```http
POST /api/v1/minecraft/purchases
Content-Type: application/json
```

```json
{
  "productId": "product-toolbag",
  "buyerId": "user-seller",
  "requestId": "74e4951d-b909-4a9f-9db2-b1555b750b4f"
}
```

購入元はAPI側で`minecraft`に固定します。Web購入と同じ購入処理を通るため、同じ商品状態と
取引履歴を更新し、初回の購入成立時だけbuyerが所有する店舗へ50 points、Productの販売店舗へ
100 pointsを加算します。同じ`requestId`の再送では再加算せず、途中で失敗した場合はすべて
rollbackします。
