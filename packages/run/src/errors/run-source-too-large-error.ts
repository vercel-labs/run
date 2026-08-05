import { RunError } from './run-error.js';

/** Raised when the provided source exceeds `limits.maxSourceBytes`. */
export class RunSourceTooLargeError extends RunError {
  constructor(bytes: number, maxBytes: number) {
    super(
      `JavaScript runtime source exceeds the ${maxBytes} byte size limit.`,
      'RUN_SOURCE_TOO_LARGE',
      { bytes, maxBytes },
    );
  }
}
