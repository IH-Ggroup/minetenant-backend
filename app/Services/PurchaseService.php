<?php

declare(strict_types=1);

namespace App\Services;

use App\Enums\PurchaseSource;
use App\Enums\TransactionStatus;
use App\Exceptions\OutOfStockException;
use App\Exceptions\RequestIdConflictException;
use App\Exceptions\SelfPurchaseException;
use App\Models\Product;
use App\Models\PurchaseTransaction;
use App\Models\Store;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

final class PurchaseService
{
    public function __construct(
        private readonly StoreGrowthService $storeGrowthService,
    ) {}

    public function purchase(
        string $productId,
        string $buyerId,
        PurchaseSource $source,
        string $requestId,
    ): PurchaseTransaction {
        try {
            return DB::transaction(
                function () use (
                    $productId,
                    $buyerId,
                    $source,
                    $requestId,
                ): PurchaseTransaction {
                    $existingTransaction = PurchaseTransaction::query()
                        ->where('request_id', $requestId)
                        ->lockForUpdate()
                        ->first();

                    if ($existingTransaction !== null) {
                        $this->ensureSamePurchase(
                            $existingTransaction,
                            $productId,
                            $buyerId,
                            $source,
                        );

                        return $existingTransaction;
                    }

                    $product = Product::query()
                        ->whereKey($productId)
                        ->lockForUpdate()
                        ->firstOrFail();

                    if ($product->seller_id === $buyerId) {
                        throw new SelfPurchaseException;
                    }

                    if ($product->stock < 1) {
                        throw new OutOfStockException;
                    }

                    $store = Store::query()
                        ->whereKey($product->store_id)
                        ->lockForUpdate()
                        ->firstOrFail();

                    $product->stock -= 1;
                    $product->save();

                    $transaction = PurchaseTransaction::query()->create([
                        'request_id' => $requestId,
                        'product_id' => $product->id,
                        'buyer_id' => $buyerId,
                        'seller_id' => $product->seller_id,
                        'source' => $source,
                        'amount' => $product->price,
                        'status' => TransactionStatus::Paid,
                        'created_at' => now(),
                    ]);

                    $this->storeGrowthService->recordSale($store);

                    return $transaction;
                },
                attempts: 3,
            );
        } catch (QueryException $exception) {
            if (! $this->isRequestIdUniqueViolation($exception)) {
                throw $exception;
            }

            $existingTransaction = PurchaseTransaction::query()
                ->where('request_id', $requestId)
                ->first();

            if ($existingTransaction === null) {
                throw $exception;
            }

            $this->ensureSamePurchase(
                $existingTransaction,
                $productId,
                $buyerId,
                $source,
            );

            return $existingTransaction;
        }
    }

    private function ensureSamePurchase(
        PurchaseTransaction $transaction,
        string $productId,
        string $buyerId,
        PurchaseSource $source,
    ): void {
        if (
            $transaction->product_id !== $productId
            || $transaction->buyer_id !== $buyerId
            || $transaction->source !== $source
        ) {
            throw new RequestIdConflictException;
        }
    }

    private function isRequestIdUniqueViolation(
        QueryException $exception,
    ): bool {
        $driverErrorCode = $exception->errorInfo[1] ?? null;

        return $driverErrorCode === 1062
            && str_contains(
                strtolower($exception->getMessage()),
                'request_id',
            );
    }
}
