# MineTenant API v1

開発URLは`http://localhost:8787`です。JSONのキーはフロントのTypeScript型に
合わせてcamelCaseで返します。

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
- Web認証: Laravel組み込みのCookieセッション（`web`ガード）
- WebのすべてのPOST・DELETEは、ログイン・登録も含めてCSRF検証の対象
- Minecraft専用APIは既存の未認証デモ仕様を維持。公開運用には対応していない
- メッセージ・チャットAPIは作らない

## Webエンドポイント一覧

ベースURLは`http://localhost:8787/api/v1`です。下表のパスを後ろにつなぎます。
ログイン必須のAPIにはセッションCookieが必要です。公開GETはログイン不要です。

| Method | パス | ログイン | 用途・正常時 |
| --- | --- | --- | --- |
| GET | `/auth/csrf-cookie` | 不要 | CSRF Cookie設定、204 |
| POST | `/auth/register` | 不要 | ユーザー・所有店舗作成とログイン、201 `data: User` |
| POST | `/auth/login` | 不要 | ログイン、200 `data: User` |
| GET | `/auth/me` | 必須 | 現在のユーザー、200 `data: User` |
| POST | `/auth/logout` | 必須 | セッション破棄、204 |
| GET | `/users` | 必須 | 開発用ユーザー一覧、200 `data: User[]` |
| GET | `/products` | 不要 | 商品一覧・検索・店舗絞り込み、200 `data: Product[]` |
| GET | `/products/{productId}` | 不要 | 商品詳細、200 `data: Product` |
| POST | `/products` | 必須 | 本人の店舗へ出品、201 `data: Product` |
| DELETE | `/products/{productId}` | 必須 | 本人の未取引商品の削除、204 |
| POST | `/purchases` | 必須 | 本文に商品IDを指定して購入、201または200 `data: Transaction` |
| POST | `/products/{productId}/purchases` | 必須 | URLに商品IDを指定して購入、201または200 `data: Transaction` |
| GET | `/stores/{storeId}` | 不要 | 公開店舗情報、200 `data: Store` |
| GET | `/stores/{storeId}/dashboard` | 所有者のみ | 店舗集計、200 `data: Dashboard` |
| GET | `/transactions` | 必須 | 本人の購入・販売履歴、200 `data: Transaction[]` |
| GET | `/transactions/{transactionId}` | 取引関係者のみ | 取引詳細、200 `data: Transaction` |

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
`201 Created`と`data: User`を返します。店舗はレベル1・0ポイント・`offline`から
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

## 商品一覧

```http
GET /api/v1/products
GET /api/v1/products?storeId=store-mine
GET /api/v1/products?keyword=%E6%9C%A8
GET /api/v1/products?storeId=store-mine&keyword=%E6%9C%A8
```

`keyword`は商品名・商品説明の部分一致検索です。前後の空白を除き、最大120文字、
空なら全件を返します。`%`と`_`も文字として検索します。`storeId`と併用できます。
結果は作成日時の新しい順で、売り切れ商品も含みます。

