import { RunError } from './run-error.js';

/**
 * Raised when sandboxed code starts host bridge work and returns without
 * awaiting or otherwise observing it.
 */
export class RunDetachedBridgeRequestError extends RunError {
  constructor(message: string, details?: unknown) {
    super(message, 'RUN_DETACHED_BRIDGE_REQUEST', details);
  }
}
