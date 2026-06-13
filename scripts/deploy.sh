#!/bin/bash
# Single-shot deploy: smoke test, deploy worker, deploy pages, verify live URLs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source /Users/trinity/clawd/.secrets/cloudflare-privileged.env
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

# Sync subdir copies
cp www/index.html www/math/index.html
cp www/index.html www/trillion/index.html

echo "=== Pre-deploy smoke ==="
./scripts/smoke-test.sh

echo ""
echo "=== Deploy Worker ==="
( cd worker && npx wrangler deploy 2>&1 | tail -5 )

echo ""
echo "=== Deploy Pages ==="
( cd worker && npx wrangler pages deploy ../www --project-name=elonsworth --branch=main --commit-dirty=true 2>&1 | tail -5 )

echo ""
echo "=== Live verify ==="
sleep 4
./scripts/smoke-test.sh https://www.elonsworth.com | tail -10
