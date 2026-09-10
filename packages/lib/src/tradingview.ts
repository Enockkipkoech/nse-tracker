/**
 * TradingView scanner — direct client.
 * COLUMNS VERIFIED 2026-09-07 against NSEKE:SCOM. All 50 candidates resolved.
 *
 * Findings baked into this file — read before changing anything:
 *
 *  1. update_mode = "delayed_streaming_900" -> data is 15 MINUTES DELAYED.
 *     Not live. Polling faster than 15m re-fetches the same bar.
 *  2. `time` carries the session bar timestamp. Use it for trade_date.
 *     The wall-clock EAT inference in index.ts is retired.
 *  3. market_cap_basic and market_cap_calc DISAGREE with each other and
 *     neither equals close x total_shares_outstanding. We compute our own.
 *  4. Value.Traded is volume x close, NOT exchange turnover.
 *  5. dividends_per_share_* are null, but DPS is recoverable two ways
 *     that cross-check each other. See deriveDps().
 */
import fs from "fs";

const SCAN = "https://scanner.tradingview.com/kenya/scan";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

/** Verified present. ORDER IS LOAD-BEARING — it defines the d[] indices. */
export const COLUMNS = [
  /* 0*/ "name", /* 1*/ "description", /* 2*/ "type", /* 3*/ "typespecs",
  /* 4*/ "currency", /* 5*/ "sector", /* 6*/ "industry", /* 7*/ "exchange",
  /* 8*/ "close", /* 9*/ "open", /*10*/ "high", /*11*/ "low",
  /*12*/ "change", /*13*/ "change_abs", /*14*/ "gap",
  /*15*/ "price_52_week_high", /*16*/ "price_52_week_low",
  /*17*/ "High.All", /*18*/ "Low.All",
  /*19*/ "volume", /*20*/ "Value.Traded",
  /*21*/ "average_volume_10d_calc", /*22*/ "average_volume_30d_calc",
  /*23*/ "relative_volume_10d_calc",
  /*24*/ "market_cap_basic", /*25*/ "market_cap_calc",
  /*26*/ "price_earnings_ttm", /*27*/ "price_book_ratio",
  /*28*/ "earnings_per_share_basic_ttm", /*29*/ "earnings_per_share_diluted_ttm",
  /*30*/ "total_shares_outstanding", /*31*/ "float_shares_outstanding",
  /*32*/ "total_shares_outstanding_fundamental",
  /*33*/ "dividends_yield", /*34*/ "dividends_yield_current",
  /*35*/ "dividend_payout_ratio_ttm",
  /*36*/ "dividends_per_share_fq", /*37*/ "dividends_per_share_fy",
  /*38*/ "continuous_dividend_payout", /*39*/ "continuous_dividend_growth",
  /*40*/ "last_annual_dividends_per_share",
  /*41*/ "Perf.W", /*42*/ "Perf.1M", /*43*/ "Perf.3M",
  /*44*/ "Perf.6M", /*45*/ "Perf.YTD", /*46*/ "Perf.Y",
  /*47*/ "update_mode", /*48*/ "time", /*49*/ "last_bar_update_time",
] as const;

const IX: Record<string, number> = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));

export interface TvRow {
    ticker: string; symbol: string;
    instrument_type: "ORDINARY" | "PREFERENCE" | "ETF" | "REIT" | "DR" | "UNKNOWN";
    company: string | null;
    sector_upstream: string | null;
    industry_upstream: string | null;      // splits banks from insurers where `sector` cannot
    currency: string | null;

    close: number | null; open: number | null; high: number | null; low: number | null;
    change_pct: number | null; change_kes: number | null; gap_pct: number | null;
    high_52w: number | null; low_52w: number | null;
    high_all: number | null; low_all: number | null;

    volume: number | null;
    value_traded_kes: number | null;       // volume x close — NOT exchange turnover
    avg_volume_10d: number | null; avg_volume_30d: number | null;
    relative_volume_10d: number | null;

