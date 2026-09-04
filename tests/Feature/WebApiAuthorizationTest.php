<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class WebApiAuthorizationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
    }

    public function test_private_web_endpoints_require_login(): void
    {
        foreach ([
            '/api/v1/auth/me',
            '/api/v1/users',
            '/api/v1/transactions',
            '/api/v1/transactions/transaction-demo',
            '/api/v1/stores/store-mine/dashboard',
        ] as $url) {
            $this->getJson($url)->assertUnauthorized();
        }

        foreach ([
            '/api/v1/products',
            '/api/v1/purchases',
            '/api/v1/products/product-stool/purchases',
            '/api/v1/auth/logout',
        ] as $url) {
            $this->postJson($url)->assertUnauthorized();
        }

        $this->deleteJson('/api/v1/products/product-stool')->assertUnauthorized();
    }

    public function test_unauthenticated_api_requests_without_an_accept_header_return_json(): void
    {
        $this->get('/api/v1/auth/me')
            ->assertUnauthorized()
            ->assertHeader('Content-Type', 'application/json');
    }

    public function test_login_requires_a_valid_csrf_token_outside_the_test_bypass(): void
    {
        $this->app['env'] = 'local';
        $credentials = ['email' => 'demo@minetenant.jp', 'password' => 'password'];

        $this->postJson('/api/v1/auth/login', $credentials)->assertStatus(419);
        $this->withSession(['_token' => 'valid-csrf-token'])
            ->withHeader('X-CSRF-TOKEN', 'wrong-token')
            ->postJson('/api/v1/auth/login', $credentials)->assertStatus(419);
        $this->withSession(['_token' => 'valid-csrf-token'])
            ->withHeader('X-CSRF-TOKEN', 'valid-csrf-token')
            ->postJson('/api/v1/auth/login', $credentials)->assertOk();
    }

    public function test_login_attempts_are_rate_limited(): void
    {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->postJson('/api/v1/auth/login', [
                'email' => 'demo@minetenant.jp', 'password' => 'incorrect',
            ])->assertUnprocessable();
        }

        $this->postJson('/api/v1/auth/login', [
            'email' => 'demo@minetenant.jp', 'password' => 'incorrect',
        ])->assertStatus(429)->assertHeader('Retry-After');
    }

    public function test_auth_validation_rejects_non_string_email_without_server_error(): void
    {
        $this->postJson('/api/v1/auth/login', ['email' => ['invalid'], 'password' => 'password'])
            ->assertUnprocessable()->assertJsonValidationErrors('email');
    }

    public function test_product_listing_uses_the_logged_in_users_store_and_identity(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));

        $this->postJson('/api/v1/products', $this->productPayload())
            ->assertCreated()
            ->assertJsonPath('data.sellerId', 'user-buyer')
            ->assertJsonPath('data.storeId', 'store-yamada');
    }

    public function test_listing_cannot_impersonate_another_store_owner(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));

        $this->postJson('/api/v1/products', [
            ...$this->productPayload(),
            'sellerId' => 'user-seller',
            'storeId' => 'store-mine',
        ])->assertUnprocessable()->assertJsonValidationErrors('sellerId');

        $this->postJson('/api/v1/products', [
            ...$this->productPayload(),
            'storeId' => 'store-mine',
        ])->assertUnprocessable();

        $this->assertDatabaseCount('products', 6);
    }

    public function test_purchase_alias_uses_session_identity_and_is_idempotent_across_urls(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));
        $payload = ['productId' => 'product-stool', 'requestId' => 'web-alias-request'];

        $id = $this->postJson('/api/v1/purchases', $payload)
            ->assertCreated()
            ->assertJsonPath('data.buyerId', 'user-buyer')
            ->assertJsonPath('data.source', 'web')
            ->json('data.id');

        $this->postJson('/api/v1/purchases', $payload)
            ->assertOk()->assertJsonPath('data.id', $id);
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'requestId' => 'web-alias-request',
        ])->assertOk()->assertJsonPath('data.id', $id);

        $this->getJson('/api/v1/products/product-stool')->assertJsonPath('data.stock', 1);
        $this->assertDatabaseCount('purchase_transactions', 2);
    }

    public function test_purchase_cannot_forge_buyer_or_source(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));

        $this->postJson('/api/v1/purchases', [
            'productId' => 'product-stool',
            'requestId' => 'forged-purchase',
            'buyerId' => 'user-seller',
            'source' => 'minecraft',
        ])->assertUnprocessable()->assertJsonValidationErrors(['buyerId', 'source']);

        $this->assertDatabaseHas('products', ['id' => 'product-stool', 'stock' => 2]);
    }

    public function test_purchase_alias_validates_product_and_request_id(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));
        $this->postJson('/api/v1/purchases', [])
            ->assertUnprocessable()->assertJsonValidationErrors(['productId', 'requestId']);
        $this->postJson('/api/v1/purchases', [
            'productId' => 'missing', 'requestId' => 'missing-product',
        ])->assertUnprocessable()->assertJsonValidationErrors('productId');
        $this->postJson('/api/v1/products/product-stool/purchases', [
            'productId' => 'product-hoodie', 'requestId' => 'mismatched-product',
        ])->assertUnprocessable()->assertJsonValidationErrors('productId');
    }

    public function test_transactions_default_to_the_logged_in_user_and_reject_other_ids(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));
        $this->getJson('/api/v1/transactions')
            ->assertOk()->assertJsonCount(1, 'data');
        $this->getJson('/api/v1/transactions?userId=user-seller')
            ->assertUnprocessable()->assertJsonValidationErrors('userId');

        $other = User::factory()->create();
        $this->actingAs($other);
        $this->getJson('/api/v1/transactions')->assertOk()->assertJsonCount(0, 'data');
    }

    public function test_transaction_detail_is_only_visible_to_buyer_or_seller(): void
    {
        foreach (['user-buyer', 'user-seller'] as $userId) {
            $this->actingAs(User::query()->findOrFail($userId));
            $this->getJson('/api/v1/transactions/transaction-demo')
                ->assertOk()->assertJsonPath('data.id', 'transaction-demo');
        }

        $this->actingAs(User::factory()->create());
        $this->getJson('/api/v1/transactions/transaction-demo')->assertForbidden();
        $this->getJson('/api/v1/transactions/missing')->assertNotFound();
    }

    public function test_store_dashboard_is_only_visible_to_owner(): void
    {
        $this->actingAs(User::query()->findOrFail('user-buyer'));
        $this->getJson('/api/v1/stores/store-mine/dashboard')->assertForbidden();
        $this->getJson('/api/v1/stores/store-yamada/dashboard')->assertOk();
    }

    public function test_web_cors_allows_credentials_for_the_configured_frontend(): void
    {
        $this->withHeaders(['Origin' => 'http://localhost:5173'])
            ->get('/api/v1/auth/csrf-cookie')
            ->assertNoContent()
            ->assertHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
            ->assertHeader('Access-Control-Allow-Credentials', 'true');
    }

    private function productPayload(): array
    {
        return [
            'name' => 'Webからの出品',
            'description' => 'ログインしたユーザーが所有する店舗への出品。',
            'price' => 1500,
            'stock' => 2,
            'category' => 'hobby',
            'theme' => 'forest',
            'emoji' => '📦',
        ];
    }
}
