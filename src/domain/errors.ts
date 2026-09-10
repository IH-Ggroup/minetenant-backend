export type ValidationErrors = Record<string, string[]>;

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly errors?: ValidationErrors;

  constructor(
    status: number,
    message: string,
    options: { code?: string; errors?: ValidationErrors } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code;
    this.errors = options.errors;
  }
}

export class ValidationError extends HttpError {
  constructor(errors: ValidationErrors) {
    const messages = Object.values(errors).flat();
    const additional = messages.length - 1;
    const suffix =
      additional > 0
        ? ` (and ${additional} more error${additional === 1 ? '' : 's'})`
        : '';
    super(422, `${messages[0] ?? 'The given data was invalid.'}${suffix}`, {
      errors,
    });
    this.name = 'ValidationError';
  }
}

export function notFound(): never {
  throw new HttpError(404, 'Not Found');
}

export function selfPurchase(): never {
  const message = '自分が出品した商品は購入できません。';
  throw new HttpError(422, message, {
    code: 'SELF_PURCHASE',
    errors: { buyerId: [message] },
  });
}

export function outOfStock(): never {
  throw new HttpError(409, 'この商品は売り切れのため購入できません。', {
    code: 'OUT_OF_STOCK',
  });
}

export function requestIdConflict(): never {
  const message = '同じrequestIdが別の購入内容ですでに使用されています。';
  throw new HttpError(409, message, {
    code: 'REQUEST_ID_CONFLICT',
    errors: { requestId: [message] },
  });
}
