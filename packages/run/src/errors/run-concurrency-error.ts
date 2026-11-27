import { RunError } from './run-error.js';

/**
 * Raised when the process-global worker cap has been reached, or when
 * admitting the invocation would leave fewer free workers than its
 * `reserveWorkers`.
 *
 * Configure the cap with `setMaxWorkers`.
 */
export class RunConcurrencyError extends RunError {
  constructor(maxWorkers: number, reserveWorkers = 0) {
    super(
      reserveWorkers === 0
        ? `JavaScript runtime maxWorkers limit reached (${maxWorkers}).`
        : `JavaScript runtime refused the invocation to keep ${reserveWorkers} reserved worker${reserveWorkers === 1 ? '' : 's'} free (maxWorkers ${maxWorkers}).`,
      'RUN_CONCURRENCY_LIMIT',
      reserveWorkers === 0 ? { maxWorkers } : { maxWorkers, reserveWorkers },
    );
  }
}