    shares_outstanding: number | null;     // reported, exact
    float_shares: number | null;           // free float, straight from upstream
    free_float_pct: number | null;         // derived
    market_cap_kes: number | null;         // OURS: close x shares_outstanding
    market_cap_basic_upstream: number | null;
    market_cap_calc_upstream: number | null;

    pe_ratio: number | null; pb_ratio: number | null;
    eps_basic_ttm: number | null; eps_diluted_ttm: number | null;

    dividend_yield_pct: number | null;         // chosen field — see deriveDps
    dividend_yield_raw: number | null;         // dividends_yield, unfiltered
    dividend_yield_current_raw: number | null; // dividends_yield_current, unfiltered
    yield_fields_disagree: boolean;            // the two yield fields differ >2% (seen on KCB)
    payout_ratio_pct: number | null;
    payout_ratio_suspect: boolean;             // payout=0 but yield>0 — broken field, not "no dividend" (seen on EQTY)
    dps_derived_kes: number | null;
    dps_confidence: "high" | "low" | "none";
    dividend_streak_years: number | null;  // continuous_dividend_payout
    dividend_growth_years: number | null;

    perf_1w: number | null; perf_1m: number | null; perf_3m: number | null;
    perf_6m: number | null; perf_ytd: number | null; perf_1y: number | null;

    update_mode: string | null;
    bar_time: number | null;               // session bar epoch seconds
    last_update_time: number | null;
    trade_date: string | null;             // EAT date from bar_time
    delay_seconds: number | null;          // parsed from update_mode
}

// ---------------------------------------------------------------- helpers

const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const at = (d: unknown[], c: string): unknown => d[IX[c]] ?? null;
const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

export const bareTicker = (s: string) => s.replace(/^NSEKE:/, "");

/**
 * DPS is null upstream but recoverable via two independent routes:
 *   A) yield x price / 100
 *   B) payout_ratio x EPS_ttm / 100
 *
 * TWO TRAPS FOUND VERIFYING AGAINST LIVE DATA (do not remove these checks):
 *
 *  1. `dividends_yield` and `dividends_yield_current` can disagree hard.
 *     KCB: yield=5.1020, yield_current=4.0816 — a 20% split. Route B
 *     (payout x eps = 23.5806% x 21.2039 = 5.0002) confirms `dividends_yield`
 *     is the one that reconciles, not `_current`. On SCOM and EQTY the two
 *     fields were identical, so a small sample will not surface this bug —
 *     it only shows up on tickers where they genuinely diverge. We now try
 *     BOTH yield fields against route B and keep whichever agrees.
 *
 *  2. `dividend_payout_ratio_ttm` can be exactly 0 while yield is clearly
 *     nonzero (EQTY: payout=0, yield=5.4245%). That is a broken field, not
 *     "no earnings paid out" — a real 0% payout does not coexist with a
 *     positive yield. Route B is suppressed when payout=0 and yield>0
 *     rather than trusted as a corroborating zero.
 *
 * Still does NOT give ex-date, books closure, payment date, or the
 * interim/final split. Those remain NSE-announcement work.
 */
