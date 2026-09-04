<?php

declare(strict_types=1);

namespace App\Support;

use Dedoc\Scramble\SecurityDocumentation\MiddlewareAuthSecurityStrategy;
use Dedoc\Scramble\Support\Generator\SecurityScheme;

final class SessionCookieSecurityStrategy extends MiddlewareAuthSecurityStrategy
{
    public function __construct()
    {
        parent::__construct(
            middleware: ['auth:web'],
            scheme: SecurityScheme::apiKey('cookie', (string) config('session.cookie'))
                ->as('session')
                ->setDescription('ログインAPIでログインすると、ブラウザがCookieを自動送信します。認証欄への値の入力は不要です。'),
        );
    }
}
