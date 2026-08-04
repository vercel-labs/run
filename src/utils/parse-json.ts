/**
 * Local JSON parser used by the zero-runtime-dependency `run` package.
 *
 * Callers must enforce their boundary-specific byte and shape limits before
 * accepting the returned value.
 *
 * @internal
 */
export const parseJson = (value: string): unknown => JSON.parse(value);
