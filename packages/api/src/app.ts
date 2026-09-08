import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });
// ^ packages/api/src -> packages/api -> packages -> repo root. Same pattern
// as packages/db/prisma.config.ts — this package has no config-file hook
// equivalent, so it's loaded explicitly here, first, before anything reads
// process.env.DATABASE_URL / READ_TOKEN / TZ.

// Native BigInt has no default JSON representation and JSON.stringify throws
// on one rather than skipping it. daily_prices.volume (and any other BigInt
// column — shares_issued, free_float_shares) will hit this the moment a
// route returns it via res.json(). Without this, that throw is synchronous
// and uncaught, which crashes the whole process — not just that request.
// String is the safe choice over Number: volume can exceed 2^53 in theory
// (it won't on this market, but market_cap-scale BigInts elsewhere could).
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
};

import express from "express";
import cron from "node-cron";
import { router } from "./routes/api";
import { runIntradayCapture, runEodCapture } from "./services/capture.service";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/v1", (req, res, next) => {
    const auth = req.header("authorization");
    if (auth !== `Bearer ${process.env.READ_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
    next();
}, router);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => console.log(`nse-tracker listening on :${PORT}`));

process.on("uncaughtException", e => console.error("uncaughtException:", e));
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));


if (process.env.ENABLE_CRON === "true") {
    cron.schedule("*/15 9-15 * * 1-5", () => runIntradayCapture().catch(e => console.error("intraday capture failed:", e)));
    cron.schedule("0 16 * * 1-5", () => runEodCapture().catch(e => console.error("EOD capture failed:", e)));
    console.log("cron scheduled: intraday */15 9-15 * * 1-5, EOD 0 16 * * 1-5 (requires TZ=Africa/Nairobi)");
}