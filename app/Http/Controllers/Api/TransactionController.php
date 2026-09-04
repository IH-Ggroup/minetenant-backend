<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\TransactionResource;
use App\Models\PurchaseTransaction;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Validation\Rule;

final class TransactionController extends Controller
{
    public function index(Request $request): AnonymousResourceCollection
    {
        $request->validate([
            'userId' => ['sometimes', 'string', Rule::in([$request->user()->getAuthIdentifier()])],
        ]);

        $userId = $request->user()->getAuthIdentifier();

        $transactions = PurchaseTransaction::query()
            ->where(function ($query) use ($userId): void {
                $query
                    ->where('buyer_id', $userId)
                    ->orWhere('seller_id', $userId);
            })
            ->latest('created_at')
            ->get();

        return TransactionResource::collection($transactions);
    }

    public function show(Request $request, PurchaseTransaction $transaction): TransactionResource
    {
        $userId = $request->user()->getAuthIdentifier();
        abort_unless(in_array($userId, [$transaction->buyer_id, $transaction->seller_id], true), 403);

        return new TransactionResource($transaction);
    }
}
