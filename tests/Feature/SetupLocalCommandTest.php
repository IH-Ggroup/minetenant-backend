<?php

namespace Tests\Feature;

use App\Models\Product;
use App\Models\User;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\TestCase;

class SetupLocalCommandTest extends TestCase
{
    use RefreshDatabase;

    public function test_setup_is_rejected_outside_local_environment(): void
    {
        $this->artisan('app:setup-local')->assertFailed();

        $this->assertDatabaseCount('users', 0);
    }

    public function test_empty_local_database_is_migrated_and_seeded(): void
    {
        $this->app['env'] = 'local';
        // テストから作業用 .env のキーを変更しないよう、設定済みの状態にします。
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32))]);

        $this->artisan('app:setup-local')->assertSuccessful();

        $this->assertDatabaseCount('users', 2);
        $this->assertDatabaseCount('products', 6);
    }

    public function test_repeated_setup_keeps_existing_data_and_key(): void
    {
        $this->app['env'] = 'local';
        $key = 'base64:'.base64_encode(str_repeat('a', 32));
        config(['app.key' => $key]);

        $this->artisan('app:setup-local')->assertSuccessful();
        Product::query()->whereKey('product-stool')->update(['stock' => 9]);
        User::query()->whereKey('user-buyer')->update(['name' => '変更済みの名前']);

        $this->artisan('app:setup-local')->assertSuccessful();

        $this->assertDatabaseHas('products', ['id' => 'product-stool', 'stock' => 9]);
        $this->assertDatabaseHas('users', ['id' => 'user-buyer', 'name' => '変更済みの名前']);
        $this->assertSame($key, config('app.key'));
    }

    public function test_setup_does_not_seed_a_database_with_existing_users(): void
    {
        $this->app['env'] = 'local';
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32))]);
        User::factory()->create(['name' => '開発メンバー']);

        $this->artisan('app:setup-local')->assertSuccessful();

        $this->assertDatabaseCount('users', 1);
        $this->assertDatabaseCount('products', 0);
    }

    public function test_failed_seed_is_rolled_back(): void
    {
        $this->app['env'] = 'local';
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32))]);
        $this->app->bind(DatabaseSeeder::class, fn () => new class extends DatabaseSeeder
        {
            public function run(): void
            {
                User::factory()->create();

                throw new RuntimeException('seedの途中失敗を再現');
            }
        });

        $this->artisan('app:setup-local')->assertFailed();

        $this->assertDatabaseCount('users', 0);
    }

    public function test_missing_app_key_line_does_not_report_success(): void
    {
        $this->app['env'] = 'local';
        config(['app.key' => null]);
        $directory = sys_get_temp_dir().'/minetenant-setup-'.bin2hex(random_bytes(8));
        mkdir($directory);
        file_put_contents($directory.'/.env', "APP_ENV=local\n");
        $this->app->useEnvironmentPath($directory);
        $this->app->loadEnvironmentFrom('.env');

        try {
            $this->artisan('app:setup-local')->assertFailed();
            $this->assertDatabaseCount('users', 0);
        } finally {
            unlink($directory.'/.env');
            rmdir($directory);
        }
    }
}
