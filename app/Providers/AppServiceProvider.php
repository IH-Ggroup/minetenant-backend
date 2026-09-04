<?php

namespace App\Providers;

use App\Support\ApiRequestExamples;
use Dedoc\Scramble\Scramble;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Scramble::configure()->withOperationTransformers(ApiRequestExamples::class);

        RateLimiter::for('web-auth', function (Request $request): array {
            $emailInput = $request->input('email', '');
            $email = is_string($emailInput) ? mb_strtolower(trim($emailInput)) : '';

            return [
                Limit::perMinute(30)->by('web-auth-ip:'.$request->ip()),
                Limit::perMinute(5)->by('web-auth-email:'.$email.'|'.$request->ip()),
            ];
        });
    }
}
