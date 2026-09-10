/**
 * Sector mapping + manual corrections — the Prisma/Postgres equivalent of
 * migrations 004-007 from the D1 build. Kept as data (not raw SQL) so
 * `scripts/seed.ts` can apply it idempotently on every run.
 *
 * Same confidence tiers as before:
 *   TIER 1 — mechanical, derived from TradingView `industry_upstream`.
 *   TIER 2 — user-confirmed overrides, each with its provenance kept inline.
 *            Do not "clean up" a comment here without checking the audit
 *            trail — several of these reversed an earlier guess of ours.
 */

export const NSE_SECTORS = [
  "AGRICULTURAL", "AUTOMOBILES_ACCESSORIES", "BANKING", "COMMERCIAL_SERVICES",
  "CONSTRUCTION_ALLIED", "ENERGY_PETROLEUM", "INSURANCE", "INVESTMENT",
  "INVESTMENT_SERVICES", "MANUFACTURING_ALLIED", "TELECOMMUNICATION",
  "REAL_ESTATE_REIT", "EXCHANGE_TRADED_FUND",
] as const;
export type NseSector = (typeof NSE_SECTORS)[number];

/** TIER 1 — mechanical rule, applied first, by TradingView `industry`. */
export const INDUSTRY_TO_SECTOR: Record<string, NseSector> = {
  "Regional Banks": "BANKING",
  "Major Banks": "BANKING",
  "Multi-Line Insurance": "INSURANCE",
  "Financial Conglomerates": "INVESTMENT",
  "Investment Banks/Brokers": "INVESTMENT_SERVICES",
  "Agricultural Commodities/Milling": "AGRICULTURAL",
};

/**
 * TIER 2 — per-ticker overrides. Applied after the Tier 1 rule, so an entry
 * here always wins. Every entry states its source; several are corrections
 * of an earlier entry in this same list — that history stays in the comment,
 * not in a separate migration file, since there's only one file now.
 */
export const SECTOR_OVERRIDES: Record<string, { sector: NseSector; note: string }> = {
  SCOM: { sector: "TELECOMMUNICATION", note: "single-member segment" },
  NSE: { sector: "INVESTMENT_SERVICES", note: "the exchange itself" },

  // Energy & Petroleum — TradingView splits Utilities from Energy; the NSE
  // does not. UMME (Umeme, Ugandan, cross-listed) confirmed by user as a
  // genuine NSE listing — counted, not excluded.
  KPC: { sector: "ENERGY_PETROLEUM", note: "official: Energy & Petroleum" },
  TOTL: { sector: "ENERGY_PETROLEUM", note: "official NSE listing extract, ISIN KE0000000463" },
  KEGN: { sector: "ENERGY_PETROLEUM", note: "merged from TradingView Utilities — unverified merge, only TOTL/KPC/KPLC confirmed official" },
  KPLC: { sector: "ENERGY_PETROLEUM", note: "merged from TradingView Utilities — unverified merge" },
  "KPLC.P0004": { sector: "ENERGY_PETROLEUM", note: "preference share, parent KPLC" },
  UMME: { sector: "ENERGY_PETROLEUM", note: "Ugandan, cross-listed on NSE — user-confirmed to count in KE rollups" },

  CGEN: { sector: "AUTOMOBILES_ACCESSORIES", note: "official NSE listing extract, ISIN KE0000000109" },

  // Construction & Allied. CONTESTED: an earlier round set these to
  // COMMERCIAL_SERVICES on a user-supplied extract whose section headers
  // read "Commercial and services" directly above both entries; the user
  // then corrected that to CONSTRUCTION_ALLIED. The two user messages
  // disagreed with each other and neither was independently verified against
  // nse.co.ke — this is the one sector assignment in the whole file still
  // worth a direct check.
  CRWN: { sector: "CONSTRUCTION_ALLIED", note: "UNRESOLVED CONTRADICTION — see comment above; user's final word, not independently confirmed" },
  PORT: { sector: "CONSTRUCTION_ALLIED", note: "UNRESOLVED CONTRADICTION — see comment above; user's final word, not independently confirmed" },

  SMER: { sector: "COMMERCIAL_SERVICES", note: "official NSE listing extract; corrects an earlier MANUFACTURING_ALLIED guess" },
  XPRS: { sector: "COMMERCIAL_SERVICES", note: "official NSE listing extract, ISIN KE0000000224" },
  EABL: { sector: "MANUFACTURING_ALLIED", note: "official NSE listing extract, ISIN KE0000000216; corrects an earlier COMMERCIAL_SERVICES guess" },
  EGAD: { sector: "AGRICULTURAL", note: "user-confirmed (Eaagads); overrides TradingView's Food:Specialty/Candy industry tag" },
  NBV: { sector: "COMMERCIAL_SERVICES", note: "user-confirmed (Nairobi Business Ventures); overrides TradingView's Apparel/Footwear industry tag" },

  NMG: { sector: "COMMERCIAL_SERVICES", note: "unverified — TradingView industry only" },
  SGL: { sector: "COMMERCIAL_SERVICES", note: "unverified — TradingView industry only" },
  LKL: { sector: "COMMERCIAL_SERVICES", note: "unverified — TradingView industry only" },
  TPSE: { sector: "COMMERCIAL_SERVICES", note: "unverified — TradingView industry only" },
  UCHM: { sector: "COMMERCIAL_SERVICES", note: "unverified — TradingView industry only" },
  SCAN: { sector: "COMMERCIAL_SERVICES", note: "unverified — TradingView industry only" },

  // Two tickers never discussed anywhere in this build — surfaced only by
  // the seed script's "4 unmapped" warning, traced by hand afterward.
  // Best-guess placement, same convention as the entries above: broad
  // Commercial & Services catch-all until an official source says otherwise.
  KQ: { sector: "COMMERCIAL_SERVICES", note: "Kenya Airways — unverified guess, TradingView industry is Airlines with no NSE equivalent segment" },
  HAFR: { sector: "COMMERCIAL_SERVICES", note: "Home Afrika — unverified guess, TradingView industry is Homebuilding; not a REIT (that's the separate REAL_ESTATE_REIT bucket), so this is the least-bad fit pending confirmation" },

  BAT: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  UNGA: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  CARB: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  BOC: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  FTGH: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  EVRD: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  OCH: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },
  SKL: { sector: "MANUFACTURING_ALLIED", note: "unverified — TradingView industry only" },

  // HFCB — NOT a taxonomy question. HF Group Plc rebranded to HFCB Group Plc
  // and changed ticker HFCK -> HFCB effective 2026-05-22. TradingView's HFCB
  // was current and correct throughout; an official-source extract quoted
  // earlier simply predated the rebrand. Both sources were right for their
  // respective dates — not a data-quality bug.
  HFCB: { sector: "BANKING", note: "confirmed via MarketScreener; former ticker HFCK, rebrand effective 2026-05-22" },
};

