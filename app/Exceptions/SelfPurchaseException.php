<?php

declare(strict_types=1);

namespace App\Exceptions;

final class SelfPurchaseException extends PurchaseDomainException
{
    public function __construct()
    {
        parent::__construct(
            message: '自分が出品した商品は購入できません。',
            errorCode: 'SELF_PURCHASE',
            statusCode: 422,
            field: 'buyerId',
        );
    }
}
