<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class PurchaseApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_web_purchase_updates_shared_inventory_and_store_growth(): void
    {
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'buyerId' => 'user-buyer',
            'source' => 'web',
            'requestId' => 'request-web-purchase',
        ])->assertCreated()
            ->assertJsonPath('data.productId', 'product-stool')
            ->assertJsonPath('data.buyerId', 'user-buyer')
            ->assertJsonPath('data.sellerId', 'user-seller')
            ->assertJsonPath('data.source', 'web')
            ->assertJsonPath('data.amount', 4200)
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
            'request_id' => 'request-web-purchase',
            'source' => 'web',
            'amount' => 4200,
        ]);
    }

    public function test_same_request_is_idempotent(): void
    {
        $payload = [
            'buyerId' => 'user-buyer',
            'source' => 'web',
            'requestId' => 'request-idempotent',
        ];

        $firstTransactionId = $this
            ->postJson('/api/v1/products/product-stool/purchases', $payload)
            ->assertCreated()
            ->json('data.id');

        $this->postJson(
            '/api/v1/products/product-stool/purchases',
            $payload,
        )->assertOk()
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

    public function test_request_id_cannot_be_reused_for_another_purchase(): void
    {
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'buyerId' => 'user-buyer',
            'source' => 'web',
            'requestId' => 'request-conflict',
        ])->assertCreated();

        $this->postJson('/api/v1/products/product-hoodie/purchases', [
            'buyerId' => 'user-buyer',
            'source' => 'web',
            'requestId' => 'request-conflict',
        ])->assertConflict()
            ->assertJsonPath('code', 'REQUEST_ID_CONFLICT');

        $this->assertDatabaseHas('products', [
            'id' => 'product-hoodie',
            'stock' => 3,
        ]);
    }

    public function test_seller_cannot_purchase_their_own_product(): void
    {
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'buyerId' => 'user-seller',
            'source' => 'web',
            'requestId' => 'request-self-purchase',
        ])->assertUnprocessable()
            ->assertJsonPath('code', 'SELF_PURCHASE')
            ->assertJsonValidationErrors(['buyerId']);

        $this->assertDatabaseHas('products', [
            'id' => 'product-stool',
            'stock' => 2,
        ]);
    }

    public function test_sold_out_product_cannot_be_purchased(): void
    {
        $this->postJson('/api/v1/products/product-notebook/purchases', [
            'buyerId' => 'user-buyer',
            'source' => 'web',
            'requestId' => 'request-out-of-stock',
        ])->assertConflict()
            ->assertJsonPath('code', 'OUT_OF_STOCK');

        $this->assertDatabaseHas('products', [
            'id' => 'product-notebook',
            'stock' => 0,
        ]);
    }

    public function test_stock_never_becomes_negative(): void
    {
        $firstPayload = [
            'buyerId' => 'user-seller',
            'source' => 'web',
            'requestId' => 'request-last-stock',
        ];

        $this->postJson(
            '/api/v1/products/product-toolbag/purchases',
            $firstPayload,
        )->assertCreated();

        $this->postJson('/api/v1/products/product-toolbag/purchases', [
            ...$firstPayload,
            'requestId' => 'request-after-sold-out',
        ])->assertConflict()
            ->assertJsonPath('code', 'OUT_OF_STOCK');

        $this->assertDatabaseHas('products', [
            'id' => 'product-toolbag',
            'stock' => 0,
        ]);
        $this->assertDatabaseHas('stores', [
            'id' => 'store-yamada',
            'points' => 140,
            'level' => 2,
        ]);
    }

    public function test_purchase_can_raise_a_store_to_level_five(): void
    {
        $this->assertDatabaseHas('stores', [
            'id' => 'store-mine',
            'level' => 3,
        ]);

        Store::query()
            ->whereKey('store-mine')
            ->update([
                'points' => 950,
                'level' => 4,
            ]);

        $this->postJson('/api/v1/products/product-stool/purchases', [
            'buyerId' => 'user-buyer',
            'source' => 'web',
            'requestId' => 'request-level-five',
        ])->assertCreated();

        $this->assertDatabaseHas('stores', [
            'id' => 'store-mine',
            'points' => 1050,
            'level' => 5,
        ]);
    }

    public function test_purchase_request_rejects_invalid_input(): void
    {
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'buyerId' => 'unknown-user',
            'source' => 'unknown',
            'requestId' => '',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors([
                'buyerId',
                'source',
                'requestId',
            ]);
    }

    public function test_web_purchase_rejects_minecraft_source(): void
    {
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'buyerId' => 'user-buyer',
            'source' => 'minecraft',
            'requestId' => 'request-wrong-source',
        ])->assertUnprocessable()
            ->assertJsonValidationErrors(['source']);
    }
}
