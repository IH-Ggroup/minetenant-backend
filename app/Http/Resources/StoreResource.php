<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

final class StoreResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'ownerId' => $this->owner_id,
            'name' => $this->name,
            'description' => $this->description,
            'level' => $this->level,
            'points' => $this->points,
            'syncStatus' => $this->sync_status->value,
        ];
    }
}
