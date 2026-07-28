<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

final class UserResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'role' => $this->role->value,
            'roleLabel' => $this->role_label,
            'avatarInitial' => $this->avatar_initial,
            'storeId' => $this->whenLoaded(
                'store',
                fn (): ?string => $this->store?->id,
            ),
        ];
    }
}
