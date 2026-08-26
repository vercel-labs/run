import { describe, expect, it } from 'vitest';
import { run } from './run.js';

/*
 * The execution timeout must be a measure of elapsed time, not of how much
 * bytecode the guest managed to execute. A long-but-terminating computation
 * that finishes inside its budget has not timed out.
 */
describe('execution timeout', () => {
  it('does not abort a computation that finishes within its budget', async () => {
    const startedAt = Date.now();
    const result = await run({
      // Long enough to run well past any fixed interrupt-check budget, but
      // still far inside the 10s timeout below.
      limits: { timeoutMs: 10_000 },
      source:
        'let n = 0; for (let i = 0; i < 50_000_000; i++) n += i % 7; return n;',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe('completed');
    expect(elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  it('scales how long a runaway loop survives with the configured timeout', async () => {
    const elapsedFor = async (timeoutMs: number): Promise<number> => {
      const startedAt = Date.now();
      await expect(
        run({ limits: { timeoutMs }, source: 'while (true) {}' }),
      ).rejects.toThrow(/timed out/i);
      return Date.now() - startedAt;
    };

    // A budget of 1s must outlast a budget of 200ms. A fixed instruction
    // budget would end both at the same point, whatever was configured.
    const short = await elapsedFor(200);
    const long = await elapsedFor(1000);

    expect(long).toBeGreaterThan(short * 2);
  }, 30_000);
});
