<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

final class TransactionResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'productId' => $this->product_id,
            'buyerId' => $this->buyer_id,
            'sellerId' => $this->seller_id,
            'source' => $this->source->value,
            'amount' => $this->amount,
            'status' => $this->status->value,
            'createdAt' => $this->created_at?->toISOString(),
        ];
    }
}
