# MineTenant Backend — Hono / TypeScript

Node.js上のHono APIです。React・Minecraft MODが利用する
API、Cookie認証、在庫・購入処理を提供します。

## 最短セットアップ

Node.js 22.22.2以上とMySQL 8.0以上を用意します（CIではMySQL 8.4で検証します）。
ローカル起動にDockerは不要です。
Node.jsは[`.nvmrc`](.nvmrc)と`package.json`で同じ版を指定しています。

MySQLは`localhost`からTCP接続でき、DBとユーザーを作成できる管理ユーザーが必要です。
macOS・Windowsの通常の`root`（パスワードなしを含む）は初回プロンプトで利用できます。
Ubuntu・Debian等で`root`が`auth_socket`専用の場合は、TCP・パスワード認証できる管理ユーザーを用意し、
`MYSQL_ADMIN_USER`へ指定してください。

初回も2回目以降も、MySQLを起動してから実行するコマンドはこれだけです。

```bash
npm run dev
```

`npm run dev`の起動前処理は次を順に行います。

- 依存パッケージがない場合、または`package-lock.json`更新後だけ`npm ci`
- 未作成の場合だけ`.env.example`から`.env`を作成
- MySQLの起動状態と接続先を確認
- `npm run doctor`でDBと必須テーブルを診断
- DBまたは接続用ユーザーが未作成の場合だけ、安全な初期DB準備を開始
- 未適用のDB変更がある場合は、DB単位で直列化してversion順に1度だけ適用
- 初期準備後にもう一度doctorを通してからHonoを起動

初期DB準備が必要なときだけ、MySQL管理ユーザー（初期値は`root`）の
パスワード入力が表示されます。入力内容は画面や`.env`へ保存しません。その後、次をまとめて行います。

- 開発DB・テストDB・アプリ接続用ユーザーの作成
- 未作成テーブルの追加
- 空DBへのデモデータ投入

初回に作る`.env`には、このclone専用のランダムなDBユーザー名とパスワードを生成します。
そのため、PCに同名ユーザーが残っていても上書きせず、別cloneの接続も壊しません。
DB・テーブル・既存データは上書きせず、既存の`.env`がある場合は内容を一切変更しません。
登録済みmigrationで解消できない設定不一致やスキーマ不一致は、
勝手に修復せず診断を表示して停止します。

MySQLの管理ユーザーが`root`以外の場合は、実行前に`MYSQL_ADMIN_USER`を設定します。
CIなど対話入力できない環境だけ`MYSQL_ADMIN_PASSWORD`も設定できます。これらは`.env`へ保存しません。

MySQL本体のインストールやOSサービスの起動は自動化しません。MySQLが停止している場合は、
安全のためDB操作をせず、起動を案内して終了します。

### 既にDBを準備済みの場合

既存環境や更新取り込み後も`npm run dev`だけです。既存の`.env`を上書きせず、
接続・スキーマを診断し、未適用のmigrationをversion順に実行してから起動します。
空のDBにだけデモデータを入れます。

