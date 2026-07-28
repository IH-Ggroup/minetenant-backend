<?php

namespace Database\Seeders;

use App\Enums\ProductCategory;
use App\Enums\ProductTheme;
use App\Enums\PurchaseSource;
use App\Enums\StoreSyncStatus;
use App\Enums\TransactionStatus;
use App\Enums\UserRole;
use App\Models\Product;
use App\Models\PurchaseTransaction;
use App\Models\Store;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;

class DemoSeeder extends Seeder
{
    /**
     * Seed the frontend demo records.
     */
    public function run(): void
    {
        $seededAt = Carbon::parse('2026-07-13 00:00:00', 'UTC');

        $users = [
            [
                'id' => 'user-buyer',
                'name' => '山田 みどり',
                'email' => 'demo@minetenant.jp',
                'password' => Hash::make('password'),
                'role' => UserRole::Buyer,
                'role_label' => '購入者デモ',
                'avatar_initial' => '山',
                'email_verified_at' => $seededAt,
                'created_at' => $seededAt,
                'updated_at' => $seededAt,
            ],
            [
                'id' => 'user-seller',
                'name' => '青鉱舎 店長',
                'email' => 'seller@minetenant.jp',
                'password' => Hash::make('password'),
                'role' => UserRole::Seller,
                'role_label' => '出品者デモ',
                'avatar_initial' => 'M',
                'email_verified_at' => $seededAt,
                'created_at' => $seededAt,
                'updated_at' => $seededAt,
            ],
        ];

        foreach ($users as $attributes) {
            $user = User::query()->find($attributes['id']) ?? new User;
            $user->forceFill($attributes)->save();
        }

        $stores = [
            [
                'id' => 'store-mine',
                'owner_id' => 'user-seller',
                'name' => 'BLUE ORE STUDIO',
                'description' => '青い鉱石を目印に、暮らしの道具と出会う店。',
                'level' => 3,
                'points' => 420,
                'sync_status' => StoreSyncStatus::Connected,
                'created_at' => $seededAt,
                'updated_at' => $seededAt,
            ],
            [
                'id' => 'store-yamada',
                'owner_id' => 'user-buyer',
                'name' => 'YAMADA CRAFT',
                'description' => '日常にひとつ、手仕事の温かさを。',
                'level' => 1,
                'points' => 40,
                'sync_status' => StoreSyncStatus::Connected,
                'created_at' => $seededAt,
                'updated_at' => $seededAt,
            ],
        ];

        foreach ($stores as $attributes) {
            $store = Store::query()->find($attributes['id']) ?? new Store;
            $store->forceFill($attributes)->save();
        }

        $products = [
            [
                'id' => 'product-hoodie',
                'store_id' => 'store-mine',
                'seller_id' => 'user-seller',
                'name' => 'コバルトブルーのパーカー',
                'description' => '深い青色と、ゆったりしたシルエットが特徴のパーカーです。普段使いしやすい厚さに仕上げました。',
                'price' => 6800,
                'stock' => 3,
                'category' => ProductCategory::Fashion,
                'theme' => ProductTheme::Ocean,
                'emoji' => '🧥',
                'created_at' => Carbon::parse('2026-07-18 09:00:00', 'UTC'),
            ],
            [
                'id' => 'product-stool',
                'store_id' => 'store-mine',
                'seller_id' => 'user-seller',
                'name' => '森の木製スツール',
                'description' => '天然木の表情を残して仕上げた小さなスツールです。椅子としても飾り台としても使えます。',
                'price' => 4200,
                'stock' => 2,
                'category' => ProductCategory::Interior,
                'theme' => ProductTheme::Forest,
                'emoji' => '🪵',
                'created_at' => Carbon::parse('2026-07-17 04:30:00', 'UTC'),
            ],
            [
                'id' => 'product-notebook',
                'store_id' => 'store-mine',
                'seller_id' => 'user-seller',
                'name' => 'エンチャント風ノート',
                'description' => '紫色の表紙に箔押しを施したハンドメイドノート。冒険の記録やアイデア帳におすすめです。',
                'price' => 1800,
                'stock' => 0,
                'category' => ProductCategory::Hobby,
                'theme' => ProductTheme::Amethyst,
                'emoji' => '📕',
                'created_at' => Carbon::parse('2026-07-16 12:00:00', 'UTC'),
            ],
            [
                'id' => 'product-pendant',
                'store_id' => 'store-yamada',
                'seller_id' => 'user-buyer',
                'name' => '鉱石モチーフペンダント',
                'description' => '光を受けてきらめく鉱石をイメージしたペンダントです。長さを調整できるコードを使用しています。',
                'price' => 3200,
                'stock' => 4,
                'category' => ProductCategory::Accessory,
                'theme' => ProductTheme::Sunset,
                'emoji' => '💎',
                'created_at' => Carbon::parse('2026-07-15 07:00:00', 'UTC'),
            ],
            [
                'id' => 'product-toolbag',
                'store_id' => 'store-yamada',
                'seller_id' => 'user-buyer',
                'name' => '手織りツールバッグ',
                'description' => '丈夫な帆布で作った道具入れです。内側を仕切り、細かな道具も迷子になりにくくしました。',
                'price' => 5800,
                'stock' => 1,
                'category' => ProductCategory::Tool,
                'theme' => ProductTheme::Sand,
                'emoji' => '👜',
                'created_at' => Carbon::parse('2026-07-14 03:15:00', 'UTC'),
            ],
            [
                'id' => 'product-lamp',
                'store_id' => 'store-yamada',
                'seller_id' => 'user-buyer',
                'name' => '苔むしたランタン',
                'description' => '森の遺跡に置かれたランタンをイメージした小型照明です。やわらかな暖色の光が広がります。',
                'price' => 7500,
                'stock' => 5,
                'category' => ProductCategory::Interior,
                'theme' => ProductTheme::Moss,
                'emoji' => '🏮',
                'created_at' => Carbon::parse('2026-07-13 10:45:00', 'UTC'),
            ],
        ];

        foreach ($products as $attributes) {
            $attributes['updated_at'] = $attributes['created_at'];

            $product = Product::query()->find($attributes['id']) ?? new Product;
            $product->forceFill($attributes)->save();
        }

        $transactionCreatedAt = Carbon::parse(
            '2026-07-21 08:30:00',
            'UTC',
        );

        $transaction = PurchaseTransaction::query()->find('transaction-demo')
            ?? new PurchaseTransaction;
        $transaction->forceFill([
            'id' => 'transaction-demo',
            'request_id' => 'request-demo',
            'product_id' => 'product-stool',
            'buyer_id' => 'user-buyer',
            'seller_id' => 'user-seller',
            'source' => PurchaseSource::Minecraft,
            'amount' => 4200,
            'status' => TransactionStatus::Shipping,
            'created_at' => $transactionCreatedAt,
            'updated_at' => $transactionCreatedAt,
        ])->save();
    }
}
