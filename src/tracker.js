// Watches every tracked pool for new trades.
// Cheap scan: one "multi" request covers 30 pools and tells us which ones had activity;
// only those get a (more expensive) trades request. That keeps hundreds of groups inside the free API budget.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCAN_EVERY = 30000;
const FORCE_TRADES_AFTER = 5 * 60000;

export function createTracker({ db, gecko, onTrade, log = console.log }) {
  const pools = new Map();
  const keyOf = (net, pool) => `${net}:${pool.toLowerCase()}`;

  function sync() {
    const wanted = new Map();
    for (const g of db.trackedGroups()) wanted.set(keyOf(g.network, g.pool), g);
    for (const k of pools.keys()) if (!wanted.has(k)) pools.delete(k);
    for (const [k, g] of wanted) {
      if (!pools.has(k)) pools.set(k, { key: k, net: g.network, pool: g.pool, token: g.token, since: Date.now() - 60000, seen: new Set(), sig: null, lastTrades: 0, stats: null });
    }
  }

  async function pollTrades(p) {
    const rows = await gecko.trades(p.net, p.pool);
    p.lastTrades = Date.now();
    const tok = p.token.toLowerCase();
    const fresh = [];
    for (const t of rows) {
      const id = `${t.tx_hash}:${t.from_token_amount}:${t.to_token_amount}`;
      if (p.seen.has(id)) continue;
      p.seen.add(id);
      const ts = Date.parse(t.block_timestamp);
      if (ts < p.since || t.is_anomalous) continue;
      const buy = (t.to_token_address || '').toLowerCase() === tok;
      const sell = (t.from_token_address || '').toLowerCase() === tok;
      if (!buy && !sell) continue;
      fresh.push({
        side: buy ? 'buy' : 'sell', ts,
        usd: +t.volume_in_usd || 0,
        paid: buy ? +t.from_token_amount : +t.to_token_amount,
        got: buy ? +t.to_token_amount : +t.from_token_amount,
        price: buy ? +t.price_to_in_usd : +t.price_from_in_usd,
        buyer: t.tx_from_address, tx: t.tx_hash
      });
    }
    while (p.seen.size > 3000) p.seen.delete(p.seen.values().next().value);
    fresh.sort((a, b) => a.ts - b.ts);
    for (const tr of fresh) {
      try { await onTrade(p, tr); } catch (e) { log('onTrade error', e.message); }
    }
  }

  async function scan() {
    sync();
    const byNet = new Map();
    for (const p of pools.values()) {
      if (!byNet.has(p.net)) byNet.set(p.net, []);
      byNet.get(p.net).push(p);
    }
    const due = [];
    for (const [net, list] of byNet) {
      for (let i = 0; i < list.length; i += 30) {
        const chunk = list.slice(i, i + 30);
        let attrs = [];
        try { attrs = await gecko.multi(net, chunk.map(p => p.pool)); } catch (e) { log('multi failed', net, e.message); }
        for (const a of attrs) {
          const p = pools.get(keyOf(net, a.address));
          if (!p) continue;
          const isBase = a._base.toLowerCase().endsWith(p.token.toLowerCase());
          p.stats = { mcap: isBase ? (+a.market_cap_usd || +a.fdv_usd || 0) : 0, raw: a };
          const t = a.transactions || {};
          const sig = [t.m5?.buys, t.m5?.sells, t.m15?.buys, t.h1?.buys, t.h1?.sells].join('/');
          if (sig !== p.sig || Date.now() - p.lastTrades > FORCE_TRADES_AFTER) { p.sig = sig; due.push(p); }
        }
        // Pools missing from the multi response still get checked now and then.
        for (const p of chunk) if (!p.stats && Date.now() - p.lastTrades > FORCE_TRADES_AFTER) due.push(p);
      }
    }
    for (const p of due) {
      try { await pollTrades(p); } catch (e) { log('trades failed', p.key, e.message); }
    }
  }

  return {
    pools,
    stats: (net, pool) => pools.get(keyOf(net, pool))?.stats,
    async run() {
      for (;;) {
        const t0 = Date.now();
        try { await scan(); } catch (e) { log('scan error', e.message); }
        await sleep(Math.max(3000, SCAN_EVERY - (Date.now() - t0)));
      }
    }
  };
}
