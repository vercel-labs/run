import { RunError } from './run-error.js';

/**
 * Raised when the process-global worker cap has been reached.
 *
 * Configure the cap with `setMaxWorkers`.
 */
export class RunConcurrencyError extends RunError {
  constructor(maxWorkers: number) {
    super(
      `JavaScript runtime maxWorkers limit reached (${maxWorkers}).`,
      'RUN_CONCURRENCY_LIMIT',
      { maxWorkers },
    );
  }
}
