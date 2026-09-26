import { expect, test } from 'vitest';

test('temporary proof that required CI blocks a failed test', () => {
  expect('required-check').toBe('intentionally-failing');
});
