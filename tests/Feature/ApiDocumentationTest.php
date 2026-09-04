<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ApiDocumentationTest extends TestCase
{
    use RefreshDatabase;

    public function test_local_developers_can_open_the_api_reference_and_generated_specification(): void
    {
        $this->app['env'] = 'local';

        $this->get('/docs/api')
            ->assertOk()
            ->assertSee('MineTenant API一覧・動作確認')
            ->assertSee('Scalar.createApiReference', false);

        $this->getJson('/docs/api.json')
            ->assertOk()
            ->assertJsonStructure(['openapi', 'paths', 'components']);
    }

    public function test_the_api_reference_and_specification_are_not_public_in_production(): void
    {
        $this->app['env'] = 'production';

        $this->get('/docs/api')->assertForbidden();
        $this->getJson('/docs/api.json')->assertForbidden();
    }

    public function test_documented_operations_and_cookie_authentication_match_the_real_routes(): void
    {
        $this->app['env'] = 'local';
        config(['session.cookie' => 'docs-contract-session']);

        $spec = $this->getJson('/docs/api.json')->assertOk()->json();
        $schemes = $spec['components']['securitySchemes'];

        $this->assertCount(1, $schemes);
        $schemeName = array_key_first($schemes);
        $this->assertSame('apiKey', $schemes[$schemeName]['type']);
        $this->assertSame('cookie', $schemes[$schemeName]['in']);
        $this->assertSame(config('session.cookie'), $schemes[$schemeName]['name']);
        $this->assertArrayNotHasKey('scheme', $schemes[$schemeName]);

        $documentedOperations = [];

        foreach ($spec['paths'] as $path => $pathItem) {
            foreach (['get', 'post', 'put', 'patch', 'delete', 'options'] as $method) {
                if (isset($pathItem[$method])) {
                    $documentedOperations[strtoupper($method).' /api'.$path] = $pathItem[$method];
                }
            }
        }

        $routes = [];

        foreach ($this->app['router']->getRoutes() as $route) {
            if (! str_starts_with($route->uri(), 'api/')) {
                continue;
            }

            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                $routes[$method.' /'.$route->uri()] = $route;
            }
        }

        $this->assertCount(19, $routes);
        $this->assertEqualsCanonicalizing(array_keys($routes), array_keys($documentedOperations));

        foreach ($routes as $name => $route) {
            $operation = $documentedOperations[$name];

            if (in_array('auth:web', $route->gatherMiddleware(), true)) {
                // An operation can inherit the document's security requirement.
                $this->assertSame(
                    [[$schemeName => []]],
                    $operation['security'] ?? $spec['security'] ?? [],
                    $name.' must describe the login session cookie.',
                );
            } else {
                $this->assertArrayHasKey('security', $operation, $name.' must explicitly be public.');
                $this->assertSame([], $operation['security'], $name.' must not require login.');
            }
        }
    }

    public function test_the_examples_and_schemas_describe_a_valid_login_and_purchase(): void
    {
        $this->app['env'] = 'local';

        $spec = $this->getJson('/docs/api.json')->assertOk()->json();
        $login = $this->resolveSchema(
            $spec,
            $spec['paths']['/v1/auth/login']['post']['requestBody']['content']['application/json']['schema'],
        );

        $this->assertEqualsCanonicalizing(['email', 'password'], $login['required']);
        $this->assertContains('demo@minetenant.jp', $login['properties']['email']['examples']);
        $this->assertContains('password', $login['properties']['password']['examples']);

        $purchase = $spec['paths']['/v1/purchases']['post'];
        $body = $this->resolveSchema($spec, $purchase['requestBody']['content']['application/json']['schema']);

        $this->assertEqualsCanonicalizing(['productId', 'requestId'], $body['required']);
        $this->assertContains('product-stool', $body['properties']['productId']['examples']);
        $this->assertNotEmpty($body['properties']['requestId']['examples']);

        foreach ([201, 200] as $status) {
            $this->assertArrayHasKey($status, $purchase['responses']);
            $response = $this->resolveSchema(
                $spec,
                $purchase['responses'][$status]['content']['application/json']['schema'],
            );
            $transaction = $this->resolveSchema($spec, $response['properties']['data']);

            $this->assertSame('integer', $transaction['properties']['amount']['type']);
            $this->assertContains('id', $transaction['required']);
        }

        $dashboard = $spec['components']['schemas']['StoreDashboardResource'];
        $stats = $this->resolveSchema($spec, $dashboard['properties']['stats']);

        $this->assertSame('object', $stats['type']);
        $this->assertSame('integer', $stats['properties']['totalStock']['type']);
        $this->assertSame('integer', $stats['properties']['salesAmount']['type']);
    }

    public function test_purchase_and_listing_examples_omit_fields_filled_from_the_login_session(): void
    {
        $this->app['env'] = 'local';

        $spec = $this->getJson('/docs/api.json')->assertOk()->json();
        $examples = [
            '/v1/purchases' => [
                'productId' => 'product-stool',
                'requestId' => 'docs-web-stool-001',
            ],
            '/v1/products/{product}/purchases' => [
                'requestId' => 'docs-web-stool-001',
            ],
            '/v1/products' => [
                'name' => '確認用の木製トレイ',
                'description' => 'API画面からの出品確認です。',
                'price' => 1200,
                'stock' => 2,
                'category' => 'interior',
                'theme' => 'forest',
                'emoji' => '🪵',
            ],
        ];

        foreach ($examples as $path => $example) {
            $content = $spec['paths'][$path]['post']['requestBody']['content']['application/json'];

            $this->assertSame([$example], $content['schema']['examples'], $path.' must start with a usable request body.');
            $schema = $this->resolveSchema($spec, $content['schema']);
            $this->assertNotEmpty($schema['properties'], $path.' must retain its full input schema.');
        }
    }

    /**
     * Read schema references and combined request schemas without depending on
     * whether the generator inlines a schema or puts it in components.
     */
    private function resolveSchema(array $spec, array $schema): array
    {
        if (isset($schema['$ref'])) {
            $prefix = '#/components/schemas/';
            $this->assertStringStartsWith($prefix, $schema['$ref']);
            $schema = $this->resolveSchema($spec, $spec['components']['schemas'][substr($schema['$ref'], strlen($prefix))]);
        }

        foreach ($schema['allOf'] ?? [] as $part) {
            $part = $this->resolveSchema($spec, $part);
            $required = array_values(array_unique([
                ...($schema['required'] ?? []),
                ...($part['required'] ?? []),
            ]));
            $schema = array_replace_recursive($schema, $part);
            $schema['required'] = $required;
        }

        return $schema;
    }
}
