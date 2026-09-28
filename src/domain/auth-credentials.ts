import { ValidationError, type ValidationErrors } from './errors.js';

export interface LoginCredentials {
  readonly username: string;
  readonly password: string;
}

export interface RegisterCredentials extends LoginCredentials {
  readonly displayName: string;
}

const usernamePattern = /^[a-z0-9_]{3,32}$/;
const reservedUsernames = new Set(['demo', 'seller']);

function addError(
  errors: ValidationErrors,
  field: string,
  message: string,
): void {
  (errors[field] ??= []).push(message);
}

export function normalizeUsername(value: string): string {
  return value.trim().replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function parseUsername(
  input: Readonly<Record<string, unknown>>,
  errors: ValidationErrors,
  rejectReserved: boolean,
): string {
  const value = input.username;
  if (!Object.hasOwn(input, 'username')) {
    addError(errors, 'username', 'ユーザー名を入力してください。');
    return '';
  }
  if (typeof value !== 'string') {
    addError(errors, 'username', 'ユーザー名は文字列で入力してください。');
    return '';
  }

  const username = normalizeUsername(value);
  if (!usernamePattern.test(username)) {
    addError(
      errors,
      'username',
      'ユーザー名は小文字英数字と_で3〜32文字にしてください。',
    );
  } else if (rejectReserved && reservedUsernames.has(username)) {
    addError(errors, 'username', 'このユーザー名は使用できません。');
  }
  return username;
}

function parsePassword(
  input: Readonly<Record<string, unknown>>,
  errors: ValidationErrors,
): string {
  const value = input.password;
  if (!Object.hasOwn(input, 'password')) {
    addError(errors, 'password', 'パスワードを入力してください。');
    return '';
  }
  if (typeof value !== 'string') {
    addError(errors, 'password', 'パスワードは文字列で入力してください。');
    return '';
  }

  if (Array.from(value).length < 8) {
    addError(errors, 'password', 'パスワードは8文字以上で入力してください。');
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    addError(
      errors,
      'password',
      'パスワードは72バイト以内で入力してください。',
    );
  }
  if (value.includes('\0')) {
    addError(
      errors,
      'password',
      'パスワードに使用できない文字が含まれています。',
    );
  }
  return value;
}

function parseDisplayName(
  input: Readonly<Record<string, unknown>>,
  username: string,
  errors: ValidationErrors,
): string {
  const value = input.displayName;
  if (!Object.hasOwn(input, 'displayName') || value === null) return username;
  if (typeof value !== 'string') {
    addError(errors, 'displayName', '表示名は文字列で入力してください。');
    return username;
  }

  const displayName = value.trim();
  if (displayName === '') return username;
  if (Array.from(displayName).length > 120) {
    addError(errors, 'displayName', '表示名は120文字以内で入力してください。');
  }
  return displayName;
}

function validatePasswordConfirmation(
  input: Readonly<Record<string, unknown>>,
  password: string,
  errors: ValidationErrors,
): void {
  if (!Object.hasOwn(input, 'passwordConfirmation')) return;

  const value = input.passwordConfirmation;
  if (typeof value !== 'string') {
    addError(
      errors,
      'passwordConfirmation',
      '確認用パスワードは文字列で入力してください。',
    );
  } else if (typeof input.password === 'string' && value !== password) {
    addError(
      errors,
      'passwordConfirmation',
      '確認用パスワードが一致しません。',
    );
  }
}

export function parseLoginCredentials(
  input: Readonly<Record<string, unknown>>,
): LoginCredentials {
  const errors: ValidationErrors = {};
  const username = parseUsername(input, errors, false);
  const password = parsePassword(input, errors);
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { username, password };
}

export function parseRegisterCredentials(
  input: Readonly<Record<string, unknown>>,
): RegisterCredentials {
  const errors: ValidationErrors = {};
  const username = parseUsername(input, errors, true);
  const password = parsePassword(input, errors);
  const displayName = parseDisplayName(input, username, errors);
  validatePasswordConfirmation(input, password, errors);
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return { username, displayName, password };
}
