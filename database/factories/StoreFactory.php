<?php

namespace Database\Factories;

use App\Enums\StoreSyncStatus;
use App\Models\Store;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Store>
 */
class StoreFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'owner_id' => User::factory(),
            'name' => fake()->company(),
            'description' => fake()->sentence(),
            'level' => fake()->numberBetween(1, 5),
            'points' => fake()->numberBetween(0, 1000),
            'sync_status' => StoreSyncStatus::Connected,
        ];
    }
}
