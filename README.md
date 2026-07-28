# MineTenant Backend

MineTenantのWebフロントとMinecraft Fabric MODから共通利用する、
Laravel製REST APIの開発土台です。

完成したバックエンドではなく、メンバーが機能を分担して肉付けするための
小さく動く基盤です。認証や決済を先に作り込まず、MineTenantの中心である
「共通在庫」と「店舗育成」の境界を先に揃えています。

## 採用技術

| 担当 | 技術 |
| --- | --- |
| Webフロント | Vite + React + TypeScript |
| API・DB | Laravel 13 + MySQL 8.4 |
| Minecraft | Fabric MOD |
| API通信 | HTTP / JSON |
| 自動テスト | PHPUnit + MySQLテストDB |

WebとFabricは別々の在庫を持たず、どちらもLaravelの購入サービスを呼びます。

## この基盤に含むもの

- 商品一覧・詳細・出品API
- 店舗情報・店舗ダッシュボードAPI
- ユーザー切り替え用の仮ユーザーAPI
- 取引履歴API
- Web購入とFabric購入で共有する購入処理
- MySQLトランザクションと行ロックによる在庫保護
- リクエストIDによる購入の重複防止
- 売上時の店舗ポイント加算とレベル再計算
- Fabric MODから呼べる`GET /api/hello`
- フロント開発サーバー向けCORS設定
- フロントと同じ初期デモデータ
- Docker ComposeによるLaravel・MySQL開発環境

## 今回含めないもの

- 本物のログイン認証・権限管理
- 決済、配送、住所管理
- メッセージ・チャット機能
- 画像ファイルのアップロード
- WebSocket
- Fabric MODそのもののコード
- 本番環境向けインフラ

認証導入までは、APIリクエストへ`buyerId`や`sellerId`を明示して動作を確認します。

> [!WARNING]
> このリポジトリはローカル開発用の基盤です。現時点では認証がなく、IDを指定すれば
> 出品・購入操作を呼び出せます。インターネットへ公開しないでください。
> CORSはブラウザの通信元を制限する仕組みであり、認証の代わりにはなりません。

## セットアップ

基本の開発環境は次の3つです。

- PHP 8.3以上
- Composer 2
- MySQL 8.4

MacではLaravel Herdを使うと、PHPとComposerをまとめて準備できます。

### PHP・MySQLをローカルで使う場合

MySQLの管理ユーザーで次を実行し、開発専用ユーザーと2つのデータベースを
作成します。ここで使う`minetenant`パスワードはローカル開発専用です。

```bash
mysql -u root -p <<'SQL'
CREATE DATABASE IF NOT EXISTS minetenant
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS minetenant_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'minetenant'@'localhost'
  IDENTIFIED BY 'minetenant';
CREATE USER IF NOT EXISTS 'minetenant'@'127.0.0.1'
  IDENTIFIED BY 'minetenant';
ALTER USER 'minetenant'@'localhost' IDENTIFIED BY 'minetenant';
ALTER USER 'minetenant'@'127.0.0.1' IDENTIFIED BY 'minetenant';

GRANT ALL PRIVILEGES ON minetenant.* TO 'minetenant'@'localhost';
GRANT ALL PRIVILEGES ON minetenant_test.* TO 'minetenant'@'localhost';
GRANT ALL PRIVILEGES ON minetenant.* TO 'minetenant'@'127.0.0.1';
GRANT ALL PRIVILEGES ON minetenant_test.* TO 'minetenant'@'127.0.0.1';
SQL
```

続いてLaravelをセットアップします。

```bash
composer install
cp .env.example .env
php artisan key:generate
php artisan migrate:fresh --seed
php artisan serve --host=127.0.0.1 --port=8787
```

`migrate:fresh`は対象データベースの既存テーブルを削除します。上記コマンドは
開発用の`minetenant`データベースだけに対して実行してください。

起動後のURL：

- API: <http://localhost:8787>
- 疎通確認: <http://localhost:8787/api/hello>
- Laravelヘルスチェック: <http://localhost:8787/up>
- MySQL: `127.0.0.1:3306`

## よく使うコマンド

