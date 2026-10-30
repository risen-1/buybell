// Watch a token without Telegram and print the alerts the bot would send.
//   node scripts/dryrun.js <token address> [minutes]
import { createGecko } from '../src/gecko.js';
import { createTracker } from '../src/tracker.js';
import { buyAlert } from '../src/format.js';

const address = process.argv[2];
const minutes = +process.argv[3] || 3;
if (!address) { console.log('usage: node scripts/dryrun.js <token address> [minutes]'); process.exit(1); }

const gecko = createGecko(25);
const t = await gecko.findToken(address);
if (!t) { console.log('Token not found on supported networks'); process.exit(1); }
console.log(`Found ${t.name} (${t.symbol}) on ${t.network} — pool ${t.poolName} [${t.dex}], liquidity $${Math.round(t.liquidity)}`);

const group = { chat_id: 1, network: t.network, token: t.token, symbol: t.symbol, token_name: t.name, pool: t.pool, quote_symbol: t.quoteSymbol, min_usd: 0, emoji: '🟢', emoji_step: 10, pro_until: 0 };
const db = { trackedGroups: () => [group] };
let n = 0;
const tracker = createTracker({
  db, gecko,
  onTrade(p, trade) {
    n++;
    const text = buyAlert(group, trade, tracker.stats(p.net, p.pool), null, 'BuyBellBot');
    console.log('\n' + '─'.repeat(40) + `\n[${new Date(trade.ts).toISOString()}] ${trade.side.toUpperCase()}\n` + text.replace(/<[^>]+>/g, ''));
  }
});
tracker.run();
setTimeout(() => { console.log(`\nDone: ${n} trades in ${minutes} min`); process.exit(0); }, minutes * 60000);
