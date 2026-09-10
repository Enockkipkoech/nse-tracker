/**
 * Fundamentals seed — from fixtures/fundamentals.json, hand-entered from
 * published annual/interim reports. Unlike prisma/seed.ts (the security
 * master, sourced from a TradingView board pull), there is no upstream API
 * for this: revenue, PAT and book value per share aren't in the verified
 * scanner columns. This will always be manual entry — the seed script's job
 * is validation and cross-checking, not fetching.
 *
 * Once a Fundamental row exists for a ticker, GET /v1/watchlist automatically
 * prefers its dpsDeclared over daily_prices.dpsDerivedKes — read-time
 * precedence, not a write here. This script never mutates daily_prices:
 * writing a "confirmed" value there would just get overwritten by the next
 * capture cron's derived estimate. See routes/api.ts.
 *
 * CURRENCY: every figure here is in the security's reportingCurrency
 * (security_master), not assumed KES. Column names are deliberately
 * unsuffixed (revenue, not revenueKes) after UMME proved that a *Kes
 * suffix actively lies for a cross-listed security — TradingView's own
 * 393% derived yield bug was exactly a UGX figure silently treated as KES.
 * Don't re-introduce that assumption by naming convention here.
 *
 * Usage:
 *   pnpm run seed:fundamentals                    # fixtures/fundamentals.json
 *   FUNDAMENTALS_FIXTURE=path pnpm run seed:fundamentals
 */

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });
// ^ same fix as prisma/seed.ts: this script runs via `tsx prisma/seed-
// fundamentals.ts` directly (see package.json), which never touches
// prisma.config.ts's own dotenv loading — that only fires through the
// `prisma` CLI (`prisma db seed`, `prisma migrate dev`). Without this,
// DATABASE_URL is never in process.env when PrismaClient is constructed.

import { readFileSync } from "node:fs";
import { prisma, upsertFundamental } from "../src/client";

const FIXTURE_PATH = process.env.FUNDAMENTALS_FIXTURE ?? "fixtures/fundamentals.json";

interface FundamentalRow {
  ticker: string;
  periodEnd: string;
  periodType: "FY" | "HY" | "Q1" | "Q3";
  isAudited: boolean;
  revenue: number | null;
  pat: number | null;
  epsBasic: number | null;
  dpsDeclared: number | null;
  bookValuePerShare: number | null;
  reportUrl: string | null;
  sourceTier?: string | null;
  extra?: Record<string, unknown> | null;
  _status?: string;
}

async function main() {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { fundamentals: FundamentalRow[] };
  const rows = raw.fundamentals ?? [];

  const securities = await prisma.securityMaster.findMany({
    select: { ticker: true, reportingCurrency: true, exchangeCurrency: true },
  });
  const known = new Map(securities.map(s => [s.ticker, s]));

  let seeded = 0, skippedPlaceholder = 0, skippedInvalid = 0;

  for (const row of rows) {
    // A row with no reportUrl and no real figures is a template placeholder,
    // not data — this pre-filter is seed-script/bulk-fixture specific (an
    // admin submitting a form has no equivalent "template" concept), so it
    // stays here rather than in the shared function. dpsDeclared counts as
    // a real figure — it didn't before an earlier refactor, which meant a
    // row with a real, sourced dividend but no revenue/PAT/EPS (exactly
    // UMME's situation) was wrongly treated as an empty placeholder.
    const hasRealFigures = row.revenue != null || row.pat != null || row.epsBasic != null || row.dpsDeclared != null;
    if (!hasRealFigures) {
      skippedPlaceholder++;
      continue;
    }

    const security = known.get(row.ticker);

    // reportUrl-required, ticker-must-exist, and sourceTier-allowlist rules
    // all live in upsertFundamental now, shared with the /admin HTTP route
    // — not duplicated here. See packages/db/src/admin.ts.
    const result = await upsertFundamental(row);
    if (!result.ok) {
      console.error(`SKIP ${row.ticker} ${row.periodEnd}: ${result.error}`);
      skippedInvalid++;
      continue;
    }

    if (security) await crossCheck(row, security.reportingCurrency, security.exchangeCurrency);
    seeded++;
  }

  console.log(`fundamentals: seeded=${seeded} skipped_placeholder=${skippedPlaceholder} skipped_invalid=${skippedInvalid}`);
}

