<?php

namespace App\Models;

use App\Enums\StoreSyncStatus;
use App\Models\Concerns\HasStringPrimaryKey;
use Database\Factories\StoreFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable([
    'owner_id',
    'name',
    'description',
    'level',
    'points',
    'sync_status',
])]
class Store extends Model
{
    /** @use HasFactory<StoreFactory> */
    use HasFactory, HasStringPrimaryKey;

    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'owner_id');
    }

    public function products(): HasMany
    {
        return $this->hasMany(Product::class);
    }

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'level' => 'integer',
            'points' => 'integer',
            'sync_status' => StoreSyncStatus::class,
        ];
    }
}
