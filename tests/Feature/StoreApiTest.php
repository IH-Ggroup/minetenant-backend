<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class StoreApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_store_show_returns_the_public_store_information(): void
    {
        $this->getJson('/api/v1/stores/store-mine')
            ->assertOk()
            ->assertJsonPath('data.id', 'store-mine')
            ->assertJsonPath('data.ownerId', 'user-seller')
            ->assertJsonPath('data.name', 'BLUE ORE STUDIO')
            ->assertJsonPath('data.level', 3)
            ->assertJsonPath('data.points', 420)
            ->assertJsonPath('data.syncStatus', 'connected');
    }

    public function test_store_dashboard_returns_inventory_and_sales_summary(): void
    {
        $this->getJson('/api/v1/stores/store-mine/dashboard')
            ->assertOk()
            ->assertJsonPath('data.store.id', 'store-mine')
            ->assertJsonCount(3, 'data.products')
            ->assertJsonPath('data.products.0.id', 'product-hoodie')
            ->assertJsonPath('data.stats.productCount', 3)
            ->assertJsonPath('data.stats.availableProductCount', 2)
            ->assertJsonPath('data.stats.soldOutProductCount', 1)
            ->assertJsonPath('data.stats.totalStock', 5)
            ->assertJsonPath('data.stats.salesCount', 1)
            ->assertJsonPath('data.stats.salesAmount', 4200)
            ->assertJsonPath('data.stats.webSalesCount', 0)
            ->assertJsonPath('data.stats.minecraftSalesCount', 1)
            ->assertJsonPath('data.stats.nextLevelPoints', 180)
            ->assertJsonPath('data.stats.levelProgressPercent', 40)
            ->assertJsonCount(1, 'data.recentTransactions')
            ->assertJsonPath(
                'data.recentTransactions.0.id',
                'transaction-demo',
            );
    }

    public function test_store_show_returns_not_found_for_an_unknown_store(): void
    {
        $this->getJson('/api/v1/stores/store-missing')
            ->assertNotFound()
            ->assertHeader('Content-Type', 'application/json');
    }
}
