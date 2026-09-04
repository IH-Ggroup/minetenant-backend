<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Dedoc\Scramble\Attributes\Group;
use Illuminate\Http\Response;

#[Group('動作確認', weight: 0)]
final class HelloController extends Controller
{
    /**
     * APIの起動を確認する
     *
     * ログイン不要です。成功は200で、MineTenant API is running.という文字列を返します。
     */
    public function __invoke(): Response
    {
        return response(
            content: 'MineTenant API is running.',
            headers: ['Content-Type' => 'text/plain; charset=UTF-8'],
        );
    }
}
