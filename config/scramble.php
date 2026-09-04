<?php

use App\Support\SessionCookieSecurityStrategy;
use Dedoc\Scramble\Http\Middleware\RestrictedDocsAccess;

return [
    'api_path' => 'api',
    'dev_tools' => ['enabled' => false],
    'info' => [
        'version' => '1.0.0',
        'description' => <<<'MARKDOWN'
MineTenantのAPI一覧です。左のメニューから機能を選び、**Test Request**で入力欄を開き、**Send**でAPIを実行できます。

**まずは「APIの起動を確認する」か「商品の一覧を確認・検索する」を試してください。** GETはデータを読む操作です。POST・DELETEはデータを変更します。

### ログインして購入を試す

1. 「CSRF Cookieを準備する」を送信する。**204**で本文が空なら成功。
2. 「ログインする」を開き、`demo@minetenant.jp` / `password`で送信する。**200**なら成功。
3. 「ログイン中の自分を確認する」で`user-buyer`を確認する。
4. 「商品IDを本文に入れて購入する」を送信する。購入前に商品の在庫を確認してください。

CookieとCSRFヘッダーはこの画面が自動で送信します。**Authentication欄にトークンを入力する必要はありません。**

購入は初回**201**、同じ`requestId`・同じ内容の再送は**200**です。同じ購入を再送するときは`requestId`を変えないでください。新しいIDは別の購入になります。

### 返答の見方

| ステータス | 意味 |
| --- | --- |
| 200 / 201 | 成功。通常は`data`の中に結果があります |
| 204 | 成功。本文はありません |
| 401 | ログインが必要です |
| 403 | このユーザーでは操作できません |
| 409 | 在庫切れ・購入番号の競合など。本文を確認してください |
| 419 | ログインの準備からやり直してください |
| 422 | 入力内容を確認してください |

この画面は開発用です。実行すると、起動しているAPIのDBが更新されます。Minecraft専用APIは別のグループにまとめています。
MARKDOWN,
    ],
    'ui' => [
        'title' => 'MineTenant API一覧・動作確認',
    ],
    'renderer' => 'scalar',
    'renderers' => [
        'scalar' => [
            'view' => 'scramble::scalar',
            'cdn' => 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.js',
            'theme' => 'default',
            'darkMode' => false,
            // The docs and API share an origin; keep local requests out of external proxies.
            'proxyUrl' => null,
            'credentials' => 'include',
            'showDeveloperTools' => 'never',
            'agent' => ['disabled' => true],
            'mcp' => ['disabled' => true],
            'hideClientButton' => true,
            'hideModels' => true,
            'defaultRequestBodyView' => 'form',
            'persistAuth' => false,
        ],
    ],
    'servers' => [
        'このPCのAPI' => '/api',
    ],
    'security_strategy' => SessionCookieSecurityStrategy::class,
    'middleware' => [
        'web',
        RestrictedDocsAccess::class,
    ],
];
