import { RunError } from './run-error.js';

/** Base class for failures caused by nested host function execution. */
export class RunHostFunctionError extends RunError {
  constructor(message: string, details?: unknown) {
    super(message, 'RUN_HOST_FUNCTION_ERROR', details);
  }
}
