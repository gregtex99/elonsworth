#!/bin/bash
# Pre-deploy smoke test. Bails on the first failure so we never push a broken site.
# Usage: scripts/smoke-test.sh [target_url]
# Default target: local file inspection only (no live deploy needed)
set -euo pipefail
TARGET="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
ylw()   { printf "\033[33m%s\033[0m\n" "$*"; }

fail=0
check() {
  local name="$1"; shift
  if "$@"; then green "  ✓ $name"; else red "  ✗ $name"; fail=1; fi
}

ylw "=== Static checks ==="

# 1. HTML files exist
check "www/index.html exists" test -f www/index.html
check "www/math/index.html exists" test -f www/math/index.html
check "www/trillion/index.html exists" test -f www/trillion/index.html

# 2. All three index.html files are identical (we maintain them by copy)
check "www/math == www" cmp -s www/index.html www/math/index.html
check "www/trillion == www" cmp -s www/index.html www/trillion/index.html

# 3. JS syntactically parses
check "JS syntax" node -e "
const fs=require('fs'), html=fs.readFileSync('www/index.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/);
if(!m) { console.error('no script tag'); process.exit(1); }
new Function(m[1]);
"

# 4. HTML balanced tags
check "div tags balanced" node -e "
const html=require('fs').readFileSync('www/index.html','utf8');
const o=(html.match(/<div\b/g)||[]).length, c=(html.match(/<\/div>/g)||[]).length;
if(o!==c){console.error('div imbalance:',o,'vs',c);process.exit(1);}
"
check "script tags balanced" node -e "
const html=require('fs').readFileSync('www/index.html','utf8');
const o=(html.match(/<script\b/g)||[]).length, c=(html.match(/<\/script>/g)||[]).length;
if(o!==c){console.error('script imbalance:',o,'vs',c);process.exit(1);}
"

# 5. Required IDs present in index.html
for id in formula math-components math-page trillion-page tr-board hero live-dot live-text stale-note; do
  check "id=\"$id\" present" grep -q "id=\"$id\"" www/index.html
done

# 6. Worker TS compiles
check "worker tsc" bash -c "cd worker && npx tsc --noEmit"

ylw ""
ylw "=== Worker API checks ==="
WORKER_URL="https://api.elonsworth.com"
# Resolve via Cloudflare edge IP if local DNS is broken (Tailscale interception, etc.)
RESOLVE_OPTS=""
if ! getent hosts api.elonsworth.com >/dev/null 2>&1 && ! host api.elonsworth.com >/dev/null 2>&1; then
  RESOLVE_OPTS="--resolve api.elonsworth.com:443:172.66.47.9"
fi
check "/healthz" bash -c "curl -fs --max-time 5 $RESOLVE_OPTS $WORKER_URL/healthz | grep -q ok"
check "/api/quote returns valid JSON" bash -c "curl -fs --max-time 5 $RESOLVE_OPTS $WORKER_URL/api/quote | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d[\"quotes\"][\"TSLA\"][\"p\"] > 0; assert d[\"quotes\"][\"SPCX\"][\"p\"] > 0'"
check "/api/net-worth returns sane value" bash -c "curl -fs --max-time 5 $RESOLVE_OPTS $WORKER_URL/api/net-worth | python3 -c 'import json,sys; d=json.load(sys.stdin); nw=d[\"net_worth\"]; assert 5e11 < nw < 2e12, f\"net_worth out of range: {nw}\"'"
check "/api/formula returns constants" bash -c "curl -fs --max-time 5 $RESOLVE_OPTS $WORKER_URL/api/formula | python3 -c 'import json,sys; d=json.load(sys.stdin); assert \"TSLA\" in d[\"constants\"]'"

if [ -n "$TARGET" ]; then
  ylw ""
  ylw "=== Live site checks at $TARGET ==="
  check "$TARGET/ returns 200" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 $TARGET/)\" = 200 ]"
  check "$TARGET/math reachable (200 after redirect)" bash -c "[ \"\$(curl -sL -o /dev/null -w '%{http_code}' --max-time 5 $TARGET/math)\" = 200 ]"
  check "$TARGET/trillion reachable (200 after redirect)" bash -c "[ \"\$(curl -sL -o /dev/null -w '%{http_code}' --max-time 5 $TARGET/trillion)\" = 200 ]"
  check "Home page has hero" bash -c "curl -fs --max-time 5 $TARGET/ | grep -q 'id=\"hero\"'"
  check "/math has 'Show your work'" bash -c "curl -fsL --max-time 5 $TARGET/math | grep -q 'Show your work'"
  check "/trillion has game board" bash -c "curl -fsL --max-time 5 $TARGET/trillion | grep -q 'MAKE A TRILLION'"
fi

ylw ""
if [ $fail -eq 0 ]; then green "ALL CHECKS PASSED"; exit 0
else red "FAILURES — DO NOT DEPLOY"; exit 1
fi
