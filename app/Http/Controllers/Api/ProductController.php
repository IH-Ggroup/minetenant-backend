<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\CreateProductRequest;
use App\Http\Resources\ProductResource;
use App\Models\Product;
use App\Services\ProductService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

final class ProductController extends Controller
{
    public function __construct(
        private readonly ProductService $productService,
    ) {}

    public function index(Request $request): AnonymousResourceCollection
    {
        $validated = $request->validate([
            'storeId' => ['sometimes', 'string', 'exists:stores,id'],
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

    public function show(Product $product): ProductResource
    {
        return new ProductResource($product);
    }

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

    public function store(CreateProductRequest $request): JsonResponse
    {
        $product = $this->productService->create($request->validated());

        return (new ProductResource($product))
            ->response()
            ->setStatusCode(201);
    }
}
