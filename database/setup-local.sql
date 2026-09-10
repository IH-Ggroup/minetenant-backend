-- 自分のPCのMySQLに、管理ユーザーで一度だけ実行してください。
-- ローカル開発専用です。本番環境では使わないでください。
-- 既存テーブルの削除、既存ユーザーのパスワード変更は行いません。
CREATE DATABASE IF NOT EXISTS minetenant
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS minetenant_test
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS minetenant_hono_migration_test
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'minetenant'@'localhost' IDENTIFIED BY 'minetenant';
CREATE USER IF NOT EXISTS 'minetenant'@'127.0.0.1' IDENTIFIED BY 'minetenant';

GRANT ALL PRIVILEGES ON minetenant.* TO 'minetenant'@'localhost';
GRANT ALL PRIVILEGES ON minetenant_test.* TO 'minetenant'@'localhost';
GRANT ALL PRIVILEGES ON minetenant.* TO 'minetenant'@'127.0.0.1';
GRANT ALL PRIVILEGES ON minetenant_test.* TO 'minetenant'@'127.0.0.1';
GRANT ALL PRIVILEGES ON minetenant_hono_migration_test.* TO 'minetenant'@'localhost';
GRANT ALL PRIVILEGES ON minetenant_hono_migration_test.* TO 'minetenant'@'127.0.0.1';