[疎通確認](http://localhost:8787/api/hello)が
`MineTenant API is running.`を返せば起動完了です。停止は`Ctrl+C`です。
APIは起動前にDB接続を確認するため、DBが未準備のまま見かけ上起動して
`/auth/me`だけ500になることはありません。

**8787番ポートが使用中の場合は、そのプロセスを止めてからHonoを起動してください。**
比較用に別ポートで起動する場合は`PORT=8788 npm run dev`を使えます。
Windows PowerShellでは`$env:PORT="8788"; npm run dev`です。

## 起動できないとき

最初に`npm run doctor`を実行してください。Node.js、MySQLの接続先・バージョン、DB、
必須テーブル・列・一意制約をパスワードを表示せず確認します。よくあるエラーは次のように対処できます。

| コード                         | 原因                                     | 対処                                                  |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| `ECONNREFUSED`                 | MySQL停止、またはhost・port違い          | MySQLを起動し、`.env`の`DB_HOST`・`DB_PORT`を確認     |
| `ER_ACCESS_DENIED_ERROR`       | 接続用ユーザー未作成、または認証情報違い | 初回は`npm run dev`が自動準備。既存`.env`は設定を確認 |
| `ER_BAD_DB_ERROR`              | `DB_DATABASE`のDBが未作成                | `npm run dev`がローカルDBを自動準備                   |
| `MINETENANT_MIGRATION_PENDING` | 履歴にないDB変更がコードに登録済み       | ローカルでは`npm run dev`がversion順に適用            |
| `MINETENANT_SCHEMA_INCOMPLETE` | 適用済み履歴に対して必須テーブルが不足   | DBをバックアップして履歴と実schemaを調査              |
| `MINETENANT_SCHEMA_MISMATCH`   | 適用済み履歴に対して列・一意制約が不足   | DBをバックアップして履歴と実schemaを調査              |

セットアップ、doctor、API起動はいずれも同じ診断を表示します。ドライバーの長いスタックトレースより先に、
エラーコード・接続先・次のコマンドを確認してください。

## フロントとの接続

フロント側の設定と通信処理は維持できます。

```env
VITE_API_BASE_URL=http://localhost:8787/api/v1
```

フロントは`http://localhost:5173`で開きます。
APIとブラウザで`localhost`と`127.0.0.1`を混在させないでください。

Cookie認証では`XSRF-TOKEN`、`X-XSRF-TOKEN`ヘッダー、
`credentials: 'include'`を使用します。
セッションはHono専用Cookieと`hono_sessions`へ保存します。
bcryptパスワード（`$2b$`・`$2y$`）を照合できます。

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
  db/migrations/  番号順に1度だけ適用するDB変更
  auth.ts         セッション・CSRF・試行制限
  routes/         認証、商品・店舗、購入・取引・Minecraft
  services/       商品保存・購入・店舗成長・集計
  domain/         型、JSON整形、入力検証、業務エラー
scripts/          初期準備・テーブル作成・空DB専用デモデータ
tests-ts/         実MySQLでのAPI・認証・並行購入テスト
```

## マイグレーションの追加

1. `src/db/migrations/` に、未使用のゼロ埋めversionを付けたファイルを追加します。
2. `preflight`で前提を確認し、`up`を再実行可能に作り、`verify`で完了状態を確認します。
3. 静的なmigration一覧と現行の必須schemaに追加します。v0要件と適用済みversionは変更しません。
4. 空DB、既存DB、2回実行、途中失敗からの再実行を実MySQLテストに追加します。
5. `npm run db:migrate` と検証コマンド一式を実行します。

runnerは`up`・`verify`・履歴記録の全体を1つのtransactionでは囲みません。
MySQLのDDLはステートメント単位で暗黙にcommitされるため、複数DDLをまたぐ自動rollbackや
`down`は行わず、DMLだけの原子性が必要な処理は`up`内の`db.transaction()`で囲みます。
`up`と`verify`の成功後だけversionを履歴へ記録し、失敗時は後続versionを実行しません。
共有環境でschemaを変更する場合は、実行前にAPIの書き込みを停めてDBをバックアップします。
失敗時は書き込みを停めたまま、エラー・DB状態・履歴を確認します。同じversionを
再実行可能なままfix-forwardし、`npm run db:migrate`を再実行してください。

## 検証

[database/setup-local.sql](database/setup-local.sql)は専用の
`minetenant_test`も準備します。`npm test`はこのDBだけを初期化します。

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
Cloudflare Workers + D1へのDB変更やデプロイは含みません。

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
Cookie転送を利用できます。Honoの起動には`npm start`または`npm run dev`を使ってください。

Minecraft専用APIは既存の未認証デモ仕様を維持し、公開モードでは遮断します。
決済・配送・画像アップロード・Minecraft認証の追加は含みません。
