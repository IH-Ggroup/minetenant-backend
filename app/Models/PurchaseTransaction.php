<?php

namespace App\Models;

use App\Enums\PurchaseSource;
use App\Enums\TransactionStatus;
use App\Models\Concerns\HasStringPrimaryKey;
use Database\Factories\PurchaseTransactionFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable([
    'request_id',
    'product_id',
    'buyer_id',
    'seller_id',
    'source',
    'amount',
    'status',
    'created_at',
])]
class PurchaseTransaction extends Model
{
    /** @use HasFactory<PurchaseTransactionFactory> */
    use HasFactory, HasStringPrimaryKey;

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    public function buyer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'buyer_id');
    }

    public function seller(): BelongsTo
    {
        return $this->belongsTo(User::class, 'seller_id');
    }

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'source' => PurchaseSource::class,
            'amount' => 'integer',
            'status' => TransactionStatus::class,
            'created_at' => 'datetime',
        ];
    }
}
