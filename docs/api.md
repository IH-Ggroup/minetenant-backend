# MineTenant API v1

開発URLは`http://localhost:8787`です。バックエンドはNode.js上のTypeScript / Honoで
動作し、MySQLへデータを保存します。JSONのキーはフロントのTypeScript型に合わせて
camelCaseで返します。

> **B-CONTRACT-01 / 02の読み方**
> 「現行から確定契約への変更」と「一点物Product」から「Web購入」までの各節は、
> B-PRODUCT / B-BUY / B-XP / B-BUILD Issueが実装する最終契約です。2026-09-19時点の`develop`
> (`da99a9f`)はまだ`stock`モデルで、店舗pointsも販売店舗だけへ加算するため、実装完了までは
> 動作と異なります。それ以外の認証、取引履歴、Fabric APIの認証・pathは現行実装の説明であり、
> このIssueでは契約を変更しません。ただし共有serializerが返すProductの形、店舗の成長表示、
> 出品・購入に伴う店舗pointsの加算規則は、どの対象endpointでも本契約へ統一します。

## 現行から確定契約への変更

| 対象           | 現行`develop`                                  | 確定契約                                                                |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Product        | `stock: number`                                | `status: "available" \| "sold"`。`stock`は返さない                      |
| 一覧・詳細     | `stock`を含み、売り切れも公開                  | `status`を含み、`available` / `sold`を公開。soft delete済みは除外       |
| 出品request    | 商品項目 + 必須`stock`。所有者・店舗も送信可能 | `requestId` + 数量なしの商品項目だけ。所有者・店舗・初期状態はAPIが確定 |
| 出品の再送     | 毎回別Productを作成                            | 同じ利用者・ID・内容は同じProduct。異なる内容は409                      |
| Web購入request | 2つのpathで`buyerId` / `source`も送信可能      | 正規pathは本文`requestId`だけ。互換pathは`productId` + `requestId`だけ  |
| 購入時の状態   | `stock`を1減らす                               | `available`から`sold`へ一度だけ変更                                     |
| 店舗points     | 販売店舗へ100 points                           | 出品店舗へ10、buyer店舗へ50、販売店舗へ100                              |
| 店舗level      | 境界と表示計算が実装に直書き                   | 境界、最大Lv、最大到達後、表示値、丸めを共通契約として固定              |

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
| GET    | `/users`                          | 必須           | 開発用ユーザー一覧、200 `data: User[]`                       |
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

### 新規登録

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

### ログイン・状態復元・ログアウト

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

使用例です。`Product`はこの文書の一点物Product型へ更新し、`SessionUser`と`Transaction`は
フロントの既存の型を使います。

```ts
await refreshCsrf();
const user = await api<SessionUser>('/auth/login', {
  method: 'POST',
  body: { email: 'demo@minetenant.jp', password: 'password' },
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
   登録画面は名前・メールアドレス・パスワード・確認用パスワードを送信します。
3. `DemoStoreProvider`はログイン状態をAPIから復元します。セッションCookieはブラウザが管理し、
   パスワードやトークンはlocalStorageへ保存しません。
4. 出品では保持した`requestId`と数量なしの商品情報を送信し、`sellerId`・`storeId`・`status`は
   API側で決定します。
5. 購入は`POST /products/{productId}/purchases`へ保持した`requestId`を送信します。
   `transaction.id`で完了画面へ進み、商品を再GETして販売状態を表示します。
6. マイページ・購入完了画面では`GET /transactions`から本人の取引を取得し、
   店舗管理では本人の店舗ダッシュボードを使います。クライアントから本人IDを指定しません。
7. 登録・ログインの422は入力欄に表示します。401時は認証状態をクリアし、
   419や通信失敗では操作を自動再送せず、ユーザーへ再操作を案内します。

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
