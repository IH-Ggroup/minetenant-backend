<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

final class ProductResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'storeId' => $this->store_id,
            'sellerId' => $this->seller_id,
            'name' => $this->name,
            'description' => $this->description,
            'price' => $this->price,
            'stock' => $this->stock,
            'category' => $this->category->value,
            'theme' => $this->theme->value,
            'emoji' => $this->emoji,
            'createdAt' => $this->created_at?->toISOString(),
        ];
    }
}
