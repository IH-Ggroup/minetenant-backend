# MineTenant 一点物商品・購入 DB 契約

この文書は [B-CONTRACT-01](https://github.com/IH-Ggroup/minetenant-backend/issues/41) で確定した、
`products`と`purchase_transactions`だけの目標契約です。現行`develop`の実装説明ではなく、
B-PRODUCT / B-BUY Issueが実装するときの正本です。migration、route、service本体はこのIssueでは
変更しません。

APIのcamelCase、HTTP status、error codeは[`docs/api.md`](./api.md)を正本とし、この文書では
MySQLのsnake_case、制約、移行規則を固定します。ここにない経験値、Minecraft認証・連携、建築
ジョブの列やtableは、それぞれの契約Issueで決めます。

## 現行から目標への変更

| 対象               | 現行`develop`                 | 目標契約                                                      |
| ------------------ | ----------------------------- | ------------------------------------------------------------- |
| 商品の販売状態     | `products.stock INT UNSIGNED` | `products.status = available / sold`                          |
| 出品の冪等性       | なし                          | 出品者と`listing_request_id`を一意化し、内容fingerprintを保存 |
| 商品削除           | 未取引行を物理削除            | `deleted_at`によるsoft delete                                 |
| 一商品あたりの取引 | `product_id`は通常index       | `product_id`をUNIQUEにして最大1取引                           |
| 購入の冪等性       | `request_id`を一意化済み      | NO PAD比較の一意制約を維持。新規IDはAPIでASCII・100文字に制限 |
| 購入時の販売状態   | `stock < 1`判定後に1減算      | `available`をlockし、`sold`へ一度だけ遷移                     |

`users`、`stores`とその主キーは既存の`id`を維持します。`stores.owner_id`も改名しません。

## 決定理由

| 決定                                               | 理由                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| 数量ではなく`available / sold`                     | 一点物に`stock>=2`や再入荷という不可能な状態を残さないため                  |
| 出品keyを`(seller_id, listing_request_id)`で一意化 | 別ユーザーの操作を衝突させず、同じユーザーの重複出品だけを防ぐため          |
| 購入`request_id`をglobalに一意化                   | Web / Minecraftをまたぐ再送と誤ったID再利用を同じ規則で検出するため         |
| `purchase_transactions.product_id`を一意化         | applicationのlockに加え、DBでも一商品一取引を保証するため                   |
| 商品をsoft delete                                  | 物理削除後の再送で同じ出品requestから別Productが生まれるのを防ぐため        |
| `OUT_OF_STOCK`を維持                               | 既存クライアントの409分岐を壊さず、「すでにsold」の意味へ読み替えられるため |

## API error codeとの対応

| Status | code                      | DBを変更するか |
| ------ | ------------------------- | -------------- |
| 409    | `REQUEST_ID_CONFLICT`     | 変更しない     |
| 409    | `LISTING_REQUEST_RETIRED` | 変更しない     |
| 409    | `USER_STORE_NOT_READY`    | 変更しない     |
| 409    | `OUT_OF_STOCK`            | 変更しない     |
| 422    | `SELF_PURCHASE`           | 変更しない     |

HTTP responseの本文は[`docs/api.md`](./api.md)を正本とします。

## `products`

`status`が一点物の販売状態の正本です。新規商品は必ず`available`で作成し、購入成立時だけ`sold`へ
遷移します。`sold`から戻す状態遷移、予約、数量変更は定義しません。

| 列                            | 型                                                   | NULL | default     | 説明                                  |
| ----------------------------- | ---------------------------------------------------- | ---- | ----------- | ------------------------------------- |
| `id`                          | `VARCHAR(255)`                                       | 不可 | なし        | 既存互換のPK                          |
| `store_id`                    | `VARCHAR(255)`                                       | 不可 | なし        | 出品店舗                              |
| `seller_id`                   | `VARCHAR(255)`                                       | 不可 | なし        | 出品者                                |
| `name`                        | `VARCHAR(255)`                                       | 不可 | なし        | API入力は1〜120文字                   |
| `description`                 | `TEXT`                                               | 不可 | なし        | API入力は1〜2,000文字                 |
| `price`                       | `INT UNSIGNED`                                       | 不可 | なし        | 1〜99,999,999円                       |
| `status`                      | `VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin`  | 不可 | `available` | `available` / `sold`                  |
| `category`                    | `VARCHAR(32)`                                        | 不可 | なし        | APIのallowlist値                      |
| `theme`                       | `VARCHAR(32)`                                        | 不可 | なし        | APIのallowlist値                      |
| `emoji`                       | `VARCHAR(32)`                                        | 不可 | なし        | API入力は1〜16 code point             |
| `listing_request_id`          | `VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin` | 可   | `NULL`      | 出品の冪等key。NULLは移行前の商品だけ |
| `listing_request_fingerprint` | `CHAR(64) CHARACTER SET ascii COLLATE ascii_bin`     | 可   | `NULL`      | 正規化した出品内容のSHA-256           |
| `deleted_at`                  | `TIMESTAMP(6)`                                       | 可   | `NULL`      | soft delete時刻                       |
| `created_at`                  | `TIMESTAMP`                                          | 可   | `NULL`      | 現行互換の作成日時                    |
| `updated_at`                  | `TIMESTAMP`                                          | 可   | `NULL`      | 現行互換の更新日時                    |

最終schemaでは物理`stock`列を持ちません。段階移行中だけ旧serviceとの互換用に残す場合も、
`available=1`、`sold=0`以外を保存してはいけません。APIのProduct JSONには移行開始時点から
`stock`を返さず、状態判定は`status`だけを使います。

### 制約とindex

- `PRIMARY KEY (id)`
- `UNIQUE (seller_id, listing_request_id)`
- `UNIQUE (id, seller_id)`。Transactionのseller整合を複合外部キーで保証するために使う
- `INDEX products_category_index (category)`
- `INDEX products_created_at_index (created_at)`
- `INDEX products_store_id_created_at_index (store_id, created_at)`
- `INDEX products_seller_id_created_at_index (seller_id, created_at)`
- `INDEX products_public_list_index (deleted_at, created_at)`
- `FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE RESTRICT`
- `FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT`
- `CHECK (BINARY status IN ('available','sold'))`
- `CHECK (price BETWEEN 1 AND 99999999)`
- `CHECK (BINARY category IN ('fashion','interior','hobby','accessory','tool'))`
- `CHECK (BINARY theme IN ('ocean','forest','amethyst','sunset','sand','moss'))`
- `CHECK (listing_request_id IS NULL OR listing_request_id REGEXP '^[A-Za-z0-9._:-]{1,100}$')`
- `CHECK (listing_request_fingerprint IS NULL OR listing_request_fingerprint REGEXP '^[0-9a-f]{64}$')`
- `CHECK ((listing_request_id IS NULL AND listing_request_fingerprint IS NULL) OR
(listing_request_id IS NOT NULL AND listing_request_fingerprint IS NOT NULL))`
- `CHECK (deleted_at IS NULL OR BINARY status = 'available')`。売却済み商品は削除できない

MySQLではUNIQUE列のNULLを複数許すため、既存商品は出品request IDを捏造せず両列NULLのまま保持
できます。新規出品ではapplicationが両列を必須にします。

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

| 列           | 型                                                            | NULL | default | 説明                                  |
| ------------ | ------------------------------------------------------------- | ---- | ------- | ------------------------------------- |
| `id`         | `VARCHAR(255)`                                                | 不可 | なし    | 既存互換のPK                          |
| `request_id` | `VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` | 不可 | なし    | Web/Minecraft共通の購入冪等key        |
| `product_id` | `VARCHAR(255)`                                                | 不可 | なし    | 購入した一点物、unique                |
| `buyer_id`   | `VARCHAR(255)`                                                | 不可 | なし    | 認証主体から決めた購入者              |
| `seller_id`  | `VARCHAR(255)`                                                | 不可 | なし    | lock後のProductから決めた販売者       |
| `source`     | `VARCHAR(32)`                                                 | 不可 | なし    | `web` / `minecraft`                   |
| `amount`     | `INT UNSIGNED`                                                | 不可 | なし    | lock後のProductから取得した成立時価格 |
| `status`     | `VARCHAR(32)`                                                 | 不可 | なし    | `paid` / `shipping` / `complete`      |
| `created_at` | `TIMESTAMP`                                                   | 可   | `NULL`  | 現行互換の成立日時                    |
| `updated_at` | `TIMESTAMP`                                                   | 可   | `NULL`  | 現行互換の更新日時                    |

### 制約とindex

- `PRIMARY KEY (id)`
- `UNIQUE (request_id)`
- 現行の`purchase_transactions_product_id_index`を`UNIQUE (product_id)`へ変更する
- `INDEX purchase_transactions_product_seller (product_id, seller_id)`
- `INDEX purchase_transactions_source_index (source)`
- `INDEX purchase_transactions_status_index (status)`
- `INDEX purchase_transactions_buyer_id_created_at_index (buyer_id, created_at)`
- `INDEX purchase_transactions_seller_id_created_at_index (seller_id, created_at)`
- `FOREIGN KEY (product_id, seller_id) REFERENCES products(id, seller_id) ON DELETE RESTRICT`
- `FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE RESTRICT`
- `FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE RESTRICT`
- `CHECK (buyer_id <> seller_id)`
- `CHECK (BINARY source IN ('web','minecraft'))`
- `CHECK (BINARY status IN ('paid','shipping','complete'))`
- `CHECK (amount BETWEEN 1 AND 99999999)`

同じ`request_id`の同内容再送とは、既存行の`product_id`、`buyer_id`、`source`がすべて今回の
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

- `stock=0`、`stock=1`、`stock>=2`の件数とProduct ID。`stock>=2`は変換監査用に旧数量も記録する
- ProductごとのTransaction件数
- Transactionありかつ`stock>0`の行
- 同じProductにTransactionが2件以上ある行
- Transactionの`seller_id`が参照先Productの`seller_id`と異なる行
- 存在しないstore、seller、productを参照する行
- 100文字超過または`[A-Za-z0-9._:-]`以外を含む購入`request_id`。grandfather再送テスト用の監査一覧
- buyerとsellerが同じTransaction、範囲外amount、`web` / `minecraft`以外のsource、
  `paid` / `shipping` / `complete`以外のTransaction status
- 範囲外price、allowlist外category / themeなど、目標CHECKに違反するProduct

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

- 旧INSERTが`status`を省略した場合は、`stock=0`を`sold`、`stock>=1`を`available`へ変換し、物理
  `stock`もそれぞれ0 / 1へ正規化する
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

### 5. B-PRODUCT-CUTOVER

`status`のCHECK、出品冪等性の一意制約、`UNIQUE (purchase_transactions.product_id)`は、preflightと
backfillの検証後に有効にします。`status NOT NULL DEFAULT 'available'`、互換trigger / 物理`stock`と
deprecatedな内部fieldの削除は
[B-PRODUCT-CUTOVER (#93)](https://github.com/IH-Ggroup/minetenant-backend/issues/93)だけが行います。

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
