<?php

namespace App\Enums;

enum StoreSyncStatus: string
{
    case Connected = 'connected';
    case Syncing = 'syncing';
    case Offline = 'offline';
}
