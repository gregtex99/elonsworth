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

    // Share/page-view event sink (best-effort; KV daily rollup).
    if (url.pathname === "/api/event" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const event = String(body.event || "unknown").slice(0, 32);
        const variant = (typeof body.variant === "number") ? body.variant : null;
        const ref = String(body.referrer || "").slice(0, 256);
        const screen = String(body.screen || "").slice(0, 32);
        const ua = (req.headers.get("user-agent") || "").slice(0, 200);
        const country = req.headers.get("cf-ipcountry") || "";
        const day = new Date().toISOString().slice(0, 10);
        const key = `ev:${day}:${event}:${variant ?? "_"}`;
        const kv = (env as any).QUOTES_KV;
        if (kv) {
          const cur = JSON.parse((await kv.get(key)) || "{}");
          cur.count = (cur.count || 0) + 1;
          cur.last_ts = Date.now();
          cur.last_country = country;
          cur.last_screen = screen;
          cur.last_ref = ref;
          await kv.put(key, JSON.stringify(cur), { expirationTtl: 60 * 60 * 24 * 90 });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
      } catch (e: any) {
        // Never fail loudly — sharing must still work.
        return new Response(JSON.stringify({ ok: false, err: e?.message }), { headers: corsHeaders() });
      }
    }

    if (url.pathname === "/api/events/summary") {
      // GET /api/events/summary?days=7
      const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days") || "7", 10)));
      const kv = (env as any).QUOTES_KV;
      if (!kv) return new Response(JSON.stringify({ error: "no_kv" }), { status: 500, headers: corsHeaders() });
      const out: Record<string, any> = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const list = await kv.list({ prefix: `ev:${d}:` });
        for (const k of list.keys) {
          const v = JSON.parse((await kv.get(k.name)) || "{}");
          out[k.name] = v;
        }
      }
      return new Response(JSON.stringify(out, null, 2), { headers: corsHeaders() });
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
      if (url.pathname === "/api/history") {
        // GET /api/history?range=1d|5d|1mo|3mo|6mo|1y|max
        // Returns daily TSLA + SPCX closes and a derived net-worth time series.
        // Historical accuracy notes (especially for max):
        //   - SPCX IPO’d 2026-06-12 — zero SPCX paper wealth before that timestamp.
        //   - 2025 award vests over time — we model it as zero before its first vest gate.
        //   - 2018 options have a $23.34 effective strike and vested by 2022; treat as in-the-money only after 2022.
        //   - Private holdings + margin loans are modeled at constant current value (rough; not yet historical).
        // For “max” we deliberately switch interval to monthly to keep series small
        // and to dampen the visual effect of SPCX joining as a step-function.
        const range = (url.searchParams.get("range") || "1mo").toLowerCase();
        const allowed: Record<string, { range: string; interval: string }> = {
          "1d":  { range: "1d",  interval: "5m" },
          "5d":  { range: "5d",  interval: "30m" },
          "1mo": { range: "1mo", interval: "1d" },
          "3mo": { range: "3mo", interval: "1d" },
          "6mo": { range: "6mo", interval: "1d" },
          "1y":  { range: "1y",  interval: "1d" },
          "max": { range: "max", interval: "1mo" },
        };
        const sel = allowed[range] || allowed["1mo"];
        const hist = await loadHistory(SYMBOLS, sel.range, sel.interval);
        const tArr = hist.TSLA || [];
        const sArr = hist.SPCX || [];
        const sByTs = new Map(sArr.map(p => [p.t, p.c]));
        const sFirstTs = sArr[0]?.t ?? Number.POSITIVE_INFINITY;
        // Constants for piecewise historical modeling
        const TSLA_2018_OPTIONS_VESTED_TS = Date.UTC(2022, 7, 25);   // ~Aug 25, 2022 final 2018 tranche vested
        const TSLA_2025_AWARD_FIRST_VEST_TS = Date.UTC(2026, 0, 1);  // 2025 award vesting starts 2026 (placeholder)
        const SPCX_IPO_TS = Date.UTC(2026, 5, 12);                   // 2026-06-12 SPCX IPO
        // For ALL/longer ranges, dampen the "constant" private + margin values to avoid pretending
        // those values existed in 2012. We linearly ramp them in over the last 5y.
        const NOW = Date.now();
        const FIVE_Y_MS = 5 * 365 * 86400000;
        function privAt(t: number): number {
          if (range === "1d" || range === "5d" || range === "1mo") {
            // Recent: just use current model
            return CONSTANTS.PRIVATE.boring_company_est + CONSTANTS.PRIVATE.neuralink_est + CONSTANTS.PRIVATE.cash_residual_est;
          }
          // Linear ramp from 0 (5y ago) to current
          const frac = Math.max(0, Math.min(1, 1 - (NOW - t) / FIVE_Y_MS));
          return frac * (CONSTANTS.PRIVATE.boring_company_est + CONSTANTS.PRIVATE.neuralink_est + CONSTANTS.PRIVATE.cash_residual_est);
        }
        function liabAt(t: number): number {
          if (range === "1d" || range === "5d" || range === "1mo") {
            return CONSTANTS.LIABILITIES.margin_loans_est;
          }
          const frac = Math.max(0, Math.min(1, 1 - (NOW - t) / FIVE_Y_MS));
          return frac * CONSTANTS.LIABILITIES.margin_loans_est;
        }
        const series: { t: number; v: number; tsla: number; spcx: number }[] = [];
        for (const tp of tArr) {
          if (tp == null) continue;
          // SPCX: $0 before IPO, market price after
          let sClose = 0;
          if (tp.t >= SPCX_IPO_TS) {
            sClose = sByTs.get(tp.t) ?? (tp.t >= sFirstTs ? (sArr[sArr.length - 1]?.c ?? 135) : 135);
          }
          // 2018 options: $0 before final vest date
          const options2018Val = tp.t >= TSLA_2018_OPTIONS_VESTED_TS
            ? CONSTANTS.TSLA.options_2018_shares * Math.max(0, tp.c - CONSTANTS.TSLA.options_2018_strike)
            : 0;
          // 2025 award: $0 before first vest
          const award2025Val = tp.t >= TSLA_2025_AWARD_FIRST_VEST_TS
            ? CONSTANTS.TSLA.award_2025_shares_per_tranche * CONSTANTS.TSLA.award_2025_tranches_vested * Math.max(0, tp.c - CONSTANTS.TSLA.award_2025_offset)
            : 0;
          const t = CONSTANTS.TSLA.trust_shares * tp.c + options2018Val + award2025Val;
          const s = CONSTANTS.SPCX.musk_shares * sClose;
          const priv = privAt(tp.t);
          const liab = liabAt(tp.t);
          series.push({ t: tp.t, v: t + s + priv - liab, tsla: tp.c, spcx: sClose });
        }
        return new Response(JSON.stringify({ range, series }),
          { headers: corsHeaders({ "Cache-Control": "public, max-age=300, s-maxage=300" }) });
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "not_found", routes: ["/api/quote", "/api/net-worth", "/api/formula", "/api/history", "/api/event", "/api/events/summary", "/healthz"] }),
      { status: 404, headers: corsHeaders() });
  },
};

// Fetch historical OHLC bars from Yahoo Finance chart API.
// Returns { TSLA: [{t, c}], SPCX: [{t, c}] } using closes.
async function loadHistory(symbols: readonly string[], range: string, interval: string): Promise<Record<string, { t: number; c: number }[]>> {
  const out: Record<string, { t: number; c: number }[]> = {};
  await Promise.all(symbols.map(async sym => {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 300, cacheEverything: true } as any });
      if (!r.ok) { out[sym] = []; return; }
      const j: any = await r.json();
      const res = j?.chart?.result?.[0];
      const ts: number[] = res?.timestamp || [];
      const closes: (number | null)[] = res?.indicators?.quote?.[0]?.close || [];
      const points = ts.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter(p => typeof p.c === "number") as { t: number; c: number }[];
      out[sym] = points;
    } catch {
      out[sym] = [];
    }
  }));
  return out;
}
