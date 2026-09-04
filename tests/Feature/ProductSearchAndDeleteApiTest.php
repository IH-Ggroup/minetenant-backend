<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Product;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ProductSearchAndDeleteApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_guests_can_search_product_names_with_a_trimmed_keyword(): void
    {
        $this->getJson('/api/v1/products?'.http_build_query([
            'keyword' => '  スツール  ',
        ]))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'product-stool');
    }

    public function test_keyword_search_also_matches_product_descriptions(): void
    {
        $this->getJson('/api/v1/products?'.http_build_query([
            'keyword' => '暖色',
        ]))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'product-lamp');
    }

    public function test_empty_keywords_return_all_products_in_existing_order(): void
    {
        foreach (['', '   '] as $keyword) {
            $this->getJson('/api/v1/products?'.http_build_query([
                'keyword' => $keyword,
            ]))
                ->assertOk()
                ->assertJsonCount(6, 'data')
                ->assertJsonPath('data.0.id', 'product-hoodie');
        }
    }

    public function test_unmatched_keywords_return_an_empty_collection(): void
    {
        $this->getJson('/api/v1/products?keyword=unmatched-product')
            ->assertOk()
            ->assertExactJson(['data' => []]);
    }

    public function test_keyword_and_store_filters_are_combined(): void
    {
        $this->getJson('/api/v1/products?'.http_build_query([
            'keyword' => '森',
            'storeId' => 'store-mine',
        ]))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'product-stool');

        $this->getJson('/api/v1/products?'.http_build_query([
            'keyword' => '森',
            'storeId' => 'store-yamada',
        ]))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'product-lamp');
    }

    public function test_search_treats_wildcards_escape_characters_and_quotes_as_text(): void
    {
        $searches = [
            ['name' => '100% cotton', 'keyword' => '%'],
            ['name' => 'tool_bag', 'keyword' => '_'],
            ['name' => 'hello!', 'keyword' => '!'],
            ['name' => "O'Reilly book", 'keyword' => "O'Reilly"],
        ];

        foreach ($searches as $search) {
            $product = Product::factory()->create([
                'store_id' => 'store-mine',
                'seller_id' => 'user-seller',
                'name' => $search['name'],
                'description' => 'Literal search fixture.',
            ]);

            $this->getJson('/api/v1/products?'.http_build_query([
                'keyword' => $search['keyword'],
            ]))
                ->assertOk()
                ->assertJsonCount(1, 'data')
                ->assertJsonPath('data.0.id', $product->id);
        }
    }

    public function test_keyword_cannot_exceed_120_characters(): void
    {
        $this->getJson('/api/v1/products?'.http_build_query([
            'keyword' => str_repeat('あ', 121),
        ]))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('keyword');
    }

    public function test_keyword_must_be_a_string(): void
    {
        $this->getJson('/api/v1/products?keyword[]=stool')
            ->assertUnprocessable()
            ->assertJsonValidationErrors('keyword');
    }

    public function test_owner_can_delete_a_product_without_transactions(): void
    {
        $this->actingAs(User::query()->findOrFail('user-seller'), 'web')
            ->deleteJson('/api/v1/products/product-hoodie')
            ->assertNoContent();

        $this->assertDatabaseMissing('products', ['id' => 'product-hoodie']);

        $this->getJson('/api/v1/products/product-hoodie')->assertNotFound();
        $this->getJson('/api/v1/products')
            ->assertOk()
            ->assertJsonCount(5, 'data');
    }

    public function test_another_user_cannot_delete_a_product(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'), 'web')
            ->deleteJson('/api/v1/products/product-hoodie')
            ->assertForbidden();

        $this->assertDatabaseHas('products', ['id' => 'product-hoodie']);
    }

    public function test_guests_cannot_delete_products(): void
    {
        $this->deleteJson('/api/v1/products/product-hoodie')
            ->assertUnauthorized();

        $this->assertDatabaseHas('products', ['id' => 'product-hoodie']);
    }

    public function test_products_with_transactions_cannot_be_deleted_and_history_is_preserved(): void
    {
        $this->actingAs(User::query()->findOrFail('user-seller'), 'web')
            ->deleteJson('/api/v1/products/product-stool')
            ->assertConflict()
            ->assertJsonPath(
                'message',
                'Products with transaction history cannot be deleted.',
            );

        $this->assertDatabaseHas('products', [
            'id' => 'product-stool',
            'stock' => 2,
        ]);
        $this->assertDatabaseHas('purchase_transactions', [
            'id' => 'transaction-demo',
            'product_id' => 'product-stool',
            'buyer_id' => 'user-buyer',
            'seller_id' => 'user-seller',
            'amount' => 4200,
        ]);
        $this->assertDatabaseCount('purchase_transactions', 1);
        $this->assertDatabaseHas('stores', [
            'id' => 'store-mine',
            'points' => 420,
        ]);

        $this->getJson('/api/v1/products/product-stool')
            ->assertOk()
            ->assertJsonPath('data.name', '森の木製スツール');
    }

    public function test_deleting_an_unknown_product_returns_not_found(): void
    {
        $this->actingAs(User::query()->findOrFail('user-seller'), 'web')
            ->deleteJson('/api/v1/products/product-missing')
            ->assertNotFound();
    }
}
