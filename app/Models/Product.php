<?php

namespace App\Models;

use App\Enums\ProductCategory;
use App\Enums\ProductTheme;
use App\Models\Concerns\HasStringPrimaryKey;
use Database\Factories\ProductFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable([
    'store_id',
    'seller_id',
    'name',
    'description',
    'price',
    'stock',
    'category',
    'theme',
    'emoji',
    'created_at',
])]
class Product extends Model
{
    /** @use HasFactory<ProductFactory> */
    use HasFactory, HasStringPrimaryKey;

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function seller(): BelongsTo
    {
        return $this->belongsTo(User::class, 'seller_id');
    }

    public function transactions(): HasMany
    {
        return $this->hasMany(PurchaseTransaction::class);
    }

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'price' => 'integer',
            'stock' => 'integer',
            'category' => ProductCategory::class,
            'theme' => ProductTheme::class,
            'created_at' => 'datetime',
        ];
    }
}
