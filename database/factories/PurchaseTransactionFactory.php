<?php

namespace Database\Factories;

use App\Enums\PurchaseSource;
use App\Enums\TransactionStatus;
use App\Models\Product;
use App\Models\PurchaseTransaction;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<PurchaseTransaction>
 */
class PurchaseTransactionFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'request_id' => (string) Str::uuid(),
            'product_id' => Product::factory(),
            'buyer_id' => User::factory(),
            'seller_id' => fn (array $attributes) => Product::query()
                ->findOrFail($attributes['product_id'])
                ->seller_id,
            'source' => PurchaseSource::Web,
            'amount' => fn (array $attributes) => Product::query()
                ->findOrFail($attributes['product_id'])
                ->price,
            'status' => TransactionStatus::Paid,
        ];
    }
}
