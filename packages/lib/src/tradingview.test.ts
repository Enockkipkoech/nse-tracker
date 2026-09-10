import { describe, it, expect } from "vitest";
import { deriveDps, classify, normalize, assertRows, type TvRow } from "./tradingview";

// ============================================================ deriveDps
//
// The highest-value tests in this file. Every case below is a real bug this
// build actually shipped and fixed once already tonight — these numbers are
// not invented, they're the exact figures quoted in tradingview.ts's own
// doc comments, verified against live captures.

describe("deriveDps", () => {
  it("SCOM case: both routes agree closely -> confidence high", () => {
    // yield=yieldCurrent (no disagreement), payout=83.7977, eps=2.3867, close=37.45
    // routeB = 83.7977 * 2.3867 / 100 ≈ 2.0001
    // routeA = 5.3121 * 37.45 / 100 ≈ 1.9894
    const r = deriveDps(37.45, 5.3120849933598935, 5.31208499335989, 83.7977123224536, 2.3867);
    expect(r.confidence).toBe("high");
    expect(r.yieldsDisagree).toBe(false);
    expect(r.payoutSuspect).toBe(false);
    expect(r.dps).toBeCloseTo(1.995, 1); // midpoint of the two routes, ~2.00
  });

  it("KCB case: yield fields disagree 20%, payout route breaks the tie correctly", () => {
    // This is the exact bug that shipped once: preferring dividends_yield_current
    // (4.0816 -> dps~4.00) instead of dividends_yield (5.1020 -> dps~5.00), when
    // the payout route (23.5806% x 21.2039 = 5.0002) confirms 5.1020 is the one
    // that reconciles. If this test ever fails by picking ~4.00, that specific
    // regression is back.
    const r = deriveDps(98, 5.1020408163265305, 4.08163265306122, 23.580567725748562, 21.2039);
    expect(r.yieldsDisagree).toBe(true);
    expect(r.chosenYield).toBeCloseTo(5.1020, 3);
    expect(r.chosenYield).not.toBeCloseTo(4.0816, 1);
    expect(r.confidence).toBe("high");
    expect(r.dps).toBeCloseTo(5.0, 1);
  });

  it("EQTY case: payout=0 with real yield -> flagged suspect, not treated as corroborating", () => {
    // A genuine 0% payout cannot coexist with a positive yield. routeB must be
    // suppressed here, not trusted as "confirms zero" — that was the second
    // real bug this function exists to guard against.
    const r = deriveDps(105, 5.4245283018867925, 5.42452830188679, 0, 21.8504);
    expect(r.payoutSuspect).toBe(true);
    expect(r.confidence).not.toBe("high"); // no valid routeB to corroborate against
    expect(r.dps).toBeCloseTo(5.696, 1); // yield route only: 5.4245 * 105 / 100
  });

  it("UMME-shape case: no payout/eps at all -> low confidence, yield route only, no crash", () => {
    // UMME's real payout/eps were both null upstream. deriveDps must degrade
    // gracefully to routeA-only rather than throw or silently return "high".
    const r = deriveDps(6.3, 120.35809523809525, 393.650793650794, null, null);
    expect(r.confidence).toBe("low");
    expect(r.payoutSuspect).toBe(false); // payout is null, not 0 — different case, must not conflate
    expect(r.dps).not.toBeNull();
  });

  it("both routes unavailable -> confidence none, dps null", () => {
    const r = deriveDps(null, null, null, null, null);
    expect(r.confidence).toBe("none");
    expect(r.dps).toBeNull();
  });

  it("yield fields identical -> yieldsDisagree false even without a payout route", () => {
    const r = deriveDps(50, 5, 5, null, null);
    expect(r.yieldsDisagree).toBe(false);
  });
});

// ============================================================ classify

