<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\Store;

final class StoreGrowthService
{
    public function recordSale(Store $store): Store
    {
        $salePoints = max(
            0,
            (int) config('minetenant.store_growth.sale_points', 100),
        );

        $store->points += $salePoints;
        $store->level = $this->levelForPoints($store->points);
        $store->save();

        return $store;
    }

    public function levelForPoints(int $points): int
    {
        /** @var array<int|string, int|string> $configuredThresholds */
        $configuredThresholds = config(
            'minetenant.store_growth.level_thresholds',
            [
                1 => 0,
                2 => 100,
                3 => 300,
                4 => 600,
                5 => 1000,
            ],
        );

        $thresholds = [];

        foreach ($configuredThresholds as $level => $threshold) {
            $normalizedLevel = (int) $level;

            if ($normalizedLevel < 1 || $normalizedLevel > 5) {
                continue;
            }

            $thresholds[$normalizedLevel] = max(0, (int) $threshold);
        }

        ksort($thresholds);

        $currentLevel = 1;

        foreach ($thresholds as $level => $threshold) {
            if ($points >= $threshold) {
                $currentLevel = $level;
            }
        }

        return min(5, max(1, $currentLevel));
    }
}
