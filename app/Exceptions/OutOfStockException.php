<?php

declare(strict_types=1);

namespace App\Exceptions;

final class OutOfStockException extends PurchaseDomainException
{
    public function __construct()
    {
        parent::__construct(
            message: 'この商品は売り切れのため購入できません。',
            errorCode: 'OUT_OF_STOCK',
            statusCode: 409,
        );
    }
}
