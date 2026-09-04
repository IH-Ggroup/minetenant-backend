<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\TransactionResource;
use App\Models\PurchaseTransaction;
use Dedoc\Scramble\Attributes\Group;
use Dedoc\Scramble\Attributes\PathParameter;
use Dedoc\Scramble\Attributes\QueryParameter;
use Dedoc\Scramble\Attributes\Response;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Validation\Rule;

#[Group('取引履歴', weight: 5)]
final class TransactionController extends Controller
{
    /**
     * 自分の購入・販売履歴を見る
     *
     * ログインが必要です。入力なしで、自分が購入者または出品者になっている取引を返します。
     * 初期データにも取引履歴が1件あります。購入確認ではrequestIdやidで今回の取引を見分けてください。
     */
    #[QueryParameter('userId', description: '通常は省略します。指定する場合もログイン中の自分のIDだけが使えます。例は購入者demo@minetenant.jpのIDです。', required: false, type: 'string', infer: false, example: 'user-buyer')]
    public function index(Request $request): AnonymousResourceCollection
    {
        $request->validate([
            /**
             * 通常は省略します。指定する場合もログイン中の自分のIDだけが使えます。
             */
            'userId' => ['sometimes', 'string', Rule::in([$request->user()?->getAuthIdentifier()])],
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

    /**
     * 取引1件の詳細を見る
     *
     * ログインが必要です。自分が購入者または出品者の取引だけが見られます。
     * 購入結果のdata.id、または取引一覧にあるidをコピーして指定してください。requestIdとは別の値です。
     * 他人の取引は403、存在しない取引IDは404です。
     */
    #[PathParameter('transaction', description: '購入結果のdata.idを貼り付けます。購入のたびに生成されるIDで、requestIdとは異なります。', type: 'string')]
    #[Response(403, 'この取引の購入者・出品者だけが確認できます。', type: 'array{message: string}')]
    #[Response(404, '指定した取引が見つかりません。', type: 'array{message: string}')]
    public function show(Request $request, PurchaseTransaction $transaction): TransactionResource
    {
        $userId = $request->user()->getAuthIdentifier();
        abort_unless(in_array($userId, [$transaction->buyer_id, $transaction->seller_id], true), 403);

        return new TransactionResource($transaction);
    }
}
