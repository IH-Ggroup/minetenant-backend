<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\StoreDashboardResource;
use App\Http\Resources\StoreResource;
use App\Models\Store;
use App\Services\StoreDashboardService;
use Dedoc\Scramble\Attributes\Group;
use Dedoc\Scramble\Attributes\PathParameter;
use Dedoc\Scramble\Attributes\Response;
use Illuminate\Http\Request;

#[Group('店舗', weight: 4)]
final class StoreController extends Controller
{
    public function __construct(
        private readonly StoreDashboardService $dashboardService,
    ) {}

    /**
     * 店舗の公開情報を見る
     *
     * ログイン不要です。店舗名・レベル・ポイントなどを返します。存在しない店舗IDは404です。
     */
    #[PathParameter('store', description: '店舗のid。初期データのstore-mineは出品者の店舗です。', type: 'string', example: 'store-mine')]
    #[Response(404, '指定した店舗が見つかりません。', type: 'array{message: string}')]
    public function show(Store $store): StoreResource
    {
        return new StoreResource($store);
    }

    /**
     * 自分の店舗の売上・商品を確認する
     *
     * ログインが必要です。指定した店舗の所有者だけが見られます。他人の店舗は403です。
     * store-mineを確認するときはseller@minetenant.jp / passwordでログインしてください。
     * 購入者demo@minetenant.jpでログインしている場合は、自分の店舗store-yamadaを指定します。
     */
    #[PathParameter('store', description: 'ログイン中の自分が所有する店舗のid。', type: 'string', example: 'store-mine')]
    #[Response(403, 'この店舗を所有するユーザーだけが確認できます。', type: 'array{message: string}')]
    #[Response(404, '指定した店舗が見つかりません。', type: 'array{message: string}')]
    public function dashboard(Request $request, Store $store): StoreDashboardResource
    {
        abort_unless($store->owner_id === $request->user()->getAuthIdentifier(), 403);

        return new StoreDashboardResource(
            $this->dashboardService->getDashboard($store),
        );
    }
}
