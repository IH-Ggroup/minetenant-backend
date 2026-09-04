<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class MinecraftPurchaseRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            /**
             * 購入する商品のID。
             *
             * @example product-stool
             */
            'productId' => ['required', 'string', 'exists:products,id'],
            /**
             * Minecraft上で購入するユーザーのID。
             *
             * @example user-buyer
             */
            'buyerId' => ['required', 'string', 'exists:users,id'],
            /**
             * 1回の購入を識別する文字列。再送時は同じ値、新しい購入には新しい値を使います。
             * Web購入に使ったrequestIdは使えません。
             *
             * @example docs-minecraft-stool-001
             */
            'requestId' => ['required', 'string', 'max:100'],
            /**
             * 送信しないでください。購入元はサーバーでminecraftに固定します。
             */
            'source' => ['prohibited'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'productId.required' => '購入する商品を指定してください。',
            'productId.exists' => '指定された商品が見つかりません。',
            'buyerId.required' => '購入者を指定してください。',
            'buyerId.exists' => '指定された購入者が見つかりません。',
            'requestId.required' => '購入リクエストIDを指定してください。',
            'requestId.max' => '購入リクエストIDは100文字以内で指定してください。',
            'source.prohibited' => 'Minecraft購入では購入元を指定できません。',
        ];
    }
}