```json
{
  "data": [
    {
      "id": "product-stool",
      "storeId": "store-mine",
      "sellerId": "user-seller",
      "name": "森の木製スツール",
      "description": "天然木の表情を残して仕上げた小さなスツールです。",
      "price": 4200,
      "stock": 2,
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

## 商品出品

ログインとCSRFトークンが必要です。`sellerId`と`storeId`は省略でき、ログインした
本人とその所有店舗から補完します。送信する場合も本人・所有店舗との一致が必要で、
不一致は422です。

```http
POST /api/v1/products
Content-Type: application/json
```

```json
{
  "name": "鉱石モチーフのペンダント",
  "description": "青い鉱石をイメージした手作りペンダントです。",
  "price": 3200,
  "stock": 4,
  "category": "accessory",
  "theme": "ocean",
  "emoji": "💎"
}
```

成功時は`201 Created`で`{ "data": Product }`を返します。価格は1〜99,999,999の整数、
在庫は0〜99,999の整数、名前は120文字以内、説明は2,000文字以内です。
`category`は`fashion` / `interior` / `hobby` / `accessory` / `tool`、
`theme`は`ocean` / `forest` / `amethyst` / `sunset` / `sand` / `moss`です。

## 商品削除

```http
DELETE /api/v1/products/{productId}
```

ログインとCSRFトークンが必要です。商品の出品者本人だけが削除でき、他人なら403です。
一度でも取引された商品は履歴を保持するため409を返し、削除しません。
未取引商品の削除が成功した場合は204です。

## Web購入

ログインとCSRFトークンが必要です。`requestId`は購入操作を始めるときに一つ生成し、
その操作の結果が確定するまで保持してください。タイムアウトなどで結果が不明な場合も、
同じ購入の再送には同じ値を使います。新しいIDは別の購入として扱われます。

フロントのAPI関数に合わせ、商品IDを本文に渡す入口を用意しています。

```http
POST /api/v1/purchases
Content-Type: application/json
```

```json
{
  "productId": "product-stool",
  "requestId": "3cb3f539-01ee-4f38-8f85-f1f0862755e1"
}
```

従来のURLも同じ購入サービスへ接続します。この場合は本文の商品IDを省略できます。

```http
POST /api/v1/products/product-stool/purchases
Content-Type: application/json
```

```json
{
  "requestId": "3cb3f539-01ee-4f38-8f85-f1f0862755e1"
}
```

`buyerId`・`source`は省略可能で、本人・`web`に補完されます。明示する場合も
本人・`web`以外は422です。URLの商品IDと本文の商品IDの不一致も422です。
`requestId`は必須の100文字以内の文字列で、UUIDを推奨します。

初回成功は201、同じ購入内容・同じ`requestId`の再送成功は200で、在庫を再度減らさず
最初の取引を返します。同じIDを異なる購入へ使うと409です。在庫切れは409、
自己購入は422です。

```json
{
  "data": {
    "id": "transaction-example",
    "productId": "product-stool",
    "buyerId": "user-buyer",
    "sellerId": "user-seller",
    "source": "web",
    "amount": 4200,
    "status": "paid",
    "createdAt": "2026-09-04T02:00:00.000000Z"
  }
}
```

返るのは取引情報です。フロントの`{ ok, transactionId }`形式ではありません。
`data.id`が購入完了画面へ渡す取引IDです。最新の在庫は購入成功後に商品詳細を
もう一度GETして表示します。実際の決済・配送処理は行いません。

## 店舗

```http
GET /api/v1/stores/store-mine
GET /api/v1/stores/store-mine/dashboard
```

店舗情報は公開GETです。ダッシュボードはログイン済みの所有者だけが取得でき、
他人の店舗なら403です。

ダッシュボードでは、出品数、売り切れ数、販売数、売上、Web/Fabric別の購入数、
次のレベルまでのポイント、最近の取引を返します。

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
        "stock": 3,
        "category": "fashion",
        "theme": "ocean",
        "emoji": "🧥",
        "createdAt": "2026-07-18T09:00:00.000000Z"
      }
    ],
    "stats": {
      "productCount": 3,
      "availableProductCount": 2,
      "soldOutProductCount": 1,
      "totalStock": 5,
      "salesCount": 1,
      "salesAmount": 4200,
      "webSalesCount": 0,
      "minecraftSalesCount": 1,
      "nextLevelPoints": 180,
      "levelProgressPercent": 40
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
  errors?: Record<string, string[]>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly errors: Record<string, string[]>;

  constructor(
    status: number,
    message: string,
    errors: Record<string, string[]> = {},
  ) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

function csrfToken(): string | undefined {
  const cookie = document.cookie
    .split('; ')
    .find((item) => item.startsWith('XSRF-TOKEN='));
  return cookie ? decodeURIComponent(cookie.slice('XSRF-TOKEN='.length)) : undefined;
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
    if (!token) throw new Error('CSRF Cookieを取得できません。接続先を確認してください。');
    headers.set('X-XSRF-TOKEN', token);
  }
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return readResponse<T>(response);
}
```

使用例です。`SessionUser`・`Product`・`Transaction`はフロントの既存の型を使います。

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
  productId: 'product-stool',
  requestId: crypto.randomUUID(),
};
const transaction = await api<Transaction>('/purchases', {
  method: 'POST',
  body: pendingPurchase,
});
const product = await api<Product>(
  `/products/${encodeURIComponent(transaction.productId)}`,
);
// 完了画面のIDはtransaction.id、最新の在庫はproduct.stock。

await api<void>('/auth/logout', { method: 'POST' });
```

### 現在のフロントからの切り替え手順

1. `src/api/products.ts`の各関数を上のヘルパーへ接続する。APIレスポンス全体を
   `Product[]`などへキャストせず、`data`を取り出す。
2. 新規登録画面へ名前入力を追加し、`register(name, email, password)`として送る。
   現在の関数は`name`引数がないまま送信しようとしているため修正する。
3. `DemoStoreProvider`の仮ログインを、ログインAPI・`GET /auth/me`へ差し替える。
   セッションCookieはブラウザが管理する。ユーザー情報だけを画面の状態に持つ。
4. 商品一覧・詳細・店舗ページで各GETを使い、出品時はフォームの内容をPOSTする。
   `sellerId`と`storeId`は送らなくてよい。
5. 購入は`POST /purchases`へ`productId`と保持した`requestId`を送る。
   `transaction.id`で完了画面へ進み、商品を再GETして在庫を更新する。
6. マイページは`GET /transactions`、購入完了ページの再読み込みは
   `GET /transactions/{transactionId}`、店舗管理は本人の店舗ダッシュボードを使う。
7. 422の`errors`をフォームに表示し、403・409・419・通信失敗を成功表示にしない。
   汎用ヘルパーでPOST・DELETEを自動的に繰り返さない。

現在のフロント画面は仮データのContextを利用しています。このリポジトリの変更だけで
自動的にAPI接続へ切り替わるわけではなく、上記のフロント実装が別途必要です。

## Fabric商品一覧

以下のMinecraft専用APIは今回変更していません。Webのセッション認証・CSRF検証は
適用されず、開発用の未認証APIです。Web画面からはこちらを使わないでください。

```http
GET /api/v1/minecraft/catalog
```

Webと同じ共通在庫を、売り切れ商品も含めてFabric側へ返します。`stock`が`0`の
商品はFabric側で購入不可として表示してください。

## Fabric購入

```http
POST /api/v1/minecraft/purchases
Content-Type: application/json
```

```json
{
  "productId": "product-stool",
  "buyerId": "user-buyer",
  "requestId": "74e4951d-b909-4a9f-9db2-b1555b750b4f"
}
```

購入元はLaravel側で`minecraft`に固定します。Web購入と同じ`PurchaseService`を
通るため、同じ商品在庫・取引履歴・店舗ポイントが更新されます。