/**
 * Cross-check the hand-entered EPS/DPS against what the TradingView capture
 * already computed independently (daily_prices.epsTtm, dpsDerivedKes). Two
 * independent sources agreeing is real corroboration; disagreeing is worth
 * a log entry, not a silent overwrite either way — this script never edits
 * daily_prices, only flags the divergence for a human to resolve.
 *
 * daily_prices.epsTtm / dpsDerivedKes are ALWAYS in exchangeCurrency (KES) —
 * they come straight from TradingView's KES-quoted price/yield fields. This
 * fixture's row.epsBasic / row.dpsDeclared are in the security's
 * reportingCurrency, which is NOT always the same currency. Comparing across
 * two different currencies numerically isn't a data-quality signal, it's
 * just wrong — it would report a huge "divergence" for every cross-listed
 * ticker purely because UGX and KES are different units, telling you nothing
 * about whether the actual figures agree. Skip the comparison entirely when
 * the two currencies differ, rather than log a comparison that can't mean
 * anything.
 */
async function crossCheck(row: FundamentalRow, reportingCurrency: string, exchangeCurrency: string) {
  if (reportingCurrency !== exchangeCurrency) {
    await prisma.qualityLog.create({
      data: {
        severity: "INFO", code: "CROSS_CHECK_SKIPPED_CURRENCY_MISMATCH", ticker: row.ticker,
        detail: `reportingCurrency=${reportingCurrency} vs exchangeCurrency=${exchangeCurrency} — EPS/DPS cross-check against TradingView's KES-denominated derived figures skipped, since a numeric comparison across different currencies isn't a meaningful signal either way.`,
      },
    });
    return;
  }

  const latest = await prisma.dailyPrice.findFirst({
    where: { ticker: row.ticker, isStale: false },
    orderBy: { tradeDate: "desc" },
  });
  if (!latest) return;

  if (row.epsBasic != null && latest.epsTtm != null) {
    const spread = Math.abs(Number(row.epsBasic) - Number(latest.epsTtm)) / Math.abs(Number(latest.epsTtm));
    if (spread > 0.05) {
      await prisma.qualityLog.create({
        data: {
          severity: "WARN", code: "EPS_SOURCE_DIVERGENCE", ticker: row.ticker,
          detail: `annual report EPS=${row.epsBasic} vs TradingView TTM EPS=${latest.epsTtm} — ${(spread * 100).toFixed(1)}% apart. Likely a TTM-window mismatch (report is FY, TradingView is trailing-12m as of capture date), not necessarily an error.`,
        },
      });
    }
  }

  if (row.dpsDeclared != null && latest.dpsDerivedKes != null) {
    const spread = Math.abs(Number(row.dpsDeclared) - Number(latest.dpsDerivedKes)) / Math.abs(Number(latest.dpsDerivedKes));
    if (spread > 0.05) {
      await prisma.qualityLog.create({
        data: {
          severity: "INFO", code: "DPS_CONFIRMED_OVERRIDES_DERIVED", ticker: row.ticker,
          detail: `annual report DPS=${row.dpsDeclared} vs TradingView-derived=${latest.dpsDerivedKes} (confidence=${latest.dpsConfidence}) — ${(spread * 100).toFixed(1)}% apart. Not a conflict to resolve: /v1/watchlist now serves the annual-report figure automatically whenever a Fundamental row exists, regardless of what the derived value says. This log is diagnostic only — explains why the two differ, doesn't require action.`,
        },
      });
    }
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
