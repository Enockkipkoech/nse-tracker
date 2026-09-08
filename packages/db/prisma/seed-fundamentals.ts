/**
 * Fundamentals seed — from fixtures/fundamentals.json, hand-entered from
 * published annual/interim reports. Unlike prisma/seed.ts (the security
 * master, sourced from a TradingView board pull), there is no upstream API
 * for this: revenue, PAT and book value per share aren't in the verified
 * scanner columns. This will always be manual entry — the seed script's job
 * is validation and cross-checking, not fetching.
 *
 * Once a Fundamental row exists for a ticker, GET /v1/watchlist automatically
 * prefers its dpsDeclaredKes over daily_prices.dpsDerivedKes — read-time
 * precedence, not a write here. This script never mutates daily_prices:
 * writing a "confirmed" value there would just get overwritten by the next
 * capture cron's derived estimate. See routes/api.ts.
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

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();
const FIXTURE_PATH = process.env.FUNDAMENTALS_FIXTURE ?? "fixtures/fundamentals.json";

interface FundamentalRow {
  ticker: string;
  periodEnd: string;
  periodType: "FY" | "HY" | "Q1" | "Q3";
  isAudited: boolean;
  revenueKes: number | null;
  patKes: number | null;
  epsBasicKes: number | null;
  dpsDeclaredKes: number | null;
  bookValuePerShareKes: number | null;
  reportUrl: string | null;
  extra?: Record<string, unknown> | null;
  _status?: string;
}

async function main() {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { fundamentals: FundamentalRow[] };
  const rows = raw.fundamentals ?? [];

  const known = new Set((await prisma.securityMaster.findMany({ select: { ticker: true } })).map(r => r.ticker));

  let seeded = 0, skippedPlaceholder = 0, skippedInvalid = 0;

  for (const row of rows) {
    // A row with no reportUrl and no core figures is a template placeholder,
    // not data. Skip silently — that's the expected state for unfilled rows.
    const hasCoreFigures = row.revenueKes != null || row.patKes != null || row.epsBasicKes != null;
    if (!hasCoreFigures) {
      skippedPlaceholder++;
      continue;
    }

    // Once a row DOES carry figures, reportUrl stops being optional. Data
    // with no source is a claim, not a fact — refuse to seed it rather than
    // silently accept an unsourced number.
    if (!row.reportUrl) {
      console.error(`SKIP ${row.ticker} ${row.periodEnd}: has figures but no reportUrl — refusing to seed unsourced data`);
      skippedInvalid++;
      continue;
    }

    if (!known.has(row.ticker)) {
      console.error(`SKIP ${row.ticker}: not in security_master — run prisma/seed.ts first`);
      skippedInvalid++;
      continue;
    }

    await prisma.fundamental.upsert({
      where: { ticker_periodEnd: { ticker: row.ticker, periodEnd: new Date(row.periodEnd) } },
      create: {
        ticker: row.ticker,
        periodEnd: new Date(row.periodEnd),
        periodType: row.periodType,
        isAudited: row.isAudited,
        revenueKes: row.revenueKes,
        patKes: row.patKes,
        epsBasicKes: row.epsBasicKes,
        dpsDeclaredKes: row.dpsDeclaredKes,
        bookValuePerShare: row.bookValuePerShareKes,
        reportUrl: row.reportUrl,
        extra: row.extra ?? undefined,
      },
      update: {
        periodType: row.periodType,
        isAudited: row.isAudited,
        revenueKes: row.revenueKes,
        patKes: row.patKes,
        epsBasicKes: row.epsBasicKes,
        dpsDeclaredKes: row.dpsDeclaredKes,
        bookValuePerShare: row.bookValuePerShareKes,
        reportUrl: row.reportUrl,
        extra: row.extra ?? undefined,
      },
    });

    await crossCheck(row);
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
 */
async function crossCheck(row: FundamentalRow) {
  const latest = await prisma.dailyPrice.findFirst({
    where: { ticker: row.ticker, isStale: false },
    orderBy: { tradeDate: "desc" },
  });
  if (!latest) return;

  if (row.epsBasicKes != null && latest.epsTtm != null) {
    const spread = Math.abs(Number(row.epsBasicKes) - Number(latest.epsTtm)) / Math.abs(Number(latest.epsTtm));
    if (spread > 0.05) {
      await prisma.qualityLog.create({
        data: {
          severity: "WARN", code: "EPS_SOURCE_DIVERGENCE", ticker: row.ticker,
          detail: `annual report EPS=${row.epsBasicKes} vs TradingView TTM EPS=${latest.epsTtm} — ${(spread * 100).toFixed(1)}% apart. Likely a TTM-window mismatch (report is FY, TradingView is trailing-12m as of capture date), not necessarily an error.`,
        },
      });
    }
  }

  if (row.dpsDeclaredKes != null && latest.dpsDerivedKes != null) {
    const spread = Math.abs(Number(row.dpsDeclaredKes) - Number(latest.dpsDerivedKes)) / Math.abs(Number(latest.dpsDerivedKes));
    if (spread > 0.05) {
      await prisma.qualityLog.create({
        data: {
          severity: "INFO", code: "DPS_CONFIRMED_OVERRIDES_DERIVED", ticker: row.ticker,
          detail: `annual report DPS=${row.dpsDeclaredKes} vs TradingView-derived=${latest.dpsDerivedKes} (confidence=${latest.dpsConfidence}) — ${(spread * 100).toFixed(1)}% apart. Not a conflict to resolve: /v1/watchlist now serves the annual-report figure automatically whenever a Fundamental row exists, regardless of what the derived value says. This log is diagnostic only — explains why the two differ, doesn't require action.`,
        },
      });
    }
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
