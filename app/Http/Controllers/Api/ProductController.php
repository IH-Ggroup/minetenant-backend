<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\CreateProductRequest;
use App\Http\Resources\ProductResource;
use App\Models\Product;
use App\Services\ProductService;
use Dedoc\Scramble\Attributes\Group;
use Dedoc\Scramble\Attributes\PathParameter;
use Dedoc\Scramble\Attributes\Response as ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

#[Group('商品', weight: 2)]
final class ProductController extends Controller
{
    public function __construct(
        private readonly ProductService $productService,
    ) {}

    /**
     * 商品の一覧を確認・検索する
     *
     * ログイン不要です。何も入力せずに送ると全商品を返します。
     * storeIdで店舗を絞り込み、keywordで商品名・説明を部分一致検索できます。
     * 商品はdata配列に入り、該当商品がなければ空の配列になります。
     */
    public function index(Request $request): AnonymousResourceCollection
    {
        $validated = $request->validate([
            /**
             * 絞り込む店舗のID。省略すると全店舗の商品を対象にします。
             *
             * @example store-mine
             */
            'storeId' => ['sometimes', 'string', 'exists:stores,id'],
            /**
             * 商品名・説明から探す言葉。省略すると検索条件を付けません。
             *
             * @example スツール
             */
            'keyword' => ['sometimes', 'nullable', 'string', 'max:120'],
        ]);

        $keyword = trim($validated['keyword'] ?? '');

        $products = Product::query()
            ->when(
                $validated['storeId'] ?? null,
                fn ($query, string $storeId) => $query->where(
                    'store_id',
                    $storeId,
                ),
            )
            ->when($keyword !== '', function ($query) use ($keyword): void {
                $pattern = '%'.str_replace(
                    ['!', '%', '_'],
                    ['!!', '!%', '!_'],
                    $keyword,
                ).'%';

                $query->where(function ($query) use ($pattern): void {
                    $query->whereRaw("name LIKE ? ESCAPE '!'", [$pattern])
                        ->orWhereRaw("description LIKE ? ESCAPE '!'", [$pattern]);
                });
            })
            ->latest('created_at')
            ->get();

        return ProductResource::collection($products);
    }

    /**
     * 商品1件の詳細を見る
     *
     * ログイン不要です。初期データのproduct-stoolは「森の木製スツール」です。
     * 在庫はstockで確認できます。存在しない商品IDは404です。
     */
    #[PathParameter('product', description: '商品一覧のdata内にあるid。', type: 'string', example: 'product-stool')]
    #[ApiResponse(404, '指定した商品が見つかりません。', type: 'array{message: string}')]
    public function show(Product $product): ProductResource
    {
        return new ProductResource($product);
    }

    /**
     * 自分が出品した商品を削除する
     *
     * ログインとCSRF Cookieが必要です。成功は204（本文なし）です。
     * 他人の商品は403、取引履歴がある商品は409になります。
     * 初期データのproduct-stoolには取引履歴があるため、削除の成功確認には自分で新しく出品した商品のIDを使ってください。
     */
    #[PathParameter('product', description: '削除する商品のid。自分の出品かつ取引履歴なしの商品を指定します。', type: 'string')]
    #[ApiResponse(403, 'この商品を出品したユーザーだけが削除できます。', type: 'array{message: string}')]
    #[ApiResponse(404, '指定した商品が見つかりません。', type: 'array{message: string}')]
    #[ApiResponse(409, '取引履歴がある商品は削除できません。', type: 'array{message: string}')]
    #[ApiResponse(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    public function destroy(Request $request, Product $product): Response
    {
        return DB::transaction(function () use ($request, $product): Response {
            $product = Product::query()
                ->whereKey($product->getKey())
                ->lockForUpdate()
                ->firstOrFail();

            abort_unless(
                $product->seller_id === $request->user()->getAuthIdentifier(),
                403,
                'Only the seller can delete this product.',
            );

            abort_if(
                $product->transactions()->exists(),
                409,
                'Products with transaction history cannot be deleted.',
            );

            $product->delete();

            return response()->noContent();
        }, attempts: 3);
    }

    /**
     * 商品を出品する
     *
     * ログインとCSRF Cookieが必要です。成功は201です。
     * storeIdとsellerIdは省略すると自分の店舗・ユーザーIDになります。他人の店舗への出品はできません。
     * 返ってきたdata.idを、商品詳細や削除の確認に使えます。
     */
    #[ApiResponse(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    public function store(CreateProductRequest $request): JsonResponse
    {
        $product = $this->productService->create($request->validated());

        return (new ProductResource($product))
            ->response()
            ->setStatusCode(201);
    }
}
