CREATE DATABASE IF NOT EXISTS minetenant_test
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON minetenant_test.* TO 'minetenant'@'%';
