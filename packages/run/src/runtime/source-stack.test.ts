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

  it('escapes control characters in guest-controlled error headers', () => {
    expect(
      normalizeUserSourceStack({
        message: 'boom\r\n    at attacker://forged:1:1\u001B[31m',
        name: 'Err\nor\u001B',
        source: 'throw new Error("boom");',
        stack: undefined,
      }),
    ).toBe(
      'Err\\u000aor\\u001b: boom\\u000d\\u000a    at attacker://forged:1:1\\u001b[31m',
    );
  });

  it('drops injected pseudo-frames while preserving user source frames', () => {
    const message = 'boom\n    at attacker://forged:1:1';
    const stack = [
      `Error: ${message}`,
      '    at attacker://forged:1:1',
      'arbitrary guest-controlled text',
      `    at run.js:${USER_SOURCE_LINE_OFFSET + 1}:7`,
    ].join('\n');

    expect(
      normalizeUserSourceStack({
        message,
        name: 'Error',
        source: 'throw new Error("boom");',
        stack,
      }),
    ).toBe('Error: boom\\u000a    at attacker://forged:1:1\n    at run.js:1:7');
  });
});
