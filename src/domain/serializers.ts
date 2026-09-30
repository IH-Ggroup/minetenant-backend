import { isCanonicalUsername } from './auth-credentials.js';
import type {
  ProductRow,
  SessionUser,
  SessionUserRow,
  StoreRow,
  Timestamp,
  TransactionRow,
  UserRow,
} from './types.js';

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

export class SessionUserSerializationError extends Error {
  readonly code = 'MINETENANT_AUTH_SESSION_USER_INVALID';

  constructor() {
    super('The authenticated user row cannot be serialized.');
    this.name = 'SessionUserSerializationError';
  }
}

function invalidSessionUser(): never {
  throw new SessionUserSerializationError();
}

function sessionRoleLabel(
  role: SessionUserRow['role'],
): SessionUser['roleLabel'] {
  switch (role) {
    case 'buyer':
      return '購入者';
    case 'seller':
      return '出品者';
    default:
      return invalidSessionUser();
  }
}

// API timestamps use UTC with six fractional digits.
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
    id: product.product_id,
    storeId: product.store_id,
    sellerId: product.user_id,
    name: product.name,
    description: product.description,
    price: Number(product.price),
    status: product.status,
    category: product.category,
    theme: product.theme,
    emoji: product.emoji,
    createdAt: serializeTimestamp(product.created_at),
  };
}

export function serializeStore(store: StoreRow) {
  return {
    id: store.store_id,
    ownerId: store.user_id,
    name: store.name,
    description: store.description,
    level: Number(store.level),
    points: Number(store.points),
    syncStatus: store.sync_status,
  };
}

export function serializeTransaction(transaction: TransactionRow) {
  return {
    id: transaction.transaction_id,
    productId: transaction.product_id,
    buyerId: transaction.buyer_user_id,
    sellerId: transaction.seller_user_id,
    source: transaction.source,
    amount: Number(transaction.amount),
    status: transaction.status,
    createdAt: serializeTimestamp(transaction.created_at),
  };
}

export function serializeUser(user: UserRow) {
  return {
    id: user.user_id,
    name: user.name,
    role: user.role,
    roleLabel: user.role_label,
    avatarInitial: user.avatar_initial,
    storeId: user.store_id ?? null,
  };
}

export function serializeSessionUser(user: SessionUserRow): SessionUser {
  if (
    typeof user !== 'object' ||
    user === null ||
    typeof user.user_id !== 'string' ||
    user.user_id.length === 0 ||
    typeof user.username !== 'string' ||
    !isCanonicalUsername(user.username) ||
    typeof user.display_name !== 'string' ||
    user.display_name.length === 0 ||
    user.display_name.trim() !== user.display_name ||
    typeof user.password_hash !== 'string' ||
    user.password_hash.length === 0 ||
    (user.store_id !== null &&
      (typeof user.store_id !== 'string' || user.store_id.length === 0))
  ) {
    invalidSessionUser();
  }

  const segments = graphemeSegmenter.segment(user.display_name);
  const first = segments[Symbol.iterator]().next();
  if (first.done) invalidSessionUser();

  return {
    id: user.user_id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    roleLabel: sessionRoleLabel(user.role),
    avatarInitial: first.value.segment,
    storeId: user.store_id,
  };
}
