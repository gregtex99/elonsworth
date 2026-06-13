/**
 * elonsworth.com — quote relay Cloudflare Worker.
 *
 * Routes:
 *   GET /api/quote?symbols=TSLA,SPCX
 *      → { TSLA: {p, ts, prev, source, stale_sec}, SPCX: {...} }
 *   GET /api/net-worth
 *      → live full computation server-side
 *   GET /api/formula
 *      → the canonical formula + every constant we use (transparency moat)
 *   GET /healthz
 *
 * Resilience model:
 *   1. Yahoo Finance (primary, free, unofficial) — fast.
 *   2. Finnhub (free tier, optional via FINNHUB_TOKEN env) — fallback.
 *   3. KV last-good cache — final fallback. Renders a `source:"cache", stale_sec` flag.
 *   So a Yahoo outage or a SPCX trading halt cannot zero-out the site.
 *
 * Caching: 1s edge cache during market hours, 30s off-hours. Worker absorbs
 * viral traffic spikes so we never DoS the quote provider.
 */

const SYMBOLS = ["TSLA", "SPCX"];

// Canonical formula constants. ALL EDITS MUST BE SOURCED.
const CONSTANTS = {
  TSLA: {
    trust_shares: 413_200_000,
    options_2018_shares: 304_000_000,
    options_2018_strike: 23.34,
    award_2025_shares_per_tranche: 35_311_992,
    award_2025_tranches_total: 12,
    award_2025_offset: 334.09,
    award_2025_tranches_vested: 0,
    source: "Schedule 13G/A (Apr 16, 2026); 2025 CEO Performance Award (shareholder-approved Nov 6, 2025)",
  },
  SPCX: {
    total_shares_outstanding: 12_500_000_000,
    musk_economic_pct: 0.42,
    musk_shares: 5_250_000_000,
    musk_lockup_end: "2027-06-12",
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
  source: "yahoo" | "finnhub" | "cache";
  stale_sec?: number;
}

interface Env {
  QUOTES_KV: KVNamespace;
  FINNHUB_TOKEN?: string;
}

async function fetchYahooQuote(symbol: string): Promise<QuoteSnapshot> {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; elonsworth/1.0)" } },
  );
  if (!r.ok) throw new Error(`yahoo ${symbol} ${r.status}`);
  const j: any = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`yahoo ${symbol} empty`);
  return {
    p: meta.regularMarketPrice,
    prev: meta.previousClose,
    hi: meta.regularMarketDayHigh,
    lo: meta.regularMarketDayLow,
    ts: meta.regularMarketTime,
    exch: meta.exchangeName,
    source: "yahoo",
  };
}

async function fetchFinnhubQuote(symbol: string, token: string): Promise<QuoteSnapshot> {
  const r = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (compatible; elonsworth/1.0)" } },
  );
  if (!r.ok) throw new Error(`finnhub ${symbol} ${r.status}`);
  const j: any = await r.json();
  // Finnhub: c=current, pc=previous close, h=high, l=low, t=timestamp
  if (j?.c == null || j.c === 0) throw new Error(`finnhub ${symbol} empty`);
  return {
    p: j.c,
    prev: j.pc,
    hi: j.h,
    lo: j.l,
    ts: j.t,
    exch: "FINNHUB",
    source: "finnhub",
  };
}

async function getQuoteWithFallback(symbol: string, env: Env): Promise<QuoteSnapshot> {
  const errors: string[] = [];

  // 1. Yahoo
  try {
    const q = await fetchYahooQuote(symbol);
    // Write-through to KV so we can fall back later
    if (env.QUOTES_KV) {
      await env.QUOTES_KV.put(
        `lastgood:${symbol}`,
        JSON.stringify(q),
        { expirationTtl: 7 * 24 * 3600 },
      );
    }
    return q;
  } catch (e: any) { errors.push(`yahoo: ${e.message}`); }

  // 2. Finnhub
  if (env.FINNHUB_TOKEN) {
    try {
      const q = await fetchFinnhubQuote(symbol, env.FINNHUB_TOKEN);
      if (env.QUOTES_KV) {
        await env.QUOTES_KV.put(
          `lastgood:${symbol}`,
          JSON.stringify(q),
          { expirationTtl: 7 * 24 * 3600 },
        );
      }
      return q;
    } catch (e: any) { errors.push(`finnhub: ${e.message}`); }
  }

  // 3. Last-good cache
  if (env.QUOTES_KV) {
    const cached = await env.QUOTES_KV.get(`lastgood:${symbol}`);
    if (cached) {
      const q: QuoteSnapshot = JSON.parse(cached);
      q.source = "cache";
      q.stale_sec = Math.floor(Date.now() / 1000) - q.ts;
      return q;
    }
  }

  throw new Error(`all quote sources failed: ${errors.join("; ")}`);
}

function computeNetWorth(quotes: Record<string, QuoteSnapshot>) {
  const T = quotes.TSLA?.p;
  const S = quotes.SPCX?.p;
  if (T == null || S == null) throw new Error("missing quote");

  const C = CONSTANTS;

  const tsla_trust = C.TSLA.trust_shares * T;
  const tsla_2018  = C.TSLA.options_2018_shares * Math.max(0, T - C.TSLA.options_2018_strike);
  const spcx       = C.SPCX.musk_shares * S;
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

  const award_remaining_tranches =
    C.TSLA.award_2025_tranches_total - C.TSLA.award_2025_tranches_vested;
  const award_potential_unvested =
    C.TSLA.award_2025_shares_per_tranche * award_remaining_tranches *
    Math.max(0, T - C.TSLA.award_2025_offset);

  // Highest stale-seconds across all quotes → headline data freshness
  const max_stale_sec = Math.max(
    quotes.TSLA.stale_sec || 0,
    quotes.SPCX.stale_sec || 0,
  );
  const any_cached = Object.values(quotes).some(q => q.source === "cache");

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
      paper_locked: spcx,
    },
    quotes,
    constants: CONSTANTS,
    asof: Math.max(quotes.TSLA.ts, quotes.SPCX.ts),
    data_quality: {
      any_cached,
      max_stale_sec,
      sources: {
        TSLA: quotes.TSLA.source,
        SPCX: quotes.SPCX.source,
      },
    },
  };
}

async function loadAllQuotes(env: Env): Promise<Record<string, QuoteSnapshot>> {
  const results = await Promise.all(
    SYMBOLS.map(async s => [s, await getQuoteWithFallback(s, env)] as const),
  );
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

function cacheTTL(quotes?: Record<string, QuoteSnapshot>): number {
  // If any quote is from cache (provider down or halt), cap TTL low so we
  // re-probe upstream rapidly.
  if (quotes && Object.values(quotes).some(q => q.source === "cache")) return 5;
  const now = new Date();
  const utc = now.getUTCDay();
  if (utc === 0 || utc === 6) return 30;
  const et = (now.getUTCHours() - 4 + 24) % 24;
  const min = et * 60 + now.getUTCMinutes();
  return (min >= 570 && min <= 960) ? 1 : 30;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
      if (url.pathname === "/api/quote") {
        const quotes = await loadAllQuotes(env);
        const ttl = cacheTTL(quotes);
        return new Response(JSON.stringify({ quotes, asof: Math.max(...Object.values(quotes).map(q => q.ts)) }),
          { headers: corsHeaders({ "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}` }) });
      }
      if (url.pathname === "/api/net-worth") {
        const quotes = await loadAllQuotes(env);
        const result = computeNetWorth(quotes);
        const ttl = cacheTTL(quotes);
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
