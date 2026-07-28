<?php

namespace Database\Factories;

use App\Enums\ProductCategory;
use App\Enums\ProductTheme;
use App\Models\Product;
use App\Models\Store;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Product>
 */
class ProductFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'store_id' => Store::factory(),
            'seller_id' => fn (array $attributes) => Store::query()
                ->findOrFail($attributes['store_id'])
                ->owner_id,
            'name' => fake()->words(3, true),
            'description' => fake()->paragraph(),
            'price' => fake()->numberBetween(500, 10000),
            'stock' => fake()->numberBetween(0, 20),
            'category' => fake()->randomElement(ProductCategory::cases()),
            'theme' => fake()->randomElement(ProductTheme::cases()),
            'emoji' => '📦',
        ];
    }
}
