# MineTenant API v1

開発URLは`http://localhost:8787`です。JSONのキーはフロントのTypeScript型に
合わせてcamelCaseで返します。

## 共通仕様

- ID: 文字列
- 価格: 日本円の整数
- 日時: ISO 8601
- Content-Type: `application/json`
- 入力エラー: `422 Unprocessable Entity`
- データなし: `404 Not Found`
- 在庫切れ・重複など: `409 Conflict`
- 認証は未実装。デモ用ユーザーIDをリクエストへ明示する
- メッセージ・チャットAPIは作らない

## 疎通確認

```http
GET /api/hello
```

```text
MineTenant API is running.
```

既存Fabric MODの`/callapi`が利用する互換用エンドポイントです。

## 仮ユーザー

```http
GET /api/v1/users
```

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
```

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

認証導入前のため、`sellerId`と`storeId`を一時的に受け取ります。

```http
POST /api/v1/products
Content-Type: application/json
```

```json
{
  "sellerId": "user-seller",
  "storeId": "store-mine",
  "name": "鉱石モチーフのペンダント",
  "description": "青い鉱石をイメージした手作りペンダントです。",
  "price": 3200,
  "stock": 4,
  "category": "accessory",
  "theme": "ocean",
  "emoji": "💎"
}
```

成功時は`201 Created`で商品を返します。

## Web購入

`requestId`は購入ボタンを押した1回の操作につき一つ生成し、再送時は同じ値を
使用してください。

```http
POST /api/v1/products/product-stool/purchases
Content-Type: application/json
```

```json
{
  "buyerId": "user-buyer",
  "source": "web",
  "requestId": "3cb3f539-01ee-4f38-8f85-f1f0862755e1"
}
```

同じ`requestId`を再送した場合は、在庫を再度減らさず最初の取引を返します。

## 店舗

```http
GET /api/v1/stores/store-mine
GET /api/v1/stores/store-mine/dashboard
```

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
GET /api/v1/transactions?userId=user-buyer
```

購入者または出品者として関係する取引だけを返します。

## Fabric商品一覧

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
