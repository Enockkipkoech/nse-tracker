/**
 * Corporate actions seed — from fixtures/corporate-actions.json.
 *
 * This table has existed in the schema since the very first design pass and
 * has never been populated: every dividend-yield/DPS figure this build
 * produces has been either derived from TradingView's yield/payout fields
 * (see @nse/lib's deriveDps, with confidence tiers because that derivation
 * is unreliable on ~45% of the board) or, more recently, confirmed via
 * Fundamental rows (annual-report DPS, but no ex-date/record-date/payment
 * split). This is the first real source for what corporate_actions was
 * always meant to hold: the actual dividend EVENTS — interim vs final,
 * announcement date, books closure, ex-date, payment date.
 *
 * Once seeded, /v1/watchlist could in principle prefer this over both the
 * derived and Fundamental-confirmed DPS (it's the highest-authority source
 * of the three) — not wired yet; see the note at the bottom of this file.
 *
 * Usage:
 *   pnpm run seed:corporate-actions
 */

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { readFileSync } from "node:fs";
import { prisma, upsertCorporateAction } from "../src/client";

const FIXTURE_PATH = process.env.CORPORATE_ACTIONS_FIXTURE ?? "fixtures/corporate-actions.json";

interface ActionRow {
  actionId: string;
  ticker: string;
  actionType: string;
  dividendType?: string | null;
  fiscalYear?: number | null;
  announcementDate?: string | null;
  amountPerShare?: number | null;
  ratio?: string | null;
  booksClosureDate?: string | null;
  exDate?: string | null;
  paymentDate?: string | null;
  status: string;
  sourceUrl: string | null;
  sourceTier?: string | null;
  _note?: string;
}

async function main() {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { actions: ActionRow[] };
  const rows = raw.actions ?? [];

  let seeded = 0, skippedInvalid = 0;

  for (const row of rows) {
    // reportUrl/sourceUrl-required-if-amount-present, ticker-must-exist,
    // and enum-validity rules all live in upsertCorporateAction now, shared
    // with the /admin HTTP route — not duplicated here. See
    // packages/db/src/admin.ts.
    const result = await upsertCorporateAction(row);
    if (!result.ok) {
      console.error(`SKIP ${row.actionId}: ${result.error}`);
      skippedInvalid++;
      continue;
    }
    seeded++;
  }

  console.log(`corporate_actions: seeded=${seeded} skipped_invalid=${skippedInvalid}`);

  // Internal consistency check, not a hard requirement: if this ticker also
  // has a Fundamental row for the same fiscal year's DPS, the sum of this
  // fixture's dividend rows for that ticker/year should match it. Flags a
  // typo in either fixture rather than a real conflict — both sources are
  // meant to agree, unlike the derived-vs-confirmed comparison elsewhere.
  const byTickerYear = new Map<string, number>();
  for (const row of rows) {
    if (row.actionType !== "CASH_DIVIDEND" || row.amountPerShare == null || !row.fiscalYear) continue;
    const key = `${row.ticker}-${row.fiscalYear}`;
    byTickerYear.set(key, (byTickerYear.get(key) ?? 0) + row.amountPerShare);
  }
  for (const [key, total] of byTickerYear) {
    const [ticker, fyStr] = key.split("-");
    const periodEnd = await prisma.fundamental.findFirst({
      where: { ticker, periodEnd: { gte: new Date(`${fyStr}-01-01`), lt: new Date(`${Number(fyStr) + 1}-01-01`) } },
      select: { dpsDeclared: true },
    });
    if (periodEnd?.dpsDeclared != null && Math.abs(Number(periodEnd.dpsDeclared) - total) > 0.01) {
      await prisma.qualityLog.create({
        data: {
          severity: "WARN", code: "CORPORATE_ACTION_SUM_MISMATCH", ticker,
          detail: `corporate_actions rows for FY${fyStr} sum to ${total}, but fundamentals.dpsDeclared says ${periodEnd.dpsDeclared} — check both fixtures for a typo.`,
        },
      });
    }
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

// NOT YET WIRED: /v1/watchlist currently checks Fundamental before falling
// back to daily_prices' derived value. corporate_actions — trailing-12m sum
// of PAID CASH_DIVIDEND rows — is actually the higher-authority source of
// the three (it's the only one with a real payment date, not just a report
// period). Left for a follow-up rather than done here, since it changes the
// precedence logic in routes/api.ts and deserves its own pass rather than
// being folded into this seed script's commit.
