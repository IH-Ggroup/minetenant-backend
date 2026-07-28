<?php

namespace App\Enums;

enum TransactionStatus: string
{
    case Paid = 'paid';
    case Shipping = 'shipping';
    case Complete = 'complete';
}
