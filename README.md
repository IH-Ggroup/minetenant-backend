# MineTenant Backend

**APIの一覧・入力項目・実行結果をブラウザで確認できます。**
起動後に [API一覧・動作確認](http://localhost:8787/docs/api) を開いてください。
追加のデスクトップアプリやサービス登録は不要です。
最初の使い方は [ブラウザでAPIを試す手順](docs/api-browser.md) にまとめています。

MineTenantのWebフロントとMinecraft Fabric MODから共通利用する、
Laravel製REST APIの開発土台です。

完成したバックエンドではなく、メンバーが機能を分担して肉付けするための
小さく動く基盤です。Web向けのセッション認証と、MineTenantの中心である
「共通在庫」「店舗育成」を実装しています。決済はデモ処理です。

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

- Webの新規登録・ログイン・ログアウト・ログイン状態取得API
- Cookieセッション認証、CSRF検証、所有者・取引関係者の確認
- 商品一覧・検索・詳細・出品・未取引商品の削除API
- 店舗情報・店舗ダッシュボードAPI
- ログイン必須の開発用ユーザー一覧API
- 本人の取引履歴・取引詳細API
- Web購入とFabric購入で共有する購入処理
- MySQLトランザクションと行ロックによる在庫保護
- リクエストIDによる購入の重複防止
- 売上時の店舗ポイント加算とレベル再計算
- Fabric MODから呼べる`GET /api/hello`
- フロント開発サーバー向けCORS設定
- フロントと同じ初期デモデータ
- Docker ComposeによるLaravel・MySQL開発環境

## 今回含めないもの

- メール認証・パスワード再設定・管理者向け権限管理
- 決済、配送、住所管理
- メッセージ・チャット機能
- 画像ファイルのアップロード
- WebSocket
- Fabric MODそのもののコード
- 本番環境向けインフラ

Webの出品者・購入者IDはログイン済みユーザーから決めます。新規登録時には
本人の店舗も作成します。Minecraft側の従来APIはデモ用ユーザーIDを受け取る
仕様を維持しています。

> [!WARNING]
> このリポジトリはローカル開発用の基盤です。Webの操作は認証で保護されていますが、
> Minecraftの購入APIは未認証のままで、IDを指定すれば購入処理を呼び出せます。
> インターネットへ公開しないでください。
> CORSはブラウザの通信元を制限する仕組みであり、認証の代わりにはなりません。

## セットアップ

基本の開発環境は次の3つです。

- PHP 8.4.1以上（現在のcomposer.lockの依存ライブラリに必要）
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

### ブラウザで一覧を見て実行する

ScrambleがLaravelのルート・入力ルールからOpenAPIを生成し、Scalarで表示します。
コードを更新した後は`composer install`を実行してAPIを再起動してください。

- 閲覧・実行画面: <http://localhost:8787/docs/api>
- OpenAPI JSON: <http://localhost:8787/docs/api.json>
- 初学者向け手順: [ブラウザでAPIを試す](docs/api-browser.md)

Web認証はCookieセッションです。この画面はCookie・CSRFヘッダーを自動送信するため、
「CSRF Cookieを準備する」→「ログインする」の順に実行すれば購入なども試せます。
外部のAPIプロキシは使わず、同じPCのAPIへ直接送信します。

ドキュメントの2つのURLは`APP_ENV=local`で利用できます。本番環境では403です。
表示には固定バージョンのScalarをCDNから読み込むため、初回はインターネット接続が必要です。
APIの実行先と試す内容は、そのPCの開発用DBです。

メンテナンス時には`php artisan scramble:export --path=storage/app/api.json`で仕様を確認できます。
API注釈はControllerとFormRequestに置き、ルート一覧との一致・認証・主要な型をテストします。
配列を包む`StoreDashboardResource`についてはScrambleの`JR001`警告が1件残りますが、
集計値の型は明示しており、生成されたスキーマをテストで確認しています。

### Webフロントから接続する手順

1. フロントの`.env.local`に`VITE_API_BASE_URL=http://localhost:8787/api/v1`を設定する。
2. 最初に`GET /api/v1/auth/csrf-cookie`を`credentials: 'include'`で呼ぶ。
3. Cookieの`XSRF-TOKEN`をURLデコードし、POST・DELETEの`X-XSRF-TOKEN`ヘッダーへ設定する。
4. `POST /auth/login`または`POST /auth/register`でログインし、以後も全リクエストに
   `credentials: 'include'`を指定する。トークンは書き込みのたびにCookieから読み直す。
5. 起動・再読み込み時に`GET /auth/me`を呼び、ログイン状態を復元する。

ベースURL以降の`/auth/login`などはすべて`/api/v1`配下です。通常のレスポンスは
`{ "data": ... }`なので、フロントでは`data`を取り出します。ログアウトと削除は
`204 No Content`のため、JSONとして読まないでください。

同じPCでのHTTP開発では、フロントを`http://localhost:5173`、APIを
`http://localhost:8787`にそろえてください。`localhost`と`127.0.0.1`を混在させると
Cookieを共有できません。CORSの許可元は`CORS_ALLOWED_ORIGINS`に設定します。
既定のサーバーはループバックに限定して起動するため、別のPCからは接続できません。

現在のフロントは`DemoStoreProvider`による仮データの画面です。このバックエンドの
変更だけではAPI接続へ切り替わりません。名前入力欄、Cookie/CSRF処理、`data`の
取り出し、購入ごとの`requestId`保持など、フロント側の変更が別途必要です。
[接続用fetchヘルパーと画面ごとの手順](docs/api.md#webフロントの接続例)を参照してください。

主な入口：

| Method | URL | 役割 |
| --- | --- | --- |
| GET | `/api/hello` | Fabric疎通確認 |
| GET | `/api/v1/auth/csrf-cookie` | CSRF Cookie初期化 |
| POST | `/api/v1/auth/register` | 新規登録・店舗作成・ログイン |
| POST | `/api/v1/auth/login` | ログイン |
| GET | `/api/v1/auth/me` | ログイン済みユーザー |
| POST | `/api/v1/auth/logout` | ログアウト |
| GET | `/api/v1/users` | ログイン必須の開発用ユーザー一覧 |
| GET | `/api/v1/products?keyword={検索語}` | 商品一覧・検索 |
| GET | `/api/v1/products/{id}` | 商品詳細 |
| POST | `/api/v1/products` | 商品出品 |
| DELETE | `/api/v1/products/{id}` | 本人の未取引商品を削除 |
| POST | `/api/v1/purchases` | Web購入（商品IDを本文に指定） |
| POST | `/api/v1/products/{id}/purchases` | Web購入 |
| GET | `/api/v1/stores/{id}` | 店舗情報 |
| GET | `/api/v1/stores/{id}/dashboard` | 所有者向け店舗集計 |
| GET | `/api/v1/transactions` | 本人の取引履歴 |
| GET | `/api/v1/transactions/{id}` | 関係する取引の詳細 |
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

ローカルデモ用のログイン情報：

| ユーザー | メールアドレス | パスワード |
| --- | --- | --- |
| 購入者 | `demo@minetenant.jp` | `password` |
| 出品者 | `seller@minetenant.jp` | `password` |

購入者も自分の店舗へ出品できます。商品`product-stool`を購入するデモでは、
出品者本人ではなく購入者アカウントでログインしてください。

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
2. Minecraft APIの認証方式とユーザー連携
3. 商品更新と画像アップロード
4. Fabric側の商品カタログ表示と購入コマンド
5. MySQLを使うCIテスト
6. 本番環境とシークレット管理

大きな機能を追加する前に、`docs/api.md`とフロントのTypeScript型を一緒に更新して
ください。