describe("classify", () => {
  it("preference share via ticker suffix (.P0004)", () => {
    expect(classify("NSEKE:KPLC.P0004", "stock", ["common"])).toBe("PREFERENCE");
  });

  it("preference share via typespecs, even without the ticker suffix", () => {
    expect(classify("NSEKE:XYZ", "stock", ["preferred"])).toBe("PREFERENCE");
  });

  it("ETF via type=fund", () => {
    expect(classify("NSEKE:GLD", "fund", ["etf"])).toBe("ETF");
  });

  it("ETF via typespecs alone (etn)", () => {
    expect(classify("NSEKE:XYZ", "stock", ["etn"])).toBe("ETF");
  });

  it("REIT via typespecs", () => {
    expect(classify("NSEKE:FAHR", "stock", ["reit"])).toBe("REIT");
  });

  it("DR via type=dr", () => {
    expect(classify("NSEKE:XYZ", "dr", [])).toBe("DR");
  });

  it("ordinary equity via type=stock, no special typespecs", () => {
    expect(classify("NSEKE:SCOM", "stock", ["common"])).toBe("ORDINARY");
  });

  it("falls back to UNKNOWN when nothing matches", () => {
    expect(classify("NSEKE:???", "something_else", [])).toBe("UNKNOWN");
  });

  it("handles missing/undefined typespecs without throwing", () => {
    expect(classify("NSEKE:SCOM", "stock", undefined)).toBe("ORDINARY");
  });
});

// ============================================================ normalize
//
// Real raw {s, d[]} tuples, captured live and verified against TradingView
// on 2026-09-07 — not synthetic. These are the exact rows that first
// surfaced the KCB yield-mismatch bug and the EQTY payout-suspect bug. Using
// real data here is a genuine regression guard on COLUMNS' index alignment:
// if that array ever silently reorders, these specific assertions catch it
// where a synthetic fixture might not (a hand-built fixture can't drift out
// of sync with a real upstream schema change the way copy-pasted real data
// immediately reveals).

const SCOM_RAW = {
  s: "NSEKE:SCOM",
  d: [
    "SCOM", "Safaricom PLC", "stock", ["common"], "KES", "Communications",
    "Wireless Telecommunications", "NSEKE", 37.45, 37.7, 38, 37,
    -0.663129973474801, -0.25, 0, 39.5, 25.8, 45.25, 2.95, 2550764,
    95526111.80000001, 10361483.2, 8123223.5, 0.24743794846639128,
    1491663940532, 1483740094898.364, 15.691121632379438, 7.459921596124428,
    2.3867, 2.3867, 40065400000, 10042833229.4, 40065400000,
    5.3120849933598935, 5.31208499335989, 83.7977123224536, null, null,
    18, 1, null, -1.963350785340314, 5.492957746478881, 18.700475435816173,
    24.83333333333334, 31.403508771929832, 25.250836120401353,
    "delayed_streaming_900", 1788760800, 1788782473,
  ],
};

const KCB_RAW = {
  s: "NSEKE:KCB",
  d: [
    "KCB", "KCB Group PLC", "stock", ["common"], "KES", "Finance",
    "Regional Banks", "NSEKE", 98, 99, 100, 97.75, -1.0101010101010102, -1, 0,
    101, 51.25, 101, 0.66071243, 354735, 34764030, 1574559.9,
    1477396.5333333341, 0.2159721688230398, 314919339355, 314919339355,
    4.621791274246719, 0.9500804466076118, 21.2039, 21.2039, 3213460000,
    2543591768.78, 3213460000, 5.1020408163265305, 4.08163265306122,
    23.580567725748562, null, null, 2, 1, null, 4.81283422459893,
    15.294117647058824, 40, 24.840764331210192, 49.049429657794676,
    94.05940594059406, "delayed_streaming_900", 1788760800, 1788782465,
  ],
};

const EQTY_RAW = {
  s: "NSEKE:EQTY",
  d: [
    "EQTY", "Equity Group Holdings Limited", "stock", ["common"], "KES",
    "Finance", "Regional Banks", "NSEKE", 105, 105.75, 107.75, 101.5,
    -0.9433962264150944, -1, -0.2358490566037736, 109, 53.25, 109,
    3.16666667, 3043179, 319533795, 3379980.6, 2080498.4333333333,
    0.9578537356191505, 400009529297, 396235854492.31134,
    4.805404020063706, 1.2802244221219368, 21.8504, 21.8504, 3773670000,
    2941794637.86, 3773670000, 5.4245283018867925, 5.42452830188679, 0,
    null, null, 5, 2, null, 11.11111111111111, 23.529411764705884,
    36.36363636363637, 39.0728476821192, 57.89473684210526,
    90.04524886877829, "delayed_streaming_900", 1788760800, 1788782454,
  ],
};

