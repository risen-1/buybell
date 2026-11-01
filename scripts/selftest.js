// End-to-end test without a real bot: Telegram, TronGrid and CoinGecko are simulated,
// GeckoTerminal is real (live market data). Run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.BOT_TOKEN = 'TEST:TOKEN';
process.env.OWNER_ID = '111';
process.env.ADMIN_IDS = '444';
process.env.WALLET_TRC20 = 'TXYZtestWalletAddressForSelfTest1';
process.env.WALLET_TON = '';
const dbFile = path.join(os.tmpdir(), `buybell-test-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const { cfg } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { createTg } = await import('../src/tg.js');
const { createGecko } = await import('../src/gecko.js');
const { createPayments } = await import('../src/payments.js');
const { createAds } = await import('../src/ads.js');
const { createBot } = await import('../src/bot.js');
const { buyAlert, isPro } = await import('../src/format.js');

// ---------- fake network ----------
const sent = [];
let msgId = 100;
const transfers = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const ok = result => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  if (url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body || '{}');
    sent.push({ method, ...body });
    if (method === 'getChatMember') return ok({ status: body.user_id === 999 ? 'member' : 'administrator' });
    if (method === 'sendMessage') return ok({ message_id: ++msgId, chat: { id: body.chat_id } });
    return ok(true);
  }
  if (url.startsWith('https://api.trongrid.io/')) return { ok: true, json: async () => ({ success: true, data: transfers }) };
  if (url.startsWith('https://api.coingecko.com/')) return { ok: true, json: async () => ({ 'the-open-network': { usd: 2 } }) };
  return realFetch(url, opts);
};

const log = () => {};
const db = openDb(cfg.dbPath);
const tg = createTg(cfg.token, log);
const gecko = createGecko(25, log);
const ads = createAds(db);
const ctx = { tg, db, gecko, ads, cfg, log, me: 'BuyBellBot', tracker: { pools: new Map(), stats: () => null } };
const bot = createBot(ctx);
const payments = createPayments({ db, cfg, onPaid: inv => bot.onPaid(inv), log });
ctx.payments = payments;

const GID = -1001234567890, ADMIN = 222, OWNER = 111, FRIEND = 333;
const group = { id: GID, type: 'supergroup', title: 'Frog Army' };
const user = id => ({ id, first_name: 'U' + id, username: 'u' + id });
let uid = 1;
const msg = (chat, from, text) => bot.handle({ update_id: uid++, message: { message_id: uid, chat, from: user(from), text, date: 0 } });
const cb = (chat, from, data) => bot.handle({ update_id: uid++, callback_query: { id: 'q' + uid, from: user(from), data, message: { message_id: 1, chat } } });
const last = (method, chat) => [...sent].reverse().find(s => s.method === method && (chat == null || s.chat_id === chat));
const step = name => console.log('✓', name);

// 1. bot added to a group
await bot.handle({ update_id: uid++, my_chat_member: { chat: group, from: user(ADMIN), old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } });
assert.match(last('sendMessage', GID).text, /Thanks for adding BuyBell/);
step('welcome message on join');

// 2. setup with a live token (most liquid trending Solana pool)
const tr = await realFetch('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token').then(r => r.json());
const tokenAddr = tr.included[0].attributes.address;
await msg(group, 999, `/setup ${tokenAddr}`);
assert.match(last('sendMessage', GID).text, /Only group admins/);
await msg(group, ADMIN, `/setup ${tokenAddr}`);
const card = last('editMessageText', GID);
assert.match(card.text, /Track this token/);
step(`token lookup (${card.text.split('\n')[0].replace(/<[^>]+>/g, '')})`);

await cb(group, ADMIN, `cfm:${GID}`);
let g = db.group(GID);
assert.equal(g.network, 'solana');
assert.ok(g.pool && g.symbol && g.quote_symbol);
step('group configured: ' + g.symbol + ' / ' + g.quote_symbol);

// 3. settings
await cb(group, ADMIN, `set:${GID}:min`);
assert.equal(db.group(GID).min_usd, 10);
await cb(group, ADMIN, `set:${GID}:sells`);
assert.equal(db.group(GID).sells, 0, 'Pro-only toggle must stay off for free groups');
step('settings: min buy cycles, Pro features locked');

// 4. free alert carries the house ad
g = db.group(GID);
const trade = { side: 'buy', usd: 123.45, paid: 1.2, got: 50000, price: 0.0024, buyer: 'Buyer1111111111111111111111111111111', tx: 'TXHASH' };
assert.match(buyAlert(g, trade, { mcap: 2400000 }, null, 'BuyBellBot'), /Get buy alerts for your token/);
step('free alert shows viral footer');

// 5. Pro purchase via USDT-TRC20
await msg({ id: ADMIN, type: 'private' }, ADMIN, `/start pro_${GID}`);
assert.match(last('sendMessage', ADMIN).text, /Choose a plan/);
await cb({ id: ADMIN, type: 'private' }, ADMIN, `prn:${GID}:1:trc20`);
const inv = db.get("SELECT * FROM invoices WHERE kind = 'pro' ORDER BY id DESC");
assert.equal(inv.status, 'pending');
assert.match(inv.amount, /^29\.\d{4}$/);
transfers.push({ transaction_id: 'wrongamount', to: cfg.wallets.trc20, value: '29000000', block_timestamp: Date.now() });
await payments.checkAll();
assert.equal(db.get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'pending', 'round amount must not match');
transfers.push({ transaction_id: 'protx', to: cfg.wallets.trc20, value: String(Math.round(parseFloat(inv.amount) * 1e6)), block_timestamp: Date.now() });
await payments.checkAll();
await payments.checkAll();
g = db.group(GID);
assert.ok(isPro(g), 'group should be Pro after payment');
assert.equal(db.get("SELECT COUNT(*) AS n FROM invoices WHERE status = 'paid'").n, 1, 'paid exactly once');
step(`Pro paid with ${inv.amount} USDT → active until ${new Date(g.pro_until).toISOString().slice(0, 10)}`);

await cb(group, ADMIN, `set:${GID}:sells`);
assert.equal(db.group(GID).sells, 1);
assert.doesNotMatch(buyAlert(db.group(GID), trade, null, { text: 'x', url: 'https://x.y' }, 'BuyBellBot'), /\(ad\)|Get buy alerts/);
step('Pro: sells unlocked, no ads on alerts');

// 6. referral + ad booking + owner approval
await msg({ id: OWNER, type: 'private' }, OWNER, '/start');
await msg({ id: FRIEND, type: 'private' }, FRIEND, `/start ref_${OWNER}`);
assert.equal(db.get('SELECT ref_by FROM users WHERE id = ?', FRIEND).ref_by, OWNER);
await cb({ id: FRIEND, type: 'private' }, FRIEND, 'add:3');
await msg({ id: FRIEND, type: 'private' }, FRIEND, '🚀 $FROG presale live');
await msg({ id: FRIEND, type: 'private' }, FRIEND, 'https://t.me/frogarmy');
const ad = db.get('SELECT * FROM ads WHERE user_id = ?', FRIEND);
assert.equal(ad.status, 'unpaid');
await cb({ id: FRIEND, type: 'private' }, FRIEND, `adp:${ad.id}:trc20`);
const adInv = db.get("SELECT * FROM invoices WHERE kind = 'ad'");
assert.equal(adInv.commission, Math.round(cfg.adPrices[3] * cfg.refPercent) / 100);
transfers.push({ transaction_id: 'adtx', to: cfg.wallets.trc20, value: String(Math.round(parseFloat(adInv.amount) * 1e6)), block_timestamp: Date.now() });
await payments.checkAll();
assert.equal(db.get('SELECT status FROM ads WHERE id = ?', ad.id).status, 'review');
assert.ok(sent.some(s => s.chat_id === OWNER && /waiting for review/.test(s.text)));
await cb({ id: OWNER, type: 'private' }, FRIEND, `adm:ok:${ad.id}`);
assert.equal(db.get('SELECT status FROM ads WHERE id = ?', ad.id).status, 'review', 'only the owner can approve');
await cb({ id: OWNER, type: 'private' }, OWNER, `adm:ok:${ad.id}`);
assert.equal(db.get('SELECT status FROM ads WHERE id = ?', ad.id).status, 'active');
ads.refresh();
assert.equal(ads.pick()?.text, '🚀 $FROG presale live');
step(`ad booked (${adInv.amount} USDT), reviewed, live; referrer earns $${adInv.commission}`);

// 7. owner panel
await msg({ id: OWNER, type: 'private' }, OWNER, '/admin');
const report = [...sent].reverse().find(s => s.chat_id === OWNER && /BuyBell report/.test(s.text || '')).text;
assert.match(report, /Revenue/);
step('owner report:\n' + report.replace(/<[^>]+>/g, '').split('\n').map(l => '    ' + l).join('\n'));

// 8. extra admin (ADMIN_IDS): same notifications and commands as the owner; others are ignored
const ADMIN2 = 444;
assert.ok(sent.some(s => s.chat_id === ADMIN2 && /waiting for review/.test(s.text)), 'extra admin gets ad review cards');
await msg({ id: ADMIN2, type: 'private' }, ADMIN2, '/admin');
assert.ok(sent.some(s => s.chat_id === ADMIN2 && /BuyBell report/.test(s.text || '')));
await msg({ id: ADMIN2, type: 'private' }, ADMIN2, `/grantpro ${GID} 10`);
assert.match(last('sendMessage', ADMIN2).text, /is Pro until/);
const before = sent.length;
await msg({ id: FRIEND, type: 'private' }, FRIEND, '/admin');
assert.ok(!sent.slice(before).some(s => /BuyBell report/.test(s.text || '')), 'non-admins get no report');
step('extra admin: review cards, /admin and /grantpro work; non-admins blocked');

// 9. outreach leads: admins only, DM text names the token and the exact setup command
const { leadMessage } = await import('../src/leads.js');
let leadCalls = 0;
ctx.leads = { send: async to => { leadCalls++; assert.deepEqual(to, [ADMIN2]); } };
await msg({ id: FRIEND, type: 'private' }, FRIEND, '/leads');
await msg({ id: ADMIN2, type: 'private' }, ADMIN2, '/leads');
assert.equal(leadCalls, 1, 'only admins can request leads');
const dm = leadMessage({ symbol: 'FROG', net: 'solana', token: 'FrogMint111' }, 'BuyBellBot', 1);
assert.match(dm, /\$FROG/);
assert.match(dm, /@BuyBellBot/);
assert.match(dm, /\/setup FrogMint111/);
step('leads: /leads is admin-only, DM template is personalised');

db.raw.close();
fs.rmSync(dbFile, { force: true });
for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
console.log('\nAll tests passed.');
process.exit(0);
