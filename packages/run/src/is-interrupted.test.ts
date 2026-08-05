import { describe, expect, it } from 'vitest';
import { isRunInterruptedResult } from './is-interrupted.js';

describe('isRunInterruptedResult', () => {
  it('narrows interrupted results', () => {
    const value: unknown = {
      continuation: 'token',
      interruptions: [],
      status: 'interrupted',
    };

    expect(isRunInterruptedResult(value)).toBe(true);
    if (isRunInterruptedResult(value)) {
      expect(value.continuation).toBe('token');
    }
  });

  it.each([
    null,
    {},
    { status: 'completed', value: 1 },
    { interruptions: [], status: 'interrupted' },
    { continuation: 'token', interruptions: {}, status: 'interrupted' },
  ])('rejects non-interrupted shape %#', value => {
    expect(isRunInterruptedResult(value)).toBe(false);
  });
});