export function deriveDps(
    close: number | null,
    yieldPct: number | null, yieldCurrentPct: number | null,
    payoutPct: number | null, eps: number | null
): {
    dps: number | null; confidence: TvRow["dps_confidence"];
    chosenYield: number | null; yieldsDisagree: boolean; payoutSuspect: boolean;
} {
    const yieldsDisagree =
        yieldPct != null && yieldCurrentPct != null
            ? Math.abs(yieldPct - yieldCurrentPct) / Math.max(yieldPct, yieldCurrentPct, 1e-9) > 0.02
            : false;

    const payoutSuspect = payoutPct === 0 && (yieldPct ?? 0) > 0;
    const routeB = !payoutSuspect && payoutPct != null && eps != null ? (payoutPct * eps) / 100 : null;

    const routeA = (y: number | null) => (close != null && y != null ? (y * close) / 100 : null);

    // Prefer whichever yield field reconciles with route B; fall back to
    // `dividends_yield` (the field that proved reliable in the KCB case).
    let chosenYield = yieldPct ?? yieldCurrentPct ?? null;
    let a = routeA(chosenYield);

    if (yieldsDisagree && routeB != null) {
        const candidates: Array<[number | null, number | null]> = [
            [yieldPct, routeA(yieldPct)], [yieldCurrentPct, routeA(yieldCurrentPct)],
        ];
        const best = candidates
            .filter(([, val]) => val != null)
            .sort((x, y) => Math.abs((x[1] as number) - routeB) - Math.abs((y[1] as number) - routeB))[0];
        if (best) { chosenYield = best[0]; a = best[1]; }
    }

    if (a != null && routeB != null) {
        const spread = Math.abs(a - routeB) / Math.max(a, routeB);
        return spread <= 0.02
            ? { dps: round((a + routeB) / 2), confidence: "high", chosenYield, yieldsDisagree, payoutSuspect }
            : { dps: round(a), confidence: "low", chosenYield, yieldsDisagree, payoutSuspect };
    }
    if (a != null) return { dps: round(a), confidence: "low", chosenYield, yieldsDisagree, payoutSuspect };
    if (routeB != null) return { dps: round(routeB), confidence: "low", chosenYield, yieldsDisagree, payoutSuspect };
    return { dps: null, confidence: "none", chosenYield, yieldsDisagree, payoutSuspect };
}

/** "delayed_streaming_900" -> 900. realtime/streaming -> 0. */
function parseDelay(mode: string | null): number | null {
    if (!mode) return null;
    const m = mode.match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
    return /real|stream/i.test(mode) ? 0 : null;
}

/** Session date in EAT (UTC+3, no DST) from the bar epoch. */
function eatDateFromEpoch(sec: number | null): string | null {
    if (sec == null) return null;
    return new Date((sec + 3 * 3600) * 1000).toISOString().slice(0, 10);
}

export function classify(
    symbol: string, type?: string | null, typespecs?: unknown
): TvRow["instrument_type"] {
    const bare = bareTicker(symbol);
    const specs = Array.isArray(typespecs)
        ? (typespecs as unknown[]).map(s => String(s).toLowerCase()) : [];
    if (/\.P\d+$/i.test(bare) || specs.includes("preferred")) return "PREFERENCE";
    if (type === "fund" || specs.some(s => s === "etf" || s === "etn")) return "ETF";
    if (specs.some(s => s === "reit" || s === "trust")) return "REIT";
    if (type === "dr" || specs.includes("depository")) return "DR";
    if (type === "stock") return "ORDINARY";
    return "UNKNOWN";
}

// ---------------------------------------------------------------- normalize

