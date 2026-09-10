/**
 * Admin write operations — shared by the CLI seed scripts
 * (prisma/seed-fundamentals.ts, prisma/seed-corporate-actions.ts) AND the
 * HTTP /admin routes in @nse/api. One implementation, not two, on purpose:
 * the validation here (reportUrl required for any real figure, ticker must
 * exist, sourceTier stays honest) is the exact discipline this build has
 * depended on all night — UMME's currency conflation, BKG's provenance
 * mix-up, the placeholder-detection gate that silently skipped a real
 * dividend once already. An admin dashboard that could bypass this by
 * hitting the API directly, while the CLI path still enforced it, would be
 * a real gap, not a hypothetical one.
 *
 * HTTP-layer concerns (request shape validation, status codes as numbers
 * an Express handler maps 1:1) live here too, in the AdminResult type —
 * the route handlers should be thin pass-throughs, not a second place
 * business rules get decided.
 */
import { prisma } from "./client";
import { CorpActionType, ActionStatus, DividendType } from "@prisma/client";

export type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404; error: string };

const SOURCE_TIERS = ["primary", "secondary_corroborated", "secondary_uncorroborated", "mixed"] as const;

function validSourceTier(t: unknown): t is (typeof SOURCE_TIERS)[number] {
  return typeof t === "string" && (SOURCE_TIERS as readonly string[]).includes(t);
}

async function tickerExists(ticker: string): Promise<boolean> {
  return (await prisma.securityMaster.findUnique({ where: { ticker }, select: { ticker: true } })) != null;
}

// ============================================================ Fundamental

export interface FundamentalInput {
  ticker: string;
  periodEnd: string; // ISO date
  periodType?: string | null;
  isAudited?: boolean | null;
  revenue?: number | null;
  pat?: number | null;
  epsBasic?: number | null;
  dpsDeclared?: number | null;
  bookValuePerShare?: number | null;
  reportUrl?: string | null;
  sourceTier?: string | null;
  extra?: Record<string, unknown> | null;
}

export async function upsertFundamental(input: FundamentalInput): Promise<AdminResult<unknown>> {
  if (!(await tickerExists(input.ticker))) {
    return { ok: false, status: 404, error: `${input.ticker} not in security_master — create the security first` };
  }

  const periodEnd = new Date(input.periodEnd);
  if (Number.isNaN(periodEnd.getTime())) {
    return { ok: false, status: 400, error: `periodEnd "${input.periodEnd}" is not a valid date` };
  }

  // Same rule as seed-fundamentals.ts's hasRealFigures gate: a row with any
  // real figure needs a source, or it's an unsourced claim, not data.
  const hasRealFigures =
    input.revenue != null || input.pat != null || input.epsBasic != null || input.dpsDeclared != null;
  if (hasRealFigures && !input.reportUrl) {
    return { ok: false, status: 400, error: "revenue/pat/epsBasic/dpsDeclared present but reportUrl is missing — refusing to save an unsourced figure" };
  }

  if (input.sourceTier != null && !validSourceTier(input.sourceTier)) {
    return { ok: false, status: 400, error: `sourceTier must be one of: ${SOURCE_TIERS.join(", ")}` };
  }

  const data = {
    periodType: input.periodType ?? undefined,
    isAudited: input.isAudited ?? undefined,
    revenue: input.revenue ?? undefined,
    pat: input.pat ?? undefined,
    epsBasic: input.epsBasic ?? undefined,
    dpsDeclared: input.dpsDeclared ?? undefined,
    bookValuePerShare: input.bookValuePerShare ?? undefined,
    reportUrl: input.reportUrl ?? undefined,
    sourceTier: input.sourceTier ?? undefined,
    extra: input.extra ?? undefined,
  };

  const row = await prisma.fundamental.upsert({
    where: { ticker_periodEnd: { ticker: input.ticker, periodEnd } },
    create: { ticker: input.ticker, periodEnd, ...data },
    update: data,
  });

  return { ok: true, data: row };
}

