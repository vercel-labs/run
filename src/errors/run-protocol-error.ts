import { RunError } from './run-error.js';

/**
 * Raised when the main thread and worker protocol observes an invalid or
 * mismatched message.
 */
export class RunProtocolError extends RunError {
  constructor(message: string, details?: unknown) {
    super(message, 'RUN_PROTOCOL_ERROR', details);
  }
}
