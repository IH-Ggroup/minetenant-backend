<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ProductApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_products_returns_all_products_in_newest_first_order(): void
    {
        $this->getJson('/api/v1/products')
            ->assertOk()
            ->assertJsonCount(6, 'data')
            ->assertJsonPath('data.0.id', 'product-hoodie')
            ->assertJsonStructure([
                'data' => [
                    '*' => [
                        'id',
                        'storeId',
                        'sellerId',
                        'name',
                        'description',
                        'price',
                        'stock',
                        'category',
                        'theme',
                        'emoji',
                        'createdAt',
                    ],
                ],
            ]);
    }

    public function test_products_can_be_filtered_by_store(): void
    {
        $this->getJson('/api/v1/products?storeId=store-yamada')
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('data.0.id', 'product-pendant')
            ->assertJsonMissing([
                'storeId' => 'store-mine',
            ]);
    }

    public function test_product_show_returns_a_product(): void
    {
        $this->getJson('/api/v1/products/product-stool')
            ->assertOk()
            ->assertJsonPath('data.id', 'product-stool')
            ->assertJsonPath('data.storeId', 'store-mine')
            ->assertJsonPath('data.sellerId', 'user-seller')
            ->assertJsonPath('data.name', '森の木製スツール')
            ->assertJsonPath('data.price', 4200)
            ->assertJsonPath('data.stock', 2)
            ->assertJsonPath('data.category', 'interior')
            ->assertJsonPath('data.theme', 'forest');
    }

    public function test_product_show_returns_not_found_for_an_unknown_product(): void
    {
        $this->getJson('/api/v1/products/product-missing')
            ->assertNotFound()
            ->assertHeader('Content-Type', 'application/json');
    }

    public function test_product_can_be_created_for_the_store_owner(): void
    {
        $payload = [
            'storeId' => 'store-mine',
            'sellerId' => 'user-seller',
            'name' => 'テスト用ツールセット',
            'description' => 'APIの出品フローを確認するための商品です。',
            'price' => 2500,
            'stock' => 3,
            'category' => 'tool',
            'theme' => 'moss',
            'emoji' => '🧰',
        ];

        $response = $this->postJson('/api/v1/products', $payload);

        $response
            ->assertCreated()
            ->assertJsonPath('data.storeId', 'store-mine')
            ->assertJsonPath('data.sellerId', 'user-seller')
            ->assertJsonPath('data.name', 'テスト用ツールセット')
            ->assertJsonPath('data.price', 2500)
            ->assertJsonPath('data.stock', 3)
            ->assertJsonPath('data.category', 'tool')
            ->assertJsonPath('data.theme', 'moss');

        $this->assertDatabaseHas('products', [
            'id' => $response->json('data.id'),
            'store_id' => 'store-mine',
            'seller_id' => 'user-seller',
            'name' => 'テスト用ツールセット',
            'price' => 2500,
            'stock' => 3,
        ]);
    }

    public function test_product_create_rejects_invalid_fields(): void
    {
        $this->postJson('/api/v1/products', [
            'storeId' => '',
            'sellerId' => '',
            'name' => '',
            'description' => '',
            'price' => 0,
            'stock' => -1,
            'category' => 'unknown',
            'theme' => 'unknown',
            'emoji' => '',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors([
                'storeId',
                'sellerId',
                'name',
                'description',
                'price',
                'stock',
                'category',
                'theme',
                'emoji',
            ]);
    }

    public function test_product_create_rejects_a_seller_who_does_not_own_the_store(): void
    {
        $this->postJson('/api/v1/products', [
            'storeId' => 'store-mine',
            'sellerId' => 'user-buyer',
            'name' => '所有者不一致の商品',
            'description' => '店舗所有者ではないユーザーによる出品です。',
            'price' => 1500,
            'stock' => 1,
            'category' => 'hobby',
            'theme' => 'forest',
            'emoji' => '📦',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['sellerId']);

        $this->assertDatabaseMissing('products', [
            'name' => '所有者不一致の商品',
        ]);
    }
}