export function normalize(row: { s: string; d: unknown[] }): TvRow {
    const d = row.d ?? [];

    const close = num(at(d, "close"));
    const shares = num(at(d, "total_shares_outstanding"));
    const float = num(at(d, "float_shares_outstanding"));
    const yieldRaw = num(at(d, "dividends_yield"));
    const yieldCurrentRaw = num(at(d, "dividends_yield_current"));
    const payout = num(at(d, "dividend_payout_ratio_ttm"));
    const eps = num(at(d, "earnings_per_share_basic_ttm"));
    const barTime = num(at(d, "time"));
    const mode = str(at(d, "update_mode"));

    const { dps, confidence, chosenYield, yieldsDisagree, payoutSuspect } =
        deriveDps(close, yieldRaw, yieldCurrentRaw, payout, eps);

    return {
        ticker: bareTicker(row.s),
        symbol: row.s,
        instrument_type: classify(row.s, str(at(d, "type")), at(d, "typespecs")),
        company: str(at(d, "description")),
        sector_upstream: str(at(d, "sector")),
        industry_upstream: str(at(d, "industry")),
        currency: str(at(d, "currency")) ?? "KES",

        close,
        open: num(at(d, "open")),
        high: num(at(d, "high")),
        low: num(at(d, "low")),
        change_pct: num(at(d, "change")),
        change_kes: num(at(d, "change_abs")),
        gap_pct: num(at(d, "gap")),
        high_52w: num(at(d, "price_52_week_high")),
        low_52w: num(at(d, "price_52_week_low")),
        high_all: num(at(d, "High.All")),
        low_all: num(at(d, "Low.All")),

        volume: num(at(d, "volume")),
        value_traded_kes: num(at(d, "Value.Traded")),
        avg_volume_10d: num(at(d, "average_volume_10d_calc")),
        avg_volume_30d: num(at(d, "average_volume_30d_calc")),
        relative_volume_10d: num(at(d, "relative_volume_10d_calc")),

        shares_outstanding: shares,
        float_shares: float,
        free_float_pct: shares && float ? round((float / shares) * 100, 2) : null,

        // Computed, not taken. Upstream's two market-cap fields disagree with each
        // other and with close x shares: basic lags the live price, calc uses a
        // share count ~1.1% below the reported one. Ours is reproducible.
        market_cap_kes: close != null && shares != null ? round(close * shares, 0) : null,
        market_cap_basic_upstream: num(at(d, "market_cap_basic")),
        market_cap_calc_upstream: num(at(d, "market_cap_calc")),

        pe_ratio: num(at(d, "price_earnings_ttm")),
        pb_ratio: num(at(d, "price_book_ratio")),
        eps_basic_ttm: eps,
        eps_diluted_ttm: num(at(d, "earnings_per_share_diluted_ttm")),

        dividend_yield_pct: chosenYield,
        dividend_yield_raw: yieldRaw,
        dividend_yield_current_raw: yieldCurrentRaw,
        yield_fields_disagree: yieldsDisagree,
        payout_ratio_pct: payout,
        payout_ratio_suspect: payoutSuspect,
        dps_derived_kes: dps,
        dps_confidence: confidence,
        dividend_streak_years: num(at(d, "continuous_dividend_payout")),
        dividend_growth_years: num(at(d, "continuous_dividend_growth")),

        perf_1w: num(at(d, "Perf.W")),
        perf_1m: num(at(d, "Perf.1M")),
        perf_3m: num(at(d, "Perf.3M")),
        perf_6m: num(at(d, "Perf.6M")),
        perf_ytd: num(at(d, "Perf.YTD")),
        perf_1y: num(at(d, "Perf.Y")),

        update_mode: mode,
        bar_time: barTime,
        last_update_time: num(at(d, "last_bar_update_time")),
        trade_date: eatDateFromEpoch(barTime),
        delay_seconds: parseDelay(mode),
    };
}

// ---------------------------------------------------------------- fetch

