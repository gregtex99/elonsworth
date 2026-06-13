/**
 * elonsworth.com — quote relay Cloudflare Worker.
 *
 * Routes:
 *   GET /api/quote?symbols=TSLA,SPCX
 *      → { TSLA: {p, ts, prev}, SPCX: {p, ts, prev} }
 *   GET /api/net-worth
 *      → live full computation server-side
 *   GET /api/formula
 *      → the canonical formula + every constant we use (transparency moat)
 *   GET /healthz
 *
 * Caching: 1-2s edge cache during market hours, 30s off-hours. The Worker
 * absorbs viral traffic spikes so we never DoS the quote provider.
 */

const SYMBOLS = ["TSLA", "SPCX"];

// Canonical formula constants. ALL EDITS MUST BE SOURCED.
// See /api/formula for the source-cited public version.
const CONSTANTS = {
  TSLA: {
    trust_shares: 413_200_000,            // Elon Musk Revocable Trust
    options_2018_shares: 304_000_000,     // 2018 award, exercisable
    options_2018_strike: 23.34,           // split-adjusted
    award_2025_shares_per_tranche: 35_311_992,
    award_2025_tranches_total: 12,
    award_2025_offset: 334.09,            // RSU-style offset, NOT a strike
    award_2025_tranches_vested: 0,        // bump as milestones cleared
    source: "Schedule 13G/A (Apr 16, 2026); 2025 CEO Performance Award (shareholder-approved Nov 6, 2025)",
  },
  SPCX: {
    total_shares_outstanding: 12_500_000_000,  // S-1 + 424B
    musk_economic_pct: 0.42,                    // ~42% economic / ~85% voting
    musk_shares: 5_250_000_000,
    musk_lockup_end: "2027-06-12",              // 366-day lockup, no early release
    source: "SpaceX S-1 (May 20, 2026) + 424B prospectus",
  },
  PRIVATE: {
    boring_company_est: 6_500_000_000,
    neuralink_est: 4_500_000_000,
    cash_residual_est: 7_000_000_000,
    note: "Last-round implied valuations × ~50% Musk stake. Updated when new rounds publish.",
  },
  LIABILITIES: {
    margin_loans_est: 7_500_000_000,
    note: "Public reporting suggests Musk-pledged TSLA + SPCX collateral; exact figure unknown.",
  },
} as const;

interface QuoteSnapshot {
  p: number;        // last price
  prev: number;     // prev close
  hi: number;       // day high
  lo: number;       // day low
  ts: number;       // unix seconds
  exch: string;
}

async function fetchYahooQuote(symbol: string): Promise<QuoteSnapshot> {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; elonsworth/1.0)" } },
  );
  if (!r.ok) throw new Error(`yahoo ${symbol} ${r.status}`);
  const j: any = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`yahoo ${symbol} empty`);
  return {
    p: meta.regularMarketPrice,
    prev: meta.previousClose,
    hi: meta.regularMarketDayHigh,
    lo: meta.regularMarketDayLow,
    ts: meta.regularMarketTime,
    exch: meta.exchangeName,
  };
}

function computeNetWorth(quotes: Record<string, QuoteSnapshot>) {
  const T = quotes.TSLA?.p;
  const S = quotes.SPCX?.p;
  if (T == null || S == null) throw new Error("missing quote");

  const C = CONSTANTS;

  // Live components
  const tsla_trust = C.TSLA.trust_shares * T;
  const tsla_2018  = C.TSLA.options_2018_shares * Math.max(0, T - C.TSLA.options_2018_strike);
  const spcx       = C.SPCX.musk_shares * S;

  // 2025 award — count only VESTED tranches
  const tsla_2025  =
    C.TSLA.award_2025_shares_per_tranche *
    C.TSLA.award_2025_tranches_vested *
    Math.max(0, T - C.TSLA.award_2025_offset);

  const private_total =
    C.PRIVATE.boring_company_est +
    C.PRIVATE.neuralink_est +
    C.PRIVATE.cash_residual_est;

  const liabilities = C.LIABILITIES.margin_loans_est;

  const subtotal = tsla_trust + tsla_2018 + spcx + tsla_2025 + private_total - liabilities;

  // Potential ghost-meter for the unvested 2025 award
  const award_remaining_tranches =
    C.TSLA.award_2025_tranches_total - C.TSLA.award_2025_tranches_vested;
  const award_potential_unvested =
    C.TSLA.award_2025_shares_per_tranche * award_remaining_tranches *
    Math.max(0, T - C.TSLA.award_2025_offset);

  return {
    net_worth: subtotal,
    components: {
      tsla_trust,
      tsla_2018_options: tsla_2018,
      tsla_2025_award_vested: tsla_2025,
      spcx,
      private_holdings: private_total,
      liabilities: -liabilities,
    },
    unvested_award_potential: award_potential_unvested,
    spcx_lockup: {
      ends: C.SPCX.musk_lockup_end,
      paper_locked: spcx, // headline "wealth he literally can't sell"
    },
    quotes,
    constants: CONSTANTS,
    asof: Math.max(quotes.TSLA.ts, quotes.SPCX.ts),
  };
}

async function loadAllQuotes(): Promise<Record<string, QuoteSnapshot>> {
  const results = await Promise.all(SYMBOLS.map(async s => [s, await fetchYahooQuote(s)] as const));
  return Object.fromEntries(results);
}

function corsHeaders(extra: Record<string, string> = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    ...extra,
  };
}

function cacheTTL(): number {
  // Market hours (Mon-Fri 09:30-16:00 ET) → 1s. Off hours → 30s.
  const now = new Date();
  const utc = now.getUTCDay();
  if (utc === 0 || utc === 6) return 30;
  const et = (now.getUTCHours() - 4 + 24) % 24; // approx EDT
  const min = et * 60 + now.getUTCMinutes();
  return (min >= 570 && min <= 960) ? 1 : 30;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/healthz") return new Response("ok", { headers: corsHeaders({ "Content-Type": "text/plain" }) });

    if (url.pathname === "/api/formula") {
      return new Response(JSON.stringify({
        formula: "live = TSLA·trust + max(0, TSLA-23.34)·options2018 + max(0, TSLA-334.09)·award2025_vested + SPCX·musk_spcx + private - liabilities",
        constants: CONSTANTS,
        note: "Estimate, not endorsement. All inputs are public SEC filings or last-round implied valuations.",
      }, null, 2), { headers: corsHeaders() });
    }

    try {
      const ttl = cacheTTL();
      if (url.pathname === "/api/quote") {
        const quotes = await loadAllQuotes();
        return new Response(JSON.stringify({ quotes, asof: Math.max(...Object.values(quotes).map(q => q.ts)) }),
          { headers: corsHeaders({ "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}` }) });
      }
      if (url.pathname === "/api/net-worth") {
        const quotes = await loadAllQuotes();
        const result = computeNetWorth(quotes);
        return new Response(JSON.stringify(result),
          { headers: corsHeaders({ "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}` }) });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "not_found", routes: ["/api/quote", "/api/net-worth", "/api/formula", "/healthz"] }),
      { status: 404, headers: corsHeaders() });
  },
};
