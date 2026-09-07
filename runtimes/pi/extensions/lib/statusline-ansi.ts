export const RESET = '\x1b[0m';

export function isNonNegativeInt(value: unknown): value is number {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0;
  }
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}
