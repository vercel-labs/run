import { RunError } from './run-error.js';

/** Base class for failures caused by nested host binding execution. */
export class RunBindingError extends RunError {
  constructor(message: string, details?: unknown) {
    super(message, 'RUN_BINDING_ERROR', details);
  }
}
