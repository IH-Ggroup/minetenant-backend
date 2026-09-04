<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

final class StoreDashboardResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'store' => new StoreResource($this->resource['store']),
            'products' => ProductResource::collection(
                $this->resource['products'],
            ),
            /**
             * 店舗の商品・売上・成長の集計値。
             *
             * @var array{
             *     productCount: int,
             *     availableProductCount: int,
             *     soldOutProductCount: int,
             *     totalStock: int,
             *     salesCount: int,
             *     salesAmount: int,
             *     webSalesCount: int,
             *     minecraftSalesCount: int,
             *     nextLevelPoints: int,
             *     levelProgressPercent: int
             * }
             */
            'stats' => $this->resource['stats'],
            'recentTransactions' => TransactionResource::collection(
                $this->resource['recentTransactions'],
            ),
        ];
    }
}
