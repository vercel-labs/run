import { RunError } from './run-error.js';

/** Raised when a sandbox invocation exceeds its timeout. */
export class RunTimeoutError extends RunError {
  constructor(timeoutMs: number) {
    super(
      `JavaScript runtime execution timed out after ${timeoutMs}ms.`,
      'RUN_TIMEOUT',
      { timeoutMs },
    );
  }
}
