<?php

use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return response()->json([
        'service' => 'MineTenant Backend',
        'status' => 'ok',
        'hello' => url('/api/hello'),
        'health' => url('/up'),
        'docs' => app()->environment('local') ? url('/docs/api') : null,
    ]);
});
