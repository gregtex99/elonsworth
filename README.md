# elonsworth.com

Live, transparent Elon Musk net-worth tracker. Public S-1 data, public quote feeds, formula on the page.

## Layout
- `worker/` — Cloudflare Worker quote relay + net-worth math (TypeScript)
- `www/` — static frontend (TBD after Claude Design picks a visual direction)
- `sources.md` — every constant + its SEC/news source, updated whenever inputs change

## Architecture
- Browser polls/streams from `api.elonsworth.com/api/net-worth` (Worker)
- Worker fetches quotes from Yahoo Finance unofficial endpoint (no key, prototype phase)
- Edge cache 1s in market hours / 30s off hours → absorbs viral spikes
- Switch quote provider to Polygon.io ($29/mo) for real real-time later

## Status
- 2026-06-12: scaffolded Worker, verified formula matches Forbes/Bloomberg to ~3%
- Next: Greg picks visual direction via Claude Design brainstorm; ship frontend

## Verified formula
```
live = TSLA × 413,200,000                                  // Trust
     + max(0, TSLA - 23.34) × 304,000,000                  // 2018 options
     + max(0, TSLA - 334.09) × 35,311,992 × vested_tranches // 2025 award
     + SPCX × 5,250,000,000                                // SpaceX equity
     + ~$18B private (Boring/Neuralink/cash)
     - ~$7.5B liabilities (margin, est)
```

All inputs sourced in `sources.md`. Estimate, not endorsement.
