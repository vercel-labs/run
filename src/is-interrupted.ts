import type { RunInterruptedResult } from './types.js';

/** Returns whether a value is an interrupted run result. */
export const isRunInterruptedResult = (
  value: unknown,
): value is RunInterruptedResult<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as { status?: unknown }).status === 'interrupted' &&
  Array.isArray((value as { interruptions?: unknown }).interruptions) &&
  'continuation' in value;
