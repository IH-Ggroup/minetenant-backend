<?php

declare(strict_types=1);

namespace App\Support;

use Dedoc\Scramble\Contracts\OperationTransformer;
use Dedoc\Scramble\Support\Generator\Operation;
use Dedoc\Scramble\Support\Generator\Schema;
use Dedoc\Scramble\Support\RouteInfo;

final class ApiRequestExamples implements OperationTransformer
{
    public function handle(Operation $operation, RouteInfo $routeInfo): void
    {
        if ($operation->method !== 'post' || $operation->requestBodyObject === null) {
            return;
        }

        $example = match ($routeInfo->route->uri()) {
            'api/v1/purchases' => [
                'productId' => 'product-stool',
                'requestId' => 'docs-web-stool-001',
            ],
            'api/v1/products/{product}/purchases' => [
                'requestId' => 'docs-web-stool-001',
            ],
            'api/v1/products' => [
                'name' => '確認用の木製トレイ',
                'description' => 'API画面からの出品確認です。',
                'price' => 1200,
                'stock' => 2,
                'category' => 'interior',
                'theme' => 'forest',
                'emoji' => '🪵',
            ],
            default => null,
        };

        if ($example === null) {
            return;
        }

        // Keep the full schema while preventing Scalar from inventing empty
        // values for fields filled from the login session. Clone the wrapper
        // so examples stay specific to this operation, including shared refs.
        $schema = clone $operation->requestBodyObject->content['application/json'];

        if ($schema instanceof Schema) {
            $schema->type = clone $schema->type;
            $schema->type->examples([$example]);
        } else {
            $schema->examples([$example]);
        }

        $operation->requestBodyObject->content['application/json'] = $schema;
    }
}
