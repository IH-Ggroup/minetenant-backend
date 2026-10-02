export const productCategories = [
  'fashion',
  'interior',
  'hobby',
  'accessory',
  'tool',
] as const;
export const productThemes = [
  'ocean',
  'forest',
  'amethyst',
  'sunset',
  'sand',
  'moss',
] as const;

export type ProductCategory = (typeof productCategories)[number];
export type ProductTheme = (typeof productThemes)[number];
export type ProductStatus = 'available' | 'sold';
export type PurchaseSource = 'web' | 'minecraft';
export type Timestamp = string | Date | null;
export type UserRole = 'buyer' | 'seller';

export interface UserRow {
  user_id: string;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  role_label: string;
  avatar_initial: string;
  store_id?: string | null;
  created_at?: Timestamp;
  updated_at?: Timestamp;
}

/** Transitional auth row used only by username-based session endpoints. */
export interface SessionUserRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  password_hash: string | null;
  role: UserRole;
  store_id: string | null;
}

/** Public user contract shared by register, login and me. */
export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly roleLabel: '購入者' | '出品者';
  readonly avatarInitial: string;
  readonly storeId: string | null;
}

export interface StoreRow {
  store_id: string;
  user_id: string;
  name: string;
  description: string;
  level: number;
  points: number;
  sync_status: 'connected' | 'syncing' | 'offline';
  created_at?: Timestamp;
  updated_at?: Timestamp;
}

export interface ProductRow {
  product_id: string;
  store_id: string;
  user_id: string;
  name: string;
  description: string;
  price: number;
  /** @deprecated Remove after all readers and writers migrate in #93. */
  stock: number;
  status: ProductStatus;
  category: ProductCategory;
  theme: ProductTheme;
  emoji: string;
  listing_request_id: string | null;
  listing_request_fingerprint: string | null;
  deleted_at: Timestamp;
  created_at: Timestamp;
  updated_at?: Timestamp;
}

export interface TransactionRow {
  transaction_id: string;
  request_id: string;
  product_id: string;
  buyer_user_id: string;
  seller_user_id: string;
  source: PurchaseSource;
  amount: number;
  status: 'paid' | 'shipping' | 'complete';
  created_at: Timestamp;
  updated_at?: Timestamp;
}

export interface CreateProductInput {
  storeId: string;
  sellerId: string;
  name: string;
  description: string;
  price: number;
  /** @deprecated Dual-write in #52, then remove after the #93 cutover. */
  stock: number;
  category: ProductCategory;
  theme: ProductTheme;
  emoji: string;
}

export interface PurchaseInput {
  productId: string;
  buyerId: string;
  source: PurchaseSource;
  requestId: string;
}
