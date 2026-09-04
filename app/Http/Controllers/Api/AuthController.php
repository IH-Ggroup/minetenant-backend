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
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

final class AuthController extends Controller
{
    public function csrfCookie(): Response
    {
        return response()->noContent();
    }

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

    public function logout(Request $request): Response
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    public function me(Request $request): JsonResponse
    {
        return (new UserResource($request->user('web')->load('store')))
            ->response()
            ->setStatusCode(200);
    }
}
