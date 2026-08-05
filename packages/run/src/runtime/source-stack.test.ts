import { describe, expect, it } from 'vitest';
import {
  normalizeUserSourceStack,
  USER_SOURCE_LINE_OFFSET,
} from './source-stack.js';

describe('user source stack normalization', () => {
  it('maps generated wrapper lines back to user source', () => {
    const source = ['const first = 1;', 'throw new Error("boom");'].join('\n');
    const stack = [
      'Error: boom',
      `    at run.js:${USER_SOURCE_LINE_OFFSET + 2}:7`,
      '    at run-setup.js:10:2',
    ].join('\n');

    expect(
      normalizeUserSourceStack({
        message: 'boom',
        name: 'Error',
        source,
        stack,
      }),
    ).toBe('Error: boom\n    at run.js:2:7');
  });

  it('omits generated run.js frames outside the user source', () => {
    expect(
      normalizeUserSourceStack({
        message: 'boom',
        name: 'Error',
        source: 'throw new Error("boom");',
        stack: 'Error: boom\n    at run.js:1:1\n    at run.js:3:1',
      }),
    ).toBe('Error: boom\n    at run.js:1:1');
  });

  it('returns a stable header when no stack is available', () => {
    expect(
      normalizeUserSourceStack({
        message: 'boom',
        name: 'Error',
        source: '',
        stack: undefined,
      }),
    ).toBe('Error: boom');
  });
});
