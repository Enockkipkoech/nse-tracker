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
import { adminRouter } from "./routes/admin";
import { runIntradayCapture, runEodCapture } from "./services/capture.service";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/v1", (req, res, next) => {
    const auth = req.header("authorization");
    if (auth !== `Bearer ${process.env.READ_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
    next();
}, router);

// Separate token, separate namespace, deliberately not reused from /v1's
// READ_TOKEN check above. /admin writes financial data that feeds every
// yield calculation in this API — anyone who can read the board shouldn't
// automatically also be able to rewrite what it says. ADMIN_TOKEN must be
// set explicitly; there's no fallback to READ_TOKEN if it's missing, since
// silently degrading to a shared token here would defeat the entire point.
app.use("/admin", (req, res, next) => {
    if (!process.env.ADMIN_TOKEN) {
        console.error("ADMIN_TOKEN is not set — refusing all /admin requests");
        return res.status(503).json({ error: "admin routes not configured" });
    }
    const auth = req.header("authorization");
    if (auth !== `Bearer ${process.env.ADMIN_TOKEN}`) return res.status(401).json({ error: "unauthorized" });
    next();
}, adminRouter);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => console.log(`nse-tracker listening on :${PORT}`));

// Last-resort net, not a substitute for the try/catch in each route above.
// An uncaught error at this level means some code path genuinely wasn't
// anticipated — log it and keep the process alive rather than repeat
// tonight's pattern of one bad response silently killing the whole server
// until the next file save triggers tsx watch to restart it.
process.on("uncaughtException", e => console.error("uncaughtException:", e));
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));

// Two crons, two purposes — do not merge them back into one:
//
//   Intraday (*/15 during market hours): appends to intraday_ticks. Safe to
//   run as often as every 15 minutes since that's the upstream delay anyway
//   (update_mode: delayed_streaming_900) — faster just re-fetches the same
//   bar under a new timestamp. runOnInit: true is safe here — an extra
//   append-only tick on every server (re)start has no correctness cost.
//
//   EOD (once, after close): writes the single authoritative daily_prices
//   row. Scheduled for 16:00 EAT, not 15:30 (session close) or 15:45 (naive
//   delay math) — the 15-min delay means the true 15:30 close isn't visible
//   upstream until ~15:45, and 16:00 leaves a safety margin rather than
//   racing the delay window exactly. Deliberately NO runOnInit here: a
//   restart at an arbitrary time of day (a deploy, a crash, autoscaling —
//   all plausible on Railway) would otherwise write mid-session data into
//   the slot meant to hold the day's one authoritative close.
//
// timezone is passed explicitly to node-cron rather than relied on via
// process.env.TZ — system-timezone dependence is a common source of
// silently wrong schedules. Africa/Nairobi has no DST, so there's no
// "repeated hour" edge case to worry about either.
//
// Overlap protection is a hand-rolled running-flag, not a library option —
// the installed node-cron version's ScheduledTask type doesn't expose
// getNextRun() (an earlier version of this file assumed it did, based on
// docs that turned out to be for a version ahead of what `^3.0.3` actually
// resolves to). Rather than keep guessing at exactly which options-object
// shape this version supports, this sticks to the confirmed-working
// surface: schedule(expr, fn, { timezone, recoverMissedExecutions }) —
// recoverMissedExecutions verified directly against the installed source
// (node_modules/node-cron/src/scheduled-task.js), not assumed from docs.
//
// CRON EXPRESSIONS MUST BE DISTINCT FROM EACH OTHER. Confirmed the hard
// way: registering two jobs with the byte-identical expression+timezone
// (both set to "star-slash-10 * * * * *" during a manual test) resulted in
// only ONE of them ever actually ticking after the initial runOnInit fire —
// the scheduler appears to key its internal timer by the expression itself
// rather than by task identity, so an identical second registration
// silently collides with the first instead of creating an independent
// timer. Not an issue for the real INTRADAY_CRON/EOD_CRON values below,
// which are already structurally different — but if you ever swap in test
// expressions again, make sure the two differ, not just the callback.
// (Written as "star-slash" above deliberately — a literal */ inside a /*
// */ block comment closes it prematurely; that exact mistake in an earlier
// version of this comment is what caused the syntax errors this rewrite
// fixes. // comments don't have that problem, which is the other reason
// this whole block moved to // instead of /** */.)
if (process.env.ENABLE_CRON === "true") {
    const TZ = "Africa/Nairobi";
    const INTRADAY_CRON = "*/15 9-15 * * 1-5";
    const EOD_CRON = "0 16 * * 1-5";

    let intradayRunning = false;
    let eodRunning = false;

    cron.schedule(
        INTRADAY_CRON,
        () => {
            if (intradayRunning) return;
            intradayRunning = true;
            runIntradayCapture()
                .catch(e => console.error("intraday capture failed:", e))
                .finally(() => { intradayRunning = false; });
        },
        { timezone: TZ, recoverMissedExecutions: true, runOnInit: true }
    );

    cron.schedule(
        EOD_CRON,
        () => {
            if (eodRunning) return;
            eodRunning = true;
            runEodCapture()
                .catch(e => console.error("EOD capture failed:", e))
                .finally(() => { eodRunning = false; });
        },
        { timezone: TZ, recoverMissedExecutions: true }
    );

    // getNextRun() isn't available on this node-cron version — rather than
    // depend on an API surface that's already proven to be a moving target,
    // print the current time as this process's Node runtime actually sees it
    // in Nairobi, and check the raw cron expressions against it by hand (or
    // paste them into crontab.guru). This is exactly the kind of check that
    // would have caught the original process.env.TZ-only bug: if this
    // printed time is wrong, nothing downstream about the schedule can be
    // trusted either.
    //
    // Built from the same INTRADAY_CRON/EOD_CRON constants actually passed to
    // schedule() above, not a separately hardcoded string — the previous
    // version of this log line was a static string that would have kept
    // claiming the production schedule even while test expressions were
    // active. Same "log says one thing, code does another" class of bug as
    // the two issues described above; fixed the same way, by removing the
    // duplication rather than trusting two copies to stay in sync.
    console.log(
        `cron scheduled — intraday ${INTRADAY_CRON}, EOD ${EOD_CRON} (tz=${TZ}).`,
        "Current time in Nairobi right now:",
        new Date().toLocaleString("en-GB", { timeZone: TZ })
    );
}