export async function deleteFundamental(ticker: string, periodEndStr: string): Promise<AdminResult<null>> {
  const periodEnd = new Date(periodEndStr);
  if (Number.isNaN(periodEnd.getTime())) {
    return { ok: false, status: 400, error: `periodEnd "${periodEndStr}" is not a valid date` };
  }
  try {
    await prisma.fundamental.delete({ where: { ticker_periodEnd: { ticker, periodEnd } } });
    return { ok: true, data: null };
  } catch {
    return { ok: false, status: 404, error: `no fundamental row for ${ticker} at ${periodEndStr}` };
  }
}

// ============================================================ CorporateAction

export interface CorporateActionInput {
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
  status?: string;
  sourceUrl?: string | null;
  sourceTier?: string | null;
}

// Enum membership checked against Prisma's OWN generated runtime objects,
// not a hand-duplicated list — schema.prisma stays the single source of
// truth for what's valid, so this can't silently drift from it the way a
// copy-pasted string array could.
const parseDate = (s: string | null | undefined) => (s ? new Date(s) : undefined);
const isValidDateOrUndef = (d: Date | undefined) => d === undefined || !Number.isNaN(d.getTime());

export async function upsertCorporateAction(input: CorporateActionInput): Promise<AdminResult<unknown>> {
  if (!(await tickerExists(input.ticker))) {
    return { ok: false, status: 404, error: `${input.ticker} not in security_master — create the security first` };
  }

  if (!(Object.values(CorpActionType) as string[]).includes(input.actionType)) {
    return { ok: false, status: 400, error: `actionType must be one of: ${Object.values(CorpActionType).join(", ")}` };
  }
  if (input.dividendType != null && !(Object.values(DividendType) as string[]).includes(input.dividendType)) {
    return { ok: false, status: 400, error: `dividendType must be one of: ${Object.values(DividendType).join(", ")}` };
  }
  if (input.status != null && !(Object.values(ActionStatus) as string[]).includes(input.status)) {
    return { ok: false, status: 400, error: `status must be one of: ${Object.values(ActionStatus).join(", ")}` };
  }
  if (input.sourceTier != null && !validSourceTier(input.sourceTier)) {
    return { ok: false, status: 400, error: `sourceTier must be one of: ${SOURCE_TIERS.join(", ")}` };
  }

  // Same rule as seed-corporate-actions.ts: an amount needs a source.
  if (input.amountPerShare != null && !input.sourceUrl) {
    return { ok: false, status: 400, error: "amountPerShare present but sourceUrl is missing — refusing to save an unsourced figure" };
  }

  const announcementDate = parseDate(input.announcementDate);
  const booksClosureDate = parseDate(input.booksClosureDate);
  const exDate = parseDate(input.exDate);
  const paymentDate = parseDate(input.paymentDate);
  for (const [name, d] of [["announcementDate", announcementDate], ["booksClosureDate", booksClosureDate], ["exDate", exDate], ["paymentDate", paymentDate]] as const) {
    if (!isValidDateOrUndef(d)) {
      return { ok: false, status: 400, error: `${name} is not a valid date` };
    }
  }

  const data = {
    ticker: input.ticker,
    actionType: input.actionType as CorpActionType,
    dividendType: (input.dividendType as DividendType) ?? undefined,
    fiscalYear: input.fiscalYear ?? undefined,
    announcementDate, amountPerShare: input.amountPerShare ?? undefined,
    ratio: input.ratio ?? undefined,
    booksClosureDate, exDate, paymentDate,
    status: (input.status as ActionStatus) ?? undefined,
    sourceUrl: input.sourceUrl ?? undefined,
    sourceTier: input.sourceTier ?? undefined,
    verifiedAt: new Date(),
  };

  const row = await prisma.corporateAction.upsert({
    where: { actionId: input.actionId },
    create: { actionId: input.actionId, ...data },
    update: data,
  });

  return { ok: true, data: row };
}

export async function deleteCorporateAction(actionId: string): Promise<AdminResult<null>> {
  try {
    await prisma.corporateAction.delete({ where: { actionId } });
    return { ok: true, data: null };
  } catch {
    return { ok: false, status: 404, error: `no corporate_action row with actionId "${actionId}"` };
  }
}
