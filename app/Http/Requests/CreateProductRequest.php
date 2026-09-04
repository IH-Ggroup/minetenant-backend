<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\Enums\ProductCategory;
use App\Enums\ProductTheme;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

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
            'name' => ['required', 'string', 'max:120'],
            'description' => ['required', 'string', 'max:2000'],
            'price' => ['required', 'integer', 'min:1', 'max:99999999'],
            'stock' => ['required', 'integer', 'min:0', 'max:99999'],
            'category' => ['required', Rule::enum(ProductCategory::class)],
            'theme' => ['required', Rule::enum(ProductTheme::class)],
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
