import { Router } from "express";
import { prisma } from "@nse/db";
import { runIntradayCapture, runEodCapture, coverageDiff } from "../services/capture.service";

export const router = Router();

const DPS_CONFIDENCE_RANK: Record<string, number> = { confirmed: 3, high: 2, low: 1, none: 0 };


router.get("/watchlist", async (req, res) => {
  try {
    const securities = await prisma.securityMaster.findMany({
      where: { status: "ACTIVE" },
      include: {
        dailyPrices: { where: { isStale: false }, orderBy: { tradeDate: "desc" }, take: 1 },
        fundamentals: { orderBy: { periodEnd: "desc" }, take: 1 },
      },
    });

    let data = securities
      .map(s => {
        const latest = s.dailyPrices[0];
        const confirmed = s.fundamentals[0];
        const hasConfirmedDps = confirmed?.dpsDeclaredKes != null;

        const dpsKes = hasConfirmedDps ? confirmed.dpsDeclaredKes : latest?.dpsDerivedKes ?? null;
        const dpsConfidence = hasConfirmedDps ? "confirmed" : latest?.dpsConfidence ?? null;
        const dpsSource = hasConfirmedDps ? "annual_report" : latest?.dpsDerivedKes != null ? "derived" : null;
        const dividendYieldPct =
          hasConfirmedDps && latest?.close != null && Number(latest.close) > 0
            ? Number(confirmed.dpsDeclaredKes) / Number(latest.close) * 100
            : latest?.dividendYieldPct ?? null;

        return {
          ticker: s.ticker,
          companyName: s.companyName,
          isin: s.isin,
          nseSector: s.nseSector,
          instrumentType: s.instrumentType,
          asOf: latest?.tradeDate ?? null,
          closeKes: latest?.close ?? null,
          changePct: latest?.changePct ?? null,
          marketCapKes: latest?.marketCapKes ?? null,
          peRatio: latest?.peRatio ?? null,
          dividendYieldPct,
          dpsKes,
          dpsConfidence,
          dpsSource,
          dpsReportUrl: hasConfirmedDps ? confirmed.reportUrl : null,
          dpsReportPeriodEnd: hasConfirmedDps ? confirmed.periodEnd : null,
          inMarketCap: s.inMarketCap,
        };
      })
      .sort((a, b) => Number(b.marketCapKes ?? 0) - Number(a.marketCapKes ?? 0));


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

router.get("/fundamentals", async (req, res) => {
  try {
    const ticker = String(req.query.ticker ?? "");
    if (!ticker) return res.status(400).json({ error: "ticker required" });

    const all = req.query.all === "true";
    const data = await prisma.fundamental.findMany({
      where: { ticker },
      orderBy: { periodEnd: "desc" },
      take: all ? undefined : 1,
    });

    if (data.length === 0) return res.status(404).json({ error: `no fundamentals on file for ${ticker}` });

    res.json({ ticker, count: data.length, data });
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