import { RunError } from './run-error.js';

/** Raised when sandboxed code exceeds bridge request limits. */
export class RunBridgeLimitError extends RunError {
  constructor(message: string, details?: unknown) {
    super(message, 'RUN_BRIDGE_LIMIT', details);
  }
}
