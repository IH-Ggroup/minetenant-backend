<?php

declare(strict_types=1);

namespace App\Services;

use App\Enums\PurchaseSource;
use App\Models\Product;
use App\Models\PurchaseTransaction;
use App\Models\Store;
use Illuminate\Database\Eloquent\Collection;

final class StoreDashboardService
{
    /**
     * @return array{
     *     store: Store,
     *     products: Collection<int, Product>,
     *     stats: array{
     *         productCount: int,
     *         availableProductCount: int,
     *         soldOutProductCount: int,
     *         totalStock: int,
     *         salesCount: int,
     *         salesAmount: int,
     *         webSalesCount: int,
     *         minecraftSalesCount: int,
     *         nextLevelPoints: int,
     *         levelProgressPercent: int
     *     },
     *     recentTransactions: Collection<int, PurchaseTransaction>
     * }
     */
    public function getDashboard(Store $store): array
    {
        $products = $store->products()
            ->latest('created_at')
            ->get();

        $transactions = PurchaseTransaction::query()
            ->where('seller_id', $store->owner_id)
            ->latest('created_at')
            ->get();

        $growth = $this->growthProgress($store);

        return [
            'store' => $store,
            'products' => $products,
            'stats' => [
                'productCount' => $products->count(),
                'availableProductCount' => $products
                    ->where('stock', '>', 0)
                    ->count(),
                'soldOutProductCount' => $products
                    ->where('stock', 0)
                    ->count(),
                'totalStock' => (int) $products->sum('stock'),
                'salesCount' => $transactions->count(),
                'salesAmount' => (int) $transactions->sum('amount'),
                'webSalesCount' => $transactions
                    ->where('source', PurchaseSource::Web)
                    ->count(),
                'minecraftSalesCount' => $transactions
                    ->where('source', PurchaseSource::Minecraft)
                    ->count(),
                'nextLevelPoints' => $growth['nextLevelPoints'],
                'levelProgressPercent' => $growth['levelProgressPercent'],
            ],
            'recentTransactions' => $transactions->take(5),
        ];
    }

    /**
     * @return array{nextLevelPoints: int, levelProgressPercent: int}
     */
    private function growthProgress(Store $store): array
    {
        /** @var array<int, int> $thresholds */
        $thresholds = config('minetenant.store_growth.level_thresholds', []);
        $currentThreshold = $thresholds[$store->level] ?? 0;
        $nextThreshold = $thresholds[$store->level + 1] ?? null;

        if ($nextThreshold === null) {
            return [
                'nextLevelPoints' => 0,
                'levelProgressPercent' => 100,
            ];
        }

        $levelRange = max(1, $nextThreshold - $currentThreshold);
        $earnedInLevel = max(0, $store->points - $currentThreshold);

        return [
            'nextLevelPoints' => max(0, $nextThreshold - $store->points),
            'levelProgressPercent' => (int) min(
                100,
                round(($earnedInLevel / $levelRange) * 100),
            ),
        ];
    }
}
