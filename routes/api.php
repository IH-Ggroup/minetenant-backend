<?php

declare(strict_types=1);

use App\Http\Controllers\Api\HelloController;
use App\Http\Controllers\Api\MinecraftController;
use App\Http\Controllers\Api\ProductController;
use App\Http\Controllers\Api\PurchaseController;
use App\Http\Controllers\Api\StoreController;
use App\Http\Controllers\Api\TransactionController;
use App\Http\Controllers\Api\UserController;
use Illuminate\Support\Facades\Route;

Route::get('/hello', HelloController::class);

Route::prefix('v1')->group(function (): void {
    Route::get('/users', [UserController::class, 'index']);

    Route::get('/products', [ProductController::class, 'index']);
    Route::get('/products/{product}', [ProductController::class, 'show']);
    Route::post('/products', [ProductController::class, 'store']);
    Route::post(
        '/products/{product}/purchases',
        [PurchaseController::class, 'store'],
    );

    Route::get('/stores/{store}', [StoreController::class, 'show']);
    Route::get(
        '/stores/{store}/dashboard',
        [StoreController::class, 'dashboard'],
    );

    Route::get('/transactions', [TransactionController::class, 'index']);

    Route::get(
        '/minecraft/catalog',
        [MinecraftController::class, 'catalog'],
    );
    Route::post(
        '/minecraft/purchases',
        [MinecraftController::class, 'purchase'],
    );
});
