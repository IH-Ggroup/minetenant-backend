<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\StoreDashboardResource;
use App\Http\Resources\StoreResource;
use App\Models\Store;
use App\Services\StoreDashboardService;

final class StoreController extends Controller
{
    public function __construct(
        private readonly StoreDashboardService $dashboardService,
    ) {}

    public function show(Store $store): StoreResource
    {
        return new StoreResource($store);
    }

    public function dashboard(Store $store): StoreDashboardResource
    {
        return new StoreDashboardResource(
            $this->dashboardService->getDashboard($store),
        );
    }
}
