<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class UserApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
        $this->actingAs(User::query()->findOrFail('user-buyer'));
    }

    public function test_users_returns_the_demo_users_for_temporary_login(): void
    {
        $response = $this->getJson('/api/v1/users');

        $response
            ->assertOk()
            ->assertJsonCount(2, 'data')
            ->assertJsonStructure([
                'data' => [
                    '*' => [
                        'id',
                        'name',
                        'role',
                        'roleLabel',
                        'avatarInitial',
                        'storeId',
                    ],
                ],
            ])
            ->assertJsonFragment([
                'id' => 'user-buyer',
                'name' => '山田 みどり',
                'role' => 'buyer',
                'roleLabel' => '購入者デモ',
                'avatarInitial' => '山',
                'storeId' => 'store-yamada',
            ])
            ->assertJsonFragment([
                'id' => 'user-seller',
                'name' => '青鉱舎 店長',
                'role' => 'seller',
                'roleLabel' => '出品者デモ',
                'avatarInitial' => 'M',
                'storeId' => 'store-mine',
            ])
            ->assertJsonMissingPath('data.0.password')
            ->assertJsonMissingPath('data.1.password');
    }
}
