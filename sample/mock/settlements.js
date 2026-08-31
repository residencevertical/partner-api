/**
 * MOCK ONLY (throw this file away) — one canned weekly settlement for `GET /settlements`.
 *
 * The real platform closes every partner's LAST COMPLETE week (Monday 00:00 → Sunday 24:00,
 * Europe/Bucharest) each Monday morning and invoices `net = gross − commission` — the commission
 * is a visible negative line on the invoice, which is how the revenue share is given. The mock
 * ships exactly one already-`invoiced` settlement for that last complete week so you can build your
 * reconciliation before a real one exists.
 */
import { randomUUID } from "node:crypto";

const REPORT_PRICE_CENTS = 5000; // 50 lei list price — the same number `GET /me` reports
const REPORTS_COUNT = 12;
const DUE_DAYS = 7; // payment terms: 7 days from the invoice date
const DAY_MS = 86_400_000;

/** Calendar date + weekday in Europe/Bucharest, without any dependency. */
function bucharestParts(instant) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
}

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * The last COMPLETE Monday→Sunday week before the current one, as calendar dates.
 * Date arithmetic runs on UTC midnights of the calendar dates, which is DST-safe for date math.
 */
export function lastCompleteWeek(now = new Date()) {
  const parts = bucharestParts(now);
  const todayUtcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const currentWeekMonday = todayUtcMidnight - (WEEKDAY_INDEX[parts.weekday] - 1) * DAY_MS;
  const toDate = (millis) => new Date(millis).toISOString().slice(0, 10);
  return {
    periodStart: toDate(currentWeekMonday - 7 * DAY_MS), // the previous Monday
    periodEnd: toDate(currentWeekMonday - DAY_MS),       // …through its Sunday
    closeDate: toDate(currentWeekMonday),                // the Monday the close job ran
  };
}

/**
 * One canned settlement in the documented wire shape (guide §16) — status `invoiced`, awaiting
 * payment. Money is consistent with the mock's `/me`: gross = reports × 50 lei list price,
 * commission = the account's percentage of it, net = gross − commission (what the partner owes).
 */
export function buildCannedSettlement({ commissionPct = 15, now = new Date() } = {}) {
  const { periodStart, periodEnd, closeDate } = lastCompleteWeek(now);
  const grossCents = REPORTS_COUNT * REPORT_PRICE_CENTS;
  const commissionCents = Math.round(grossCents * commissionPct / 100);
  // The close job runs Monday 06:00 Europe/Bucharest; the fixed +03:00 offset is a mock-grade
  // approximation of that timezone (off by an hour in winter, irrelevant for integration work).
  const issuedAt = new Date(`${closeDate}T06:00:00+03:00`).toISOString();
  const dueAt = new Date(Date.parse(issuedAt) + DUE_DAYS * DAY_MS).toISOString();
  return {
    settlementId: randomUUID(),
    periodStart,
    periodEnd,
    reportsCount: REPORTS_COUNT,
    grossCents,
    commissionCents,
    netCents: grossCents - commissionCents,
    currency: "RON",
    status: "invoiced",
    invoiceNumber: "RVTP 0042", // series + number joined; the mock is a test env → the RVTP series
    issuedAt,
    dueAt,
    paidAt: null,
  };
}