```bash
composer test
composer lint
composer format
php artisan migrate:fresh --seed
php artisan route:list --path=api
```

`composer run dev`でも8787番ポートの開発サーバーを起動できます。

## Dockerを使う場合（任意）

ローカルへPHPやMySQLを入れたくないメンバー向けに、Docker Composeも任意で
用意しています。上のネイティブ手順ではDockerを使いません。

```bash
make setup
make up
```

Docker利用時のみ、MySQLはホストの`127.0.0.1:3307`でも確認できます。
終了は`make down`です。

## Fabric MODとの疎通

確認済みのFabric側コードは、次のURLへGETします。

```text
http://localhost:8787/api/hello
```

そのためLaravelを8787番ポートで起動すれば、MODの`/callapi`コマンドから
そのまま接続確認できます。レスポンスはシンプルなプレーンテキストです。

今後Fabricの商品一覧や購入操作を実装するときは、次のMinecraft専用入口を使います。

- `GET /api/v1/minecraft/catalog`
- `POST /api/v1/minecraft/purchases`

Minecraft専用Controllerも、購入処理自体はWebと同じ`PurchaseService`を呼びます。

## API

詳細とリクエスト例は[docs/api.md](docs/api.md)を参照してください。

主な入口：

| Method | URL | 役割 |
| --- | --- | --- |
| GET | `/api/hello` | Fabric疎通確認 |
| GET | `/api/v1/users` | 仮ユーザー一覧 |
| GET | `/api/v1/products` | 商品一覧 |
| GET | `/api/v1/products/{id}` | 商品詳細 |
| POST | `/api/v1/products` | 商品出品 |
| POST | `/api/v1/products/{id}/purchases` | Web購入 |
| GET | `/api/v1/stores/{id}` | 店舗情報 |
| GET | `/api/v1/stores/{id}/dashboard` | 店舗集計 |
| GET | `/api/v1/transactions?userId={id}` | 取引履歴 |
| GET | `/api/v1/minecraft/catalog` | Fabric向け商品一覧 |
| POST | `/api/v1/minecraft/purchases` | Fabric購入 |

## 初期データ

フロントのfixtureと対応するIDを使っています。

- 購入者: `user-buyer`
- 出品者: `user-seller`
- BLUE ORE STUDIO: `store-mine`
- YAMADA CRAFT: `store-yamada`
- 商品6件（うち1件は売り切れ）
- Minecraft購入履歴1件

## ディレクトリ

```text
app/
├── Enums/                 # APIとDBで共有する状態値
├── Exceptions/            # ドメイン上の失敗
├── Http/
│   ├── Controllers/Api/   # HTTPの入口
│   ├── Requests/          # 入力検証
│   └── Resources/         # フロントへ返すJSON
├── Models/                # Eloquentモデル
└── Services/              # 出品・購入・店舗育成などの処理
database/
├── migrations/            # MySQLのテーブル定義
└── seeders/               # フロントと対応するデモデータ
routes/api.php             # APIルート
tests/Feature/             # 重要フローのAPIテスト
```

Controllerへ業務処理を直接増やさず、複数画面やFabricから共通利用する処理は
`app/Services`へ置いてください。

## 購入処理のルール

購入は一つのDBトランザクション内で次を行います。

1. リクエストIDによる処理済み確認
2. 商品行を`lockForUpdate`
3. 在庫・自己購入を検証
4. 在庫を1減らす
5. 取引履歴を作る
6. 店舗へ100ポイント加算
7. 店舗レベルを再計算

途中で失敗した場合はすべてロールバックされます。価格や出品者IDはクライアントの
値を信用せず、DBの商品情報から決定します。

## 次に実装する候補

1. フロントの`DemoStoreProvider`をAPIクライアントへ差し替える
2. Laravel Sanctumによる認証と本人IDのサーバー決定
3. 商品更新・削除と画像アップロード
4. Fabric側の商品カタログ表示と購入コマンド
5. MySQLを使うCIテスト
6. 本番環境とシークレット管理

大きな機能を追加する前に、`docs/api.md`とフロントのTypeScript型を一緒に更新して
ください。
