import { describe, expect, it } from 'vitest';
import { interrupt, isHostFunctionInterruptSignal } from './interrupt.js';

describe('interrupt', () => {
  it.each([Symbol('value'), () => {}])(
    'rejects non-serializable payload %#',
    payload => {
      expect(() => interrupt(payload)).toThrow('is not serializable');
    },
  );

  it('preserves cyclic and special payload values', () => {
    const payload: Record<string, unknown> = {
      exact: 1n,
      omitted: undefined,
    };
    payload.self = payload;
    try {
      interrupt(payload);
    } catch (error) {
      expect(isHostFunctionInterruptSignal(error)).toBe(true);
      if (isHostFunctionInterruptSignal(error)) {
        const revived = error.payload as Record<string, unknown>;
        expect(revived.exact).toBe(1n);
        expect(Object.hasOwn(revived, 'omitted')).toBe(true);
        expect(revived.omitted).toBeUndefined();
        expect(revived.self).toBe(revived);
      }
      return;
    }
    throw new Error('Expected interrupt to throw.');
  });
});
