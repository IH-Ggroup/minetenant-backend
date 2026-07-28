<?php

namespace App\Models\Concerns;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Str;

trait HasStringPrimaryKey
{
    /**
     * Configure the model to use a non-incrementing string key.
     */
    public function initializeHasStringPrimaryKey(): void
    {
        $this->incrementing = false;
        $this->keyType = 'string';
    }

    /**
     * Generate a UUID only when a string ID was not assigned explicitly.
     */
    public static function bootHasStringPrimaryKey(): void
    {
        static::creating(function (Model $model): void {
            if ($model->getKey() === null || $model->getKey() === '') {
                $model->setAttribute(
                    $model->getKeyName(),
                    (string) Str::uuid(),
                );
            }
        });
    }
}
