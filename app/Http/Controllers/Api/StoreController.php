<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\StoreDashboardResource;
use App\Http\Resources\StoreResource;
use App\Models\Store;
use App\Services\StoreDashboardService;
use Illuminate\Http\Request;

final class StoreController extends Controller
{
    public function __construct(
        private readonly StoreDashboardService $dashboardService,
    ) {}

    public function show(Store $store): StoreResource
    {
        return new StoreResource($store);
    }

    public function dashboard(Request $request, Store $store): StoreDashboardResource
    {
        abort_unless($store->owner_id === $request->user()->getAuthIdentifier(), 403);

        return new StoreDashboardResource(
            $this->dashboardService->getDashboard($store),
        );
    }
}
