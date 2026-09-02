/**
 * MOCK ONLY (throw this file away) — a canned referral ledger for `GET /referrals` and the
 * `referral` block on `GET /me` (guide §4.2, §4.3).
 *
 * The referral program: the partner links their user to the ResidenceVertical checkout (a
 * minted `/c/<token>` link or the `/p/<slug>` link); the user pays the 50 lei list price to
 * ResidenceVertical directly, and the partner earns `commissionPct` per report that reaches
 * `generated` — paid out weekly by SEPA transfer. The mock ships one row in every state a real
 * ledger can show (`pending`, `earned` unpaid, `earned` already paid out, `void`), so a
 * reconciliation flow can be built before a single real referral exists. The `/me` totals are
 * COMPUTED from these rows (`referralTotals`), so the two surfaces can never disagree — the same
 * consistency the real service guarantees.
 */
import { randomUUID } from "node:crypto";
import { mintCheckoutToken } from "./checkoutLinks.js";

const REPORT_PRICE_CENTS = 5000; // 50 lei list price — the same number `GET /me` reports
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Calendar date + weekday in Europe/Bucharest, without any dependency. */
function bucharestParts(instant) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(instant).map((part) => [part.type, part.value]));
}

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * The last COMPLETE payout week (Monday 00:00 → Sunday 24:00, Europe/Bucharest — guide §2.2)
 * before the current one, as calendar dates, plus the Monday its payout was made on.
 * Date arithmetic runs on UTC midnights of the calendar dates, which is DST-safe for date math.
 */
export function lastPayoutWeek(now = new Date()) {
  const parts = bucharestParts(now);
  const todayUtcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const currentWeekMonday = todayUtcMidnight - (WEEKDAY_INDEX[parts.weekday] - 1) * DAY_MS;
  const toDate = (millis) => new Date(millis).toISOString().slice(0, 10);
  return {
    periodStart: toDate(currentWeekMonday - 7 * DAY_MS), // the previous Monday
    periodEnd: toDate(currentWeekMonday - DAY_MS),       // …through its Sunday
    payoutDate: toDate(currentWeekMonday),               // the Monday the payout was made
  };
}

/**
 * One wire row in the documented field order (guide §4.2). `externalReference` +
 * `checkoutLinkId` are copied from the CHECKOUT LINK that attributed the purchase — the
 * per-lead conversion tracking. Both are `null` when the buyer arrived through the link-only
 * `/p/<slug>` tier instead.
 */
function referralRow({
  createdAt, status, commissionCents, earnedAt = null, paidAt = null,
  externalReference = null, checkoutLinkId = null,
}) {
  return {
    referralId: randomUUID(),
    createdAt: createdAt.toISOString(),
    status,
    priceCents: REPORT_PRICE_CENTS,
    commissionCents,
    earnedAt: earnedAt ? earnedAt.toISOString() : null,
    paidAt: paidAt ? paidAt.toISOString() : null,
    externalReference,
    checkoutLinkId,
  };
}

/** A checkout-link attribution pair for a canned row — a real-shaped `pcl_…` token. */
const viaCheckoutLink = (lead) => ({ externalReference: lead, checkoutLinkId: mintCheckoutToken() });

/**
 * The canned ledger, newest first:
 *   - 1 × `pending` — bought minutes ago, report still generating (via a checkout link);
 *   - 2 × `earned`  — generated, waiting for the next Monday payout (`paidAt: null`); one via a
 *                     checkout link (lead reference attached), one via the link-only `/p` tier;
 *   - 2 × `earned`  — earned inside the last complete week and paid by its Monday payout
 *                     (`status` stays `earned` — `paidAt` is the paid marker, per the guide);
 *   - 1 × `void`    — a report that failed terminally; never earns.
 */
export function buildCannedReferrals({ commissionPct = 15, now = new Date() } = {}) {
  const per = Math.round(REPORT_PRICE_CENTS * commissionPct / 100);
  const { periodStart, payoutDate } = lastPayoutWeek(now);
  // Paid rows sit inside the last complete week; the payout was made after the Monday close.
  // The fixed +03:00 offset is a mock-grade Europe/Bucharest approximation (off by an hour in
  // winter, irrelevant for integration work).
  const paidAt = new Date(`${payoutDate}T09:00:00+03:00`);
  const inLastWeek = (dayOffset) => new Date(Date.parse(`${periodStart}T10:00:00+03:00`) + dayOffset * DAY_MS);
  const minutesAgo = (minutes) => new Date(now.getTime() - minutes * MINUTE_MS);

  const rows = [
    referralRow({
      createdAt: minutesAgo(10), status: "pending", commissionCents: per,
      ...viaCheckoutLink("lead-84213"),
    }),
    referralRow({
      createdAt: minutesAgo(26 * 60), status: "earned", commissionCents: per,
      earnedAt: minutesAgo(26 * 60 - 4), ...viaCheckoutLink("lead-83990"),
    }),
    referralRow({
      createdAt: minutesAgo(50 * 60), status: "earned", commissionCents: per,
      earnedAt: minutesAgo(50 * 60 - 4),
    }),
    referralRow({ createdAt: minutesAgo(70 * 60), status: "void", commissionCents: per }),
    referralRow({
      createdAt: inLastWeek(2), status: "earned", commissionCents: per,
      earnedAt: new Date(inLastWeek(2).getTime() + 4 * MINUTE_MS), paidAt,
      ...viaCheckoutLink("lead-83811"),
    }),
    referralRow({
      createdAt: inLastWeek(1), status: "earned", commissionCents: per,
      earnedAt: new Date(inLastWeek(1).getTime() + 4 * MINUTE_MS), paidAt,
    }),
  ];
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * The `/me` `referral` money totals, derived from the ledger rows so `/me` and `/referrals`
 * always agree: pending = `pending` rows; earned-unpaid = `earned` with no `paidAt`;
 * paid-all-time = everything with a `paidAt`.
 */
export function referralTotals(referrals) {
  const sum = (rows) => rows.reduce((total, row) => total + row.commissionCents, 0);
  return {
    pendingCents: sum(referrals.filter((row) => row.status === "pending")),
    earnedUnpaidCents: sum(referrals.filter((row) => row.status === "earned" && row.paidAt === null)),
    paidCentsAllTime: sum(referrals.filter((row) => row.paidAt !== null)),
  };
}
