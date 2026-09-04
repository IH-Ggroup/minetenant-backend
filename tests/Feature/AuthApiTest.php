<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Store;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Tests\TestCase;

final class AuthApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_csrf_cookie_endpoint_starts_a_session(): void
    {
        $this->getJson('/api/v1/auth/csrf-cookie')
            ->assertNoContent()
            ->assertCookie('XSRF-TOKEN')
            ->assertCookie(config('session.cookie'));
    }

    public function test_registration_creates_a_user_and_store_and_logs_in(): void
    {
        $this->getJson('/api/v1/auth/csrf-cookie');
        $originalSessionId = session()->getId();

        $response = $this->postJson('/api/v1/auth/register', [
            'name' => '田中 太郎',
            'email' => ' TANAKA@EXAMPLE.COM ',
            'password' => 'strong-password',
            'role' => 'seller',
            'points' => 999999,
        ]);

        $response
            ->assertCreated()
            ->assertJsonPath('data.name', '田中 太郎')
            ->assertJsonPath('data.role', UserRole::Buyer->value)
            ->assertJsonPath('data.roleLabel', '購入者')
            ->assertJsonPath('data.avatarInitial', '田')
            ->assertJsonMissingPath('data.password')
            ->assertJsonMissingPath('data.remember_token');

        $user = User::query()->sole();
        $store = Store::query()->sole();

        $this->assertSame('tanaka@example.com', $user->email);
        $this->assertTrue(Hash::check('strong-password', $user->password));
        $this->assertSame($user->id, $store->owner_id);
        $this->assertSame(1, $store->level);
        $this->assertSame(0, $store->points);
        $this->assertSame('offline', $store->sync_status->value);
        $response->assertJsonPath('data.storeId', $store->id);
        $this->assertAuthenticatedAs($user, 'web');
        $this->assertNotSame($originalSessionId, session()->getId());

        $this->getJson('/api/v1/auth/me')
            ->assertOk()
            ->assertJsonPath('data.id', $user->id)
            ->assertJsonMissingPath('data.password');
    }

    public function test_registration_rejects_duplicate_email_after_normalization(): void
    {
        User::factory()->create(['email' => 'member@example.com']);

        $this->postJson('/api/v1/auth/register', [
            'name' => '新しい利用者',
            'email' => ' MEMBER@EXAMPLE.COM ',
            'password' => 'strong-password',
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('email');

        $this->assertDatabaseCount('users', 1);
        $this->assertDatabaseCount('stores', 0);
        $this->assertGuest('web');
    }

    public function test_registration_validates_required_fields_and_password_confirmation(): void
    {
        $this->postJson('/api/v1/auth/register', [
            'name' => '',
            'email' => 'not-an-email',
            'password' => 'short',
            'password_confirmation' => 'different',
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['name', 'email', 'password', 'password_confirmation']);

        $this->assertDatabaseCount('users', 0);
        $this->assertDatabaseCount('stores', 0);
    }

    public function test_registration_handles_email_registered_after_validation(): void
    {
        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            $this->markTestSkipped('This race test requires a shared MySQL or MariaDB database.');
        }

        // Use real, independent connections outside RefreshDatabase's wrapping
        // transaction so a competing commit is visible after the failed insert.
        $defaultConnection = DB::getDefaultConnection();
        $connectionConfig = config('database.connections.'.$defaultConnection);
        config([
            'database.connections.auth_registration_request' => $connectionConfig,
            'database.connections.auth_registration_competitor' => $connectionConfig,
        ]);

        $requestConnection = DB::connection('auth_registration_request');
        $competitorConnection = DB::connection('auth_registration_competitor');
        $email = 'race-'.Str::uuid().'@example.com';
        $competitorId = (string) Str::uuid();
        User::query();
        $originalDispatcher = User::getEventDispatcher();
        User::setEventDispatcher(clone $originalDispatcher);

        try {
            DB::setDefaultConnection('auth_registration_request');
            User::creating(function (User $user) use ($email, $competitorId, $competitorConnection): void {
                if ($user->email === $email) {
                    $competitorConnection->table('users')->insert(array_merge(
                        $user->getAttributes(),
                        [
                            'id' => $competitorId,
                            'created_at' => now(),
                            'updated_at' => now(),
                        ],
                    ));
                }
            });

            $this->postJson('/api/v1/auth/register', [
                'name' => '競合する利用者',
                'email' => $email,
                'password' => 'strong-password',
            ])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('email')
                ->assertJsonPath('errors.email.0', 'このメールアドレスは既に登録されています。');

            $this->assertSame(1, $requestConnection->table('users')->where('email', $email)->count());
            $this->assertSame($competitorId, $requestConnection->table('users')->where('email', $email)->value('id'));
            $this->assertSame(0, $requestConnection->table('stores')->where('owner_id', $competitorId)->count());
            $this->assertGuest('web');
        } finally {
            User::setEventDispatcher($originalDispatcher);
            $userIds = $requestConnection->table('users')->where('email', $email)->pluck('id');
            $requestConnection->table('stores')->whereIn('owner_id', $userIds)->delete();
            $requestConnection->table('users')->where('email', $email)->delete();
            DB::setDefaultConnection($defaultConnection);
            DB::purge('auth_registration_request');
            DB::purge('auth_registration_competitor');
        }
    }

    public function test_registration_accepts_matching_optional_password_confirmation(): void
    {
        $this->postJson('/api/v1/auth/register', [
            'name' => '購入者',
            'email' => 'member@example.com',
            'password' => 'strong-password',
            'password_confirmation' => 'strong-password',
        ])->assertCreated();
    }

    public function test_registration_rejects_passwords_bcrypt_cannot_safely_hash(): void
    {
        foreach ([str_repeat('あ', 25), "password\0hidden"] as $password) {
            $this->postJson('/api/v1/auth/register', [
                'name' => '購入者',
                'email' => 'member@example.com',
                'password' => $password,
            ])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('password');
        }

        $this->assertDatabaseCount('users', 0);
    }

    public function test_login_normalizes_email_and_returns_the_authenticated_user(): void
    {
        $user = User::factory()->create(['email' => 'member@example.com']);
        $store = Store::factory()->for($user, 'owner')->create();
        $this->getJson('/api/v1/auth/csrf-cookie');
        $originalSessionId = session()->getId();

        $this->postJson('/api/v1/auth/login', [
            'email' => ' MEMBER@EXAMPLE.COM ',
            'password' => 'password',
        ])
            ->assertOk()
            ->assertJsonPath('data.id', $user->id)
            ->assertJsonPath('data.storeId', $store->id)
            ->assertJsonMissingPath('data.password')
            ->assertJsonMissingPath('data.remember_token');

        $this->assertAuthenticatedAs($user, 'web');
        $this->assertNotSame($originalSessionId, session()->getId());
    }

    public function test_unknown_email_and_wrong_password_return_the_same_error(): void
    {
        User::factory()->create(['email' => 'member@example.com']);

        $wrongPassword = $this->postJson('/api/v1/auth/login', [
            'email' => 'member@example.com',
            'password' => 'wrong-password',
        ])->assertUnprocessable()->assertJsonValidationErrors('email');

        $unknownEmail = $this->postJson('/api/v1/auth/login', [
            'email' => 'unknown@example.com',
            'password' => 'wrong-password',
        ])->assertUnprocessable()->assertJsonValidationErrors('email');

        $this->assertSame($wrongPassword->json(), $unknownEmail->json());
        $this->assertGuest('web');
    }

    public function test_login_validates_credentials(): void
    {
        $this->postJson('/api/v1/auth/login', [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['email', 'password']);

        $this->assertGuest('web');
    }

    public function test_login_does_not_accept_a_password_with_a_truncated_suffix(): void
    {
        $password = str_repeat('a', 72);
        $user = User::factory()->create([
            'email' => 'member@example.com',
            'password' => $password,
        ]);

        $this->postJson('/api/v1/auth/login', [
            'email' => $user->email,
            'password' => $password,
        ])->assertOk();
        $this->postJson('/api/v1/auth/logout')->assertNoContent();

        foreach ([$password.'suffix', "password\0hidden"] as $invalidPassword) {
            $this->postJson('/api/v1/auth/login', [
                'email' => $user->email,
                'password' => $invalidPassword,
            ])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('password');

            $this->assertGuest('web');
        }
    }

    public function test_me_requires_authentication(): void
    {
        $this->getJson('/api/v1/auth/me')->assertUnauthorized();
    }

    public function test_logout_ends_the_session_and_me_returns_unauthorized(): void
    {
        $user = User::factory()->create(['email' => 'member@example.com']);
        $this->postJson('/api/v1/auth/login', [
            'email' => $user->email,
            'password' => 'password',
        ])->assertOk();

        $originalSessionId = session()->getId();
        $originalToken = session()->token();

        $this->postJson('/api/v1/auth/logout')->assertNoContent();

        $this->assertGuest('web');
        $this->assertNotSame($originalSessionId, session()->getId());
        $this->assertNotSame($originalToken, session()->token());
        $this->getJson('/api/v1/auth/me')->assertUnauthorized();
    }
}
