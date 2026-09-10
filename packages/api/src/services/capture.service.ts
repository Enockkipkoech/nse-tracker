import type { Severity } from "@prisma/client";
import { prisma } from "@nse/db";
import { fetchBoard, assertRows, resolveSector, TICKER_RENAMES, type TvRow } from "@nse/lib";

const renameMap = new Map(TICKER_RENAMES.map(r => [r.from, r]));

const toSeverity = (s: string): Severity =>
  (s.toUpperCase() as Severity); // assertRows emits "info"|"warn"|"error", matching the enum values case-insensitively

export interface CaptureResult {
  tradeDate: string | null;
  totalCount: number;
  persisted: number;
  skippedUnknown: string[];
  issues: number;
}

/** Shared by both capture modes: fetch, assert, log issues. No persistence here. */
async function fetchAndAssess() {
  const { rows, totalCount, capturedAt, tradeDate } = await fetchBoard();
  const issues = assertRows(rows, tradeDate);
  if (issues.length) {
    await prisma.qualityLog.createMany({
      data: issues.map(i => ({ severity: toSeverity(i.severity), code: i.code, ticker: i.ticker, detail: i.detail })),
    });
  }
  return { rows, totalCount, capturedAt, tradeDate, issueCount: issues.length };
}

/**
 * Intraday poll — append-only. Every call adds new IntradayTick rows keyed
 * on (capturedAt, ticker); it never touches daily_prices. Data is 15-minute
 * delayed upstream, so calling this more often than every 15 minutes just
 * re-captures the same bar under a new capturedAt — harmless, but wasteful.
 */
export async function runIntradayCapture(): Promise<CaptureResult> {
  const { rows, totalCount, capturedAt, tradeDate, issueCount } = await fetchAndAssess();

  const known = new Set((await prisma.securityMaster.findMany({ select: { ticker: true } })).map(r => r.ticker));
  const skippedUnknown: string[] = [];
  const data = [];

  for (const row of rows) {
    const ticker = renameMap.get(row.ticker)?.to ?? row.ticker;
    if (!known.has(ticker)) { skippedUnknown.push(ticker); continue; }
    data.push({
      capturedAt: new Date(capturedAt),
      ticker,
      price: row.close,
      changePct: row.change_pct,
      volume: row.volume != null ? BigInt(Math.floor(row.volume)) : null,
      marketCapKes: row.market_cap_kes,
      tradeDateInferred: row.trade_date ? new Date(row.trade_date) : null,
    });
  }

  const result = await prisma.intradayTick.createMany({ data, skipDuplicates: true });
  return { tradeDate, totalCount, persisted: result.count, skippedUnknown, issues: issueCount };
}

/**
 * EOD capture — the one authoritative daily_prices row per trading day.
 * Run this once, after the 15:30 EAT close has settled (the 15-min delay
 * means the true close won't be visible upstream until ~15:45; scheduled a
 * safety margin later than that — see app.ts).
 */
export async function runEodCapture(): Promise<CaptureResult> {
  const { rows, totalCount, capturedAt, tradeDate, issueCount } = await fetchAndAssess();

  if (!tradeDate) {
    await log("ERROR", "NO_TRADE_DATE", "could not infer trade_date from any row's bar time — nothing persisted");
    return { tradeDate: null, totalCount, persisted: 0, skippedUnknown: [], issues: issueCount };
  }

  const known = new Set((await prisma.securityMaster.findMany({ select: { ticker: true } })).map(r => r.ticker));
  const skippedUnknown: string[] = [];

  // Build the write list first, execute as ONE batched transaction rather
  // than N sequential awaited round trips. The sequential version caused a
  // real, reproducible hang, not just a theoretical gap: against Supabase's
  // pooled (pgbouncer, port 6543) connection, running concurrently with the
  // intraday cron hitting the same small pool, 60 sequential round trips
  // stalled indefinitely — confirmed by "EOD cron tick" firing repeatedly
  // with zero "EOD capture result" ever logging, while intraday's single
  // createMany() call kept completing reliably in the same window. Batching
  // into one transaction fixes both the performance problem (one round trip
  // instead of up to 60) and the atomicity gap this loop always had — a
  // crash mid-loop used to leave a silently partial day's data with no way
  // to tell "34 tickers, done" from "34 tickers, interrupted"; a transaction
  // is now all-or-nothing.
  //
  // securityMaster.update() calls are mixed into this SAME array (Prisma's
  // $transaction accepts operations across models) to fix a separate real
  // gap: float_shares arrives fresh in every capture, but until now nothing
  // ever wrote it back to security_master — free float was set once at
  // initial seed and silently went stale forever after. Piggybacking on the
  // EOD transaction rather than adding a new round trip; free float doesn't
  // move intraday, so once a day is the right cadence regardless.
  const upserts = [];
  let tickersWritten = 0;
  for (const row of rows) {
    const rename = renameMap.get(row.ticker);
    const ticker = rename?.to ?? row.ticker;

    if (!known.has(ticker)) {
      skippedUnknown.push(ticker);
      await log("WARN", "UNKNOWN_TICKER", `${ticker} (${row.company}) not in security_master — run the seed`, ticker, tradeDate);
      continue;
    }

    upserts.push(
      prisma.dailyPrice.upsert({
        where: {
          tradeDate_ticker_revision_source: { tradeDate: new Date(tradeDate), ticker, revision: 0, source: "TV_DIRECT" },
        },
        create: toDailyPriceRow(row, ticker, tradeDate, capturedAt),
        update: toDailyPriceRow(row, ticker, tradeDate, capturedAt),
      })
    );
    tickersWritten++;

    if (row.float_shares != null) {
      upserts.push(
        prisma.securityMaster.update({
          where: { ticker },
          data: { freeFloatShares: BigInt(Math.floor(row.float_shares)) },
        })
      );
    }
  }

  if (upserts.length) {
    await prisma.$transaction(upserts);
  }

  return { tradeDate, totalCount, persisted: tickersWritten, skippedUnknown, issues: issueCount };
}

