import { Router } from "express";
import { prisma } from "@nse/db";
import { runIntradayCapture, runEodCapture, coverageDiff } from "../services/capture.service";

export const router = Router();

const DPS_CONFIDENCE_RANK: Record<string, number> = { confirmed: 3, high: 2, low: 1, none: 0 };

/**
 * Flat watchlist. Ported from the D1 `watchlist` VIEW as a query rather than
 * a database view — keeps the dividend/latest-price logic in application
 * code, next to the assertion logic it depends on, instead of split across
 * a SQL file and a service file.
 *
 * CURRENCY: price fields (closeKes, marketCapKes) are always in
 * exchangeCurrency — every DailyPrice row comes straight from TradingView's
 * KES-quoted NSE price, never ambiguous. `dps` is the one field that can
 * come from two different sources with two different currencies (derived,
 * always exchangeCurrency; confirmed, the security's reportingCurrency),
 * so it's the one field that needs its own explicit currency alongside it
 * rather than inheriting an assumed one.
 */
router.get("/watchlist", async (req, res) => {
  try {
    const securities = await prisma.securityMaster.findMany({
      where: { status: "ACTIVE" },
      include: {
        dailyPrices: { where: { isStale: false }, orderBy: { tradeDate: "desc" }, take: 1 },
        // Latest audited figure per ticker. Read-time only — never written
        // back into daily_prices, which would just get overwritten by the
        // next capture's derived estimate. This join is what lets a
        // confirmed annual-report DPS outrank TradingView's yield/payout
        // reconciliation without fighting the capture cron for control of
        // the same column.
        // Fetches every period, not just the latest one — take:1 with
        // orderBy periodEnd desc was the exact bug BKG exposed: its most
        // recent period (H1 2026) has no dividend data, while an earlier
        // one (FY2025) does, so blindly taking "latest" silently discarded
        // real, sourced dividend data in favor of a period that has none.
        // Selection happens in application code below.
        fundamentals: { orderBy: { periodEnd: "desc" } },
      },
    });

    let data = securities
      .map(s => {
        const latest = s.dailyPrices[0];
        // Prefer the most recent period that actually HAS a dividend figure
        // (list is already periodEnd-desc, so .find() returns the newest
        // qualifying one) — fall back to the latest period overall only
        // when no period has dividend data at all, preserving today's
        // behavior for tickers with genuinely no confirmed dividend yet.
        const confirmed = s.fundamentals.find(f => f.dpsDeclared != null) ?? s.fundamentals[0] ?? null;
        const hasConfirmedDps = confirmed?.dpsDeclared != null;

        // Confirmed (audited, from an annual/interim report) always wins
        // over derived (TradingView yield/payout reconciliation, which
        // showed a >5% mismatch on ~45% of the board — see DPS_DIVERGENCE /
        // YIELD_FIELD_MISMATCH / PAYOUT_RATIO_ZERO_WITH_YIELD in quality_log).
        // corporate_actions is deliberately NOT in this chain — it answers
        // "when" (ex-date, payment date), not "how much", and right now has
        // incomplete rows (see fixtures/corporate-actions.json's interim
        // entry, with null dates) that would make it a worse amount-source
        // than Fundamental, not a better one.
        const dps = hasConfirmedDps ? confirmed.dpsDeclared : latest?.dpsDerivedKes ?? null;
        const dpsConfidence = hasConfirmedDps ? "confirmed" : latest?.dpsConfidence ?? null;
        const dpsSource = hasConfirmedDps ? "annual_report" : latest?.dpsDerivedKes != null ? "derived" : null;
        // Confirmed DPS is in reportingCurrency; derived DPS is always
        // exchangeCurrency (it comes straight from TradingView's KES-quoted
        // yield fields). These two are NOT always the same currency — that
        // gap is exactly the bug UMME/BKG surfaced.
        const dpsCurrency = hasConfirmedDps ? s.reportingCurrency : s.exchangeCurrency;
        // BKG-class case: a derived (TradingView-computed) yield for a
        // ticker whose real reportingCurrency differs from exchangeCurrency.
        // UMME's confirmed DPS made its currency mismatch checkable and
        // yieldPct got suppressed outright. A DERIVED yield has no such
        // cross-check available — TradingView computes it entirely in
        // exchangeCurrency terms with no visibility into whether the
        // underlying dividend was actually RWF/UGX/etc. BKG's derived yield
        // (7.27%) looks entirely plausible, which is exactly what makes it
        // unverified rather than exonerated: nothing currently confirms or
        // rules out the same conflation UMME had, just at a less dramatic
        // scale. This flag doesn't suppress the number (unlike the confirmed
        // case, there's nothing better to fall back to) — it says "verify
        // this against the company's own filings before trusting it."
        const derivedYieldCurrencyUnverified =
          dpsSource === "derived" && s.reportingCurrency !== s.exchangeCurrency;

        // Yield is only computable when dps and close share a currency.
        // Confirmed DPS in a non-KES reportingCurrency (UMME) can't be
        // divided by a KES close to produce a meaningful percentage — that
        // division IS the bug this whole refactor exists to stop repeating.
        const canComputeConfirmedYield =
          hasConfirmedDps && s.reportingCurrency === s.exchangeCurrency &&
          latest?.close != null && Number(latest.close) > 0;
        const dividendYieldPct = canComputeConfirmedYield
          ? Number(confirmed!.dpsDeclared) / Number(latest!.close) * 100
          : hasConfirmedDps
            ? null // confirmed DPS exists but currencies differ — no fabricated yield
            : latest?.dividendYieldPct ?? null;

        return {
          ticker: s.ticker,
          companyName: s.companyName,
          isin: s.isin,
          nseSector: s.nseSector,
          instrumentType: s.instrumentType,
          exchangeCurrency: s.exchangeCurrency, // what closeKes/marketCapKes are in — always this
          asOf: latest?.tradeDate ?? null,
          closeKes: latest?.close ?? null,
          changePct: latest?.changePct ?? null,
          marketCapKes: latest?.marketCapKes ?? null,
          peRatio: latest?.peRatio ?? null,
          dividendYieldPct,
          dps,
          dpsCurrency,
          dpsConfidence,
          dpsSource,
          derivedYieldCurrencyUnverified,
          // Provenance for the confirmed case — "confirmed" is an assertion
          // that should be checkable, not just a label. Null for the
          // derived/none cases, where there's no report to point at.
          dpsReportUrl: hasConfirmedDps ? confirmed!.reportUrl : null,
          dpsReportPeriodEnd: hasConfirmedDps ? confirmed!.periodEnd : null,
          // "confirmed" was one flat label whether a figure came from an
          // audited PDF (SCOM) or a Google AI Overview corroborated only by
          // arithmetic (BKG's FY2025 dividend) — indistinguishable to any
          // API consumer until now. null for the derived/none cases, same
          // as the two fields above.
          dpsSourceTier: hasConfirmedDps ? confirmed!.sourceTier : null,
          inMarketCap: s.inMarketCap,
        };
      })
      .sort((a, b) => Number(b.marketCapKes ?? 0) - Number(a.marketCapKes ?? 0));

    // ?minConfidence=high returns only confirmed+high, dropping low/none/null.
    // Floor filter, not exact match — "give me the ones I can trust", not
    // "give me exactly this tier". Invalid/missing param = no filtering.
    const minConfidence = String(req.query.minConfidence ?? "").toLowerCase();
    if (minConfidence in DPS_CONFIDENCE_RANK) {
      const floor = DPS_CONFIDENCE_RANK[minConfidence];
      data = data.filter(d => DPS_CONFIDENCE_RANK[d.dpsConfidence ?? "none"] >= floor);
    }

    res.json({ count: data.length, data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Detail view for one ticker's Fundamental record(s) — the full report,
 * including the `extra` JSON blob (EBITDA, PBT, NCI, auditor, etc.) that
 * /watchlist deliberately omits to keep the list-endpoint payload sane
 * across all 60 tickers. This is where that detail actually lives.
 *
 * Default: latest period only. ?all=true: full reporting history for the
 * ticker, oldest-to-newest data hidden behind an explicit opt-in rather
 * than returned by default.
 *
 * reportingCurrency is returned ONCE at the envelope level, not per-row —
 * it's a security-level constant (same for every period a company reports),
 * not something that varies row to row within one ticker's history.
 */
router.get("/fundamentals", async (req, res) => {
  try {
    const ticker = String(req.query.ticker ?? "");
    if (!ticker) return res.status(400).json({ error: "ticker required" });

    const security = await prisma.securityMaster.findUnique({
      where: { ticker },
      select: { reportingCurrency: true },
    });
    if (!security) return res.status(404).json({ error: `${ticker} not found in security_master` });

    const all = req.query.all === "true";
    const data = await prisma.fundamental.findMany({
      where: { ticker },
      orderBy: { periodEnd: "desc" },
      take: all ? undefined : 1,
    });

    if (data.length === 0) return res.status(404).json({ error: `no fundamentals on file for ${ticker}` });

    res.json({ ticker, reportingCurrency: security.reportingCurrency, count: data.length, data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get("/history", async (req, res) => {
  try {
    const ticker = String(req.query.ticker ?? "");
    if (!ticker) return res.status(400).json({ error: "ticker required" });

    const limit = Math.min(Number(req.query.limit ?? 250), 1000);
    const data = await prisma.dailyPrice.findMany({
      where: { ticker },
      orderBy: { tradeDate: "desc" },
      take: limit,
    });
    res.json({ ticker, count: data.length, data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/capture/intraday", async (_req, res) => {
  try {
    res.json(await runIntradayCapture());
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

router.post("/capture/eod", async (_req, res) => {
  try {
    res.json(await runEodCapture());
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

router.get("/coverage", async (_req, res) => {
  try {
    res.json(await coverageDiff());
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

router.get("/quality", async (_req, res) => {
  try {
    const data = await prisma.qualityLog.findMany({ orderBy: { loggedAt: "desc" }, take: 200 });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Dividend calendar — the piece tafitifinance.co.ke's /dividends page has
 * and this API didn't. All data already exists in corporate_actions; this
 * is a query, not new data collection.
 *
 * Yield basis is deliberately explicit rather than silently uniform:
 *   upcoming -> against the LATEST close (nothing has happened yet, only
 *     an indicative forward yield makes sense)
 *   past     -> against the close AT THE EX-DATE, not today's price. Using
 *     today's price for a dividend paid a year ago would misstate what it
 *     actually yielded at the time. Tafiti's own past table mostly shows
 *     "—" for yield rather than answer this — that's evasion, not a design
 *     choice worth copying. Every row here carries yieldBasis so nothing
 *     is presented without saying what it's relative to.
 *
 * CURRENCY: amountPerShare is in the security's reportingCurrency, not
 * assumed KES — a corporate_actions row for UMME/BKG-like tickers won't
 * be in KES. yieldPct is only computed when reportingCurrency matches
 * exchangeCurrency; dividing a reportingCurrency amount by a KES close
 * otherwise would repeat the exact bug this refactor exists to stop.
 */
router.get("/dividends", async (req, res) => {
  try {
    const window = req.query.window === "past" ? "past" : "upcoming";
    const ticker = req.query.ticker ? String(req.query.ticker) : undefined;
    const months = Math.max(1, Number(req.query.months ?? 12));
    const today = new Date();

    const where: Record<string, unknown> = {
      actionType: "CASH_DIVIDEND",
      ...(ticker ? { ticker } : {}),
    };
    if (window === "upcoming") {
      where.exDate = { gte: today };
    } else {
      const since = new Date(today);
      since.setMonth(since.getMonth() - months);
      where.exDate = { lt: today, gte: since };
    }

    const actions = await prisma.corporateAction.findMany({
      where,
      orderBy: { exDate: window === "upcoming" ? "asc" : "desc" },
      include: { security: { select: { companyName: true, reportingCurrency: true, exchangeCurrency: true } } },
    });

    // Latest close per ticker, for upcoming-row yield. One query, not N —
    // corporate_actions here is at most a couple dozen rows, but no reason
    // to do this the N+1 way when a single groupBy covers every ticker at once.
    const latestCloseByTicker = new Map<string, number>();
    if (window === "upcoming" && actions.length) {
      const tickers = [...new Set(actions.map(a => a.ticker))];
      const latest = await prisma.dailyPrice.findMany({
        where: { ticker: { in: tickers }, isStale: false },
        orderBy: { tradeDate: "desc" },
        distinct: ["ticker"],
        select: { ticker: true, close: true },
      });
      for (const l of latest) if (l.close != null) latestCloseByTicker.set(l.ticker, Number(l.close));
    }

    const data = await Promise.all(
      actions.map(async a => {
        let yieldPct: number | null = null;
        let yieldBasis: "latest_close" | "close_at_ex_date" | null = null;
        const currenciesMatch = a.security.reportingCurrency === a.security.exchangeCurrency;

        if (a.amountPerShare != null && currenciesMatch) {
          if (window === "upcoming") {
            const close = latestCloseByTicker.get(a.ticker);
            if (close) {
              yieldPct = Number(a.amountPerShare) / close * 100;
              yieldBasis = "latest_close";
            }
          } else if (a.exDate) {
            // Nearest price ON OR BEFORE the ex-date — the price a holder
            // actually bought at to qualify for this dividend.
            const priceAtExDate = await prisma.dailyPrice.findFirst({
              where: { ticker: a.ticker, tradeDate: { lte: a.exDate }, isStale: false },
              orderBy: { tradeDate: "desc" },
              select: { close: true },
            });
            if (priceAtExDate?.close != null) {
              yieldPct = Number(a.amountPerShare) / Number(priceAtExDate.close) * 100;
              yieldBasis = "close_at_ex_date";
            }
          }
        }

        return {
          ticker: a.ticker,
          companyName: a.security.companyName,
          dividendType: a.dividendType,
          amountPerShare: a.amountPerShare,
          amountCurrency: a.security.reportingCurrency,
          announcementDate: a.announcementDate,
          booksClosureDate: a.booksClosureDate,
          exDate: a.exDate,
          paymentDate: a.paymentDate,
          status: a.status,
          yieldPct,
          yieldBasis,
        };
      })
    );

    res.json({ window, count: data.length, data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Single-ticker detail page — everything /equities/{TICKER} needs in one
 * round trip: current price snapshot, latest fundamentals (incl. extra),
 * full dividend event history. Composed here rather than left to three
 * frontend calls, since this is exactly the page a dividend-calendar row
 * links into and a detail page shouldn't cost three round trips to render.
 *
 * exchangeCurrency and reportingCurrency are both surfaced at the top level
 * — this is the endpoint that was missing them entirely before this
 * refactor, which is what prompted the whole thing.
 */
router.get("/equities", async (req, res) => {
  try {
    const ticker = String(req.query.ticker ?? "");
    if (!ticker) return res.status(400).json({ error: "ticker required" });

    const security = await prisma.securityMaster.findUnique({
      where: { ticker },
      include: {
        dailyPrices: { where: { isStale: false }, orderBy: { tradeDate: "desc" }, take: 1 },
        // No take:1 — see the two-variable split below. This route surfaces
        // BOTH a general "fundamentals" display block (wants the truly
        // latest period, richest data) AND a dividend figure (wants the
        // latest period that actually HAS one) — those are genuinely
        // different questions, and BKG is the ticker that proves it: its
        // latest period (H1 2026) has rich revenue/PAT/EPS but no dividend;
        // an earlier period (FY2025) has the dividend but far less detail.
        // One variable can't correctly answer both.
        fundamentals: { orderBy: { periodEnd: "desc" } },
        corporateActions: { orderBy: { exDate: "desc" } },
      },
    });

    if (!security) return res.status(404).json({ error: `${ticker} not found` });

    const latest = security.dailyPrices[0];
    // General display block — unchanged semantics, truly the latest period.
    const latestFundamental = security.fundamentals[0] ?? null;
    // Dividend precedence — prefers the latest period that actually HAS a
    // dividend figure over the latest period overall. Falls back to
    // latestFundamental only when no period has dividend data at all.
    const dpsFundamental = security.fundamentals.find(f => f.dpsDeclared != null) ?? null;
    const hasConfirmedDps = dpsFundamental != null;
    const dpsSource = hasConfirmedDps ? "annual_report" : latest?.dpsDerivedKes != null ? "derived" : null;
    const dpsCurrency = hasConfirmedDps ? security.reportingCurrency : security.exchangeCurrency;
    const canComputeConfirmedYield =
      hasConfirmedDps && security.reportingCurrency === security.exchangeCurrency &&
      latest?.close != null && Number(latest.close) > 0;
    // Same BKG-class flag as /watchlist — see that route's comment for the
    // full reasoning. A derived yield has no cross-check available the way
    // a confirmed-but-mismatched one does; this says "verify before trusting."
    const derivedYieldCurrencyUnverified =
      dpsSource === "derived" && security.reportingCurrency !== security.exchangeCurrency;

    // Next/last dividend — the addition this route was always missing.
    // Deliberately does NOT touch dpsSource/dividend precedence above; this
    // answers "when," not "how much" (see the /watchlist precedence-chain
    // comment for why those stay separate).
    //
    // effectiveDate falls back through exDate ?? paymentDate ?? announcementDate
    // rather than relying on exDate alone: every corporate_actions row seeded
    // so far has exDate=null (no NSE-specific ex-date has been sourced for
    // any ticker yet — see the SCOM/UMME/BKG fixture notes). Ordering purely
    // by exDate would make this feature silently do nothing with today's
    // real data. This degrades gracefully and will sharpen automatically
    // the moment real ex-dates get sourced, without a code change.
    const today = new Date();
    const dividendActions = security.corporateActions
      .filter(a => a.actionType === "CASH_DIVIDEND")
      .map(a => ({ action: a, effectiveDate: a.exDate ?? a.paymentDate ?? a.announcementDate }))
      .filter((x): x is { action: (typeof security.corporateActions)[number]; effectiveDate: Date } => x.effectiveDate != null);

    const next = dividendActions
      .filter(x => x.effectiveDate >= today)
      .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime())[0];
    const last = dividendActions
      .filter(x => x.effectiveDate < today)
      .sort((a, b) => b.effectiveDate.getTime() - a.effectiveDate.getTime())[0];

    const toDividendSummary = (x: typeof next) => x && {
      dividendType: x.action.dividendType,
      amountPerShare: x.action.amountPerShare,
      currency: security.reportingCurrency,
      announcementDate: x.action.announcementDate,
      booksClosureDate: x.action.booksClosureDate,
      exDate: x.action.exDate,
      paymentDate: x.action.paymentDate,
      status: x.action.status,
      sourceTier: x.action.sourceTier,
    };

    res.json({
      ticker: security.ticker,
      companyName: security.companyName,
      isin: security.isin,
      nseSector: security.nseSector,
      instrumentType: security.instrumentType,
      exchangeCurrency: security.exchangeCurrency,
      reportingCurrency: security.reportingCurrency,
      price: {
        // Always exchangeCurrency — every field here comes straight from
        // TradingView's KES-quoted NSE price, never ambiguous.
        asOf: latest?.tradeDate ?? null,
        closeKes: latest?.close ?? null,
        changePct: latest?.changePct ?? null,
        high52w: latest?.high52w ?? null,
        low52w: latest?.low52w ?? null,
        marketCapKes: latest?.marketCapKes ?? null,
        peRatio: latest?.peRatio ?? null,
      },
      dividend: {
        dps: hasConfirmedDps ? dpsFundamental!.dpsDeclared : latest?.dpsDerivedKes ?? null,
        dpsCurrency,
        confidence: hasConfirmedDps ? "confirmed" : latest?.dpsConfidence ?? null,
        sourceTier: hasConfirmedDps ? dpsFundamental!.sourceTier : null,
        source: dpsSource,
        derivedYieldCurrencyUnverified,
        yieldPct: canComputeConfirmedYield
          ? Number(dpsFundamental!.dpsDeclared) / Number(latest!.close) * 100
          : hasConfirmedDps
            ? null // confirmed DPS in a currency that doesn't match the KES price — no fabricated yield
            : latest?.dividendYieldPct ?? null,
      },
      // The general display block deliberately uses latestFundamental (truly
      // the newest period, richest data), NOT dpsFundamental — this is what
      // stops the dividend-precedence fix above from silently downgrading
      // what a consumer sees when they ask "what are this company's latest
      // fundamentals." BKG's case: latestFundamental is H1 2026 (real
      // revenue/PAT/EPS, no dividend); dpsFundamental is FY2025 (has the
      // dividend, far less other detail). Both are correct for their own
      // question; using the wrong one for either would be a regression.
      fundamentals: latestFundamental, // includes `extra` — the full report detail, in reportingCurrency
      nextDividend: toDividendSummary(next) ?? null,
      lastDividend: toDividendSummary(last) ?? null,
      dividendHistory: security.corporateActions, // full history, all action types, amountPerShare in reportingCurrency
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});