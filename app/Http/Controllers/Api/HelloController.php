<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Response;

final class HelloController extends Controller
{
    public function __invoke(): Response
    {
        return response(
            content: 'MineTenant API is running.',
            headers: ['Content-Type' => 'text/plain; charset=UTF-8'],
        );
    }
}
