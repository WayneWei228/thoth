// The old JavaScript `if (x)` tests, written out for strict-boolean-expressions.

/** A string that is set and not empty (`if (s)` for a string that can be missing). */
export const ne = (s: string | null | undefined): s is string => s !== undefined && s !== null && s !== '';

/** JavaScript truthiness of a value whose type is not known (JSON input). */
export const truthy = (v: unknown): boolean => Boolean(v);

/** String(v) for a value whose type is not known (JSON input): the same text as the old code. */
export const text = (v: unknown): string => String(v);
