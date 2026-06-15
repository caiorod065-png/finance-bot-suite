import type { SpendingLimitPeriod } from '../../types.js';

// ─── Shared date / calculation utilities for ledger domain files ──────────────

export function todayIsoDate(reference = new Date()): string {
  return reference.toISOString().slice(0, 10);
}

export function isoDateInTimezone(reference: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(reference);
  const year = parts.find((item) => item.type === 'year')?.value ?? '1970';
  const month = parts.find((item) => item.type === 'month')?.value ?? '01';
  const day = parts.find((item) => item.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function toIsoDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

export function addDaysIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addMonthsIsoDate(reference = new Date(), months = 1): string {
  const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), 12, 0, 0));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function addMonthsIsoFromDate(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function daysDiffInclusive(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T12:00:00.000Z`).getTime();
  const end = new Date(`${endIso}T12:00:00.000Z`).getTime();
  const diff = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
  return diff > 0 ? diff : 0;
}

export function nextMonthlyDueDate(baseDueDateIso: string, referenceIsoDate: string): string {
  let candidate = baseDueDateIso;
  let guard = 0;
  while (candidate < referenceIsoDate && guard < 120) {
    candidate = addMonthsIsoFromDate(candidate, 1);
    guard += 1;
  }
  return candidate;
}

export function monthBounds(referenceDate: Date): { startIso: string; endIso: string } {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const start = new Date(Date.UTC(year, month, 1, 12, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 0, 12, 0, 0));
  return {
    startIso: start.toISOString().slice(0, 10),
    endIso: end.toISOString().slice(0, 10)
  };
}

export function periodBounds(period: SpendingLimitPeriod, referenceDate: Date): { startIso: string; endIso: string } {
  const endIso = todayIsoDate(referenceDate);
  if (period === 'daily') {
    return { startIso: endIso, endIso };
  }
  if (period === 'weekly') {
    const base = new Date(referenceDate);
    base.setDate(base.getDate() - 6);
    return { startIso: todayIsoDate(base), endIso };
  }
  return monthBounds(referenceDate);
}
