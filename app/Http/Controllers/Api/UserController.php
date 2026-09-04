<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Resources\UserResource;
use App\Models\User;
use Dedoc\Scramble\Attributes\Group;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

#[Group('ユーザー', weight: 6)]
final class UserController extends Controller
{
    /**
     * ユーザーの一覧を見る
     *
     * ログインが必要です。デモ用のユーザー一覧を返します。
     * このAPIを呼び出してもログインはできません。ログインには認証グループのログインAPIを使ってください。
     */
    public function index(): AnonymousResourceCollection
    {
        $users = User::query()
            ->with('store')
            ->orderBy('name')
            ->get();

        return UserResource::collection($users);
    }
}
