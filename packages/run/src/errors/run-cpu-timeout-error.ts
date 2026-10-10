import { RunError } from './run-error.js';

/** Raised when guest JavaScript exceeds its per-invocation CPU time limit. */
export class RunCpuTimeoutError extends RunError {
  constructor(cpuTimeoutMs: number) {
    super(
      `JavaScript runtime exceeded its CPU time limit of ${cpuTimeoutMs}ms.`,
      'RUN_CPU_TIMEOUT',
      { cpuTimeoutMs },
    );
  }
}