/** ISINs confirmed from an official NSE listing extract. Fill, don't guess. */
export const CONFIRMED_ISIN: Record<string, string> = {
  HFCB: "KE0000000240",
  XPRS: "KE0000000224",
  TOTL: "KE0000000463",
  CGEN: "KE0000000109",
  CRWN: "KE0000000141",
  PORT: "KE0000000190",
  EABL: "KE0000000216",
  // SMER deliberately absent — not supplied, not guessed (UNIQUE constraint
  // makes a wrong guess here worse than a null).
};

/** Corporate rebrands. Applied to seed data before ticker matching. */
export const TICKER_RENAMES: Array<{ from: string; to: string; date: string; note: string }> = [
  {
    from: "HFCK", to: "HFCB", date: "2026-05-22",
    note: "HF Group Plc -> HFCB Group Plc, mortgage lender -> Tier II bank rebrand"
  },
];

export function resolveSector(
  ticker: string,
  industryUpstream: string | null,
  instrumentType?: string
): NseSector | null {
  // ETFs are not equities and were handled by a blanket rule in the original
  // D1 migration (instrument_type='ETF' -> EXCHANGE_TRADED_FUND) that never
  // carried over when this became a function of (ticker, industry) alone.
  // Restoring it generically rather than as two more per-ticker overrides,
  // so the next ETF listing doesn't repeat this gap.
  if (instrumentType === "ETF") return "EXCHANGE_TRADED_FUND";
  if (SECTOR_OVERRIDES[ticker]) return SECTOR_OVERRIDES[ticker].sector;
  if (industryUpstream && INDUSTRY_TO_SECTOR[industryUpstream]) return INDUSTRY_TO_SECTOR[industryUpstream];
  return null; // left unmapped on purpose — surfaces in the seed script's coverage report
}

/**
 * Reporting-currency overrides for cross-listed securities. Every ticker
 * not listed here is assumed to report in KES — correct for the other 58,
 * wrong only for a genuine foreign cross-listing.
 *
 * Each entry's confidence level is real, not uniform — say so explicitly
 * rather than presenting both at the same certainty:
 *
 *   UMME — CONFIRMED. Traced directly against Umeme's own FY2025 Financial
 *   Statement (four source PDFs reviewed): interim dividend of Ushs 222.0/
 *   share, no final dividend declared for FY2025 or FY2024. This is what
 *   explained TradingView's 393.65% derived yield (see YIELD_IMPLAUSIBLE)
 *   — a UGX dividend divided by a KES price with no FX conversion.
 *
 *   BKG — STRUCTURALLY LIKELY, NOT CONFIRMED. Bank of Kigali, Rwanda-
 *   domiciled, RSE-primary-listed since 2011, NSE cross-listed since 2018,
 *   reports in RWF. Same structural situation as UMME. But BKG's derived
 *   yield (7.15% on the 2026-09-09 capture) looks entirely plausible — no
 *   annual report has been reviewed to confirm or rule out the same
 *   currency-conflation bug the way UMME's four documents did. Included
 *   here because the reporting-currency fact itself (RWF, not KES) is
 *   independently verifiable and correct regardless of whether the yield
 *   bug turns out to apply — but don't treat "BKG's yield looks fine" as
 *   evidence it's actually correct.
 */
export const REPORTING_CURRENCY_OVERRIDES: Record<string, { currency: string; confidence: "confirmed" | "likely"; note: string }> = {
  UMME: {
    currency: "UGX",
    confidence: "confirmed",
    note: "Umeme Ltd, Uganda-domiciled, primary listing on the Uganda Securities Exchange. Confirmed via FY2025 Financial Statement and AGM/Post-AGM notices.",
  },
  BKG: {
    currency: "RWF",
    confidence: "likely",
    note: "BK Group Plc (Bank of Kigali), Rwanda-domiciled, primary listing on the Rwanda Stock Exchange since 2011, NSE cross-listing since 2018. Reporting currency confirmed via public company records; whether it shares UMME's specific yield-calculation bug has NOT been independently verified against a BK Group annual report.",
  },
};

export function resolveReportingCurrency(ticker: string): string {
  return REPORTING_CURRENCY_OVERRIDES[ticker]?.currency ?? "KES";
}