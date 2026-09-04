<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Enums\PurchaseSource;
use App\Http\Controllers\Controller;
use App\Http\Requests\MinecraftPurchaseRequest;
use App\Http\Resources\ProductResource;
use App\Http\Resources\TransactionResource;
use App\Models\Product;
use App\Services\PurchaseService;
use Dedoc\Scramble\Attributes\Group;
use Dedoc\Scramble\Attributes\Response;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

#[Group('Minecraft（PoC）', weight: 7)]
final class MinecraftController extends Controller
{
    public function __construct(
        private readonly PurchaseService $purchaseService,
    ) {}

    /**
     * Minecraft用の商品一覧を見る
     *
     * PoC用のAPIです。現在はログイン不要で、全商品をdata配列で返します。
     * Web画面の商品表示には商品グループの商品一覧APIを使います。
     */
    public function catalog(): AnonymousResourceCollection
    {
        $products = Product::query()
            ->latest('created_at')
            ->get();

        return ProductResource::collection($products);
    }

    /**
     * Minecraftから購入する（PoC）
     *
     * PoC用のAPIです。現在はログイン・CSRF Cookieなしで、productId・buyerId・requestIdを指定して購入します。
     * 購入元はサーバーでminecraftに固定されます。Web購入とは別のrequestIdを使ってください。
     * 初回は201。同じ内容の再送は200で在庫は二重に減りません。在庫切れやrequestIdの使い回しは409です。
     * 自分の商品は購入できません（422）。Web画面からの購入にはWeb購入グループを使ってください。
     */
    #[Response(201, '初めての購入を作成しました。在庫が1個減ります。', type: TransactionResource::class)]
    #[Response(200, '同じ購入の再送です。以前と同じ取引を返し、在庫は減りません。', type: TransactionResource::class)]
    #[Response(409, '在庫切れ（OUT_OF_STOCK）、またはrequestIdの使い回し（REQUEST_ID_CONFLICT）。', type: 'array{message: string, code: string, errors?: array<string, array<string>>}')]
    public function purchase(
        MinecraftPurchaseRequest $request,
    ): JsonResponse {
        $validated = $request->validated();

        $transaction = $this->purchaseService->purchase(
            productId: $validated['productId'],
            buyerId: $validated['buyerId'],
            source: PurchaseSource::Minecraft,
            requestId: $validated['requestId'],
        );

        return (new TransactionResource($transaction))
            ->response()
            ->setStatusCode($transaction->wasRecentlyCreated ? 201 : 200);
    }
}