describe("normalize", () => {
  it("SCOM: maps every field correctly, delay/trade_date parsed right", () => {
    const r = normalize(SCOM_RAW);
    expect(r.ticker).toBe("SCOM");
    expect(r.instrument_type).toBe("ORDINARY");
    expect(r.close).toBe(37.45);
    expect(r.dividend_streak_years).toBe(18);
    // bar_time 1788760800 = 2026-09-07 06:00 UTC = 09:00 EAT (verified earlier
    // against a live capture) — the modal-trade-date and delay-parsing logic
    // both run through this same conversion.
    expect(r.trade_date).toBe("2026-09-07");
    expect(r.delay_seconds).toBe(900); // "delayed_streaming_900" — confirmed
                                        // NOT live, despite oanor's "live data" claim
    expect(r.yield_fields_disagree).toBe(false);
    expect(r.dps_confidence).toBe("high");
  });

  it("KCB: yield-field mismatch survives normalize() and resolves the same way live data did", () => {
    const r = normalize(KCB_RAW);
    expect(r.yield_fields_disagree).toBe(true);
    expect(r.dividend_yield_pct).toBeCloseTo(5.1020, 3);
    expect(r.payout_ratio_suspect).toBe(false);
    expect(r.dps_confidence).toBe("high");
  });

  it("EQTY: payout-suspect survives normalize()", () => {
    const r = normalize(EQTY_RAW);
    expect(r.payout_ratio_pct).toBe(0);
    expect(r.payout_ratio_suspect).toBe(true);
    expect(r.dividend_yield_raw).toBeCloseTo(5.4245, 3);
  });

  it("handles a row with an empty d[] without throwing", () => {
    const r = normalize({ s: "NSEKE:XYZ", d: [] });
    expect(r.ticker).toBe("XYZ");
    expect(r.close).toBeNull();
    expect(r.instrument_type).toBe("UNKNOWN");
  });
});

// ============================================================ assertRows
//
// A row-factory keeps each test focused on the one field that matters,
// instead of repeating a 50-field object per case.

function makeRow(overrides: Partial<TvRow> = {}): TvRow {
  return {
    ticker: "TEST", symbol: "NSEKE:TEST", instrument_type: "ORDINARY",
    company: "Test Co", sector_upstream: "Finance", industry_upstream: "Regional Banks",
    currency: "KES",
    close: 100, open: 99, high: 101, low: 98,
    change_pct: 1, change_kes: 1, gap_pct: 0,
    high_52w: 110, low_52w: 90, high_all: 120, low_all: 50,
    volume: 1000, value_traded_kes: 100000,
    avg_volume_10d: 1000, avg_volume_30d: 1000, relative_volume_10d: 1,
    shares_outstanding: 1_000_000, float_shares: 500_000, free_float_pct: 50,
    market_cap_kes: 100_000_000, market_cap_basic_upstream: 100_000_000, market_cap_calc_upstream: 100_000_000,
    pe_ratio: 10, pb_ratio: 1, eps_basic_ttm: 10, eps_diluted_ttm: 10,
    dividend_yield_pct: 5, dividend_yield_raw: 5, dividend_yield_current_raw: 5,
    yield_fields_disagree: false,
    payout_ratio_pct: 50, payout_ratio_suspect: false,
    dps_derived_kes: 5, dps_confidence: "high",
    dividend_streak_years: 5, dividend_growth_years: 1,
    perf_1w: 0, perf_1m: 0, perf_3m: 0, perf_6m: 0, perf_ytd: 0, perf_1y: 0,
    update_mode: "delayed_streaming_900", bar_time: 1788760800, last_update_time: 1788760800,
    trade_date: "2026-09-07", delay_seconds: 900,
    ...overrides,
  };
}

