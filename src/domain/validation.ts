import { HttpError, ValidationError, type ValidationErrors } from './errors.js';

export type Input = Record<string, unknown>;

// Match Laravel Str::trim, including invisible Unicode characters and NUL.
const trimmedCharacters = String.raw`\s\0\u0085\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u202f\u205f\u2060-\u2065\u206a-\u206f\u2800\u3000\u3164\ufeff\uffa0\u{1d159}\u{1d173}-\u{1d17a}\u{e0020}`;
const trimEdges = new RegExp(
  // eslint-disable-next-line no-misleading-character-class -- These marks are intentionally trimmed individually, as in Laravel.
  `^[${trimmedCharacters}]+|[${trimmedCharacters}]+$`,
  'gu',
);

function normalize(value: unknown, field = ''): unknown {
  if (typeof value === 'string') {
    const cleaned = [
      'password',
      'password_confirmation',
      'current_password',
    ].includes(field)
      ? value
      : value.replace(trimEdges, '');
    return cleaned === '' ? null : cleaned;
  }
  if (Array.isArray(value))
    return value.map((entry) => normalize(entry, field));
  if (value instanceof Blob) return value;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry, key)]),
    );
  }
  return value;
}

function parseFormEntries(entries: Iterable<[string, unknown]>): Input {
  const input: Input = Object.create(null) as Input;
  for (const [rawKey, value] of entries) {
    const key = rawKey.split('\0', 1)[0]!.replace(/^ +/, '');
    // PHP parses bracketed fields as arrays. Preserve their non-string nature
    // so inputs such as keyword[]=x or multipart sellerId[]=x fail validation.
    const bracket = key.indexOf('[');
    const array = bracket !== -1 && key.indexOf(']', bracket) !== -1;
    const name = (
      array ? key.slice(0, bracket) : key.replace('[', '_')
    ).replace(/[ .]/g, '_');
    if (name !== '') input[name] = array ? [value] : value;
  }
  return normalize(input) as Input;
}

export function parseQuery(url: string): Input {
  return parseFormEntries(new URL(url).searchParams);
}

export async function parseBody(request: Request): Promise<Input> {
  const contentType = request.headers.get('content-type') ?? '';
  let body: unknown;
  if (
    contentType.includes('application/json') ||
    contentType.includes('+json')
  ) {
    const text = await request.text();
    try {
      body = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseQuery(`http://localhost/?${await request.text()}`);
  } else if (contentType.includes('multipart/form-data')) {
    try {
      return parseFormEntries(await request.formData());
    } catch {
      throw new HttpError(400, 'Invalid request body.');
    }
  } else {
    body = {};
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return {};
  return normalize(body) as Input;
}

interface CommonOptions {
  required?: boolean;
  nullable?: boolean;
  messages?: Partial<
    Record<'required' | 'string' | 'integer' | 'min' | 'max' | 'in', string>
  >;
}

function displayName(field: string): string {
  return field
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
    .replaceAll('_', ' ');
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && /^[ \t\n\r\0\v]*$/.test(value)) ||
    (typeof value === 'object' &&
      !(value instanceof Blob) &&
      Object.keys(value).length === 0)
  );
}

export class Validator {
  readonly errors: ValidationErrors = {};

  constructor(readonly data: Input) {}

  add(field: string, message: string): void {
    (this.errors[field] ??= []).push(message);
  }

  has(field: string): boolean {
    return Object.hasOwn(this.data, field);
  }

  private absent(field: string, options: CommonOptions): boolean {
    const value = this.data[field];
    if (options.required && isEmpty(value)) {
      this.add(
        field,
        options.messages?.required ??
          `The ${displayName(field)} field is required.`,
      );
      return true;
    }
    return !this.has(field) || (options.nullable === true && value === null);
  }

  string(
    field: string,
    options: CommonOptions & {
      max?: number;
      min?: number;
      in?: readonly string[];
    } = {},
  ): string | undefined {
    if (this.absent(field, options)) return undefined;
    const value = this.data[field];
    if (typeof value !== 'string') {
      this.add(
        field,
        options.messages?.string ??
          `The ${displayName(field)} field must be a string.`,
      );
      return undefined;
    }
    const length = Array.from(value).length;
    if (options.max !== undefined && length > options.max) {
      this.add(
        field,
        options.messages?.max ??
          `The ${displayName(field)} field must not be greater than ${options.max} characters.`,
      );
    }
    if (options.min !== undefined && length < options.min) {
      this.add(
        field,
        options.messages?.min ??
          `The ${displayName(field)} field must be at least ${options.min} characters.`,
      );
    }
    if (options.in && !options.in.includes(value)) {
      this.add(
        field,
        options.messages?.in ??
          `The selected ${displayName(field)} is invalid.`,
      );
    }
    return value;
  }

  integer(
    field: string,
    options: CommonOptions & { min?: number; max?: number } = {},
  ): number | undefined {
    if (this.absent(field, options)) return undefined;
    const value = this.data[field];
    // Laravel's non-strict integer rule accepts integer strings (including +1)
    // but rejects decimals and strings with leading zeroes.
    const numeric =
      typeof value === 'number' || value === true
        ? Number(value)
        : typeof value === 'string' && /^[+-]?(?:0|[1-9]\d*)$/.test(value)
          ? Number(value)
          : NaN;
    if (!Number.isSafeInteger(numeric)) {
      this.add(
        field,
        options.messages?.integer ??
          `The ${displayName(field)} field must be an integer.`,
      );
      return undefined;
    }
    if (options.min !== undefined && numeric < options.min) {
      this.add(
        field,
        options.messages?.min ??
          `The ${displayName(field)} field must be at least ${options.min}.`,
      );
    }
    if (options.max !== undefined && numeric > options.max) {
      this.add(
        field,
        options.messages?.max ??
          `The ${displayName(field)} field must not be greater than ${options.max}.`,
      );
    }
    return numeric;
  }

  prohibited(field: string, message: string): void {
    const value = this.data[field];
    if (!isEmpty(value)) {
      this.add(field, message);
    }
  }

  throwIfInvalid(): void {
    if (Object.keys(this.errors).length > 0)
      throw new ValidationError(this.errors);
  }
}
