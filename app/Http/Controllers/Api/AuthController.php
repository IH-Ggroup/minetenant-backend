<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Enums\StoreSyncStatus;
use App\Enums\UserRole;
use App\Http\Controllers\Controller;
use App\Http\Requests\LoginRequest;
use App\Http\Requests\RegisterRequest;
use App\Http\Resources\UserResource;
use App\Models\User;
use Dedoc\Scramble\Attributes\Group;
use Dedoc\Scramble\Attributes\Response as ApiResponse;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

#[Group('認証', weight: 1)]
final class AuthController extends Controller
{
    /**
     * CSRF Cookieを準備する
     *
     * ログインや登録の前に呼び出します。成功は204（本文なし）です。
     * XSRF-TOKEN CookieとセッションCookieがブラウザに保存されます。
     * WebのPOST・DELETEでは、XSRF-TOKENをURLデコードした値をX-XSRF-TOKENヘッダーに付けます。
     */
    public function csrfCookie(): Response
    {
        return response()->noContent();
    }

    /**
     * ユーザーを登録する
     *
     * CSRF Cookieが必要です。名前・メールアドレス・パスワードからユーザーと店舗を作り、
     * そのユーザーでログインします。成功は201です。同じメールアドレスは登録できません（422）。
     */
    #[ApiResponse(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    #[ApiResponse(429, '短時間に登録・ログインを試しすぎました。少し待ってから再度お試しください。', type: 'array{message: string}')]
    public function register(RegisterRequest $request): JsonResponse
    {
        $data = $request->validated();

        try {
            $user = DB::transaction(function () use ($data): User {
                $user = User::query()->create([
                    'name' => $data['name'],
                    'email' => $data['email'],
                    'password' => $data['password'],
                    'role' => UserRole::Buyer,
                    'role_label' => '購入者',
                    'avatar_initial' => mb_substr($data['name'], 0, 1),
                ]);

                $user->store()->create([
                    'name' => $data['name'].'の店舗',
                    'description' => '',
                    'level' => 1,
                    'points' => 0,
                    'sync_status' => StoreSyncStatus::Offline,
                ]);

                return $user;
            });
        } catch (UniqueConstraintViolationException $exception) {
            if (! User::query()->where('email', $data['email'])->exists()) {
                throw $exception;
            }

            throw ValidationException::withMessages([
                'email' => ['このメールアドレスは既に登録されています。'],
            ]);
        }

        Auth::guard('web')->login($user);
        $request->session()->regenerate();

        return (new UserResource($user->load('store')))
            ->response()
            ->setStatusCode(201);
    }

    /**
     * ログインする
     *
     * 先にCSRF Cookieを準備してください。成功は200で、以後はセッションCookieで本人を確認します。
     * 初期データの購入者はdemo@minetenant.jp、出品者はseller@minetenant.jp、パスワードはどちらもpasswordです。
     * メールアドレスかパスワードが違う場合は422です。
     */
    #[ApiResponse(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    #[ApiResponse(429, '短時間に登録・ログインを試しすぎました。少し待ってから再度お試しください。', type: 'array{message: string}')]
    public function login(LoginRequest $request): JsonResponse
    {
        if (! Auth::guard('web')->attempt($request->validated())) {
            throw ValidationException::withMessages([
                'email' => ['メールアドレスまたはパスワードが正しくありません。'],
            ]);
        }

        $request->session()->regenerate();

        return (new UserResource($request->user('web')->load('store')))
            ->response()
            ->setStatusCode(200);
    }

    /**
     * ログアウトする
     *
     * ログインとCSRF Cookieが必要です。成功は204（本文なし）で、現在のセッションを無効にします。
     */
    #[ApiResponse(419, 'CSRF CookieまたはX-XSRF-TOKENヘッダーが不足・不一致です。CSRF Cookieを準備し直してください。', type: 'array{message: string}')]
    public function logout(Request $request): Response
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    /**
     * ログイン中の自分を確認する
     *
     * 成功は200で、自分のユーザー情報と店舗情報を返します。未ログインの場合は401です。
     * ページを再読み込みした後のログイン状態の確認にも使えます。
     */
    public function me(Request $request): JsonResponse
    {
        return (new UserResource($request->user('web')->load('store')))
            ->response()
            ->setStatusCode(200);
    }
}
