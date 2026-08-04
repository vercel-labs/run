const runErrorSymbol = Symbol.for('vercel.run.error.RunError');

/**
 * Base class for errors raised by the JavaScript runtime.
 *
 * All package-specific errors include a stable `code` string and may include
 * structured `details` for diagnostics.
 */
export class RunError extends Error {
  private readonly [runErrorSymbol] = true;

  /** Stable machine-readable error code. */
  code: string;

  /** Optional structured diagnostic details. */
  readonly details?: unknown;

  constructor(message: string, code = 'RUN_ERROR', details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  /** Identifies `RunError` instances across duplicate package copies. */
  static isInstance(error: unknown): error is RunError {
    return (
      error !== null &&
      typeof error === 'object' &&
      runErrorSymbol in error &&
      (error as Record<symbol, unknown>)[runErrorSymbol] === true
    );
  }
}
