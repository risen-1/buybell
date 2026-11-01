// BuyBell entry point: wires Telegram, the trade tracker, payments and scheduled reports.
import { cfg } from './config.js';
import { openDb } from './db.js';
import { createTg } from './tg.js';
import { createGecko } from './gecko.js';
import { createTracker } from './tracker.js';
import { createPayments } from './payments.js';
import { createAds } from './ads.js';
import { createBot } from './bot.js';
import { buyAlert, priceCard, isPro } from './format.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!cfg.token) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const db = openDb(cfg.dbPath);
const tg = createTg(cfg.token, log);
const gecko = createGecko(cfg.geckoRpm, log);
const ads = createAds(db);
const ctx = { tg, db, gecko, ads, cfg, log, me: '' };

const me = await tg.call('getMe').catch(e => {
  console.error(`Telegram rejected the bot token (${e.message}). Check BOT_TOKEN in .env.`);
  process.exit(1);
});
ctx.me = me.username;
log(`Logged in as @${me.username}`);

await tg.call('setMyCommands', { scope: { type: 'all_group_chats' }, commands: [
  { command: 'setup', description: 'Track a token: /setup <address>' },
  { command: 'settings', description: 'Alert settings' },
  { command: 'price', description: 'Price and market cap' },
  { command: 'pro', description: 'Upgrade to Pro' },
  { command: 'help', description: 'How BuyBell works' }
] }).catch(e => log('setMyCommands', e.message));
await tg.call('setMyCommands', { scope: { type: 'all_private_chats' }, commands: [
  { command: 'start', description: 'Add BuyBell to your group' },
  { command: 'advertise', description: 'Book an ad' },
  { command: 'referral', description: 'Earn 20% for invites' },
  { command: 'help', description: 'Help' }
] }).catch(e => log('setMyCommands', e.message));

// ---------- trades → group alerts ----------

async function onTrade(pool, trade) {
  const groups = db.trackedGroups().filter(g => g.network === pool.net && g.pool.toLowerCase() === pool.pool.toLowerCase());
  for (const g of groups) {
    const pro = isPro(g);
    if (trade.side === 'sell' && !(pro && g.sells)) continue;
    if (trade.usd < (g.min_usd || 0)) continue;
    const ad = pro ? null : ads.pick();
    const text = buyAlert(g, trade, tracker.stats(pool.net, pool.pool), ad, ctx.me);
    tg.enqueue(g.chat_id, async () => {
      try {
        if (g.media_id && pro) await tg.sendMedia(g.chat_id, g.media_type, g.media_id, text);
        else await tg.send(g.chat_id, text);
        db.count('alerts');
        if (!pro) db.count('alerts_free');
      } catch (e) {
        if (e.migrateTo) db.run('UPDATE groups SET chat_id = ? WHERE chat_id = ?', e.migrateTo, g.chat_id);
        else if (e.code === 403 || /chat not found|kicked|not enough rights/i.test(e.message)) db.upsertGroup(g.chat_id, { active: 0 });
        throw e;
      }
    });
  }
}

const tracker = createTracker({ db, gecko, onTrade, log });
ctx.tracker = tracker;
const bot = createBot(ctx);
const payments = createPayments({ db, cfg, onPaid: inv => bot.onPaid(inv), log });
ctx.payments = payments;

// ---------- schedules (UTC) ----------

let lastWeekly = '', lastDaily = '';
setInterval(async () => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCDay() === 1 && now.getUTCHours() === 9 && lastWeekly !== today) {
    lastWeekly = today;
    for (const id of cfg.adminIds) tg.send(id, bot.adminSummary()).catch(() => {});
  }
  if (now.getUTCHours() === 18 && lastDaily !== today) {
    lastDaily = today;
    for (const g of db.trackedGroups().filter(isPro)) {
      try {
        const p = await gecko.pool(g.network, g.pool);
        if (p) tg.enqueue(g.chat_id, () => tg.send(g.chat_id, '📊 <b>Daily summary</b>\n\n' + priceCard(g, p)));
      } catch (e) { log('daily summary', g.chat_id, e.message); }
    }
  }
}, 60000);

tracker.run();
payments.run();
for await (const u of tg.updates()) bot.handle(u);
