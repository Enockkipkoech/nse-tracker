/**
 * Fetches one TradingView board snapshot and prints it as JSON on stdout,
 * in the same {totalCount, data} shape the scanner itself returns — so
 * prisma/seed.ts can read it back without caring how it was captured.
 *
 * Called via `pnpm run fetch:board > fixtures/board.json`, driven by
 * scripts/capture-and-seed.sh.
 */

const SCAN = "https://scanner.tradingview.com/kenya/scan";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

// Reuses the verified column list from @nse/lib so a fixture captured here
// always matches what normalize() expects — one source of truth for the
// schema, even though capture and parsing are separate steps.
import { COLUMNS } from "@nse/lib";

async function main() {
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

  if (!res.ok) {
    process.stderr.write(`fetch failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }

  const body = await res.json();
  process.stdout.write(JSON.stringify(body));
}

main();