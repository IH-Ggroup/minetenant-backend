<?php

declare(strict_types=1);

namespace App\Exceptions;

final class RequestIdConflictException extends PurchaseDomainException
{
    public function __construct()
    {
        parent::__construct(
            message: '同じrequestIdが別の購入内容ですでに使用されています。',
            errorCode: 'REQUEST_ID_CONFLICT',
            statusCode: 409,
            field: 'requestId',
        );
    }
}
