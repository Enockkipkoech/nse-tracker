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

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();
const FIXTURE_PATH = process.env.CORPORATE_ACTIONS_FIXTURE ?? "fixtures/corporate-actions.json";

interface ActionRow {
  actionId: string;
  ticker: string;
  actionType: string;
  dividendType?: string | null;
  fiscalYear?: number | null;
  announcementDate?: string | null;
  amountPerShareKes?: number | null;
  ratio?: string | null;
  booksClosureDate?: string | null;
  exDate?: string | null;
  paymentDate?: string | null;
  status: string;
  sourceUrl: string | null;
  _note?: string;
}

async function main() {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { actions: ActionRow[] };
  const rows = raw.actions ?? [];

  const known = new Set((await prisma.securityMaster.findMany({ select: { ticker: true } })).map(r => r.ticker));

  let seeded = 0, skippedInvalid = 0;

  for (const row of rows) {
    // Same rule as fundamentals: an amount with no source is a claim, not a
    // fact. A row with no amount at all (a pure placeholder) isn't checked
    // here since none currently exist in the fixture — add that guard if
    // this fixture grows placeholder rows the way fundamentals.json did.
    if (row.amountPerShareKes != null && !row.sourceUrl) {
      console.error(`SKIP ${row.actionId}: has an amount but no sourceUrl — refusing to seed unsourced data`);
      skippedInvalid++;
      continue;
    }

    if (!known.has(row.ticker)) {
      console.error(`SKIP ${row.actionId}: ticker ${row.ticker} not in security_master — run prisma/seed.ts first`);
      skippedInvalid++;
      continue;
    }

    await prisma.corporateAction.upsert({
      where: { actionId: row.actionId },
      create: {
        actionId: row.actionId,
        ticker: row.ticker,
        actionType: row.actionType as never, // enum cast — validated by Prisma at the DB layer
        dividendType: (row.dividendType as never) ?? undefined,
        fiscalYear: row.fiscalYear ?? undefined,
        announcementDate: row.announcementDate ? new Date(row.announcementDate) : undefined,
        amountPerShareKes: row.amountPerShareKes ?? undefined,
        ratio: row.ratio ?? undefined,
        booksClosureDate: row.booksClosureDate ? new Date(row.booksClosureDate) : undefined,
        exDate: row.exDate ? new Date(row.exDate) : undefined,
        paymentDate: row.paymentDate ? new Date(row.paymentDate) : undefined,
        status: row.status as never,
        sourceUrl: row.sourceUrl ?? undefined,
        verifiedAt: new Date(),
      },
      update: {
        dividendType: (row.dividendType as never) ?? undefined,
        fiscalYear: row.fiscalYear ?? undefined,
        announcementDate: row.announcementDate ? new Date(row.announcementDate) : undefined,
        amountPerShareKes: row.amountPerShareKes ?? undefined,
        ratio: row.ratio ?? undefined,
        booksClosureDate: row.booksClosureDate ? new Date(row.booksClosureDate) : undefined,
        exDate: row.exDate ? new Date(row.exDate) : undefined,
        paymentDate: row.paymentDate ? new Date(row.paymentDate) : undefined,
        status: row.status as never,
        sourceUrl: row.sourceUrl ?? undefined,
        verifiedAt: new Date(),
      },
    });
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
    if (row.actionType !== "CASH_DIVIDEND" || row.amountPerShareKes == null || !row.fiscalYear) continue;
    const key = `${row.ticker}-${row.fiscalYear}`;
    byTickerYear.set(key, (byTickerYear.get(key) ?? 0) + row.amountPerShareKes);
  }
  for (const [key, total] of byTickerYear) {
    const [ticker, fyStr] = key.split("-");
    const periodEnd = await prisma.fundamental.findFirst({
      where: { ticker, periodEnd: { gte: new Date(`${fyStr}-01-01`), lt: new Date(`${Number(fyStr) + 1}-01-01`) } },
      select: { dpsDeclaredKes: true },
    });
    if (periodEnd?.dpsDeclaredKes != null && Math.abs(Number(periodEnd.dpsDeclaredKes) - total) > 0.01) {
      await prisma.qualityLog.create({
        data: {
          severity: "WARN", code: "CORPORATE_ACTION_SUM_MISMATCH", ticker,
          detail: `corporate_actions rows for FY${fyStr} sum to ${total}, but fundamentals.dpsDeclaredKes says ${periodEnd.dpsDeclaredKes} — check both fixtures for a typo.`,
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
