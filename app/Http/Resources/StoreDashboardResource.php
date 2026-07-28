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
            'stats' => $this->resource['stats'],
            'recentTransactions' => TransactionResource::collection(
                $this->resource['recentTransactions'],
            ),
        ];
    }
}
