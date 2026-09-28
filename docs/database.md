# MineTenant Webアカウント・一点物商品・購入・店舗成長 DB契約

この文書は [B-CONTRACT-01](https://github.com/IH-Ggroup/minetenant-backend/issues/41) と
[B-CONTRACT-02](https://github.com/IH-Ggroup/minetenant-backend/issues/42) で確定した、`products`、
`purchase_transactions`、`stores`の目標契約と、
[B-CONTRACT-07](https://github.com/IH-Ggroup/minetenant-backend/issues/96) で確定した`users`の
目標契約です。現行`develop`の実装説明ではなく、B-PRODUCT、B-BUY、B-XP、B-AUTH Issueが
実装するときの正本です。migration、route、service本体は契約Issueでは変更しません。

APIのcamelCase、HTTP status、error codeは[`docs/api.md`](./api.md)を正本とし、この文書では
MySQLのsnake_case、制約、移行規則を固定します。ここにないMinecraft認証・連携、建築ジョブの
列やtableは、それぞれの契約Issueで決めます。

## ID物理名と公開APIの境界

DBのID列は最終ER図に合わせ、entityを含む主キー名と役割が分かる外部キー名を使用します。

| table                   | 主キー           | Userへの外部キー                   |
| ----------------------- | ---------------- | ---------------------------------- |
| `users`                 | `user_id`        | -                                  |
| `stores`                | `store_id`       | `user_id`                          |
| `products`              | `product_id`     | `user_id`                          |
| `purchase_transactions` | `transaction_id` | `buyer_user_id` / `seller_user_id` |
| `hono_sessions`         | `session_id`     | `user_id`                          |

公開HTTP APIのJSON名は既存契約を維持します。DB row typeは物理名をそのまま使用し、serializerで
`user_id` / `store_id` / `product_id` / `transaction_id`を`id`へ、Storeの`user_id`を`ownerId`へ、
Productの`user_id`を`sellerId`へ、Transactionのrole付きUser IDを`buyerId` / `sellerId`へ変換します。
FrontendとMinecraftへDBの物理列名は公開しません。

`0001_entity_id_columns`適用後のID関連制約名は次で固定します。

- `stores_user_id_unique`
- `stores_user_id_foreign`
- `products_store_id_foreign`
- `products_user_id_foreign`
- `products_user_id_created_at_index`
- `purchase_transactions_product_id_foreign`
- `purchase_transactions_buyer_user_id_foreign`
- `purchase_transactions_seller_user_id_foreign`
- `purchase_transactions_buyer_user_id_created_at_index`
- `purchase_transactions_seller_user_id_created_at_index`
- `hono_sessions_user_id_foreign`（`ON DELETE CASCADE`）

上記のうち`hono_sessions.user_id`はNULLを許可し、それ以外のID外部キーはNULLを許可しません。
Session以外のID外部キーは`ON DELETE RESTRICT`です。

`0001_entity_id_columns`は、改名対象IDへ接続する定義外の外部キー、維持対象indexの欠損、
view・trigger・routine・event、改名対象table上の式やpartitionなどをDDL前に検出して停止します。
これらはMySQLの列改名だけでは安全に追随できないため、cutover前に依存内容を確認し、必要なら
別migrationで明示的に作り直します。

## 現行から目標への変更

| 対象               | 現行`develop`                 | 目標契約                                                       |
| ------------------ | ----------------------------- | -------------------------------------------------------------- |
| 商品の販売状態     | `products.stock INT UNSIGNED` | `products.status = available / sold`                           |
| 出品の冪等性       | なし                          | 出品者と`listing_request_id`を一意化し、内容fingerprintを保存  |
| 商品削除           | 未取引行を物理削除            | `deleted_at`によるsoft delete                                  |
| 一商品あたりの取引 | `product_id`は通常index       | `product_id`をUNIQUEにして最大1取引                            |
| 購入の冪等性       | `request_id`を一意化済み      | NO PAD比較の一意制約を維持。新規IDはAPIでASCII・100文字に制限  |
| 購入時の販売状態   | `stock < 1`判定後に1減算      | `available`をlockし、`sold`へ一度だけ遷移                      |
| 店舗points         | 販売店舗へ100 pointsだけ加算  | 出品店舗へ10、buyer店舗へ50、販売店舗へ100を初回成功時だけ加算 |
| 店舗level          | 境界と表示計算が実装に直書き  | Lv1〜5の境界、最大時、表示計算、丸めを共通契約として固定       |
| Webアカウント      | email / `name` / `password`   | `username` / `display_name` / `password_hash`。emailは削除     |
| User表示用field    | DB列へ保存                    | `roleLabel`と`avatarInitial`はserializerで導出                 |

ID列は上記の最終物理名を前提とし、業務機能のmigrationで別名へ戻しません。

## 決定理由

| 決定                                             | 理由                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| 数量ではなく`available / sold`                   | 一点物に`stock>=2`や再入荷という不可能な状態を残さないため                  |
| 出品keyを`(user_id, listing_request_id)`で一意化 | 別ユーザーの操作を衝突させず、同じユーザーの重複出品だけを防ぐため          |
| 購入`request_id`をglobalに一意化                 | Web / Minecraftをまたぐ再送と誤ったID再利用を同じ規則で検出するため         |
| `purchase_transactions.product_id`を一意化       | applicationのlockに加え、DBでも一商品一取引を保証するため                   |
| 商品をsoft delete                                | 物理削除後の再送で同じ出品requestから別Productが生まれるのを防ぐため        |
| `OUT_OF_STOCK`を維持                             | 既存クライアントの409分岐を壊さず、「すでにsold」の意味へ読み替えられるため |
| 出品pointsをJSTで1日3件までに制限                | 削除・再出品や自動出品によるpointsの無制限な取得を抑えるため                |
| buyerと販売店舗を同じtransactionで更新           | 購入成立と店舗成長の一部だけがcommitされる状態を作らないため                |
| 最大Lv後もpointsを保持                           | 累計実績を失わず、将来level追加時にも既存pointsを利用できるため             |
| 進捗率を小数点以下切り捨て                       | 次の境界へ未到達なのに100%と表示する状態を作らないため                      |
| usernameをASCII・binary比較                      | 大文字小文字や照合順序に依存せず、登録・ログインIDを一意にするため          |
| 表示名と認証IDを分離                             | 日本語を含む自由な表示名の変更が、ログインIDや外部キーを変えないため        |
| User表示値をserializerで導出                     | 権限labelとavatarの保存値がrole・displayNameからずれるのを防ぐため          |

## API error codeとの対応

| Status | code                      | DBを変更するか |
| ------ | ------------------------- | -------------- |
| 409    | `REQUEST_ID_CONFLICT`     | 変更しない     |
| 409    | `LISTING_REQUEST_RETIRED` | 変更しない     |
| 409    | `USER_STORE_NOT_READY`    | 変更しない     |
| 409    | `OUT_OF_STOCK`            | 変更しない     |
| 422    | `SELF_PURCHASE`           | 変更しない     |

HTTP responseの本文は[`docs/api.md`](./api.md)を正本とします。

## `users`

`users`はWebアカウントの認証情報と不変の内部IDを保持します。完成時schemaは次の7列だけです。
`0003_username_auth`適用後もruntimeは旧列を使用し、B-AUTH-01〜12とcutover関連#118〜#121の
途中だけ新旧列を共存させます。

| 列              | 型                                                  | NULL | default                | 説明                                 |
| --------------- | --------------------------------------------------- | ---- | ---------------------- | ------------------------------------ |
| `user_id`       | `VARCHAR(255)`                                      | 不可 | なし                   | UserのPK、不変の内部識別子           |
| `username`      | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin` | 不可 | なし                   | 正規化済みの登録・ログインID         |
| `display_name`  | `VARCHAR(120)`                                      | 不可 | なし                   | 重複可・日本語可の画面表示名         |
| `password_hash` | `VARCHAR(255)`                                      | 不可 | なし                   | bcrypt password hash                 |
| `role`          | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin` | 不可 | `buyer`                | `buyer` / `seller`の権限コード       |
| `created_at`    | `TIMESTAMP(6)`                                      | 不可 | `CURRENT_TIMESTAMP(6)` | 登録日時                             |
| `updated_at`    | `TIMESTAMP(6)`                                      | 不可 | なし                   | 更新時に`CURRENT_TIMESTAMP(6)`へ更新 |

### #98適用後の移行中schema

`0003_username_auth`は完成時制約を一度に有効化せず、既存email認証を動かしたまま次の3列を追加します。

| 列              | 型                                                              | NULL | default |
| --------------- | --------------------------------------------------------------- | ---- | ------- |
| `username`      | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin`             | 可   | `NULL`  |
| `display_name`  | `VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` | 可   | `NULL`  |
| `password_hash` | `VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` | 可   | `NULL`  |

互換用の`name`、`email`、`password`、`role_label`、`avatar_initial`も元の型と
`utf8mb4_unicode_ci`を維持したままNULL可へ緩和します。`email`のUNIQUE、`users_role_index`、
`user_id`、利用者参照の全外部キー、`role`、timestampは変更しません。backfill後に
`UNIQUE INDEX users_username_unique (username)`だけを追加し、usernameのCHECK、完成時のNOT NULL・
role/default/timestamp制約、旧5列の削除は#109で行います。したがって#98直後は複数のNULL usernameを
許容します。

`updated_at`は`ON UPDATE CURRENT_TIMESTAMP(6)`を付けますが、ER図にないdefaultを追加しません。
insertするserviceまたはmigrationが初期値を明示します。`password_hash`の内容はASCIIのbcrypt hash
ですが、列定義は最終ER図どおり`VARCHAR(255)`とし、平文を保存しません。受理するhashは
`^\$2[by]\$(0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$`に一致する60文字だけです。preflightはregexに加え、
`$2y$`を`$2b$`へ変換した値を`bcrypt.getRounds`で検査します。`$2a$`は受理しません。

### 制約とindex

- `PRIMARY KEY (user_id)`。PRIMARY KEYが一意性を保証するため、重複するUNIQUE indexは作らない
- `UNIQUE INDEX users_username_unique (username)`
- `INDEX users_role_index (role)`
- `CONSTRAINT users_username_format_check CHECK
(CHAR_LENGTH(username) BETWEEN 3 AND 32 AND NOT REGEXP_LIKE(username, '[^a-z0-9_]', 'c'))`

usernameはAPIで前後空白を除去してASCII `A-Z`だけを小文字化した後、`^[a-z0-9_]{3,32}$`を
検証します。DBの
`ascii_bin`、UNIQUE、CHECKでも、case-insensitiveなschema defaultや別writerから不正値が
入ることを防ぎます。ただし`INSERT IGNORE`と`UPDATE IGNORE`は、警告へ格下げされた切り詰め後の値が
CHECKを通り得るため禁止します。`REPLACE`もUNIQUE競合時にdelete + insertとなり、外部キーや監査を
壊し得るため禁止します。#98 / #109のmigration sessionに加え、B-DB-STRICT-MODE #120はruntime poolの
全connectionを
初期化・checkoutするたび、business / migration queryより前に`SET SESSION time_zone = '+00:00'`を
完了し、同じconnectionで`@@SESSION.time_zone = '+00:00'`と、`@@SESSION.sql_mode`へ
`STRICT_TRANS_TABLES`または`STRICT_ALL_TABLES`があることを検証します。満たさないconnectionでは
認証queryを実行せず、startupまたはcheckoutをfail closedにします。登録時のroleは`buyer`です。
この契約で公開するroleは`buyer`と`seller`だけで、
追加する場合はDB migrationより先にAPIとFrontendのunionを更新します。

### DB列にしないUser表示値

`roleLabel`と`avatarInitial`は保存しません。serializerが次の規則で毎回導出します。

- `buyer -> 購入者`、`seller -> 出品者`
- `avatarInitial`はtrim済み`display_name`の先頭extended grapheme cluster。
  Node.jsの`Intl.Segmenter`（`granularity: 'grapheme'`）を使う

未知のroleや空のdisplay_nameをfallbackで隠さず、DB不整合として検出します。完成時にはemail、
`name`、`password`、`role_label`、`avatar_initial`、password reset tokenを`users`へ持ちません。
User DTOへの変換は[`docs/api.md`](./api.md)を正本とし、`user_id`を`id`へ変換します。

### 参照境界と`hono_sessions`

usernameとdisplay_nameは変更可能な属性であり、外部キーに使いません。利用者を参照する列はすべて
`users.user_id`へ接続します。

| table                   | User参照列                         | NULL | delete時   |
| ----------------------- | ---------------------------------- | ---- | ---------- |
| `stores`                | `user_id`                          | 不可 | `RESTRICT` |
| `products`              | `user_id`                          | 不可 | `RESTRICT` |
| `purchase_transactions` | `buyer_user_id` / `seller_user_id` | 不可 | `RESTRICT` |
| `hono_sessions`         | `user_id`                          | 可   | `CASCADE`  |

Minecraft UUIDとのlink tableと一時link codeもusernameではなく`users.user_id`を参照します。
usernameやdisplay_nameを変更してもMinecraft identityとの対応は変わりません。

`hono_sessions.session_id`はsessionのPKです。`hono_sessions.user_id`は匿名sessionだけNULLを許し、
認証済みsessionでは内部`users.user_id`を保持します。`hono_sessions_user_id_foreign`は
`ON DELETE CASCADE`です。`user_id`は外部キーに必要なindexを持ちますが、index名はこの契約では
固定しません。session行へusername、email、password、password hashを複製しません。

### usernameの決定的backfill

B-AUTH-01は既存行を次の規則でbackfillし、同じ入力DBから同じusernameを作ります。

1. `demo`と`seller`を全環境でsystem usernameとして予約する。`user_id='user-buyer'`が存在する場合は、
   usernameがNULLなら`demo`、`user_id='user-seller'`が存在する場合はNULLなら`seller`へ固定する。
   すでにそれぞれの固定値なら維持し、それ以外の非NULL値なら上書きせず停止する。予約usernameを
   対応する固定ID以外が所有している場合も停止する。固定IDがない本番環境へdemo rowは作成しない。
2. その他は`attempt=0`から始め、`u_` +
   `SHA-256(user_id + ":" + attempt)`のlowercase hex先頭30文字を候補にする。hash入力は文字列全体の
   UTF-8 bytesとし、attemptは先頭0なしのASCII 10進表記にする。attempt 0〜99がすべて衝突した場合は
   loopを続けず、対象`user_id`を内部向け診断へ出して停止する。
3. 行を`ORDER BY BINARY user_id`で処理し、候補が既存・予約済みならattemptを1増やす。
4. 上記2つ以外で、すでにvalidなusernameがある行は上書きしない。migration再実行でも同じ値を維持する。
5. 旧`name`をECMAScript `String.prototype.trim()`と同じ規則でtrimした値をdisplay_nameへ使い、
   空なら生成済みusernameを使う。非空で120 code pointを超える場合は切り詰めず`user_id`を
   内部向け診断へ出して停止する。
6. 旧`password`のbcrypt hashをpassword_hashへbyte変更せずコピーする。平文化・一括rehashしない。

legacy registerにも同じ規則を使います。先に一意なuser_idを作り、そのuser_idから候補を生成して
UNIQUE競合時だけattemptを増やします。emailや表示名からusernameを生成しません。
部分適用済みDBで`demo`または`seller`が対応するdemo user以外へ設定済みなら、利用者を自動改名せず
競合する`user_id`を内部向け診断へ出して停止します。
backfill完了時に全usernameが`^[a-z0-9_]{3,32}$`へ一致し、重複がなく、小文字化済みであることを
検証します。部分適用時に残っていた不正値も黙って正規化・上書きせず停止します。

`0003_username_auth`はexpand DDL、全行を対象にした1 transactionのDML、username UNIQUE、verify、
履歴記録の順に進みます。DDL後に失敗した場合は追加列と旧5列のNULL許可が残り得ますが、DMLは全体を
rollbackし、同じversionを再実行して続行できます。部分適用済みDBでは検証済みの非NULL新値を
上書きせずNULLだけを埋め、不正値、旧passwordとのhash差分、旧5列のNULL、不正roleが1件でもあれば
全体を停止します。migration中に現行旧writerが追加した行については、新3列がすべてNULLの状態だけを
verifyで許容し、一部だけNULLの状態は拒否します。履歴記録後の全NULL行は#118までにversioned commandで
catch-upします。

### 段階移行

短い全API maintenanceを除いて互換性を保ちながら切り替えるため、次のexpand / cutover / contract順を
崩しません。

1. **B-AUTH-01 #98:** `username`、`display_name`、`password_hash`をNULL可で追加し、
   上記規則でbackfillする。`name`、`email`、`password`、`role_label`、`avatar_initial`と
   現行email loginを維持する。cost引き上げ時のrehashは旧`password`をbinary CAS条件にし、
   `password`と`password_hash`を一つのUPDATEで同じhashへ更新する。旧5列は#106以後の新requestが
   NULLでinsertできるよう、この時点で
   NULL可へ緩和するが、現行旧writerは引き続き全列へ非NULL値を書く。migrationと同じ共有実装を使う
   versioned `db:auth-backfill -- --mode=<check|apply>`も追加する。backfill検証後に新列をNULL可のまま
   `UNIQUE INDEX users_username_unique (username)`を作成・verifyし、#103以後の同時登録をDBで排他する。
2. **B-AUTH-02〜06 #99〜#103:** auth専用serializer・login・me・registerをfeature gateの後ろへ追加する。
   legacy registerは旧列と新列を同じtransactionで書き、新requestも#106までは決定済み互換値を
   旧列へ書いて、両runtimeで読めるようにする。`GET /users`のlegacy serializerはまだ変えない。
3. **B-AUTH-SESSION #119 / B-DB-STRICT-MODE #120:** 必要時だけ匿名sessionを作るmiddleware hardeningと、
   全runtime DB connectionのstrict SQL mode検査をcutover releaseへ含める。
4. **B-AUTH-CUTOVER #118:** 全APIをmaintenanceへ切り替えて旧instanceをdrain・停止し、上記commandの
   apply / check、全instanceの同一commit・gate確認、再apply / check、内部smoke testを経て公開する。
5. **B-AUTH-07 #104 / Frontend F-AUTH-01 #94:** local / test専用demo seedを更新し、username /
   displayNameへ切り替える。`storeId: null`の画面guardを含めて結合確認する。保持対象の全利用者が
   自分のusernameを確認できるまでemail loginを外さない。本番cutoverでdemo seedは実行しない。
6. **B-AUTH-08 / 10 #105 / #107:** login / meのlegacy branchとloginの旧`password` read / writeを
   削除してmergeするが、単独ではproduction deployしない。
7. **B-AUTH-11 #108:** 利用者列挙を避けるため`GET /users`と参照・test・docsを削除してmergeする。
   残るruntime旧列accessがregister互換だけであることを確認し、単独ではproduction deployしない。
8. **B-AUTH-09 #106:** #108完了後にregisterの旧入力・旧列write、残ったregister false branch、feature
   gateを最後に削除してmergeするが、単独ではproduction deployしない。
9. **B-AUTH-CONTRACT-CUTOVER #121:** #105 / #107 / #108 / #106を一つの全API maintenance releaseとして
   同時に切り替える。ここから新requestの旧5列はNULLとなり、runbookの安全なsmoke cleanup条件を
   外れた後はpre-#106 runtimeへ戻さない。
10. **B-AUTH-12 #109:** runtime・test・seedに旧列参照がなく、NULL・username重複・不正形式が
    ないことをpreflightで確認する。空のdisplay_name、`buyer` / `seller`以外のrole、bcryptとして
    解釈できないpassword_hashも0件であることを確認する。旧5列を削除し、NOT NULL、collation、
    CHECK、timestampをこの節の完成時schemaへ揃え、#98で作成済みのusername UNIQUE indexを保持・照合する。
    #121の証跡確認後、旧列を読む`db:auth-backfill` command、package script、専用testも同じPRで削除し、
    final schema上に恒常的に壊れる運用入口を残さない。

#109はDDL前のbackupと復旧手順を残し、空DB、移行済みDB、再実行を検証します。`users.user_id`と
それを参照する外部キーはこの移行で改名・再採番・付け替えしません。

完成時のtimestamp制約を付ける前に`created_at`と`updated_at`のNULLも検査します。片方だけがNULLなら
非NULL側の値をNULL側へコピーします。両方NULLの行があれば推測した日時を保存せず、`user_id`を
内部向け診断へ出して#109を停止し、backup・監査情報に基づくoperator remediation後に再実行します。
zero dateは既知時刻として扱わず、片方または両方にあれば同じく自動補完せず停止します。

#98から#103までの間に旧registerが作った行は新3列がNULLになり得るため、#101 / #102の新serializerを
単独で本番trafficへ公開しません。[B-AUTH-CUTOVER #118](https://github.com/IH-Ggroup/minetenant-backend/issues/118)
は[`auth-cutover.md`](./auth-cutover.md)のversioned commandと全API maintenance手順を実行します。
新3列のNULL、usernameの重複・形式違反、trim後の空または120 code point超のdisplay_name、
`BINARY role NOT IN ('buyer','seller')`、対応外hash、旧`password`と新`password_hash`のbyte差分が
すべて0件でなければ#101〜#103を有効化しません。synthetic email予約namespaceの行はuser_idから
attempt 0〜99を再計算し、新旧列も整合する正規generated値だけをcutover再実行用に許可します。
再現不能または不整合な値が1件でもあれば停止します。
その後のlegacy registerは新旧列を同じtransactionで書きます。新requestは#106まで
[`docs/api.md`](./api.md)のsynthetic emailを含む互換値を旧5列へ書き、#108完了後に実施する#106以後は
NULLのままにします。
password rehashの正本切替、binary CAS、rollback時の認証可用性も同runbookを正本とします。
#109のpreflightは最後の防御であり、このcutover前確認を先送りする理由にはしません。

## `stores`

全ユーザーは登録時に一つのStoreを持ち、`user_id`は一意です。pointsの加算先はクライアント入力では
なく、認証済みuser、lock後のProduct、Storeの所有関係からAPIが決めます。

| 列            | 型                  | NULL | default   | 説明                                |
| ------------- | ------------------- | ---- | --------- | ----------------------------------- |
| `store_id`    | `VARCHAR(255)`      | 不可 | なし      | StoreのPK                           |
| `user_id`     | `VARCHAR(255)`      | 不可 | なし      | Storeを一つだけ所有するUser         |
| `name`        | `VARCHAR(255)`      | 不可 | なし      | 店舗名                              |
| `description` | `TEXT`              | 不可 | なし      | 店舗説明                            |
| `level`       | `SMALLINT UNSIGNED` | 不可 | `1`       | pointsから算出した現在level         |
| `points`      | `INT UNSIGNED`      | 不可 | `0`       | 上限で切り捨てない累計店舗points    |
| `sync_status` | `VARCHAR(32)`       | 不可 | `offline` | `connected` / `syncing` / `offline` |
| `created_at`  | `TIMESTAMP`         | 可   | `NULL`    | 作成日時                            |
| `updated_at`  | `TIMESTAMP`         | 可   | `NULL`    | 更新日時                            |

### 制約とindex

- `PRIMARY KEY (store_id)`
- `UNIQUE INDEX stores_user_id_unique (user_id)`
- `INDEX stores_sync_status_index (sync_status)`
- `CONSTRAINT stores_user_id_foreign FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT`
- `CHECK (level BETWEEN 1 AND 5)`

### `points`と`level`

`points`がlevel計算の正本で、`level`は検索・表示用に同じStore行へ保存する導出値です。対応は
`0→Lv1`、`100→Lv2`、`300→Lv3`、`600→Lv4`、`1000→Lv5`とし、最大はLv5です。
最大Lv到達後もpointsは加算して保存し、`level=5`を維持します。

pointsを更新するtransactionでは、lock取得直後のpointsから`oldLevel`を、加算後のpointsから
`newLevel`を計算し、pointsと`newLevel`を同時に保存します。`oldLevel < newLevel`の場合だけ、その結果を
B-BUILD-03へ渡します。同じ`request_id`の再送、入力不正、競合、rollbackではlevel変更を発生させません。
1回の加算で複数境界を越えた場合のjob単位はB-CONTRACT-06を正本とします。

登録時は`points=0`、`level=1`です。既存Storeのpointsはbackfillや上限切り捨てをせず維持し、移行時に
全行のlevelをpointsから再計算します。不一致が見つかった場合はpointsを正としてlevelを修復します。
負数、少数、`NaN`、無限大は有効なpointsではなく、丸めて保存しません。

`nextLevelPoints`、`levelProgressPercent`、`maxLevel`、`isMaxLevel`は保存列にせず、`docs/api.md`の
共通規則でpointsから計算します。最大Lvでは順に`0`、`100`、`5`、`true`です。最大Lv以外の
進捗率は小数点以下を切り捨てるため、次の境界へ未到達のStoreは最大99%になります。

### points加算規則

| 初回成功操作 | 加算対象                          | 加算points | 上限                         |
| ------------ | --------------------------------- | ---------: | ---------------------------- |
| 新規出品     | Productのsellerが所有する店舗     |         10 | JSTの暦日ごとに先着3件、30pt |
| 購入成立     | buyerが所有する店舗               |         50 | 成立Transactionごと          |
| 販売成立     | Productのsellerが所有する販売店舗 |        100 | 成立Transactionごと          |

10 / 50 / 100はsourceや環境変数で変更しない契約値です。現行の`STORE_SALE_POINTS`は
移行前の互換設定であり、確定契約の100 pointsを上書きしません。累計pointsはLv5の閾値1,000へ
到達した後も加算します。`INT UNSIGNED`の範囲を超える加算はwrapさせず、操作全体をrollbackします。

既存ProductまたはTransactionを返す冪等再送ではpointsを再加算しません。入力不正、競合、自己購入、
売り切れ、所有店舗の欠落、またはtransaction失敗時も加算しません。Productをsoft deleteしても、
加算済みpointsは減算せず、そのProductが使用した日次枠も戻しません。過去のProductやTransactionへ
pointsをbackfillしません。

#### 出品の日次上限

追加のpoints台帳は作らず、Store行を同一店舗の出品mutexとして使います。新規出品は次を一つの
MySQL transactionで行います。

1. 出品者のStoreを`FOR UPDATE`し、Storeの所有者が認証済みuserと一致することを確認する。
2. `(user_id, listing_request_id)`を再確認する。既存Productがあれば現在値を返し、pointsを更新しない。
3. DB時刻を一度取得し、その値をProductの`created_at`にも使う。
4. その時刻が属する`Asia/Tokyo`の暦日をUTCの半開区間`[start, nextStart)`へ変換する。
5. 同じ`store_id`で`listing_request_id IS NOT NULL`かつ`created_at`が区間内のProduct数を数える。
   `deleted_at`や`status`では絞り込まない。移行前の`listing_request_id IS NULL`行は数えない。
6. Productを作成し、手順5の件数が3未満の場合だけ`points = points + 10`として`level`も再計算する。
7. Product作成とpoints更新を一緒にcommitする。途中で失敗した場合は両方をrollbackする。

Store行を先にlockするため、同じ店舗から異なる`requestId`で出品が同時実行されても直列化され、
commitに成功した先着3件だけが加算対象になります。購入処理はProductを先にlockするため、出品処理は
既存Productを`FOR UPDATE`せず、Store lock取得後の再確認とDB一意制約で同一requestの競合を解決します。

#### 購入成立時の2店舗更新

初回購入では、Productをlockして自己購入と`sold`を検証した後、buyerの`user_id`から購入者店舗を、
Productの`store_id`から販売店舗を確定します。二つのStore IDをUTF-8のbinary byte列で昇順に並べ、
同じ順番で1行ずつ`FOR UPDATE`します。両方のStoreをlockできた場合だけ、Productの`sold`化、
Transaction作成、購入者店舗への50 points、販売店舗への100 pointsと、両店舗の`level`再計算を行います。

対象Storeが存在しない、所有関係が一致しない、またはどれか一つでも更新に失敗した場合は購入全体を
rollbackします。すべての購入writerが同じStore lock順を使い、購入者と販売者が逆になる同時購入でも
deadlockを避けます。

## `products`

`status`が一点物の販売状態の正本です。新規商品は必ず`available`で作成し、購入成立時だけ`sold`へ
遷移します。`sold`から戻す状態遷移、予約、数量変更は定義しません。

| 列                            | 型                                                   | NULL | default     | 説明                                  |
| ----------------------------- | ---------------------------------------------------- | ---- | ----------- | ------------------------------------- |
| `product_id`                  | `VARCHAR(255)`                                       | 不可 | なし        | ProductのPK                           |
| `store_id`                    | `VARCHAR(255)`                                       | 不可 | なし        | 出品店舗                              |
| `user_id`                     | `VARCHAR(255)`                                       | 不可 | なし        | 出品者                                |
| `name`                        | `VARCHAR(255)`                                       | 不可 | なし        | API入力は1〜120文字                   |
| `description`                 | `TEXT`                                               | 不可 | なし        | API入力は1〜2,000文字                 |
| `price`                       | `INT UNSIGNED`                                       | 不可 | なし        | 1〜99,999,999円                       |
| `status`                      | `VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin`  | 不可 | `available` | `available` / `sold`                  |
| `category`                    | `VARCHAR(32)`                                        | 不可 | なし        | APIのallowlist値                      |
| `theme`                       | `VARCHAR(32)`                                        | 不可 | なし        | APIのallowlist値                      |
| `emoji`                       | `VARCHAR(32)`                                        | 不可 | なし        | API入力は1〜16 code point             |
| `listing_request_id`          | `VARCHAR(101) CHARACTER SET ascii COLLATE ascii_bin` | 可   | `NULL`      | 出品の冪等key。NULLは移行前の商品だけ |
| `listing_request_fingerprint` | `VARCHAR(65) CHARACTER SET ascii COLLATE ascii_bin`  | 可   | `NULL`      | 正規化した出品内容のSHA-256           |
| `deleted_at`                  | `TIMESTAMP(6)`                                       | 可   | `NULL`      | soft delete時刻                       |
| `created_at`                  | `TIMESTAMP`                                          | 可   | `NULL`      | 現行互換の作成日時                    |
| `updated_at`                  | `TIMESTAMP`                                          | 可   | `NULL`      | 現行互換の更新日時                    |

最終schemaでは物理`stock`列を持ちません。段階移行中だけ旧serviceとの互換用に残す場合も、
`available=1`、`sold=0`以外を保存してはいけません。APIのProduct JSONには移行開始時点から
`stock`を返さず、状態判定は`status`だけを使います。

### 制約とindex

- `PRIMARY KEY (product_id)`
- `UNIQUE (user_id, listing_request_id)`
- `UNIQUE (product_id, user_id)`。Transactionのseller整合を複合外部キーで保証するために使う
- `INDEX products_category_index (category)`
- `INDEX products_created_at_index (created_at)`
- `INDEX products_store_id_created_at_index (store_id, created_at)`
- `INDEX products_user_id_created_at_index (user_id, created_at)`
- `INDEX products_public_list_index (deleted_at, created_at)`
- `CONSTRAINT products_store_id_foreign FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE RESTRICT`
- `CONSTRAINT products_user_id_foreign FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT`
- `CHECK (BINARY status IN ('available','sold'))`
- `CHECK (price BETWEEN 1 AND 99999999)`
- `CHECK (BINARY category IN ('fashion','interior','hobby','accessory','tool'))`
- `CHECK (BINARY theme IN ('ocean','forest','amethyst','sunset','sand','moss'))`
- `CHECK (listing_request_id IS NULL OR listing_request_id REGEXP CONVERT(0x5c415b412d5a612d7a302d392e5f3a2d5d7b312c3130307d5c7a USING utf8mb4) COLLATE utf8mb4_0900_bin)`
  （hex値は絶対anchor付きの`\A[A-Za-z0-9._:-]{1,100}\z`）
- `CHECK (listing_request_fingerprint IS NULL OR listing_request_fingerprint REGEXP CONVERT(0x5c415b302d39612d665d7b36347d5c7a USING utf8mb4) COLLATE utf8mb4_0900_bin)`
  （hex値は絶対anchor付きの`\A[0-9a-f]{64}\z`）
- `CHECK ((listing_request_id IS NULL AND listing_request_fingerprint IS NULL) OR
(listing_request_id IS NOT NULL AND listing_request_fingerprint IS NOT NULL))`
- `CHECK (deleted_at IS NULL OR BINARY status = 'available')`。売却済み商品は削除できない

MySQLではUNIQUE列のNULLを複数許すため、既存商品は出品request IDを捏造せず両列NULLのまま保持
できます。新規出品ではapplicationが両列を必須にします。
`listing_request_id`の`VARCHAR(101)`と`listing_request_fingerprint`の`VARCHAR(65)`は、上限を増やす
ためではなく検証用の1文字分です。上限と同じ幅では非strict設定や末尾制御文字の扱いにより余分な
1文字がCHECK前に切り捨てられる可能性があるため、余分な1文字をDBへ到達させ、上記の完全一致CHECKで
必ず拒否します。applicationが受け付ける上限はそれぞれ100文字と64文字のままです。
regexはSQL文字列literalでなくhexから変換し、sessionの`NO_BACKSLASH_ESCAPES`設定にかかわらず
ICUへ同じbackslashと絶対anchorを渡します。patternにもbinary collationを明示し、fingerprintの
lowercase hex契約をcase-sensitiveに検査します。

### 出品fingerprint

`name`、`description`、`emoji`は現行validatorと同じUnicode whitespace trimを行い、Unicode NFCへ
正規化します。`category`と`theme`も同じtrimを行った後、case-sensitiveなallowlist値として検証します。
正規化後の文字列をProduct列へ保存し、APIにも同じ値を返します。`price`は整数として検証します。
検証後、次のキー順でobjectを作り、Node.jsの`JSON.stringify`結果をUTF-8化して、SHA-256のlowercase
hexを保存します。

```json
{
  "name": "鉱石モチーフのペンダント",
  "description": "青い鉱石をイメージした手作りペンダントです。",
  "price": 3200,
  "category": "accessory",
  "theme": "ocean",
  "emoji": "💎"
}
```

上のJSONのUTF-8 bytesに対するtest vectorは
`adcbef587d9dea01e55944817c427fe41328abc42edaa097ef3a8b7ceddfa4ce`です。

`requestId`、`sellerId`、`storeId`、`status`はfingerprintへ含めません。所有者と店舗はWeb
セッションから、初期状態はAPIから決まるためです。

同じ出品者が同じ`listing_request_id`を再送した場合は、保存済みfingerprintを比較します。

- 異なるfingerprint: 409 `REQUEST_ID_CONFLICT`
- 同じfingerprintかつ`deleted_at IS NOT NULL`: 復活・再作成せず409 `LISTING_REQUEST_RETIRED`
- 同じfingerprintかつ未削除: 既存Productを返し、行を追加しない。初回出品後に購入済みなら現在の
  `status='sold'`を返す

soft delete後も行と一意keyを保持するため、応答を失った古い出品requestが別商品を作ることは
ありません。公開一覧・詳細・購入は`deleted_at IS NULL`だけを対象にします。

検査と作成は同じtransactionで行います。同じ出品者・request ID・fingerprintの同時requestは、
一意制約でProductを1行だけ作り、作成した1requestだけを201、競合後に同じ行を読んだrequestを
すべて200にします。異なるfingerprintが競合した場合は、勝者だけを作成し、敗者を409
`REQUEST_ID_CONFLICT`にします。

認証ユーザーの所有店舗が存在しない場合は、Productを作らず409 `USER_STORE_NOT_READY`を返します。

## `purchase_transactions`

一点物につき最大1行をDB制約でも保証します。Transactionは購入成立時のproduct、buyer、seller、
source、価格のsnapshotであり、後から商品名や価格が変わっても書き換えません。

| 列               | 型                                                            | NULL | default | 説明                                  |
| ---------------- | ------------------------------------------------------------- | ---- | ------- | ------------------------------------- |
| `transaction_id` | `VARCHAR(255)`                                                | 不可 | なし    | TransactionのPK                       |
| `request_id`     | `VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | 不可 | なし    | Web/Minecraft共通の購入冪等key        |
| `product_id`     | `VARCHAR(255)`                                                | 不可 | なし    | 購入した一点物、unique                |
| `buyer_user_id`  | `VARCHAR(255)`                                                | 不可 | なし    | 認証主体から決めた購入者              |
| `seller_user_id` | `VARCHAR(255)`                                                | 不可 | なし    | lock後のProductから決めた販売者       |
| `source`         | `VARCHAR(32)`                                                 | 不可 | なし    | `web` / `minecraft`                   |
| `amount`         | `INT UNSIGNED`                                                | 不可 | なし    | lock後のProductから取得した成立時価格 |
| `status`         | `VARCHAR(32)`                                                 | 不可 | なし    | `paid` / `shipping` / `complete`      |
| `created_at`     | `TIMESTAMP`                                                   | 可   | `NULL`  | 現行互換の成立日時                    |
| `updated_at`     | `TIMESTAMP`                                                   | 可   | `NULL`  | 現行互換の更新日時                    |

### 制約とindex

- `PRIMARY KEY (transaction_id)`
- `UNIQUE (request_id)`
- 現行の`purchase_transactions_product_id_index`を`UNIQUE (product_id)`へ変更する
- `INDEX purchase_transactions_product_seller (product_id, seller_user_id)`
- `INDEX purchase_transactions_source_index (source)`
- `INDEX purchase_transactions_status_index (status)`
- `INDEX purchase_transactions_buyer_user_id_created_at_index (buyer_user_id, created_at)`
- `INDEX purchase_transactions_seller_user_id_created_at_index (seller_user_id, created_at)`
- `FOREIGN KEY (product_id, seller_user_id) REFERENCES products(product_id, user_id) ON DELETE RESTRICT`
- `CONSTRAINT purchase_transactions_buyer_user_id_foreign FOREIGN KEY (buyer_user_id) REFERENCES users(user_id) ON DELETE RESTRICT`
- `CONSTRAINT purchase_transactions_seller_user_id_foreign FOREIGN KEY (seller_user_id) REFERENCES users(user_id) ON DELETE RESTRICT`
- `CHECK (buyer_user_id <> seller_user_id)`
- `CHECK (BINARY source IN ('web','minecraft'))`
- `CHECK (BINARY status IN ('paid','shipping','complete'))`
- `CHECK (amount BETWEEN 1 AND 99999999)`

同じ`request_id`の同内容再送とは、既存行の`product_id`、`buyer_user_id`、`source`がすべて今回の
認証済み入力と一致することです。一致すれば既存Transactionを返します。一つでも違えば409
`REQUEST_ID_CONFLICT`とし、Product、Transaction、店舗pointsを変更しません。
初回の作成は201、同内容の再送は200で同じTransaction IDとimmutable fieldsを返します。配送状態が
後から変わった場合、再送時のTransaction `status`だけは現在値を返します。

DBの型は新規ID validationが全routeへ適用される前に作られた非ASCII・100文字超過のIDを変更せず
再生できるsupersetとして維持し、
新しい購入IDの`[A-Za-z0-9._:-]{1,100}`制約はAPIで保証します。受信値がこの形式外でも、既存行があり
同内容なら200、既存行があり内容が違えば409 `REQUEST_ID_CONFLICT`です。既存行がなければ422とし、
形式外のIDで新しいTransactionは作りません。このgrandfather規則でもtrimや大文字小文字変換はせず、
保存値を`utf8mb4_0900_bin`のNO PAD照合で比較します。末尾空白も値の一部として区別します。

## `available`から`sold`への購入transaction

購入serviceは次の処理を一つのMySQL transactionで行います。

1. `request_id`の既存Transactionを確認する。既存なら上記の同内容判定だけを行う。
2. Productを`FOR UPDATE`し、存在と`deleted_at IS NULL`を確認する。
3. lock待ちの間に同じrequestがcommitされた可能性があるため、`request_id`を再確認する。
4. Productのsellerと認証済みbuyerが同じなら422 `SELF_PURCHASE`を返す。
5. `status='available'`でなければ409 `OUT_OF_STOCK`を返す。
6. Productを`sold`へ更新する。
7. lock後のProductからsellerとpriceを取得し、Transactionを1行作る。
8. 同じtransaction内の後続処理がすべて成功した場合だけcommitする。

WebとMinecraftが別の`request_id`で同時購入しても、商品行lockと`UNIQUE (product_id)`により成功は
1件だけです。失敗・rollback時はProductを`available`のままにし、Transactionを残しません。
`OUT_OF_STOCK`は複数在庫時代からの互換codeとして維持し、一点物では「すでにsold」を表します。

## `stock`から`status`への移行

追加migrationはpreflight、expand、backfill、旧writer互換、verify、B-PRODUCT-CUTOVERの順に行います。
既存ID、価格、店舗・出品者参照、Transaction ID、`request_id`、buyer、seller、source、amount、status、
日時を削除・再採番・複製してはいけません。

### 1. preflight

migration開始前に、商品出品・削除とWeb / Minecraft購入を受ける全API processを停止します。
backfill、互換trigger追加、検証のcommitが完了するまで再開しません。その状態で最低限次を記録します。

実行ユーザーには対象schemaの`TRIGGER`権限が必要です。MySQLでbinary logが有効な標準運用では、
DB管理者が`log_bin_trust_function_creators=1`を有効にします。十分な管理権限を持つユーザーで直接
migrationを実行する場合は、この設定が0でもtriggerを作成できます。アプリ接続用ユーザーへ`SUPER`権限は
付与しません。ローカル開発では`npm run db:bootstrap`が管理接続で設定を行います。role、wildcard grant、
proxy userを含む実効権限を`information_schema`から正確に推測することはできないため、migrationは実際に
`CREATE TRIGGER`を実行して権限を確認します。失敗時はMySQLの1142（`TRIGGER`権限不足）と1419
（binary log制限）を区別して復旧方法を表示します。

- `stock=0`、`stock=1`、`stock>=2`の件数とProduct ID。`stock>=2`は変換監査用に旧数量も記録する
- ProductごとのTransaction件数
- Transactionありかつ`stock>0`の行
- 同じProductにTransactionが2件以上ある行
- Transactionの`seller_user_id`が参照先Productの`user_id`と異なる行
- 存在しないstore、seller、productを参照する行
- 1〜100文字の範囲外、または`[A-Za-z0-9._:-]`以外を含む購入`request_id`。grandfather再送テスト用の監査一覧
- buyerとsellerが同じTransaction、範囲外amount、`web` / `minecraft`以外のsource、
  `paid` / `shipping` / `complete`以外のTransaction status
- 範囲外price、allowlist外category / themeなど、目標CHECKに違反するProduct

移行で旧数量を上書きする前に、`product_status_migration_product_audit`へ全Productの
`product_id`、旧`stock`、関連Transaction ID、Transactionありかつ`stock>0`だったかを保存します。
最終形式外の購入request IDは`product_status_migration_request_audit`へTransaction ID、UTF-8値の
SHA-256、文字数、長さ・文字種の違反flagだけを保存します。request ID本体は既存Transactionに残るため
監査tableへ複製せず、個人情報と冪等keyの露出を最小化します。両監査tableに業務tableへの外部キーは
付けず、移行後に業務行が削除されても記録を保持します。監査行の保存とbackfillは同じDML transactionで
commitし、失敗時は両方をrollbackします。
長さflag `violates_current_length_limit`は空文字または101文字以上だけ、文字種flag
`contains_noncanonical_character`は長さと独立してallowlist外文字を含む場合だけを示します。
再実行時に非空のProductで`status`が全件設定済みなら、両監査tableと全行の完全な監査coverageを
preflightで必須にします。旧`stock`と関連Transactionから再計算した現在の`status` / `stock`まで一致しない
状態では、現在値から旧数量を推測せず中断します。Productが0件の場合と、全`status`がNULLで旧`stock`が
残る正常なexpand途中だけは、まだ監査tableがなくても後続の同一DML transactionで安全にcaptureできます。

同じProductにTransactionが2件以上ある場合は、どの購入を正とするか自動判定せずmigrationを中断
します。購入`request_id`以外の目標制約違反も、値を自動変更せず対象IDと違反理由を出力して変更前に
中断します。最終形式外の既存購入`request_id`は値を変えずに監査し、grandfather再送のfixtureへ含め、
移行の中断条件にはしません。`stock>=2`も中断条件ではなく、下記の確定規則で一点へ集約します。

### 2. expandとbackfill

1. nullableな`status`、`listing_request_id`、`listing_request_fingerprint`、`deleted_at`を追加する。
2. Productごとに次の優先順で`status`を設定する。
   - Transactionが1件ある: 現在の`stock`に関係なく`sold`
   - Transactionがなく`stock=0`: `sold`
   - Transactionがなく`stock=1`: `available`
   - Transactionがなく`stock>=2`: 同じProduct IDの`available`1点へ集約
3. `stock>=2`から商品行を複製せず、余剰数量を別ProductやTransactionへ変換しない。
4. 移行前Productの出品request列は両方NULLのままにし、架空のrequest IDを作らない。
5. 段階移行中に物理`stock`を残す場合は`sold=0`、`available=1`へ正規化する。

空DBの`migrate -> seed`でも同じ結果にするため、B-PRODUCT-01は一点物に関係する既存demo seedだけを
同じPRで更新します。ID、価格、`transaction-demo`は維持し、期待値を次へ固定します。

- `product-stool`: Transactionありなので`sold` / 互換`stock=0`
- `product-notebook`: 旧`stock=0`なので`sold` / 互換`stock=0`
- その他4商品: Transactionなし・旧`stock>=1`なので`available` / 互換`stock=1`
- 全Productの`listing_request_id` / `listing_request_fingerprint`: `NULL`

### 3. 旧writerとの互換期間

B-PRODUCT-01の後も、B-PRODUCT-04とB-BUY-01が完了するまでは旧serviceが`stock`だけを書きます。
backfill直後から`status`を正本にできるよう、B-PRODUCT-01のmigrationは書き込みを再開する前に一時的な
MySQL `BEFORE INSERT` / `BEFORE UPDATE` triggerを追加し、次を保証します。

- 現行HTTP出品APIは`stock=1`だけを受理する。`stock=0`や`stock>=2`を成功後に黙って丸めず、422で
  入力者へ返す。B-PRODUCT-04で数量field自体を廃止する
- 旧INSERTが`status`を省略した場合は、`stock=0`を`sold`、`stock>=1`を`available`へ変換し、物理
  `stock`もそれぞれ0 / 1へ正規化する。このtriggerはHTTP API以外の旧writerに対するDB安全網とする
- 旧UPDATEが`stock`だけを変更した場合は、同じ規則で`status`と`stock`を同期する
- 新writerは`status`と互換`stock`を必ず同時に書き、`available / 1`または`sold / 0`だけを指定する
- `status`と`stock`を矛盾した値へ変更するrequestはDB errorでrollbackする

同じmigrationで一時的な`BEFORE DELETE` triggerも追加し、`listing_request_id IS NOT NULL`の行を旧
serviceが物理DELETEしようとした場合は`SIGNAL SQLSTATE '45000'`で拒否します。移行前からある
`listing_request_id IS NULL`の行はこの安全策の対象外です。このtriggerは誤ったdeploy順でも出品request
のtombstoneを失わないための最後の防壁であり、通常運用ではB-PRODUCT-05のsoft deleteを使います。

B-PRODUCT-01でProduct serializerは`status`だけを公開しますが、移行中の`ProductRow`と作成・更新用の
内部TypeScript型にはdeprecatedな`stock`を残します。物理`stock`は現行どおり`NOT NULL`・defaultなし
でよく、新writerも値を省略しません。B-PRODUCT-04（#52）は新規出品を`status='available', stock=1`で
作成し、B-BUY-01（#53）は購入成立時に`status='sold', stock=0`へ更新します。互換triggerと物理`stock`、
deprecatedな内部fieldは、Dashboardなど最後のreader / writerが`status`へ移るまで残します。これにより
atomic Issueを順番にdeployしても、`status=available, stock=0`や新しい`stock>=2`を作りません。

本番への有効化順は、B-PRODUCT-01 → B-PRODUCT-02 / 03・B-BUY-01・B-DASHBOARD-PRODUCT-01・
B-MC-CATALOG-COMPAT-01 → B-PRODUCT-05 → B-PRODUCT-04です。置換前の
`GET /minecraft/catalog`はB-MC-CATALOG-COMPAT-01で同じ公開一覧filterへ接続し、全readerが
`deleted_at IS NULL`を扱ってからB-PRODUCT-05を有効化します。B-PRODUCT-04はB-PRODUCT-05の
soft deleteが本番で動作するまで有効化してはいけません。

B-PRODUCT-01では購入`request_id`を
`VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`へ変更し、UNIQUEとlookupの
case-sensitive・NO PAD比較を有効にします。この型を最終型とし、100文字への短縮、ASCII化、request ID
CHECKは行いません。WebとMinecraftの全writerは新規IDだけを未加工の値で
`[A-Za-z0-9._:-]{1,100}`へ制限し、既存形式外IDには上記grandfather規則を適用します。

### 4. verify

- 移行前後でProduct件数、Product ID、価格、Transaction件数・内容が一致する
- `status IS NULL`が0件
- TransactionがあるProductはすべて`sold`
- ProductごとのTransactionが0件または1件
- TransactionのsellerとProductのsellerが全件一致する
- 目標CHECKに違反するProduct / Transactionが0件。購入`request_id`はDB CHECK対象外
- 段階移行中に`stock`を残す場合、`available=1`、`sold=0`が全件で一致する
- 外部キー孤児が0件
- `product_status_migration_product_audit`が全移行前Productを旧`stock`・関連Transaction・anomaly flagと
  ともに保持し、`product_status_migration_request_audit`が最終形式外request IDのTransaction ID・hash・
  文字数・違反flagを漏れなく保持する

### 5. B-PRODUCT-CUTOVER

`status`のCHECK、出品冪等性の一意制約、`UNIQUE (purchase_transactions.product_id)`は、preflightと
backfillの検証後に有効にします。`status NOT NULL DEFAULT 'available'`、互換trigger / 物理`stock`と
deprecatedな内部fieldの削除は
[B-PRODUCT-CUTOVER (#93)](https://github.com/IH-Ggroup/minetenant-backend/issues/93)だけが行います。
2つの`product_status_migration_*_audit` tableは数量集約とgrandfather判定の追跡記録なので、cutoverや
通常の業務data削除に連動させません。保存期間を定めた別の監査data lifecycle Issueなしに削除しません。

B-PRODUCT-CUTOVERの前提は、B-PRODUCT-02〜05、B-BUY-01 / 02、B-MC-CATALOG-COMPAT-01、
B-MC-BUY-01の全reader / writerが本契約へ移行済みで、
[B-DASHBOARD-PRODUCT-01 (#92)](https://github.com/IH-Ggroup/minetenant-backend/issues/92)が集計を
`status`へ移行済みであることです。前提が一つでも未完了ならcutoverしません。

cutoverは次の停止手順を変えません。

1. 商品を読む・書くWeb / Minecraftを含む全API processを停止し、旧binaryのprocessが0であることを
   確認する。
2. `status IS NOT NULL`、`status / stock`対応、Transaction数、外部キー、全前提の完了をpreflightで
   再検証する。不一致があればDDLを始めず停止を維持する。
3. `status NOT NULL DEFAULT 'available'`を確定し、互換`BEFORE INSERT` / `BEFORE UPDATE` /
   `BEFORE DELETE` trigger、物理`stock`列の順に削除する。
4. `stock`を参照しないB-PRODUCT-CUTOVER版binaryをdeployする。旧binaryは再deploy・再起動しない。
5. schema、migration履歴、Product / Transaction件数、代表的なreadをpost-verifyしてから全APIを再開する。

途中のDDLまたはdeployが失敗した場合は、適用済みDDLをmigration履歴と実schemaで確認してfix-forwardし、
手順5まで旧binary・新binaryのどちらも再開しません。

同じmigrationを再実行した場合は、追加済みschemaと変換済みdataを検証して成功し、Productや
Transactionを増減させません。途中失敗はtransactional DMLをrollbackし、適用済みDDLは履歴を確認した
fix-forwardで再開します。

## Issue間の受け渡し

- B-AUTH-01〜12（#98〜#109）、B-AUTH-CUTOVER（#118）、B-AUTH-SESSION（#119）、
  B-DB-STRICT-MODE（#120）、B-AUTH-CONTRACT-CUTOVER（#121）: `users`節のexpand / cutover / contract順、決定的backfillと
  versioned catch-up、`users.user_id`参照、完成時制約を正本とする。Frontend
  F-AUTH-01（#94）の結合確認とusername確認導線が完了するまでemail / `name`互換を削除しない。
  #105 / #107、#108、#106のcode順を崩さず、#121で4 PRを一つのmaintenance releaseとして
  同時deployしてから#109へ進む
- B-PRODUCT-01（#49）: schema追加、既存data / 対象demo seed移行、一時互換trigger、Product型・serializer。
  変更で影響を受ける`tests-ts/api.test.ts`、`tests-ts/purchase-concurrency.test.ts`を含む全API・並行購入
  fixture / assertionも同じPRで更新する。このB-CONTRACT-01の受け渡しは、#49本文にある古い
  「触る場所」と必須テストの列挙を上書きする
- B-PRODUCT-02（#89）/ 03（#50）: `deleted_at IS NULL`の商品一覧・詳細。`available`と`sold`は両方公開
- B-PRODUCT-04（#52）: 未加工`requestId`を最終形式で検証し、数量なし、`available / stock=1`の
  dual-writeで冪等出品
- B-PRODUCT-05（#54）: 本人の`available`かつ取引なし商品だけをsoft delete。B-PRODUCT-02 / 03、
  B-BUY-01、B-DASHBOARD-PRODUCT-01、B-MC-CATALOG-COMPAT-01の本番反映後、B-PRODUCT-04より先に
  有効化する
- B-BUY-01（#53）: 共通購入serviceの`available / stock=1 -> sold / stock=0` dual-write
- B-BUY-02: 正規・互換Web購入routeの未加工`requestId`検証、既存形式外IDのgrandfather、最小入力、
  確定error code
- [B-DASHBOARD-PRODUCT-01 (#92)](https://github.com/IH-Ggroup/minetenant-backend/issues/92): Productは
  共通serializerの`status`を返し、集計も`status`へ移す
- [B-MC-CATALOG-COMPAT-01 (#94)](https://github.com/IH-Ggroup/minetenant-backend/issues/94): 置換前の
  `GET /minecraft/catalog`を共有公開filterへ接続し、soft delete済み商品を除外する
- B-CONTRACT-05 / B-MC-CATALOG-01: 認証・pathは別契約。共有Productは本契約の`status`を利用
- B-MC-BUY-01: Minecraft購入`requestId`を未加工の値で検証し、既存形式外IDには同じgrandfather規則を適用
- [B-PRODUCT-CUTOVER (#93)](https://github.com/IH-Ggroup/minetenant-backend/issues/93): 全前提の完了後
  だけ、互換trigger / `stock` / deprecatedな内部fieldを削除
