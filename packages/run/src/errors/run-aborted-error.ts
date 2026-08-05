import { RunError } from './run-error.js';

/** Raised when the caller's abort signal aborts a run invocation. */
export class RunAbortedError extends RunError {
  constructor() {
    super('JavaScript runtime execution was aborted.', 'RUN_ABORTED');
  }
}
