<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class TransactionApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_buyer_can_get_related_transactions(): void
    {
        $this->getJson('/api/v1/transactions?userId=user-buyer')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'transaction-demo')
            ->assertJsonPath('data.0.buyerId', 'user-buyer')
            ->assertJsonPath('data.0.source', 'minecraft');
    }

    public function test_seller_can_get_related_transactions(): void
    {
        $this->getJson('/api/v1/transactions?userId=user-seller')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', 'transaction-demo')
            ->assertJsonPath('data.0.sellerId', 'user-seller');
    }

    public function test_transactions_require_an_existing_user(): void
    {
        $this->getJson('/api/v1/transactions?userId=user-missing')
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['userId']);
    }
}
