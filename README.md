# NSE Tracker

Real-time-ish market data and dividend tracking for the Nairobi Securities Exchange. Captures live prices via TradingView's public scanner, cross-validates dividend figures against confirmed annual-report data, and serves both through a REST API.

## Stack

TypeScript · Express · Prisma · PostgreSQL (Supabase) · pnpm workspaces

## Why this exists

The NSE publishes no public REST API — only licensed FIX/MITCH feeds and EOD PDFs. This project goes through TradingView's scanner instead (keyless, full 60-symbol coverage including thin counters most aggregators drop), reconciles its unreliable dividend fields against confirmed report data where available, and tracks everything with an explicit confidence tier rather than presenting derived numbers as fact.

## Structure

```
packages/
  lib/   @nse/lib   TradingView client + NSE sector mapping — pure domain logic, no I/O beyond the fetch itself
  db/    @nse/db     Prisma schema, migrations, seed scripts, shared PrismaClient singleton
  api/   @nse/api    Express app — capture jobs, REST routes
fixtures/
  fundamentals.json        hand-entered annual-report data (revenue, EPS, DPS, audited)
  corporate-actions.json   dividend events — interim/final split, ex-date, payment date
```

## Quickstart

```bash
pnpm install
cp .env.example .env          # fill DATABASE_URL (pooled) + DIRECT_URL (unpooled) + READ_TOKEN
pnpm --filter @nse/db exec prisma migrate dev --name init
pnpm --filter @nse/db run seed              # security master, from a live TradingView pull
pnpm --filter @nse/db run seed:fundamentals # from fixtures/fundamentals.json
pnpm --filter @nse/db run seed:corporate-actions
pnpm dev                                    # starts @nse/api on :3000
```

## API

All `/v1/*` routes require `Authorization: Bearer <READ_TOKEN>`.

| Route | Purpose |
|---|---|
| `GET /v1/watchlist` | Full board snapshot — price, sector, dividend yield with confidence tier. `?minConfidence=confirmed\|high\|low` filters by reliability. |
| `GET /v1/fundamentals?ticker=X` | Full annual-report detail for one ticker, including sector-specific metadata (`extra`). `?all=true` for full reporting history. |
| `GET /v1/history?ticker=X` | Daily price series. |
| `POST /v1/capture/intraday` | Append-only 15-min snapshot. Cron-driven during market hours. |
| `POST /v1/capture/eod` | The one authoritative daily close. Cron-driven once after market close. |
| `GET /v1/coverage` | Board vs. security_master diff. |
| `GET /v1/quality` | Data-quality log — staleness, OHLC violations, dividend-field divergence. |

## Key design decisions

- **Dividend confidence is a first-class field, not a footnote.** TradingView's derived yield/payout fields disagree with each other on ~45% of the board. `dpsConfidence` (`confirmed` > `high` > `low` > `none`) tells you how much to trust `dpsKes` before you use it.
- **Confirmed annual-report data wins at read time, never by overwriting captured prices.** `daily_prices` is an honest log of what TradingView showed on a given date; a `Fundamental` row from an audited report outranks it in `/v1/watchlist`'s response, but the underlying captured row is never mutated — so the next capture run can't silently clobber a confirmed figure back down to a guess.
- **Intraday and EOD are separate tables, separate crons.** Intraday appends; EOD is the one row-per-day source of truth. Conflating them was an earlier bug.

## Status

Backend functional end to end: capture, sector mapping (60/60), dividend derivation with cross-validation, fundamentals/corporate-actions seeding. Frontend not yet built.


### TESTING COMMANDS
```bash

curl -X POST -H "Authorization: Bearer change-me" http://localhost:3000/v1/capture/intraday

```
