<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

final class PurchaseProductRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $this->mergeIfMissing([
            'buyerId' => $this->user()?->getAuthIdentifier(),
            'source' => 'web',
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $product = $this->route('product');

        return [
            'productId' => [
                Rule::requiredIf($product === null),
                'string',
                'exists:products,id',
                ...($product === null ? [] : [Rule::in([$product->id])]),
            ],
            'buyerId' => ['required', 'string', Rule::in([$this->user()?->getAuthIdentifier()])],
            'source' => ['required', Rule::in(['web'])],
            'requestId' => ['required', 'string', 'max:100'],
        ];
    }

    /**
     * @return array<string, string>
     */
    public function messages(): array
    {
        return [
            'buyerId.required' => '購入者を指定してください。',
            'buyerId.exists' => '指定された購入者が見つかりません。',
            'source.required' => '購入元を指定してください。',
            'source.in' => 'Web購入では購入元にwebを指定してください。',
            'requestId.required' => '購入リクエストIDを指定してください。',
            'requestId.max' => '購入リクエストIDは100文字以内で指定してください。',
        ];
    }
}
