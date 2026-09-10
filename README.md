# MineTenant Backend — Hono / TypeScript

Node.js上のHono APIです。既存MySQLと、React・Minecraft MODが利用する
APIのURL・JSON形式・認証・購入処理を引き継いでいます。

## 起動

Node.js 22.22.2以上とMySQL 8.4を用意します。PHP・ComposerはHonoの起動に不要です。

```bash
npm ci
npm run setup
npm run dev
```

`npm run setup`は未作成の場合だけ`.env`を作成し、未作成のテーブルを追加します。
空のDBにだけデモデータを入れ、**既存データやパスワードは上書きしません。**
Laravelで使用している`.env`の`DB_*`設定もそのまま利用できます。

MySQLを初めて用意する場合は、管理ユーザーで
[database/setup-local.sql](database/setup-local.sql)を実行してからセットアップします。
既存DBや既存ユーザーのパスワードは初期化しません。

[疎通確認](http://localhost:8787/api/hello)が
`MineTenant API is running.`を返せば起動完了です。停止は`Ctrl+C`です。

**8787番ポートでLaravelが起動中の場合は、そのプロセスを止めてからHonoを起動してください。**
比較用に別ポートで起動する場合は`PORT=8788 npm run dev`を使えます。
Windows PowerShellでは`$env:PORT="8788"; npm run dev`です。

## フロントとの接続

フロント側の設定と通信処理は維持できます。

```env
VITE_API_BASE_URL=http://localhost:8787/api/v1
```

フロントは`http://localhost:5173`で開きます。
APIとブラウザで`localhost`と`127.0.0.1`を混在させないでください。

Cookie認証、`XSRF-TOKEN`、`X-XSRF-TOKEN`ヘッダー、
`credentials: 'include'`は従来と同じです。
**切り替え後は一度ログインし直してください。**
Laravelの暗号化セッションは移さず、Hono専用Cookieと`hono_sessions`を使用します。
既存のbcryptパスワード（`$2y$`）はそのまま照合できます。

空DBの初期アカウントは`demo@minetenant.jp`、`seller@minetenant.jp`、
パスワードは双方`password`です。ローカル開発専用です。

[API仕様](docs/api.md)に全エンドポイントを記載しています。

## 維持する処理

- 商品一覧・検索・店舗絞り込み・詳細・出品・未取引商品の削除
- 登録時のユーザー／店舗作成、ログイン・ログアウト・セッション復元
- Cookie／CSRF検証、ログイン試行制限、所有者／取引関係者の確認
- WebとMinecraftの共通在庫、購入履歴、購入後の店舗ポイント／レベル更新
- `requestId`による再送の重複防止と別購入への再使用の拒否
- 在庫減少・取引作成・店舗成長を一つのMySQLトランザクションで更新
- 公開デモ用の秘密値確認、Minecraft API等の公開経路での遮断

ORMや汎用Repository層は追加せず、`mysql2`のパラメーター付きSQLと
小さなServiceで構成しています。購入は行ロックで保護し、
デッドロック時は最大3回までやり直します。

## 構成

```text
src/
  app.ts          Honoルート・CORS・公開経路の保護
  server.ts       Node.jsの起動と終了
  config.ts       環境設定
  db.ts           MySQL接続とトランザクション
  auth.ts         セッション・CSRF・試行制限
  routes/         認証、商品・店舗、購入・取引・Minecraft
  services/       商品保存・購入・店舗成長・集計
  domain/         型、JSON整形、入力検証、業務エラー
scripts/          初期準備・テーブル作成・空DB専用デモデータ
tests-ts/         実MySQLでのAPI・認証・並行購入テスト
```

既存PHPソース・PHPテストは移行の照合用に保持しています。
`npm`の起動・ビルド・テストからは使用しません。
以前の手順は[Laravel版の記録](docs/laravel-reference.md)に分離しています。

## 検証

[database/setup-local.sql](database/setup-local.sql)は専用の
`minetenant_hono_migration_test`も準備します。`npm test`はこのDBだけを初期化します。

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

別のMySQLで検証するときは`TEST_DB_HOST`・`TEST_DB_PORT`・
`TEST_DB_USERNAME`・`TEST_DB_PASSWORD`を指定します。
開発用`DB_*`からテストDB名は引き継ぎません。

ビルド後は`npm start`で起動します。
テーブルを準備するだけなら`npm run db:migrate`を使います。
デモデータは`APP_ENV=local`の空DBでのみ`npm run db:seed`で追加できます。

## 公開デモとCloudflare

今回の実行環境は**Hono + Node.js + 既存MySQL**です。
Cloudflare Workers + D1へのDB移行やデプロイは含みません。

既存フロントWorkerのAPI転送と互換の保護をHono側にも実装しています。
利用時は以下を設定し、Honoをループバックの専用ポートで起動します。

```env
APP_ENV=production
APP_DEBUG=false
APP_URL=https://YOUR-FRONTEND.workers.dev
MINETENANT_PUBLIC_TUNNEL=true
MINETENANT_ORIGIN_TOKEN=32文字以上のランダムな秘密値
SESSION_SECURE_COOKIE=true
SESSION_DOMAIN=null
SESSION_SAME_SITE=lax
```

Workerは同じ秘密値を`X-MineTenant-Origin-Token`で送信します。
検証済みクライアントIPは`X-MineTenant-Client-IP`で送信し、
Honoは秘密値確認後のループバック経由でのみこの値を信用します。
Cookie転送はそのまま使用できますが、
**既存のPHP起動用デモスクリプトはHonoを起動しません。**
Honoの起動には`npm start`または`npm run dev`を使ってください。

Minecraft専用APIは既存の未認証デモ仕様を維持し、公開モードでは遮断します。
決済・配送・画像アップロード・Minecraft認証の追加は含みません。
