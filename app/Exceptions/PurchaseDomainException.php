<?php

declare(strict_types=1);

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

abstract class PurchaseDomainException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly string $errorCode,
        public readonly int $statusCode,
        public readonly ?string $field = null,
    ) {
        parent::__construct($message);
    }

    public function render(Request $request): JsonResponse
    {
        $response = [
            'message' => $this->getMessage(),
            'code' => $this->errorCode,
        ];

        if ($this->field !== null) {
            $response['errors'] = [
                $this->field => [$this->getMessage()],
            ];
        }

        return response()->json($response, $this->statusCode);
    }
}
