<?php

declare(strict_types=1);

use App\Http\Controllers\Api\AuthController;
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
    Route::middleware('web')->group(function (): void {
        Route::get('/auth/csrf-cookie', [AuthController::class, 'csrfCookie']);
        Route::post('/auth/register', [AuthController::class, 'register'])
            ->middleware('throttle:web-auth');
        Route::post('/auth/login', [AuthController::class, 'login'])
            ->middleware('throttle:web-auth');

        Route::get('/products', [ProductController::class, 'index']);
        Route::get('/products/{product}', [ProductController::class, 'show']);
        Route::get('/stores/{store}', [StoreController::class, 'show']);

        Route::middleware('auth:web')->group(function (): void {
            Route::get('/auth/me', [AuthController::class, 'me']);
            Route::post('/auth/logout', [AuthController::class, 'logout']);
            Route::get('/users', [UserController::class, 'index']);
            Route::post('/products', [ProductController::class, 'store']);
            Route::delete('/products/{product}', [ProductController::class, 'destroy']);
            Route::post('/purchases', [PurchaseController::class, 'storeFromBody']);
            Route::post('/products/{product}/purchases', [PurchaseController::class, 'store']);
            Route::get('/stores/{store}/dashboard', [StoreController::class, 'dashboard']);
            Route::get('/transactions', [TransactionController::class, 'index']);
            Route::get('/transactions/{transaction}', [TransactionController::class, 'show']);
        });
    });

    Route::get(
        '/minecraft/catalog',
        [MinecraftController::class, 'catalog'],
    );
    Route::post(
        '/minecraft/purchases',
        [MinecraftController::class, 'purchase'],
    );
});