export async function fetchBoard(): Promise<{
    rows: TvRow[]; totalCount: number; capturedAt: string; tradeDate: string | null;
}> {
    const res = await fetch(SCAN, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA, accept: "application/json" },
        body: JSON.stringify({
            markets: ["kenya"],
            columns: COLUMNS,
            sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
            range: [0, 100],
        }),
    });

    if (!res.ok) throw new Error(`TV_${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { totalCount: number; data: Array<{ s: string; d: unknown[] }> };
    if (!Array.isArray(body.data)) throw new Error("TV_SHAPE: data[] missing — endpoint changed");

    //TODO: [DEBUG] Add a json dump of the raw response
    fs.writeFileSync("raw_response.json", JSON.stringify(body, null, 2));

    // A request without `columns` returns every d[] empty. That is a failure,
    // not 60 rows of nulls — it is exactly how the bare GET behaves.
    if (body.data.length && body.data.every(r => !r.d?.length))
        throw new Error("TV_NO_COLUMNS: every d[] empty — columns rejected or omitted");

    const rows = body.data.map(normalize);

    // Session date is a market-wide fact; take the modal value so one stale
    // suspended counter cannot mis-date the whole snapshot.
    const counts = new Map<string, number>();
    for (const r of rows) if (r.trade_date) counts.set(r.trade_date, (counts.get(r.trade_date) ?? 0) + 1);
    const tradeDate = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return { rows, totalCount: body.totalCount, capturedAt: new Date().toISOString(), tradeDate };
}

// ---------------------------------------------------------------- assertions

/** Run before persisting. Returns quality_log rows; empty means clean. */
export function assertRows(rows: TvRow[], tradeDate: string | null) {
    const issues: Array<{ severity: string; code: string; ticker?: string; detail: string }> = [];

    for (const r of rows) {
        if (r.trade_date && tradeDate && r.trade_date !== tradeDate)
            issues.push({
                severity: "warn", code: "STALE_BAR", ticker: r.ticker,
                detail: `bar dated ${r.trade_date}, board is ${tradeDate} — untraded or suspended`
            });

        if (r.volume && r.close != null && r.high != null && r.low != null && r.open != null) {
            if (!(r.low <= r.open && r.open <= r.high && r.low <= r.close && r.close <= r.high))
                issues.push({
                    severity: "error", code: "OHLC_BOUNDS", ticker: r.ticker,
                    detail: `o=${r.open} h=${r.high} l=${r.low} c=${r.close}`
                });
        }

        if (r.dps_confidence === "low" && r.dividend_yield_pct)
            issues.push({
                severity: "warn", code: "DPS_DIVERGENCE", ticker: r.ticker,
                detail: `yield and payout routes disagree >2%; dps=${r.dps_derived_kes} not authoritative`
            });

        if (r.yield_fields_disagree)
            issues.push({
                severity: "warn", code: "YIELD_FIELD_MISMATCH", ticker: r.ticker,
                detail: `dividends_yield=${r.dividend_yield_raw} vs dividends_yield_current=${r.dividend_yield_current_raw}; using ${r.dividend_yield_pct}`
            });

        if (r.payout_ratio_suspect)
            issues.push({
                severity: "error", code: "PAYOUT_RATIO_ZERO_WITH_YIELD", ticker: r.ticker,
                detail: `payout_ratio_ttm=0 but dividend_yield=${r.dividend_yield_raw}% — field broken, not "no dividend"`
            });

        // 50% is not a soft threshold — it's a hard ceiling on what's economically
        // possible for a going concern's dividend yield. Confirmed real, not
        // theoretical: UMME showed dividends_yield_current=393.65%, traced to
        // TradingView dividing a Uganda-Shilling-denominated per-share dividend
        // (26.0-222.0 Ushs, from Umeme's own FY2025 financial statements) by a
        // Kenya-Shilling close price with no currency conversion between them —
        // a cross-listing-specific bug in the upstream source, not something the
        // two-route cross-check (deriveDps) can catch, since a currency-conflated
        // number can still "agree" internally. This check is independent of
        // dps_confidence for exactly that reason: high confidence from two
        // routes agreeing says nothing about whether the underlying number is
        // physically possible.
        if (r.dividend_yield_pct != null && r.dividend_yield_pct > 50)
            issues.push({
                severity: "error", code: "YIELD_IMPLAUSIBLE", ticker: r.ticker,
                detail: `yield=${r.dividend_yield_pct}% exceeds any plausible bound for a real dividend — likely a currency or reporting-period mismatch upstream (see UMME 2026-09-09 for a confirmed real case), not a genuine figure`
            });

        if (r.free_float_pct != null && (r.free_float_pct <= 0 || r.free_float_pct > 100))
            issues.push({
                severity: "error", code: "FLOAT_RANGE", ticker: r.ticker,
                detail: `free_float_pct=${r.free_float_pct}`
            });

        if (r.instrument_type === "UNKNOWN")
            issues.push({
                severity: "warn", code: "UNCLASSIFIED", ticker: r.ticker,
                detail: `type/typespecs did not classify (${r.company ?? "no name"})`
            });
    }

    return issues;
}