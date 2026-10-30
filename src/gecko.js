// GeckoTerminal public API with a global request budget (the free tier allows ~30 requests/minute).
const API = 'https://api.geckoterminal.com/api/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const NETWORKS = ['solana', 'ton', 'bsc', 'base', 'eth'];

export function createGecko(rpm = 25, log = console.log) {
  const gap = Math.ceil(60000 / rpm);
  let chain = Promise.resolve();
  let last = 0;

  // Every request waits its turn so the whole bot never exceeds the budget.
  function get(path) {
    const run = chain.then(async () => {
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      for (let i = 1; i <= 3; i++) {
        last = Date.now();
        const res = await fetch(API + path, { headers: { accept: 'application/json' } }).catch(e => ({ ok: false, status: 0, err: e }));
        if (res.ok) return res.json();
        if (res.status === 404) return null;
        if (res.status === 429) { log('gecko 429, backing off'); await sleep(15000 * i); continue; }
        if (i === 3) throw new Error(`gecko ${res.status} ${path}`);
        await sleep(2000 * i);
      }
      return null;
    });
    chain = run.catch(() => {});
    return run;
  }

  const sym = included => Object.fromEntries((included || []).map(x => [x.id, x.attributes]));

  return {
    get,
    // Finds the most liquid pool where the token trades, on any supported network.
    async findToken(address) {
      const j = await get(`/search/pools?query=${encodeURIComponent(address)}&include=base_token,quote_token,dex`);
      const inc = sym(j?.included);
      const a = address.toLowerCase();
      const pools = (j?.data || [])
        .filter(p => NETWORKS.includes(p.relationships.network?.data?.id || p.id.split('_')[0]))
        .map(p => {
          const net = p.relationships.network?.data?.id || p.id.split('_')[0];
          const base = inc[p.relationships.base_token.data.id] || {};
          const quote = inc[p.relationships.quote_token.data.id] || {};
          const isBase = (base.address || '').toLowerCase() === a;
          const isQuote = (quote.address || '').toLowerCase() === a;
          return { net, p, base, quote, mine: isBase ? base : isQuote ? quote : null, other: isBase ? quote : base, dex: inc[p.relationships.dex?.data?.id]?.name };
        })
        .filter(x => x.mine)
        .sort((x, y) => (+y.p.attributes.reserve_in_usd || 0) - (+x.p.attributes.reserve_in_usd || 0));
      const best = pools[0];
      if (!best) return null;
      const at = best.p.attributes;
      return {
        network: best.net, pool: at.address, poolName: at.name, dex: best.dex || '',
        token: best.mine.address, symbol: best.mine.symbol, name: best.mine.name,
        quoteSymbol: best.other.symbol,
        priceUsd: +(best.mine === best.base ? at.base_token_price_usd : at.quote_token_price_usd) || 0,
        mcap: +at.market_cap_usd || +at.fdv_usd || 0,
        liquidity: +at.reserve_in_usd || 0
      };
    },
    // Up to 30 pools of one network in a single request: activity counters + price data.
    async multi(net, pools) {
      const j = await get(`/networks/${net}/pools/multi/${pools.join(',')}`);
      return (j?.data || []).map(p => ({ ...p.attributes, _base: p.relationships?.base_token?.data?.id || '' }));
    },
    async trades(net, pool) {
      const j = await get(`/networks/${net}/pools/${pool}/trades`);
      return (j?.data || []).map(t => t.attributes);
    },
    async pool(net, pool) {
      const j = await get(`/networks/${net}/pools/${pool}`);
      return j?.data?.attributes || null;
    }
  };
}
