/**
 * Evaluates the subset of a Prisma `CalendarEventWhereInput` that the
 * calendar busy-time queries use, against in-memory rows, so a mocked
 * `findMany`/`findFirst` returns what the database would: a test then fails
 * if a query's filter would leave out an event (e.g. a recurring series whose
 * first occurrence lies before the queried window).
 *
 * Supported: AND, OR, equality (string/number/Date/null), and the operators
 * lt, gt, not (value or null).
 */
type Row = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x - y;
}

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition === null || condition instanceof Date || typeof condition !== "object") {
    return same(value, condition);
  }
  return Object.entries(condition as Record<string, unknown>).every(([op, operand]) => {
    switch (op) {
      case "lt":
        return value != null && compare(value, operand) < 0;
      case "gt":
        return value != null && compare(value, operand) > 0;
      case "not":
        return !same(value, operand);
      default:
        throw new Error(`calendar-event-where: unsupported operator "${op}"`);
    }
  });
}

export function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Row[]).every((w) => matchesWhere(row, w));
    if (key === "OR") return (condition as Row[]).some((w) => matchesWhere(row, w));
    return matchesField(row[key], condition);
  });
}

/** A `findMany` that filters `rows` by the call's `where`. */
export function findManyOver<T extends Row>(rows: T[]) {
  return async (args?: { where?: Record<string, unknown> }) =>
    rows.filter((row) => matchesWhere(row, args?.where));
}

/** A `findFirst` that filters `rows` by the call's `where`. */
export function findFirstOver<T extends Row>(rows: T[]) {
  return async (args?: { where?: Record<string, unknown> }) =>
    rows.find((row) => matchesWhere(row, args?.where)) ?? null;
}
