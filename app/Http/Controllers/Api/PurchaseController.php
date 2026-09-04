<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Enums\PurchaseSource;
use App\Http\Controllers\Controller;
use App\Http\Requests\PurchaseProductRequest;
use App\Http\Resources\TransactionResource;
use App\Models\Product;
use App\Services\PurchaseService;
use Dedoc\Scramble\Attributes\BodyParameter;
use Dedoc\Scramble\Attributes\Group;
use Dedoc\Scramble\Attributes\PathParameter;
use Dedoc\Scramble\Attributes\Response;
use Illuminate\Http\JsonResponse;

#[Group('Web購入', weight: 3)]
final class PurchaseController extends Controller
{
    public function __construct(
        private readonly PurchaseService $purchaseService,
    ) {}

    /**
     * URLで指定した商品を購入する
     *
     * ログインとCSRF Cookieが必要です。URLに商品IDを入れ、本文はrequestIdだけで購入できます。
     * 初回は201。同じ購入者・商品・requestIdで再送すると同じ取引を200で返し、在庫は二重に減りません。
     * 在庫切れ、またはrequestIdを別の購入内容に使うと409です。自分の商品は購入できません（422）。
     * 1回の購入で在庫を1個減らすため、まず商品詳細で在庫を確認してください。
     */
    #[PathParameter('product', description: '購入する商品のid。購入者demo@minetenant.jpで試せる初期データです。', type: 'string', example: 'product-stool')]
    #[BodyParameter('productId', description: '省略できます。指定する場合はURLの商品IDと同じ値にします。', required: false, type: 'string', example: 'product-stool')]
    #[Response(201, '初めての購入を作成しました。在庫が1個減ります。', type: TransactionResource::class)]
    #[Response(200, '同じ購入の再送です。以前と同じ取引を返し、在庫は減りません。', type: TransactionResource::class)]
    #[Response(404, 'URLで指定した商品が見つかりません。', type: 'array{message: string}')]
    #[Response(409, '在庫切れ（OUT_OF_STOCK）、またはrequestIdの使い回し（REQUEST_ID_CONFLICT）。', type: 'array{message: string, code: string, errors?: array<string, array<string>>}')]
    #[Response(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    public function store(
        PurchaseProductRequest $request,
        Product $product,
    ): JsonResponse {
        return $this->purchase($request, $product->id);
    }

    /**
     * 商品IDを本文に入れて購入する
     *
     * ログインとCSRF Cookieが必要です。本文にproductIdとrequestIdを入力します。購入者はログイン中の自分です。
     * 初回は201。同じ購入者・商品・requestIdで再送すると200となり、二重購入を防げます。
     * 在庫切れ、または同じrequestIdで購入内容を変えた場合は409です。自分の商品は購入できません（422）。
     * 例を試すと在庫が1個減ります。再送の確認ではrequestIdを変えず、新しい購入を作るときだけ新しい値にしてください。
     */
    #[BodyParameter('productId', description: '購入する商品のid。購入者demo@minetenant.jpで試せる初期データです。', required: true, type: 'string', example: 'product-stool')]
    #[Response(201, '初めての購入を作成しました。在庫が1個減ります。', type: TransactionResource::class)]
    #[Response(200, '同じ購入の再送です。以前と同じ取引を返し、在庫は減りません。', type: TransactionResource::class)]
    #[Response(409, '在庫切れ（OUT_OF_STOCK）、またはrequestIdの使い回し（REQUEST_ID_CONFLICT）。', type: 'array{message: string, code: string, errors?: array<string, array<string>>}')]
    #[Response(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    public function storeFromBody(PurchaseProductRequest $request): JsonResponse
    {
        return $this->purchase($request, $request->validated('productId'));
    }

    private function purchase(PurchaseProductRequest $request, string $productId): JsonResponse
    {
        $validated = $request->validated();

        $transaction = $this->purchaseService->purchase(
            productId: $productId,
            buyerId: $request->user()->getAuthIdentifier(),
            source: PurchaseSource::Web,
            requestId: $validated['requestId'],
        );

        return (new TransactionResource($transaction))
            ->response()
            ->setStatusCode($transaction->wasRecentlyCreated ? 201 : 200);
    }
}
