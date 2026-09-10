/**
 * Prisma seed — security_master from a TradingView board pull.
 *
 * Replaces D1 migrations 003 (scripts/seed-master.sh output) and 004-007
 * (sector corrections, ISIN backfill, HFCB rebrand) with one idempotent run.
 * Re-running this is always safe — every write is an upsert keyed on ticker.
 *
 * Input: a board.json captured the same way as before —
 *   scripts/probe-columns.sh   (once, to verify columns — unchanged)
 *   then a POST to the scanner using @nse/lib's fetchBoard()
 *
 * Usage:
 *   pnpm tsx scripts/fetch-board.ts > fixtures/board.json   # capture
 *   pnpm prisma db seed                                     # apply
 */

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });
// ^ makes `tsx prisma/seed.ts` work standalone, not just via `prisma db seed`
// (which loads prisma.config.ts's own dotenv call). Redundant when run the
// normal way — harmless, dotenv won't override already-set env vars.

import { PrismaClient, InstrumentType } from "@prisma/client";
import { readFileSync } from "node:fs";
import { normalize, resolveSector, resolveReportingCurrency, CONFIRMED_ISIN, TICKER_RENAMES, type TvRow } from "@nse/lib";

const prisma = new PrismaClient();
const BOARD_PATH = process.env.BOARD_FIXTURE ?? "fixtures/board.json";

async function main() {
  const raw = JSON.parse(readFileSync(BOARD_PATH, "utf-8")) as {
    totalCount: number;
    data: Array<{ s: string; d: unknown[] }>;
  };

  const rows: TvRow[] = raw.data.map(normalize);

  console.log(`board pull: totalCount=${raw.totalCount} rows=${rows.length}`);
  if (rows.length !== raw.totalCount) {
    console.warn(`WARN row count mismatch — capture may be truncated or the board changed`);
  }

  // Rebrands apply before anything else, so a stale ticker in the fixture
  // (e.g. HFCK if you're replaying an old capture) lands on the current row.
  const renameMap = new Map(TICKER_RENAMES.map(r => [r.from, r]));

  let unmappedSector = 0;
  const unclassified: string[] = [];
  let processed = 0;

  for (const row of rows) {
    const rename = renameMap.get(row.ticker);
    const ticker = rename?.to ?? row.ticker;

    const sector = resolveSector(ticker, row.industry_upstream, row.instrument_type);
    if (!sector) unmappedSector++;
    if (row.instrument_type === "UNKNOWN") unclassified.push(ticker);

    const isin = CONFIRMED_ISIN[ticker] ?? undefined;
    const inMarketCap = row.instrument_type === "ORDINARY";
    // row.currency is TradingView's own live-fetched field — what currency
    // the NSE price itself is quoted in. Never hand-set; if a genuinely
    // non-KES-quoted listing ever appears, this reflects it automatically.
    const exchangeCurrency = row.currency ?? "KES";
    const reportingCurrency = resolveReportingCurrency(ticker);

    await prisma.securityMaster.upsert({
      where: { ticker },
      create: {
        ticker,
        tvSymbol: row.symbol,
        companyName: row.company ?? ticker,
        sectorUpstream: row.sector_upstream,
        industryUpstream: row.industry_upstream,
        nseSector: sector ?? undefined,
        instrumentType: row.instrument_type as InstrumentType,
        parentTicker: row.instrument_type === "PREFERENCE" ? ticker.split(".")[0] : undefined,
        formerTicker: rename?.from,
        tickerChangeDate: rename ? new Date(rename.date) : undefined,
        sharesIssued: row.shares_outstanding != null ? BigInt(Math.floor(row.shares_outstanding)) : undefined,
        freeFloatShares: row.float_shares != null ? BigInt(Math.floor(row.float_shares)) : undefined,
        isin,
        exchangeCurrency,
        reportingCurrency,
        inMarketCap,
        coveredByTv: true,
        verifiedAt: new Date(),
      },
      update: {
        tvSymbol: row.symbol,
        companyName: row.company ?? undefined,
        sectorUpstream: row.sector_upstream,
        industryUpstream: row.industry_upstream,
        // Never downgrade a manually-confirmed sector back to null; only
        // write when we actually resolved one this run.
        ...(sector ? { nseSector: sector } : {}),
        instrumentType: row.instrument_type as InstrumentType,
        ...(rename ? { formerTicker: rename.from, tickerChangeDate: new Date(rename.date) } : {}),
        sharesIssued: row.shares_outstanding != null ? BigInt(Math.floor(row.shares_outstanding)) : undefined,
        freeFloatShares: row.float_shares != null ? BigInt(Math.floor(row.float_shares)) : undefined,
        ...(isin ? { isin } : {}),
        exchangeCurrency,
        reportingCurrency,
        inMarketCap,
        coveredByTv: true,
      },
    });

    processed++;
  }

  await prisma.qualityLog.create({
    data: {
      severity: "INFO",
      code: "SEED_COMPLETE",
      detail: `rows=${rows.length} unmapped_sector=${unmappedSector} unclassified_instrument=${unclassified.join(",") || "none"}`,
    },
  });

  console.log(`seeded ${processed} tickers`);
  if (unmappedSector) console.warn(`WARN ${unmappedSector} tickers have no nse_sector — check packages/lib/src/sectors.ts coverage`);
  if (unclassified.length) console.warn(`WARN unclassified instrument_type: ${unclassified.join(", ")}`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());