/** @deprecated use runEodCapture or runIntradayCapture explicitly */
export const runCapture = runEodCapture;

function toDailyPriceRow(row: TvRow, ticker: string, tradeDate: string, capturedAt: string) {
  return {
    tradeDate: new Date(tradeDate),
    ticker,
    revision: 0,
    open: row.open, high: row.high, low: row.low, close: row.close,
    // change_kes is signed (negative on a down day), so close - change_kes
    // recovers the prior session's close: e.g. close=37.25, change=-0.45 ->
    // prevClose = 37.70. Same derivation the earlier Worker build used
    // (round(q.price - q.change)) — not upstream data, computed here because
    // TradingView's payload has no explicit previous-close field.
    prevClose: row.close != null && row.change_kes != null ? row.close - row.change_kes : null,
    changeKes: row.change_kes, changePct: row.change_pct, gapPct: row.gap_pct,
    high52w: row.high_52w, low52w: row.low_52w,
    highAll: row.high_all, lowAll: row.low_all,
    volume: row.volume != null ? BigInt(Math.floor(row.volume)) : null,
    valueTradedKes: row.value_traded_kes,
    avgVolume10d: row.avg_volume_10d, avgVolume30d: row.avg_volume_30d,
    relativeVolume10d: row.relative_volume_10d,
    marketCapKes: row.market_cap_kes,
    sharesOutstanding: row.shares_outstanding,
    peRatio: row.pe_ratio, pbRatio: row.pb_ratio,
    epsTtm: row.eps_basic_ttm, epsDilutedTtm: row.eps_diluted_ttm,
    dividendYieldPct: row.dividend_yield_pct,
    dividendYieldRaw: row.dividend_yield_raw, dividendYieldCurrentRaw: row.dividend_yield_current_raw,
    dpsDerivedKes: row.dps_derived_kes,
    dpsConfidence: row.dps_confidence,
    payoutRatioPct: row.payout_ratio_pct,
    dividendStreakYears: row.dividend_streak_years, dividendGrowthYears: row.dividend_growth_years,
    perf1w: row.perf_1w, perf1m: row.perf_1m, perf3m: row.perf_3m,
    perf6m: row.perf_6m, perfYtd: row.perf_ytd, perf1y: row.perf_1y,
    isStale: row.trade_date !== tradeDate,
    tradedFlag: (row.volume ?? 0) > 0,
    delaySeconds: row.delay_seconds,
    lastUpdateTime: row.last_update_time != null ? new Date(row.last_update_time * 1000) : null,
    source: "TV_DIRECT" as const,
    capturedAt: new Date(capturedAt),
  };
}

async function log(severity: "INFO" | "WARN" | "ERROR", code: string, detail: string, ticker?: string, tradeDate?: string) {
  await prisma.qualityLog.create({
    data: { severity, code, ticker, tradeDate: tradeDate ? new Date(tradeDate) : undefined, detail },
  });
}

/** Board-vs-master diff. Run this before trusting coverage claims. */
export async function coverageDiff() {
  const { rows, totalCount } = await fetchBoard();
  const upstream = new Set(rows.map(r => renameMap.get(r.ticker)?.to ?? r.ticker));
  const master = await prisma.securityMaster.findMany({
    where: { status: "ACTIVE" },
    select: { ticker: true, companyName: true },
  });

  const missing = master.filter(m => !upstream.has(m.ticker));
  const unmapped = [...upstream].filter(t => !master.some(m => m.ticker === t));

  return { upstreamCount: totalCount, masterCount: master.length, missingFromUpstream: missing, unmappedUpstream: unmapped };
}