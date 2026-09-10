> Hono移行前のLaravel版の記録です。現在の起動方法はルートのREADME.mdを参照してください。

# MineTenant Backend

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
- Dockerを使わないPHP・MySQLのローカル開発環境

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

### Cloudflare経由の一時公開デモ

通常の開発サーバーをそのままTunnelへつながないでください。一時公開には、
**専用のデモDB・別プロセス**と、フロント側Workerの同一オリジンAPIプロキシを使います。
デモDBには個人情報や実データを入れず、初期データの既知のパスワードは変更してください。

公開用プロセスには次の環境設定が必要です（通常の開発用`.env`とは分離します）。

```env
APP_ENV=production
APP_DEBUG=false
APP_URL=https://YOUR-FRONTEND.workers.dev
MINETENANT_PUBLIC_TUNNEL=true
MINETENANT_ORIGIN_TOKEN=32文字以上の十分にランダムな秘密値
SESSION_DRIVER=file
SESSION_SECURE_COOKIE=true
SESSION_HTTP_ONLY=true
SESSION_DOMAIN=null
SESSION_PATH=/
SESSION_SAME_SITE=lax
```

- `MINETENANT_ORIGIN_TOKEN`はフロントWorkerの**サーバー用Secret**と同じ値にし、
  Workerから`X-MineTenant-Origin-Token`ヘッダーで付けます。Git、ブラウザ、`VITE_*`には入れません。
- 公開モードでは、秘密値が未設定・32文字未満、または`APP_DEBUG=true`なら汎用JSONで503、
  秘密値のない通信は403です。Minecraft API、開発用ユーザー一覧、API以外のページは404です。
- Web APIに元々あるログイン・CSRF・所有者確認はそのまま有効です。
- Workerはブラウザ由来の秘密値ヘッダー・転送元IPヘッダーを引き継がず、
  `X-Forwarded-For`を検証済みのクライアントIP、`X-Forwarded-Proto`を`https`へ上書きしてください。
  Laravelは秘密値確認後に、loopbackから届くこの2種類の転送ヘッダーだけを信頼します。
- Laravelは`127.0.0.1`の専用ポートだけで待ち受けます。Tunnelの公開先はそのポート、
  またはAPIパスだけを渡すローカルプロキシに限定します。`public/`に秘密ファイルを置かないでください。
- フロントのビルド時に`VITE_API_BASE_URL=/api/v1`を設定し、WorkerがAPIをTunnelへ転送します。
  `Set-Cookie`は複数行を保持し、フロントのホストに保存されるよう`Domain`を付けません。

これは本番向けの運用・バックアップ・監視を備えた構成ではありません。
PC、MySQL、公開用Laravel、Tunnelを停止するとAPIも停止します。Quick Tunnelを再起動した場合は
公開先URLが変わるため、Workerの接続先も更新してください。

## セットアップ

Dockerは使いません。自分のPCに次の3つを用意します。

- **PHP 8.4.1以上（8.4系の最新パッチ推奨）**：`pdo_mysql`拡張も必要です。
- **Composer 2**
- **MySQL 8.4**：SQLiteやMariaDBではなくMySQLを使います。

Laravel自体はPHP 8.3対応ですが、このリポジトリの`composer.lock`にはPHP 8.4.1以上が
必要なライブラリが含まれます。`--ignore-platform-reqs`で回避しないでください。

