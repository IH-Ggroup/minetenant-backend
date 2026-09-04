<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

final class RegisterRequest extends FormRequest
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
             * 画面に表示する名前。
             *
             * @example 練習ユーザー
             */
            'name' => ['required', 'string', 'max:120'],
            /**
             * まだ登録されていないメールアドレス。同じ例を再送すると422になります。
             *
             * @example practice@example.com
             */
            'email' => ['required', 'string', 'email', 'max:255', Rule::unique('users', 'email')],
            /**
             * 8文字以上・72バイト以内のパスワード。
             *
             * @example practice-password
             */
            'password' => [
                'required',
                'string',
                'min:8',
                'max:72',
                'not_regex:/\x00/',
                function (string $attribute, mixed $value, Closure $fail): void {
                    if (is_string($value) && strlen($value) > 72) {
                        $fail('パスワードは72バイト以内で入力してください。');
                    }
                },
            ],
            /**
             * 確認用パスワード。省略できます。指定するときはpasswordと同じ値を入れます。
             *
             * @example practice-password
             */
            'password_confirmation' => ['sometimes', 'required', 'string', 'same:password'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'name.required' => '名前を入力してください。',
            'email.required' => 'メールアドレスを入力してください。',
            'email.email' => '有効なメールアドレスを入力してください。',
            'email.unique' => 'このメールアドレスは既に登録されています。',
            'password.required' => 'パスワードを入力してください。',
            'password.min' => 'パスワードは8文字以上で入力してください。',
            'password.max' => 'パスワードは72バイト以内で入力してください。',
            'password_confirmation.same' => '確認用パスワードが一致しません。',
        ];
    }
}
