// Message formatting (Telegram HTML).

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const NET = {
  solana: { name: 'Solana', ds: 'solana', tx: h => `https://solscan.io/tx/${h}`, addr: a => `https://solscan.io/account/${a}`, buy: t => `https://jup.ag/swap/SOL-${t}` },
  ton: { name: 'TON', ds: 'ton', tx: h => `https://tonviewer.com/transaction/${h}`, addr: a => `https://tonviewer.com/${a}`, buy: t => `https://app.ston.fi/swap?ft=TON&tt=${t}` },
  bsc: { name: 'BNB Chain', ds: 'bsc', tx: h => `https://bscscan.com/tx/${h}`, addr: a => `https://bscscan.com/address/${a}`, buy: t => `https://pancakeswap.finance/swap?outputCurrency=${t}` },
  base: { name: 'Base', ds: 'base', tx: h => `https://basescan.org/tx/${h}`, addr: a => `https://basescan.org/address/${a}`, buy: t => `https://app.uniswap.org/swap?chain=base&outputCurrency=${t}` },
  eth: { name: 'Ethereum', ds: 'ethereum', tx: h => `https://etherscan.io/tx/${h}`, addr: a => `https://etherscan.io/address/${a}`, buy: t => `https://app.uniswap.org/swap?outputCurrency=${t}` }
};

export const chartUrl = g => `https://dexscreener.com/${NET[g.network]?.ds || g.network}/${g.pool}`;

export function usd(n) {
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n === 0) return '$0';
  return '$' + n.toPrecision(4).replace(/\.?0+$/, '');
}

export function amount(n) {
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toPrecision(3);
}

export const short = a => a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '';

export const isPro = g => (g?.pro_until || 0) > Date.now();

// trade: { side, usd, paid, got, buyer, tx, price }   stats: { mcap }   ad: { text, url } | null
export function buyAlert(g, trade, stats, ad, botUser) {
  const pro = isPro(g);
  const n = Math.max(1, Math.min(40, Math.ceil(trade.usd / (g.emoji_step || 10))));
  const whale = pro && g.whale_usd > 0 && trade.usd >= g.whale_usd;
  const isSell = trade.side === 'sell';
  const net = NET[g.network];
  const head = isSell ? '🔴'.repeat(Math.min(n, 20)) : (whale ? '🐋' : g.emoji || '🟢').repeat(n);
  const title = isSell ? `${esc(g.symbol)} Sell` : whale ? `🐋 WHALE ${esc(g.symbol)} BUY!` : `${esc(g.symbol)} Buy!`;
  const lines = [
    head,
    `<b>${title}</b>`,
    '',
    `💵 ${isSell ? 'Received' : 'Spent'}: <b>${usd(trade.usd)}</b> (${amount(trade.paid)} ${esc(g.quote_symbol)})`,
    `🪙 ${isSell ? 'Sold' : 'Got'}: <b>${amount(trade.got)} ${esc(g.symbol)}</b>`,
    `👤 <a href="${net.addr(trade.buyer)}">${esc(short(trade.buyer))}</a> | <a href="${net.tx(trade.tx)}">Txn</a>`,
    `🏷 Price: ${usd(trade.price)}${stats?.mcap ? ` · MC: <b>${usd(stats.mcap)}</b>` : ''}`,
    '',
    `<a href="${chartUrl(g)}">📈 Chart</a> · <a href="${net.buy(g.token)}">🛒 Buy</a>`
  ];
  if (!pro) {
    lines.push('');
    lines.push(ad
      ? `📢 <a href="${esc(ad.url)}">${esc(ad.text)}</a> <i>(ad)</i>`
      : `🔔 <a href="https://t.me/${botUser}?startgroup=setup">Get buy alerts for your token — free</a>`);
  }
  return lines.join('\n');
}

export function priceCard(g, p) {
  const ch = +p.price_change_percentage?.h24;
  const tx = p.transactions?.h24 || {};
  return [
    `<b>${esc(g.token_name)} (${esc(g.symbol)})</b> · ${NET[g.network].name}`,
    '',
    `🏷 Price: <b>${usd(+p.base_token_price_usd)}</b>${isFinite(ch) ? ` (${ch > 0 ? '+' : ''}${ch.toFixed(2)}% 24h)` : ''}`,
    `💎 Market cap: <b>${usd(+p.market_cap_usd || +p.fdv_usd)}</b>`,
    `💧 Liquidity: ${usd(+p.reserve_in_usd)}`,
    `📊 Volume 24h: ${usd(+p.volume_usd?.h24)}`,
    `🔁 24h trades: ${tx.buys ?? '—'} buys / ${tx.sells ?? '—'} sells`,
    '',
    `<a href="${chartUrl(g)}">📈 Chart</a> · <a href="${NET[g.network].buy(g.token)}">🛒 Buy</a>`
  ].join('\n');
}
