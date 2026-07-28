<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class HelloApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seed();
    }

    public function test_hello_returns_plain_text(): void
    {
        $this->get('/api/hello')
            ->assertOk()
            ->assertHeader('Content-Type', 'text/plain; charset=UTF-8')
            ->assertContent('MineTenant API is running.');
    }

    public function test_local_vite_origin_can_make_a_cors_preflight_request(): void
    {
        $this->withHeaders([
            'Origin' => 'http://localhost:5173',
            'Access-Control-Request-Method' => 'GET',
            'Access-Control-Request-Headers' => 'Content-Type',
        ])->options('/api/v1/products')
            ->assertNoContent()
            ->assertHeader(
                'Access-Control-Allow-Origin',
                'http://localhost:5173',
            )
            ->assertHeader('Access-Control-Allow-Methods');
    }
}
