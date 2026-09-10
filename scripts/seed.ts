import 'dotenv/config';
import { hash } from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db.js';

const products = [
  [
    'product-hoodie',
    'store-mine',
    'user-seller',
    'コバルトブルーのパーカー',
    '深い青色と、ゆったりしたシルエットが特徴のパーカーです。普段使いしやすい厚さに仕上げました。',
    6800,
    3,
    'fashion',
    'ocean',
    '🧥',
    '2026-07-18 09:00:00',
  ],
  [
    'product-stool',
    'store-mine',
    'user-seller',
    '森の木製スツール',
    '天然木の表情を残して仕上げた小さなスツールです。椅子としても飾り台としても使えます。',
    4200,
    2,
    'interior',
    'forest',
    '🪵',
    '2026-07-17 04:30:00',
  ],
  [
    'product-notebook',
    'store-mine',
    'user-seller',
    'エンチャント風ノート',
    '紫色の表紙に箔押しを施したハンドメイドノート。冒険の記録やアイデア帳におすすめです。',
    1800,
    0,
    'hobby',
    'amethyst',
    '📕',
    '2026-07-16 12:00:00',
  ],
  [
    'product-pendant',
    'store-yamada',
    'user-buyer',
    '鉱石モチーフペンダント',
    '光を受けてきらめく鉱石をイメージしたペンダントです。長さを調整できるコードを使用しています。',
    3200,
    4,
    'accessory',
    'sunset',
    '💎',
    '2026-07-15 07:00:00',
  ],
  [
    'product-toolbag',
    'store-yamada',
    'user-buyer',
    '手織りツールバッグ',
    '丈夫な帆布で作った道具入れです。内側を仕切り、細かな道具も迷子になりにくくしました。',
    5800,
    1,
    'tool',
    'sand',
    '👜',
    '2026-07-14 03:15:00',
  ],
  [
    'product-lamp',
    'store-yamada',
    'user-buyer',
    '苔むしたランタン',
    '森の遺跡に置かれたランタンをイメージした小型照明です。やわらかな暖色の光が広がります。',
    7500,
    5,
    'interior',
    'moss',
    '🏮',
    '2026-07-13 10:45:00',
  ],
];

/** Only populate an empty database; never reset stock, accounts, or passwords. */
export async function seedDemo(
  db: Database,
  bcryptRounds = 12,
): Promise<boolean> {
  const password = await hash('password', bcryptRounds);
  return db.transaction(async (tx) => {
    for (const table of [
      'users',
      'stores',
      'products',
      'purchase_transactions',
    ]) {
      const rows = await tx.query(`SELECT id FROM ${table} LIMIT 1 FOR UPDATE`);
      if (rows.length) return false;
    }
    const seededAt = '2026-07-13 00:00:00';
    for (const user of [
      [
        'user-buyer',
        '山田 みどり',
        'demo@minetenant.jp',
        'buyer',
        '購入者デモ',
        '山',
      ],
      [
        'user-seller',
        '青鉱舎 店長',
        'seller@minetenant.jp',
        'seller',
        '出品者デモ',
        'M',
      ],
    ]) {
      await tx.execute(
        `INSERT INTO users (id,name,email,role,role_label,avatar_initial,password,email_verified_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [...user, password, seededAt, seededAt, seededAt],
      );
    }
    for (const store of [
      [
        'store-mine',
        'user-seller',
        'BLUE ORE STUDIO',
        '青い鉱石を目印に、暮らしの道具と出会う店。',
        3,
        420,
        'connected',
      ],
      [
        'store-yamada',
        'user-buyer',
        'YAMADA CRAFT',
        '日常にひとつ、手仕事の温かさを。',
        1,
        40,
        'connected',
      ],
    ]) {
      await tx.execute(
        `INSERT INTO stores (id,owner_id,name,description,level,points,sync_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [...store, seededAt, seededAt],
      );
    }
    for (const product of products) {
      await tx.execute(
        `INSERT INTO products (id,store_id,seller_id,name,description,price,stock,category,theme,emoji,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...product, product[10]],
      );
    }
    await tx.execute(
      `INSERT INTO purchase_transactions
      (id,request_id,product_id,buyer_id,seller_id,source,amount,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        'transaction-demo',
        'request-demo',
        'product-stool',
        'user-buyer',
        'user-seller',
        'minecraft',
        4200,
        'shipping',
        '2026-07-21 08:30:00',
        '2026-07-21 08:30:00',
      ],
    );
    return true;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = readConfig();
  if (config.appEnv !== 'local')
    throw new Error('Demo seeding is only allowed with APP_ENV=local.');
  const db = createDatabase(config);
  try {
    console.log(
      (await seedDemo(db, config.bcryptRounds))
        ? 'Demo data created.'
        : 'Existing data preserved; seeding skipped.',
    );
  } finally {
    await db.close();
  }
}
