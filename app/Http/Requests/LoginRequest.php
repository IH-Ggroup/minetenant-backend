<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;

final class LoginRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        if (is_string($this->input('email'))) {
            $this->merge([
                'email' => Str::lower(trim($this->input('email'))),
            ]);
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            /**
             * 登録済みメールアドレス。例は初期データの購入者です。
             *
             * @example demo@minetenant.jp
             */
            'email' => ['required', 'string', 'email', 'max:255'],
            /**
             * 登録時のパスワード。初期データではpasswordです。
             *
             * @example password
             */
            'password' => [
                'required',
                'string',
                'max:72',
                'not_regex:/\x00/',
                function (string $attribute, mixed $value, Closure $fail): void {
                    if (is_string($value) && strlen($value) > 72) {
                        $fail('パスワードは72バイト以内で入力してください。');
                    }
                },
            ],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'email.required' => 'メールアドレスを入力してください。',
            'email.email' => '有効なメールアドレスを入力してください。',
            'password.required' => 'パスワードを入力してください。',
        ];
    }
}