まだ入れていない場合は、[Laravelのインストール案内](https://laravel.com/docs/13.x/installation)と
[MySQL 8.4のインストール案内](https://dev.mysql.com/doc/refman/8.4/en/installing.html)を参照してください。
PHPとComposerは[Laravel Herd](https://herd.laravel.com/)でも用意できます。
MySQLは別途インストールします（有料機能は必要ありません）。

### 初回だけ行うこと

**1. MySQLを起動して、開発用DBを用意する**

このリポジトリのフォルダで次を実行します。パスワードはMySQLインストール時に設定したものです。

```bash
mysql -u root -p
```

MySQLの画面になったら、以下を実行します。Windows・macOSで同じ手順です。

```sql
SOURCE database/setup-local.sql;
EXIT;
```

開発用`minetenant`とテスト用`minetenant_test`が作られます。
MySQL Workbenchなどを使う場合は、`database/setup-local.sql`を開いて実行しても構いません。
既存テーブル・既存ユーザーのパスワードは変更しません。

**2. Laravelをセットアップする**

```bash
composer run setup
```

依存パッケージ、`.env`、暗号化キー、テーブル、初期データを準備します。
既存の`.env`・暗号化キー・データは保持します。初期データの投入は、業務テーブルが空の場合だけです。
MySQLのポートやユーザーが異なる場合は、作成された`.env`の以下を直して再実行してください。

```env
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=minetenant
DB_USERNAME=minetenant
DB_PASSWORD=minetenant
```

ここに示すパスワードはローカル開発専用です。`.env`はGitへ含めません。
更新を取り込んだときも`composer run setup`で依存関係と未適用のマイグレーションを反映できます。

### 毎回の起動

1. PC上のMySQLを起動する（インストールしたMySQLの設定画面・サービスから起動）。
2. バックエンドのターミナルで以下を実行する。

   ```bash
   composer run dev
   ```

3. 別のターミナルで[minetenant-front](https://github.com/IH-Ggroup/minetenant-front)を開き、
   初回はREADMEのセットアップ後、`npm run dev`で起動する。
4. ブラウザで **<http://localhost:5173>** を開く。

APIは<http://localhost:8787>、疎通確認は<http://localhost:8787/api/hello>です。
ブラウザとAPIのホスト名はどちらも`localhost`にそろえます。`127.0.0.1`との混在は避けてください。
フロントの`.env.local`は`VITE_API_BASE_URL=http://localhost:8787/api/v1`にします。
フロント・APIはそれぞれのターミナルで`Ctrl+C`を押すと終了します。

### テスト・コード確認

```bash
composer test
composer lint
composer format
php artisan route:list --path=api
```

APIテストは起動済みMySQLの`minetenant_test`を使います。LaravelサーバーやDockerの起動は不要です。
接続情報の既定値は`phpunit.xml`にあります。MySQLのポート・ユーザーを変えた場合は、
テスト側の設定も合わせてください。テスト用DB名は必ず`_test`で終わる名前にします。
テストは専用DBを初期化するため、開発用DB名を指定しないでください。

> `php artisan migrate:fresh --seed`は既存テーブルを削除します。通常の起動・更新では使いません。
> `php artisan db:seed`だけでもサンプル商品の在庫などを上書きします。通常は`composer run setup`を使ってください。

### 困ったとき

| 表示・症状 | 確認すること |
| --- | --- |
| `php` / `composer`が見つからない | インストール後にターミナルを開き直し、`php -v` / `composer --version`を確認 |
| `could not find driver` | `php -m`に`pdo_mysql`があるか確認。PHPのMySQL拡張を有効にする |
| MySQLに接続できない / `Access denied` | MySQLの起動、DB作成、`.env`のポート・ユーザー・パスワードを確認 |
| 8787番ポートが使用中 | 以前起動したAPIがあれば、そのターミナルで終了する |
| 401 / 419 | Dockerの問題ではなく認証・CSRFを確認。下記「Webフロントから接続する手順」を参照 |

以前のコンテナ内データはPC上のMySQLへ自動では移りません。既存コンテナ・DBボリュームを
削除せず、必要なデータがある場合はエクスポート・インポートしてから切り替えてください。

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

フロントは共通APIクライアントを通じてCookie・CSRFに対応し、新規登録・ログイン・
ログアウト・ログイン状態復元を行います。商品出品・購入・取引履歴も同じセッションを使用します。
古い仮ログイン版を使っている場合は、フロントも最新mainへ更新してください。
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

1. メール認証・パスワード再設定
2. Minecraft APIの認証方式とユーザー連携
3. 商品更新と画像アップロード
4. Fabric側の商品カタログ表示と購入コマンド
5. MySQLを使うCIテスト
6. 本番環境とシークレット管理

大きな機能を追加する前に、`docs/api.md`とフロントのTypeScript型を一緒に更新して
ください。
