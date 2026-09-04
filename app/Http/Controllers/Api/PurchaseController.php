<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Enums\PurchaseSource;
use App\Http\Controllers\Controller;
use App\Http\Requests\PurchaseProductRequest;
use App\Http\Resources\TransactionResource;
use App\Models\Product;
use App\Services\PurchaseService;
use Illuminate\Http\JsonResponse;

final class PurchaseController extends Controller
{
    public function __construct(
        private readonly PurchaseService $purchaseService,
    ) {}

    public function store(
        PurchaseProductRequest $request,
        Product $product,
    ): JsonResponse {
        return $this->purchase($request, $product->id);
    }

    public function storeFromBody(PurchaseProductRequest $request): JsonResponse
    {
        return $this->purchase($request, $request->validated('productId'));
    }

    private function purchase(PurchaseProductRequest $request, string $productId): JsonResponse
    {
        $validated = $request->validated();

        $transaction = $this->purchaseService->purchase(
            productId: $productId,
            buyerId: $request->user()->getAuthIdentifier(),
            source: PurchaseSource::Web,
            requestId: $validated['requestId'],
        );

        return (new TransactionResource($transaction))
            ->response()
            ->setStatusCode($transaction->wasRecentlyCreated ? 201 : 200);
    }
}
