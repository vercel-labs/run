import { describe, expect, it } from 'vitest';
import { buildGuestRuntimeSetupSource, wrapUserCode } from './guest-sources.js';
import { USER_SOURCE_LINE_OFFSET } from './source-stack.js';

describe('guest runtime sources', () => {
  it('installs only the configured host function namespaces', () => {
    const source = buildGuestRuntimeSetupSource(['tools', 'users']);
    expect(source).toContain(
      'const __runHostFunctionNamespaces = ["tools","users"];',
    );
    expect(source).toContain('__runCreateBridgePromise');
    expect(source).toContain('__runAssertNoDetachedBridgeCalls');
    expect(source).toContain(
      "return createBridgePromise('hostFunction', hostFunctionPath",
    );
    expect(source).not.toContain(
      "return globalThis.__runCreateBridgePromise('hostFunction'",
    );
  });

  it('includes deterministic and hardening setup', () => {
    const source = buildGuestRuntimeSetupSource([]);
    expect(source).toContain('__runResetDateNow');
    expect(source).toContain("Object.defineProperty(Math, 'random'");
    expect(source).toContain("Object.defineProperty(globalThis, 'eval'");
    expect(source).toContain('Function constructor is not allowed');
  });

  it('wraps user code at the source-stack line offset', () => {
    const wrapped = wrapUserCode('throw new Error("boom");');
    const userLine = wrapped
      .split('\n')
      .findIndex(line => line.includes('throw new Error'));
    expect(userLine).toBe(USER_SOURCE_LINE_OFFSET);
  });
});
