import { describe, expect, it } from 'vitest';
import { RunError } from './index.js';

describe('RunError', () => {
  it('identifies errors created by a duplicate package module', async () => {
    const duplicateModule = (await import(
      `${new URL('errors/run-error.js', import.meta.url).href}?duplicate`
    )) as { RunError: typeof RunError };
    const duplicateError = new duplicateModule.RunError('failure');

    expect(duplicateError).not.toBeInstanceOf(RunError);
    expect(RunError.isInstance(duplicateError)).toBe(true);
  });

  it('rejects unrelated values and false markers', () => {
    expect(RunError.isInstance(new Error('failure'))).toBe(false);
    expect(
      RunError.isInstance({
        [Symbol.for('vercel.run.error.RunError')]: false,
      }),
    ).toBe(false);
  });
});
