/**
 * Admin write routes. Deliberately thin: request-shape validation (zod)
 * happens here, but every BUSINESS rule (reportUrl required, ticker must
 * exist, sourceTier/enum allowlists) lives in @nse/db's admin.ts, shared
 * with the CLI seed scripts. If you're adding a new business rule, it goes
 * there, not here — this file should never grow its own copy of a check
 * that also needs to apply to `pnpm run seed:fundamentals`.
 *
 * Mounted at /admin (top-level, NOT under /v1) specifically so it can carry
 * a separate auth boundary — see app.ts's ADMIN_TOKEN middleware. Reusing
 * READ_TOKEN here would mean anyone with read access to this API also gets
 * write access to the financial data feeding every yield calculation.
 */
import { Router } from "express";
import { z } from "zod";
import {
  upsertFundamental, deleteFundamental,
  upsertCorporateAction, deleteCorporateAction,
} from "@nse/db";

export const adminRouter = Router();

const fundamentalSchema = z.object({
  ticker: z.string().min(1),
  periodEnd: z.string().min(1),
  periodType: z.string().nullable().optional(),
  isAudited: z.boolean().nullable().optional(),
  revenue: z.number().nullable().optional(),
  pat: z.number().nullable().optional(),
  epsBasic: z.number().nullable().optional(),
  dpsDeclared: z.number().nullable().optional(),
  bookValuePerShare: z.number().nullable().optional(),
  reportUrl: z.string().nullable().optional(),
  sourceTier: z.string().nullable().optional(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
});

const corporateActionSchema = z.object({
  actionId: z.string().min(1),
  ticker: z.string().min(1),
  actionType: z.string().min(1),
  dividendType: z.string().nullable().optional(),
  fiscalYear: z.number().nullable().optional(),
  announcementDate: z.string().nullable().optional(),
  amountPerShare: z.number().nullable().optional(),
  ratio: z.string().nullable().optional(),
  booksClosureDate: z.string().nullable().optional(),
  exDate: z.string().nullable().optional(),
  paymentDate: z.string().nullable().optional(),
  status: z.string().optional(),
  sourceUrl: z.string().nullable().optional(),
  sourceTier: z.string().nullable().optional(),
});

// ============================================================ Fundamental

adminRouter.post("/fundamentals", async (req, res) => {
  const parsed = fundamentalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
  }
  const result = await upsertFundamental(parsed.data);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(200).json(result.data);
});

adminRouter.delete("/fundamentals/:ticker/:periodEnd", async (req, res) => {
  const result = await deleteFundamental(req.params.ticker, req.params.periodEnd);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(204).send();
});

// ============================================================ CorporateAction

adminRouter.post("/corporate-actions", async (req, res) => {
  const parsed = corporateActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
  }
  const result = await upsertCorporateAction(parsed.data);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(200).json(result.data);
});

adminRouter.delete("/corporate-actions/:actionId", async (req, res) => {
  const result = await deleteCorporateAction(req.params.actionId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(204).send();
});
