<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\Enums\ProductCategory;
use App\Enums\ProductTheme;
use Dedoc\Scramble\Attributes\BodyParameter;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

#[BodyParameter('storeId', description: '省略すると自分の店舗のIDになります。通常は入力不要です。', required: false, type: 'string')]
#[BodyParameter('sellerId', description: '省略するとログイン中の自分のIDになります。他人のIDは指定できません。', required: false, type: 'string')]
final class CreateProductRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $this->mergeIfMissing([
            'sellerId' => $this->user()?->getAuthIdentifier(),
            'storeId' => $this->user()?->store?->id,
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'storeId' => ['required', 'string', 'exists:stores,id'],
            'sellerId' => ['required', 'string', Rule::in([$this->user()?->getAuthIdentifier()])],
            /**
             * 商品名（120文字以内）。
             *
             * @example 練習用の木製チェア
             */
            'name' => ['required', 'string', 'max:120'],
            /**
             * 商品説明（2000文字以内）。
             *
             * @example APIの出品確認で作った練習用の商品です。
             */
            'description' => ['required', 'string', 'max:2000'],
            /**
             * 販売価格（円）。1以上の整数を入力します。
             *
             * @example 1000
             */
            'price' => ['required', 'integer', 'min:1', 'max:99999999'],
            /**
             * 在庫数。0以上の整数を入力します。
             *
             * @example 2
             */
            'stock' => ['required', 'integer', 'min:0', 'max:99999'],
            /**
             * 商品カテゴリ。例のinteriorはインテリアです。
             *
             * @example interior
             */
            'category' => ['required', Rule::enum(ProductCategory::class)],
            /**
             * 商品の見た目のテーマ。例のforestは森のテーマです。
             *
             * @example forest
             */
            'theme' => ['required', Rule::enum(ProductTheme::class)],
            /**
             * 商品を表す絵文字。
             *
             * @example 🪑
             */
            'emoji' => ['required', 'string', 'max:16'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'storeId.required' => '出品する店舗を指定してください。',
            'storeId.exists' => '指定された店舗が見つかりません。',
            'sellerId.required' => '出品者を指定してください。',
            'sellerId.exists' => '指定された出品者が見つかりません。',
            'name.required' => '商品名を入力してください。',
            'description.required' => '商品説明を入力してください。',
            'price.required' => '価格を入力してください。',
            'price.integer' => '価格は整数で入力してください。',
            'price.min' => '価格は1円以上で入力してください。',
            'stock.required' => '在庫数を入力してください。',
            'stock.integer' => '在庫数は整数で入力してください。',
            'stock.min' => '在庫数は0以上で入力してください。',
            'category.required' => 'カテゴリを選択してください。',
            'theme.required' => '商品テーマを選択してください。',
            'emoji.required' => '商品を表す絵文字を指定してください。',
        ];
    }
}
