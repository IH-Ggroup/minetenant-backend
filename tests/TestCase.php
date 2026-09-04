<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    public function createApplication()
    {
        $app = parent::createApplication();
        // DB_URLを指定した場合も、Laravelが解決した接続先で判定します（接続はまだ行いません）。
        $connection = $app['db']->connection();
        $database = $connection->getDatabaseName();

        // RefreshDatabase が開発用DBを初期化しないよう、テスト開始前に確認します。
        if ($connection->getDriverName() !== 'mysql' || ! is_string($database) || ! str_ends_with($database, '_test')) {
            throw new \RuntimeException('テストには末尾が _test の専用MySQLデータベースを指定してください。');
        }

        return $app;
    }
}
