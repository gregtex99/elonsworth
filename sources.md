# Authoritative formula inputs — verified 2026-06-12 17:25 CDT

## TSLA (Tesla, public)
- **Shares outstanding:** 3,755,723,871 (Apr 16, 2026 SEC filing) ≈ 3.756B
  - Source: schedule-13g-a / stocktitan.net SEC mirror
- **Musk beneficial ownership:** 717.1M shares = 20.3% of outstanding
  - 413.2M shares — Elon Musk Revocable Trust (held outright)
  - 304M shares — option shares exercisable within 60 days (from 2018 grant)
- **2018 CEO Performance Award:** ~68.8M Class B options @ **$23.34/share** split-adjusted strike. Already vested + counted in the 304M exercisable.
- **2025 CEO Performance Award:** 423,743,904 shares (12 tranches × 35,311,992)
  - NOT options. Restricted stock with **$334.09/share offset** (acts like a strike)
  - ALL 12 tranches UNVESTED currently
  - Vesting tied to Tesla mkt-cap milestones $2.0T → $8.5T + operational milestones
  - Granted Sep 3, 2025; shareholder-approved Nov 6, 2025

## SPCX (SpaceX, just IPO'd June 12, 2026)
- **Total shares outstanding:** ~12.5-13.1B combined Class A + B (post-split)
  - One filing cited 12.535B basic; others 13.076B with adjustments
- **Musk's stake:** ~42% economic / ~82-85% voting power
  - Translates to roughly **5.25B-5.5B shares** Musk-held
  - (Investors.com cites 6.04B shares = 46.4% — newer figure post-IPO)
- **IPO price:** $135/share (priced June 11/12, 2026)
- **Largest IPO ever** — raised ~$75B
- **xAI is INSIDE SpaceX:** acquired Feb 2026 in all-stock deal at $250B
  - X Corp (Twitter) is inside xAI is inside SpaceX
  - So NO separate xAI / X Corp line needed — it's all in SPCX
- **Musk lockup: 366 days** (longer than std 180; no early-release for him)
  - Other insiders: tiered/staggered with releases at 180-day mark
  - 5% of IPO reserved for employees/friends with NO lockup

## Other Musk holdings (rough, private)
- Boring Company (~$5-8B last round)
- Neuralink (~$5B last round)
- Cash from past Tesla stock sales (historical $20-30B; reduced by tax + xAI funding)
- Margin loans / liabilities: estimated $5-10B

## Current net worth benchmarks (June 12, 2026)
- Forbes: $1.1T
- Bloomberg: $1.11T (post-IPO surge of +$139B / +14.3%)
- First verified trillionaire status

## 2008 near-death story (verified 2026-06-19)
- Accurate wording: Musk was reportedly broke/in debt and both Tesla and SpaceX were close to failure in 2008; this is not the same as saying he filed for personal bankruptcy.
- **CBS / 60 Minutes recap:** Musk called 2008 the worst year of his life; CBS summarized that both firms were nearly dead and Musk was broke/in debt.
  - Source: https://www.cbsnews.com/news/billionaire-elon-musk-on-2008-the-worst-year-of-my-life/
- **Tesla 2010 S-1:** 2008 cash and cash equivalents were **$9.277M**; 2008 net loss was **$82.782M**; convertible notes outstanding at Dec 31 2008 were **$54.7M**.
  - Source: https://www.sec.gov/Archives/edgar/data/1318605/000119312510017054/ds1.htm
- **Tesla emergency financing coverage:** Wired reported in Nov 2008 that Tesla lined up $40M in convertible debt after cash had dwindled sharply and a prior $100M financing fell through.
  - Source: https://www.wired.com/2008/11/tesla-adds-40-m/
- **SpaceX lifeline:** NASA OIG documents the 2008 Commercial Resupply Services award to SpaceX as **$1.6B for 12 missions**.
  - Source: https://oig.nasa.gov/docs/IG-13-016.pdf

## Canonical formula (final)
```
LIVE_TICK = 
    (TSLA × 413,200,000)                              // Revocable Trust shares
  + max(0, TSLA - 23.34) × 304,000,000                // 2018 vested options (deep ITM)
  + (SPCX × 5,500,000,000)                            // SpaceX equity (~42% stake; refine post-S-1A)

UNVESTED_2025_AWARD =
  Σ over vested tranches: (TSLA - 334.09) × 35,311,992 
  // 12 tranches; vesting on $2.0T-$8.5T mkt cap milestones; currently 0 vested

PRIVATE_HOLDINGS ≈ $15-25B   (Boring, Neuralink, residual cash, est)
LIABILITIES     ≈ $5-10B    (margin loans, est)

NET_WORTH = LIVE_TICK + UNVESTED_2025_AWARD + PRIVATE_HOLDINGS - LIABILITIES
```

## Viral UI elements that the formula enables
1. **Live tick** (sub-1s SPCX + TSLA × share counts) — the headline number
2. **366-day SPCX lockup countdown** — "Paper wealth Elon CANNOT touch: $XXX"
3. **Ghost meter for 2025 award** — show how much MORE he'd be worth if Tesla hit $2T, $2.5T, $3T... market cap
4. **Show the offset clearly** — "Above $334.09 TSLA = he profits on the 2025 award"
5. **Public vs Private split** — visualize how much is now SPCX (public, transparent) vs Boring/Neuralink (opaque)
