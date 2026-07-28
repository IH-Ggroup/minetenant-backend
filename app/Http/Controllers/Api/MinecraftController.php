<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Enums\PurchaseSource;
use App\Http\Controllers\Controller;
use App\Http\Requests\MinecraftPurchaseRequest;
use App\Http\Resources\ProductResource;
use App\Http\Resources\TransactionResource;
use App\Models\Product;
use App\Services\PurchaseService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

final class MinecraftController extends Controller
{
    public function __construct(
        private readonly PurchaseService $purchaseService,
    ) {}

    public function catalog(): AnonymousResourceCollection
    {
        $products = Product::query()
            ->latest('created_at')
            ->get();

        return ProductResource::collection($products);
    }

    public function purchase(
        MinecraftPurchaseRequest $request,
    ): JsonResponse {
        $validated = $request->validated();

        $transaction = $this->purchaseService->purchase(
            productId: $validated['productId'],
            buyerId: $validated['buyerId'],
            source: PurchaseSource::Minecraft,
            requestId: $validated['requestId'],
        );

        return (new TransactionResource($transaction))
            ->response()
            ->setStatusCode($transaction->wasRecentlyCreated ? 201 : 200);
    }
}
