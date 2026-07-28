<?php

return [
    'store_growth' => [
        'sale_points' => (int) env('STORE_SALE_POINTS', 100),
        'level_thresholds' => [
            1 => 0,
            2 => 100,
            3 => 300,
            4 => 600,
            5 => 1000,
        ],
    ],
];
