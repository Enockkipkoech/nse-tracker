#!/usr/bin/env bash
# One-shot: fetch a fresh TradingView board snapshot, then run the Prisma
# seed against it. Bash owns orchestration (fixture capture, error surfacing);
# Prisma owns the actual writes — matches the split from the D1 build, where
# probe-columns.sh/seed-master.sh drove SQL migrations.
#
# Usage: ./scripts/capture-and-seed.sh

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p fixtures

echo "== fetching board snapshot =="
pnpm run fetch:board

COUNT=$(jq '.data | length' fixtures/board.json)
echo "captured $COUNT rows"

if [ "$COUNT" -lt 55 ]; then
  echo "WARN: expected ~60 rows, got $COUNT — check fixtures/board.json before seeding" >&2
  read -p "continue anyway? [y/N] " -n 1 -r; echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

echo "== seeding =="
pnpm run seed

echo "done"
