<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\TransactionResource;
use App\Models\PurchaseTransaction;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

final class TransactionController extends Controller
{
    public function index(Request $request): AnonymousResourceCollection
    {
        $validated = $request->validate([
            'userId' => ['required', 'string', 'exists:users,id'],
        ]);

        $transactions = PurchaseTransaction::query()
            ->where(function ($query) use ($validated): void {
                $query
                    ->where('buyer_id', $validated['userId'])
                    ->orWhere('seller_id', $validated['userId']);
            })
            ->latest('created_at')
            ->get();

        return TransactionResource::collection($transactions);
    }
}