describe("assertRows", () => {
  it("a fully clean row produces zero issues", () => {
    expect(assertRows([makeRow()], "2026-09-07")).toHaveLength(0);
  });

  it("STALE_BAR: row's own trade_date predates the board's modal date", () => {
    const issues = assertRows([makeRow({ trade_date: "2026-09-05" })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("STALE_BAR");
  });

  it("OHLC_BOUNDS: close outside the high/low range", () => {
    const issues = assertRows([makeRow({ close: 200 })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("OHLC_BOUNDS");
  });

  it("OHLC_BOUNDS: skipped entirely when volume is zero (untraded row, bounds meaningless)", () => {
    const issues = assertRows([makeRow({ close: 200, volume: 0 })], "2026-09-07");
    expect(issues.map(i => i.code)).not.toContain("OHLC_BOUNDS");
  });

  it("DPS_DIVERGENCE: fires on low confidence with a nonzero yield", () => {
    const issues = assertRows([makeRow({ dps_confidence: "low", dividend_yield_pct: 5 })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("DPS_DIVERGENCE");
  });

  it("YIELD_FIELD_MISMATCH: fires when yield_fields_disagree is true", () => {
    const issues = assertRows([makeRow({ yield_fields_disagree: true })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("YIELD_FIELD_MISMATCH");
  });

  it("PAYOUT_RATIO_ZERO_WITH_YIELD: fires when payout_ratio_suspect is true", () => {
    const issues = assertRows([makeRow({ payout_ratio_suspect: true })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("PAYOUT_RATIO_ZERO_WITH_YIELD");
  });

  it("YIELD_IMPLAUSIBLE: does NOT fire at exactly 50% (boundary is strictly greater-than)", () => {
    const issues = assertRows([makeRow({ dividend_yield_pct: 50 })], "2026-09-07");
    expect(issues.map(i => i.code)).not.toContain("YIELD_IMPLAUSIBLE");
  });

  it("YIELD_IMPLAUSIBLE: fires just above 50%", () => {
    const issues = assertRows([makeRow({ dividend_yield_pct: 50.01 })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("YIELD_IMPLAUSIBLE");
  });

  it("YIELD_IMPLAUSIBLE: fires on UMME's real captured value (393.65%)", () => {
    const issues = assertRows([makeRow({ dividend_yield_pct: 393.650793650794 })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("YIELD_IMPLAUSIBLE");
  });

  it("FLOAT_RANGE: fires at exactly 0% (boundary is <=0)", () => {
    const issues = assertRows([makeRow({ free_float_pct: 0 })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("FLOAT_RANGE");
  });

  it("FLOAT_RANGE: does NOT fire at exactly 100% (boundary is strictly greater-than)", () => {
    const issues = assertRows([makeRow({ free_float_pct: 100 })], "2026-09-07");
    expect(issues.map(i => i.code)).not.toContain("FLOAT_RANGE");
  });

  it("FLOAT_RANGE: fires above 100%", () => {
    const issues = assertRows([makeRow({ free_float_pct: 100.01 })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("FLOAT_RANGE");
  });

  it("UNCLASSIFIED: fires when instrument_type is UNKNOWN", () => {
    const issues = assertRows([makeRow({ instrument_type: "UNKNOWN" })], "2026-09-07");
    expect(issues.map(i => i.code)).toContain("UNCLASSIFIED");
  });

  it("a single row can trigger multiple issues at once (UMME's real shape: divergence + implausible)", () => {
    const issues = assertRows(
      [makeRow({ dps_confidence: "low", dividend_yield_pct: 393.65, yield_fields_disagree: true })],
      "2026-09-07"
    );
    const codes = issues.map(i => i.code);
    expect(codes).toContain("DPS_DIVERGENCE");
    expect(codes).toContain("YIELD_FIELD_MISMATCH");
    expect(codes).toContain("YIELD_IMPLAUSIBLE");
  });
});