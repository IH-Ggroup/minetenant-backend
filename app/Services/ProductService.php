<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\Product;
use App\Models\Store;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

final class ProductService
{
    /**
     * @param  array<string, mixed>  $data
     */
    public function create(array $data): Product
    {
        $store = Store::query()->findOrFail($data['storeId']);

        if ($store->owner_id !== $data['sellerId']) {
            throw ValidationException::withMessages([
                'sellerId' => ['出品者と店舗の所有者が一致しません。'],
            ]);
        }

        return DB::transaction(
            fn (): Product => $store->products()->create([
                'seller_id' => $data['sellerId'],
                'name' => $data['name'],
                'description' => $data['description'],
                'price' => $data['price'],
                'stock' => $data['stock'],
                'category' => $data['category'],
                'theme' => $data['theme'],
                'emoji' => $data['emoji'],
                'created_at' => now(),
            ]),
        );
    }
}
