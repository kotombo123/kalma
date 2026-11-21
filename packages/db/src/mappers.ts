/**
 * Row → contract mappers. Postgres returns empty columns as `null`; the contracts model them as
 * optional (absent) fields. Use these instead of `Alert.parse(row)` on raw rows.
 */
import { Alert } from '@alerting/contracts';
import type { alerts } from './schema.ts';

type AlertRow = typeof alerts.$inferSelect;

/** Drops `null` values so optional contract fields validate. */
export function withoutNulls<T extends Record<string, unknown>>(
  row: T,
): { [K in keyof T]: Exclude<T[K], null> } {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)) as {
    [K in keyof T]: Exclude<T[K], null>;
  };
}

/** `alerts` row → `Alert` (validated). DB-only columns (dispatchedAt, nextEscalationAt) are not part of `Alert`. */
export function alertFromRow(row: AlertRow): Alert {
  const { dispatchedAt: _d, nextEscalationAt: _n, ...rest } = row;
  return Alert.parse(withoutNulls(rest));
}
