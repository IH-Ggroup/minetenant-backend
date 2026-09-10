import type {
  ProductRow,
  StoreRow,
  Timestamp,
  TransactionRow,
  UserRow,
} from './types.js';

// Laravel's Carbon::toISOString() uses UTC with six fractional digits.
export function serializeTimestamp(value: Timestamp): string | null {
  if (value === null) return null;
  const raw = value instanceof Date ? value.toISOString() : value;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z)?$/.exec(
      raw,
    );
  if (match)
    return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(6, '0')}Z`;
  return new Date(raw).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export function serializeProduct(product: ProductRow) {
  return {
    id: product.id,
    storeId: product.store_id,
    sellerId: product.seller_id,
    name: product.name,
    description: product.description,
    price: Number(product.price),
    stock: Number(product.stock),
    category: product.category,
    theme: product.theme,
    emoji: product.emoji,
    createdAt: serializeTimestamp(product.created_at),
  };
}

export function serializeStore(store: StoreRow) {
  return {
    id: store.id,
    ownerId: store.owner_id,
    name: store.name,
    description: store.description,
    level: Number(store.level),
    points: Number(store.points),
    syncStatus: store.sync_status,
  };
}

export function serializeTransaction(transaction: TransactionRow) {
  return {
    id: transaction.id,
    productId: transaction.product_id,
    buyerId: transaction.buyer_id,
    sellerId: transaction.seller_id,
    source: transaction.source,
    amount: Number(transaction.amount),
    status: transaction.status,
    createdAt: serializeTimestamp(transaction.created_at),
  };
}

export function serializeUser(user: UserRow) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    roleLabel: user.role_label,
    avatarInitial: user.avatar_initial,
    storeId: user.store_id ?? null,
  };
}
