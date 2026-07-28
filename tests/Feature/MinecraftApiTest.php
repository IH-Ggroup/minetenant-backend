<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class MinecraftApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_catalog_exposes_the_shared_product_inventory(): void
    {
        $this->getJson('/api/v1/minecraft/catalog')
            ->assertOk()
            ->assertJsonCount(6, 'data')
            ->assertJsonPath('data.0.id', 'product-hoodie')
            ->assertJsonFragment([
                'id' => 'product-notebook',
                'stock' => 0,
            ])
            ->assertJsonStructure([
                'data' => [
                    '*' => [
                        'id',
                        'storeId',
                        'sellerId',
                        'name',
                        'price',
                        'stock',
                        'category',
                        'theme',
                        'emoji',
                    ],
                ],
            ]);
    }

    public function test_minecraft_purchase_uses_fixed_source_and_shared_inventory(): void
    {
        $this->postJson('/api/v1/minecraft/purchases', [
            'productId' => 'product-stool',
            'buyerId' => 'user-buyer',
            'requestId' => 'request-minecraft-purchase',
        ])->assertCreated()
            ->assertJsonPath('data.productId', 'product-stool')
            ->assertJsonPath('data.source', 'minecraft')
            ->assertJsonPath('data.status', 'paid');

        $this->assertDatabaseHas('products', [
            'id' => 'product-stool',
            'stock' => 1,
        ]);
        $this->assertDatabaseHas('stores', [
            'id' => 'store-mine',
            'points' => 520,
            'level' => 3,
        ]);
        $this->assertDatabaseHas('purchase_transactions', [
            'request_id' => 'request-minecraft-purchase',
            'source' => 'minecraft',
        ]);
    }

    public function test_minecraft_purchase_is_idempotent(): void
    {
        $payload = [
            'productId' => 'product-stool',
            'buyerId' => 'user-buyer',
            'requestId' => 'request-minecraft-idempotent',
        ];

        $firstTransactionId = $this
            ->postJson('/api/v1/minecraft/purchases', $payload)
            ->assertCreated()
            ->json('data.id');

        $this->postJson('/api/v1/minecraft/purchases', $payload)
            ->assertOk()
            ->assertJsonPath('data.id', $firstTransactionId);

        $this->assertDatabaseCount('purchase_transactions', 2);
        $this->assertDatabaseHas('products', [
            'id' => 'product-stool',
            'stock' => 1,
        ]);
        $this->assertDatabaseHas('stores', [
            'id' => 'store-mine',
            'points' => 520,
        ]);
    }

    public function test_minecraft_purchase_rejects_client_defined_source(): void
    {
        $this->postJson('/api/v1/minecraft/purchases', [
            'productId' => 'product-stool',
            'buyerId' => 'user-buyer',
            'requestId' => 'request-minecraft-source',
            'source' => 'web',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['source']);
    }

    public function test_minecraft_purchase_rejects_invalid_identifiers(): void
    {
        $this->postJson('/api/v1/minecraft/purchases', [
            'productId' => 'unknown-product',
            'buyerId' => 'unknown-user',
            'requestId' => '',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors([
                'productId',
                'buyerId',
                'requestId',
            ]);
    }
}
