// All Telegram interaction: group setup & settings, Pro, ads, referrals and the owner panel.
import { esc, usd, NET, isPro, priceCard, short } from './format.js';
import { payEnabled } from './config.js';

const DAY = 86400000;
const EMOJIS = ['🟢', '🚀', '🔥', '💎', '⚡', '🐸', '🐶', '🦍', '💰', '🔔'];
const MIN_BUYS = [0, 10, 25, 50, 100, 250, 500, 1000];
const STEPS = [1, 5, 10, 25, 50, 100];
const WHALES = [0, 1000, 5000, 10000, 50000];
const next = (list, v) => list[(list.indexOf(v) + 1) % list.length] ?? list[0];
const date = ts => new Date(ts).toISOString().slice(0, 10);

const ADDR = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|(EQ|UQ)[A-Za-z0-9_-]{46})$/;

export function createBot(ctx) {
  const { tg, db, gecko, ads, cfg, log } = ctx;
  const payments = { create: a => ctx.payments.create(a), checkAll: () => ctx.payments.checkAll() }; // wired after the bot
  const me = () => ctx.me;
  const kb = rows => ({ reply_markup: { inline_keyboard: rows } });
  const stateKey = (chat, user) => `${chat}:${user}`;
  const notifyOwner = text => cfg.ownerId && tg.send(cfg.ownerId, text).catch(() => {});

  async function canManage(msg) {
    if (msg.sender_chat && msg.sender_chat.id === msg.chat.id) return true; // anonymous admin
    return tg.isAdmin(msg.chat.id, msg.from.id);
  }

  // ---------------- group ----------------

  async function welcome(chatId) {
    await tg.send(chatId, `🔔 <b>Thanks for adding BuyBell!</b>\n\nI post every buy of your token here — with amount, buyer, market cap and chart links.\n\nAn admin can start in one step:\n<code>/setup YOUR_TOKEN_ADDRESS</code>\n\nSupported: Solana, TON, BNB Chain, Base, Ethereum.`);
  }

  async function askAddress(msg) {
    db.setState(stateKey(msg.chat.id, msg.from.id), { step: 'addr' });
    await tg.send(msg.chat.id, '📝 Reply to this message with your <b>token contract address</b>.', { reply_markup: { force_reply: true, selective: true }, reply_to_message_id: msg.message_id });
  }

  async function lookup(msg, address) {
    if (!ADDR.test(address)) { await tg.send(msg.chat.id, '❌ That doesn’t look like a token address. Send the contract address (Solana, TON, BNB, Base or Ethereum).'); return; }
    const wait = await tg.send(msg.chat.id, '🔎 Looking up your token…');
    let t = null;
    try { t = await gecko.findToken(address); } catch (e) { log('findToken', e.message); }
    if (!t) { await tg.edit(msg.chat.id, wait.message_id, '❌ I couldn’t find a trading pool for this token yet. Make sure it has liquidity on a DEX, then try again.'); return; }
    db.setState(stateKey(msg.chat.id, msg.from.id), { step: 'confirm', t });
    await tg.edit(msg.chat.id, wait.message_id,
      `<b>${esc(t.name)} (${esc(t.symbol)})</b>\n🌐 ${NET[t.network].name} · ${esc(t.dex)}\n💧 Pool: ${esc(t.poolName)} (liquidity ${usd(t.liquidity)})\n🏷 Price: ${usd(t.priceUsd)}${t.mcap ? ` · MC ${usd(t.mcap)}` : ''}\n\nTrack this token in this group?`,
      kb([[{ text: '✅ Start tracking', callback_data: `cfm:${msg.chat.id}` }, { text: '✖ Cancel', callback_data: `cnl:${msg.chat.id}` }]]));
  }

  function settingsView(g) {
    const pro = isPro(g);
    const lock = pro ? '' : ' 🔒';
    const text = `⚙️ <b>BuyBell settings</b> — ${esc(g.symbol || 'no token')}\n\n`
      + `Plan: <b>${pro ? `⭐ Pro until ${date(g.pro_until)}` : 'Free'}</b>\n`
      + `Status: ${g.paused ? '⏸ Paused' : '▶ Running'}\n`
      + `Minimum buy: ${usd(g.min_usd)} · ${g.emoji} = ${usd(g.emoji_step)}\n`
      + `Media: ${g.media_id ? 'custom ' + g.media_type : 'none'} · Sells: ${g.sells ? 'on' : 'off'} · Whale: ${g.whale_usd ? usd(g.whale_usd) : 'off'}`;
    const c = f => `set:${g.chat_id}:${f}`;
    return {
      text,
      ...kb([
        [{ text: `Min buy: ${usd(g.min_usd)}`, callback_data: c('min') }, { text: `Emoji: ${g.emoji}`, callback_data: c('emoji') }],
        [{ text: `${g.emoji} per ${usd(g.emoji_step)}`, callback_data: c('step') }, { text: g.paused ? '▶ Resume' : '⏸ Pause', callback_data: c('pause') }],
        [{ text: `🎬 ${g.media_id ? 'Remove media' : 'Set GIF / image'}${lock}`, callback_data: c('media') }, { text: `🔴 Sells: ${g.sells ? 'on' : 'off'}${lock}`, callback_data: c('sells') }],
        [{ text: `🐋 Whale: ${g.whale_usd ? usd(g.whale_usd) : 'off'}${lock}`, callback_data: c('whale') }, { text: '🔁 Change token', callback_data: c('token') }],
        [{ text: pro ? '⭐ Extend Pro' : '⭐ Go Pro — no ads, media, sells, whales', url: `https://t.me/${me()}?start=pro_${g.chat_id}` }]
      ])
    };
  }

  async function onGroupCommand(msg, cmd, arg) {
    const chatId = msg.chat.id;
    db.upsertGroup(chatId, { title: msg.chat.title || '', active: 1 });
    if (cmd === 'price') {
      const g = db.group(chatId);
      if (!g?.pool) return tg.send(chatId, 'No token set yet. An admin can run /setup.');
      const p = ctx.tracker.stats(g.network, g.pool)?.raw || await gecko.pool(g.network, g.pool);
      return p ? tg.send(chatId, priceCard(g, p)) : tg.send(chatId, 'Price data is temporarily unavailable.');
    }
    if (cmd === 'help') {
      return tg.send(chatId, '🔔 <b>BuyBell commands</b>\n/setup &lt;address&gt; — track a token\n/settings — alerts, emoji, media\n/price — price & market cap\n/pro — remove ads, add media, sells & whale alerts');
    }
    if (!['setup', 'start', 'settings', 'pro'].includes(cmd)) return;
    if (!(await canManage(msg))) return tg.send(chatId, 'Only group admins can do that.');
    if (cmd === 'setup' || cmd === 'start') return arg && ADDR.test(arg) ? lookup(msg, arg) : askAddress(msg);
    const g = db.group(chatId);
    if (cmd === 'settings') {
      if (!g?.pool) return askAddress(msg);
      const v = settingsView(g);
      return tg.send(chatId, v.text, { reply_markup: v.reply_markup });
    }
    if (cmd === 'pro') {
      return tg.send(chatId, `⭐ <b>BuyBell Pro</b>${isPro(g) ? ` — active until ${date(g.pro_until)}` : ''}\n\n• No ads under your alerts\n• Your own GIF, image or video on every buy\n• Sell alerts and 🐋 whale alerts\n• Daily trading summary\n\n<b>${usd(cfg.proMonth)}/month</b> or <b>${usd(cfg.proYear)}/year</b>, paid in USDT or TON.`,
        kb([[{ text: '⭐ Get Pro', url: `https://t.me/${me()}?start=pro_${chatId}` }]]));
    }
  }

  async function onGroupMessage(msg) {
    if (msg.migrate_to_chat_id) {
      db.run('UPDATE groups SET chat_id = ? WHERE chat_id = ?', msg.migrate_to_chat_id, msg.chat.id);
      return;
    }
    const text = msg.text || msg.caption || '';
    const m = text.match(/^\/([a-z]+)(?:@(\w+))?(?:\s+(.+))?$/is);
    if (m && (!m[2] || m[2].toLowerCase() === me().toLowerCase())) return onGroupCommand(msg, m[1].toLowerCase(), (m[3] || '').trim());

    if (!msg.from) return;
    const st = db.getState(stateKey(msg.chat.id, msg.from.id));
    if (!st) return;
    if (st.step === 'addr' && text) { db.setState(stateKey(msg.chat.id, msg.from.id), null); return lookup(msg, text.trim()); }
    if (st.step === 'media') {
      const media = msg.animation ? ['animation', msg.animation.file_id] : msg.video ? ['video', msg.video.file_id] : msg.photo ? ['photo', msg.photo.at(-1).file_id] : null;
      if (!media) return tg.send(msg.chat.id, 'Please reply with a GIF, image or short video.');
      db.setState(stateKey(msg.chat.id, msg.from.id), null);
      db.upsertGroup(msg.chat.id, { media_type: media[0], media_id: media[1] });
      return tg.send(msg.chat.id, '✅ Media saved — it will appear on every buy alert.');
    }
  }

  async function onSettingsButton(q, chatId, field) {
    if (!(await tg.isAdmin(chatId, q.from.id))) return tg.answer(q.id, 'Only group admins can change settings.', true);
    let g = db.group(chatId);
    if (!g) return tg.answer(q.id);
    const proOnly = ['media', 'sells', 'whale'];
    if (proOnly.includes(field) && !isPro(g)) return tg.answer(q.id, '⭐ This is a Pro feature. Use /pro to upgrade.', true);
    if (field === 'min') g = db.upsertGroup(chatId, { min_usd: next(MIN_BUYS, g.min_usd) });
    if (field === 'emoji') g = db.upsertGroup(chatId, { emoji: next(EMOJIS, g.emoji) });
    if (field === 'step') g = db.upsertGroup(chatId, { emoji_step: next(STEPS, g.emoji_step) });
    if (field === 'pause') g = db.upsertGroup(chatId, { paused: g.paused ? 0 : 1 });
    if (field === 'sells') g = db.upsertGroup(chatId, { sells: g.sells ? 0 : 1 });
    if (field === 'whale') g = db.upsertGroup(chatId, { whale_usd: next(WHALES, g.whale_usd) });
    if (field === 'media') {
      if (g.media_id) g = db.upsertGroup(chatId, { media_id: null, media_type: null });
      else {
        db.setState(stateKey(chatId, q.from.id), { step: 'media' });
        await tg.send(chatId, '🎬 Reply to this message with the GIF, image or video to show on every buy.', { reply_markup: { force_reply: true, selective: true } });
        return tg.answer(q.id);
      }
    }
    if (field === 'token') {
      db.setState(stateKey(chatId, q.from.id), { step: 'addr' });
      await tg.send(chatId, '📝 Reply to this message with the new token contract address.', { reply_markup: { force_reply: true, selective: true } });
      return tg.answer(q.id);
    }
    const v = settingsView(g);
    await tg.edit(chatId, q.message.message_id, v.text, { reply_markup: v.reply_markup });
    return tg.answer(q.id, 'Saved');
  }

  // ---------------- private ----------------

  const payButtons = prefix => [[
    ...(cfg.wallets.trc20 ? [{ text: '💵 USDT (TRC20)', callback_data: `${prefix}:trc20` }] : []),
    ...(cfg.wallets.ton ? [{ text: '💎 TON', callback_data: `${prefix}:ton` }] : [])
  ]];

  function invoiceText(inv, title) {
    const head = `🧾 <b>Invoice #${inv.id}</b> — ${title}\nTotal: <b>${usd(inv.usd)}</b>\n\n`;
    if (inv.net === 'trc20') {
      return head + `Send <b>exactly</b>:\n<code>${inv.amount}</code> USDT\n\nOn the <b>TRON (TRC20)</b> network to:\n<code>${cfg.wallets.trc20}</code>\n\n⚠️ The last digits identify your payment — send the exact amount. Confirms automatically within a minute.`;
    }
    return head + `Send:\n<code>${inv.amount}</code> TON\n\nTo:\n<code>${cfg.wallets.ton}</code>\n\nWith this <b>comment</b> (required):\n<code>${inv.nonce}</code>\n\nConfirms automatically within a minute.`;
  }

  async function sendInvoice(chatId, inv, title) {
    const rows = [[{ text: '🔄 Check payment', callback_data: `chk:${inv.id}` }]];
    if (inv.net === 'ton') rows.unshift([{ text: '💎 Pay in Tonkeeper', url: `https://app.tonkeeper.com/transfer/${cfg.wallets.ton}?amount=${inv.nano}&text=${inv.nonce}` }]);
    await tg.send(chatId, invoiceText(inv, title) + '\n\nInvoice valid for 24 hours.', kb(rows));
  }

  async function proMenu(chatId, userId, groupId) {
    if (!payEnabled()) return tg.send(chatId, 'Payments open very soon. Thanks for your patience!');
    if (!(await tg.isAdmin(groupId, userId))) return tg.send(chatId, 'You need to be an admin of that group to buy Pro for it.');
    const g = db.group(groupId);
    await tg.send(chatId, `⭐ <b>BuyBell Pro</b> for <b>${esc(g?.title || 'your group')}</b>${isPro(g) ? `\nCurrently active until ${date(g.pro_until)} — new time is added on top.` : ''}\n\nChoose a plan:`,
      kb([[{ text: `1 month — ${usd(cfg.proMonth)}`, callback_data: `prp:${groupId}:1` }, { text: `12 months — ${usd(cfg.proYear)}`, callback_data: `prp:${groupId}:12` }]]));
  }

  async function adsMenu(chatId) {
    if (!payEnabled()) return tg.send(chatId, 'Ad bookings open very soon.');
    const groups = db.get("SELECT COUNT(*) AS n FROM groups WHERE active = 1 AND pool IS NOT NULL AND pro_until < ?", Date.now()).n;
    const views = db.sumCounter('alerts_free', 7);
    await tg.send(chatId, `📢 <b>Advertise on BuyBell</b>\n\nYour one-line ad is shown under buy alerts in <b>${groups}</b> crypto communities.\nLast 7 days: <b>${views.toLocaleString('en-US')}</b> alerts with ad space.\n\nAds rotate fairly between advertisers. Every ad is reviewed before it goes live.`,
      kb([[{ text: `1 day — ${usd(cfg.adPrices[1])}`, callback_data: 'add:1' }, { text: `3 days — ${usd(cfg.adPrices[3])}`, callback_data: 'add:3' }, { text: `7 days — ${usd(cfg.adPrices[7])}`, callback_data: 'add:7' }]]));
  }

  async function referral(chatId, userId) {
    const n = db.get('SELECT COUNT(*) AS n FROM users WHERE ref_by = ?', userId).n;
    const earned = db.get("SELECT COALESCE(SUM(commission), 0) AS s FROM invoices WHERE ref_by = ? AND status = 'paid'", userId).s;
    const u = db.get('SELECT payout FROM users WHERE id = ?', userId);
    await tg.send(chatId, `🤝 <b>Referral program</b>\n\nEarn <b>${cfg.refPercent}%</b> of every Pro and ad payment from people you invite.\n\nYour link:\n<code>https://t.me/${me()}?start=ref_${userId}</code>\n\nInvited: <b>${n}</b> · Earned: <b>${usd(earned)}</b>\nPayout wallet: ${u?.payout ? `<code>${esc(u.payout)}</code>` : 'not set — send /wallet YOUR_TRC20_ADDRESS'}\n\nPayouts are sent in USDT once your balance reaches $20.`);
  }

  function adminSummary() {
    const g = db.get('SELECT COUNT(*) AS total, SUM(active) AS active FROM groups WHERE pool IS NOT NULL');
    const pro = db.get('SELECT COUNT(*) AS n FROM groups WHERE pro_until > ?', Date.now()).n;
    const rev = d => db.get("SELECT COALESCE(SUM(usd), 0) AS s FROM invoices WHERE status = 'paid' AND paid_at > ?", Date.now() - d * DAY).s;
    const total = db.get("SELECT COALESCE(SUM(usd), 0) AS s FROM invoices WHERE status = 'paid'").s;
    const owed = db.get("SELECT COALESCE(SUM(commission), 0) AS s FROM invoices WHERE status = 'paid' AND ref_by IS NOT NULL").s - (db.get("SELECT COALESCE(SUM(n), 0) AS s FROM counters WHERE name = 'ref_paid_cents'").s / 100);
    const adsA = db.get("SELECT COUNT(*) AS n FROM ads WHERE status = 'active'").n;
    const adsR = db.get("SELECT COUNT(*) AS n FROM ads WHERE status = 'review'").n;
    return `📊 <b>BuyBell report</b>\n\n`
      + `Groups tracking: <b>${g.active || 0}</b> active / ${g.total || 0} total\n`
      + `Pro groups: <b>${pro}</b>\n`
      + `Pools watched: ${ctx.tracker.pools.size}\n`
      + `Alerts sent: ${db.sumCounter('alerts', 1)} today · ${db.sumCounter('alerts', 7)} in 7 days\n`
      + `Users: ${db.get('SELECT COUNT(*) AS n FROM users').n}\n\n`
      + `💰 Revenue: <b>${usd(rev(7))}</b> 7d · ${usd(rev(30))} 30d · ${usd(total)} all-time\n`
      + `📢 Ads: ${adsA} live · ${adsR} waiting for review\n`
      + `🤝 Referral commissions owed: ${usd(Math.max(0, owed))}`;
  }

  async function adminPanel(chatId) {
    await tg.send(chatId, adminSummary());
    for (const ad of db.all("SELECT * FROM ads WHERE status = 'review' ORDER BY id")) await reviewCard(ad);
    const owed = db.all(`SELECT i.ref_by AS id, u.username, u.payout, SUM(i.commission) AS s FROM invoices i LEFT JOIN users u ON u.id = i.ref_by
      WHERE i.status = 'paid' AND i.ref_by IS NOT NULL GROUP BY i.ref_by`);
    if (owed.length) await tg.send(chatId, '🤝 <b>Referral earnings (all-time)</b>\n' + owed.map(o => `• ${o.username ? '@' + esc(o.username) : o.id}: ${usd(o.s)} → ${o.payout ? `<code>${esc(o.payout)}</code>` : 'no wallet yet'}`).join('\n'));
  }

  async function reviewCard(ad) {
    await tg.send(cfg.ownerId, `📢 <b>Ad #${ad.id} waiting for review</b> (${ad.days}d, ${usd(ad.usd)} paid)\n\n${esc(ad.text)}\n${esc(ad.url)}`,
      kb([[{ text: '✅ Approve', callback_data: `adm:ok:${ad.id}` }, { text: '❌ Reject', callback_data: `adm:no:${ad.id}` }]]));
  }

  async function onPrivate(msg) {
    const chatId = msg.chat.id;
    const user = db.user(msg.from);
    const text = (msg.text || '').trim();
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');

    if (cmd === '/start') {
      if (arg.startsWith('ref_') && !user.ref_by) {
        const ref = +arg.slice(4);
        if (ref && ref !== user.id && db.get('SELECT id FROM users WHERE id = ?', ref)) db.run('UPDATE users SET ref_by = ? WHERE id = ?', ref, user.id);
      }
      if (arg.startsWith('pro_')) return proMenu(chatId, user.id, +arg.slice(4));
      if (arg === 'ads') return adsMenu(chatId);
      return tg.send(chatId, `🔔 <b>BuyBell</b> — buy alerts for crypto communities\n\nAdd me to your Telegram group and I’ll post every buy of your token with amount, buyer, market cap and chart links. Free forever, with Pro upgrades.\n\nWorks with Solana, TON, BNB Chain, Base and Ethereum.`,
        kb([[{ text: '➕ Add BuyBell to your group', url: `https://t.me/${me()}?startgroup=setup` }], [{ text: '📢 Advertise', callback_data: 'ads' }, { text: '🤝 Earn 20%', callback_data: 'ref' }]]));
    }
    if (cmd === '/myid') return tg.send(chatId, `Your Telegram id: <code>${user.id}</code>`);
    if (cmd === '/advertise') return adsMenu(chatId);
    if (cmd === '/referral') return referral(chatId, user.id);
    if (cmd === '/wallet') {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(arg)) return tg.send(chatId, 'Send: /wallet YOUR_TRC20_ADDRESS (starts with T)');
      db.run('UPDATE users SET payout = ? WHERE id = ?', arg, user.id);
      return tg.send(chatId, '✅ Payout wallet saved.');
    }
    if (cmd === '/help') return tg.send(chatId, '🔔 Add me to a group, then an admin runs /setup &lt;token address&gt; there.\n\n/advertise — book an ad\n/referral — earn 20% for invites\n/myid — your Telegram id');
    if (cmd === '/admin' && user.id === cfg.ownerId) return adminPanel(chatId);
    if (cmd === '/grantpro' && user.id === cfg.ownerId) {
      const [gid, days] = rest.map(Number);
      const g = gid && db.group(gid);
      if (!g || !(days > 0)) return tg.send(chatId, 'Usage: /grantpro GROUP_ID DAYS (the id is in the “New group” notification).');
      const until = Math.max(Date.now(), g.pro_until || 0) + days * DAY;
      db.upsertGroup(gid, { pro_until: until });
      tg.send(gid, `🎁 <b>You’ve been given BuyBell Pro until ${date(until)}!</b> Ads are removed — open /settings to add your GIF, sell and whale alerts.`).catch(() => {});
      return tg.send(chatId, `✅ ${esc(g.title)} is Pro until ${date(until)}.`);
    }
    if (cmd === '/refpaid' && user.id === cfg.ownerId) {
      const amount = parseFloat(arg);
      if (!(amount > 0)) return tg.send(chatId, 'Usage: /refpaid AMOUNT — records a referral payout you sent.');
      db.count('ref_paid_cents', Math.round(amount * 100));
      return tg.send(chatId, `Recorded referral payout of ${usd(amount)}.`);
    }

    const st = db.getState(stateKey(chatId, user.id));
    if (st?.step === 'ad_text') {
      if (!text || text.length > 60 || text.startsWith('/')) return tg.send(chatId, 'Please send ad text of up to 60 characters.');
      db.setState(stateKey(chatId, user.id), { step: 'ad_url', days: st.days, text });
      return tg.send(chatId, '🔗 Now send the link your ad should open (https://… or https://t.me/…).');
    }
    if (st?.step === 'ad_url') {
      if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(text)) return tg.send(chatId, 'Please send a valid https:// link.');
      db.setState(stateKey(chatId, user.id), null);
      const r = db.run("INSERT INTO ads (user_id, text, url, days, usd, status, created) VALUES (?, ?, ?, ?, ?, 'unpaid', ?)", user.id, st.text, text, st.days, cfg.adPrices[st.days], Date.now());
      return tg.send(chatId, `👀 <b>Preview</b>\n\n📢 <a href="${esc(text)}">${esc(st.text)}</a> <i>(ad)</i>\n\n${st.days} day(s) — <b>${usd(cfg.adPrices[st.days])}</b>. Choose how to pay:`, kb(payButtons(`adp:${r.lastInsertRowid}`)));
    }
    return tg.send(chatId, 'Use /start to see what I can do.');
  }

  async function onCallback(q) {
    const [kind, a, b, c] = (q.data || '').split(':');
    const chatId = q.message?.chat.id;
    if (kind === 'cfm' || kind === 'cnl') {
      const gid = +a;
      const key = stateKey(gid, q.from.id);
      const st = db.getState(key);
      if (!st || st.step !== 'confirm') return tg.answer(q.id, 'This request expired — run /setup again.', true);
      db.setState(key, null);
      if (kind === 'cnl') { await tg.edit(gid, q.message.message_id, 'Cancelled.'); return tg.answer(q.id); }
      const t = st.t;
      db.upsertGroup(gid, { network: t.network, token: t.token, symbol: t.symbol, token_name: t.name, pool: t.pool, pool_name: t.poolName, quote_symbol: t.quoteSymbol, paused: 0, active: 1, added_by: q.from.id });
      await tg.edit(gid, q.message.message_id, `✅ <b>Tracking ${esc(t.symbol)} on ${NET[t.network].name}!</b>\n\nBuys will appear here within about a minute of happening.\nCustomize with /settings · Remove ads with /pro`);
      db.count('setups');
      notifyOwner(`➕ New group tracking ${esc(t.symbol)} (${NET[t.network].name}): ${esc(q.message.chat.title || gid)}\nGroup id: <code>${gid}</code> — gift Pro with /grantpro ${gid} 30`);
      return tg.answer(q.id, 'Tracking started');
    }
    if (kind === 'set') return onSettingsButton(q, +a, b);
    if (kind === 'ads') { await adsMenu(chatId); return tg.answer(q.id); }
    if (kind === 'ref') { await referral(chatId, q.from.id); return tg.answer(q.id); }
    if (kind === 'prp') {
      await tg.send(chatId, `Plan: ${b === '12' ? '12 months' : '1 month'}. Choose how to pay:`, kb(payButtons(`prn:${a}:${b}`)));
      return tg.answer(q.id);
    }
    if (kind === 'prn') {
      if (!(await tg.isAdmin(+a, q.from.id))) return tg.answer(q.id, 'Admins only.', true);
      const months = +b === 12 ? 12 : 1;
      const inv = await payments.create({ kind: 'pro', ref: `${a}:${months}`, userId: q.from.id, usd: months === 12 ? cfg.proYear : cfg.proMonth, net: c });
      const g = db.group(+a);
      await sendInvoice(chatId, inv, `BuyBell Pro for ${esc(g?.title || 'your group')} (${months === 12 ? '12 months' : '1 month'})`);
      return tg.answer(q.id);
    }
    if (kind === 'add') {
      db.setState(stateKey(chatId, q.from.id), { step: 'ad_text', days: +a });
      await tg.send(chatId, '✍️ Send your ad text — one line, up to 60 characters.\nExample: <i>🚀 $FROG presale live — 2x bonus today</i>');
      return tg.answer(q.id);
    }
    if (kind === 'adp') {
      const ad = db.get('SELECT * FROM ads WHERE id = ? AND user_id = ?', +a, q.from.id);
      if (!ad || ad.status !== 'unpaid') return tg.answer(q.id, 'This ad was already handled.', true);
      const inv = await payments.create({ kind: 'ad', ref: ad.id, userId: q.from.id, usd: ad.usd, net: b });
      await sendInvoice(chatId, inv, `Ad #${ad.id} (${ad.days} day${ad.days > 1 ? 's' : ''})`);
      return tg.answer(q.id);
    }
    if (kind === 'chk') {
      await payments.checkAll();
      const inv = db.get('SELECT status FROM invoices WHERE id = ?', +a);
      return tg.answer(q.id, inv?.status === 'paid' ? '✅ Payment received!' : inv?.status === 'expired' ? 'This invoice expired.' : '⏳ Not received yet — it usually takes under a minute after sending.', true);
    }
    if (kind === 'adm' && q.from.id === cfg.ownerId) {
      const ad = db.get('SELECT * FROM ads WHERE id = ?', +b);
      if (!ad || ad.status !== 'review') return tg.answer(q.id, 'Already handled.');
      if (a === 'ok') {
        db.run("UPDATE ads SET status = 'active', starts = ?, ends = ? WHERE id = ?", Date.now(), Date.now() + ad.days * DAY, ad.id);
        ads.refresh();
        tg.send(ad.user_id, `✅ Your ad #${ad.id} is live for ${ad.days} day(s). Thank you!`).catch(() => {});
        await tg.edit(chatId, q.message.message_id, `✅ Ad #${ad.id} approved and live.`);
      } else {
        db.run("UPDATE ads SET status = 'rejected' WHERE id = ?", ad.id);
        tg.send(ad.user_id, `❌ Your ad #${ad.id} didn’t pass review. We’ll contact you about a refund.`).catch(() => {});
        await tg.edit(chatId, q.message.message_id, `❌ Ad #${ad.id} rejected — remember to refund ${usd(ad.usd)} to the advertiser.`);
      }
      return tg.answer(q.id);
    }
    return tg.answer(q.id);
  }

  // ---------------- payments → products ----------------

  async function onPaid(inv) {
    if (inv.kind === 'pro') {
      const [gid, months] = inv.ref.split(':').map(Number);
      const g = db.group(gid);
      const until = Math.max(Date.now(), g?.pro_until || 0) + months * 30 * DAY;
      db.upsertGroup(gid, { pro_until: until });
      tg.send(inv.user_id, `✅ Payment received — <b>BuyBell Pro is active until ${date(until)}</b>. Open /settings in your group to add media, sells and whale alerts.`).catch(() => {});
      tg.send(gid, `⭐ <b>BuyBell Pro activated!</b> Ads are gone and Pro features are unlocked until ${date(until)}. Thank you!`).catch(() => {});
      notifyOwner(`💰 <b>+${usd(inv.usd)}</b> Pro (${months} mo) — ${esc(g?.title || gid)}`);
    }
    if (inv.kind === 'ad') {
      db.run("UPDATE ads SET status = 'review' WHERE id = ?", +inv.ref);
      tg.send(inv.user_id, `✅ Payment received for ad #${inv.ref}. It goes live as soon as it’s reviewed (usually within a few hours).`).catch(() => {});
      notifyOwner(`💰 <b>+${usd(inv.usd)}</b> ad booking #${inv.ref}`);
      const ad = db.get('SELECT * FROM ads WHERE id = ?', +inv.ref);
      if (ad && cfg.ownerId) await reviewCard(ad);
    }
    if (inv.ref_by && inv.commission > 0) tg.send(inv.ref_by, `🤝 You earned <b>${usd(inv.commission)}</b> from a referral payment!`).catch(() => {});
  }

  // ---------------- dispatcher ----------------

  async function handle(u) {
    try {
      if (u.my_chat_member) {
        const m = u.my_chat_member;
        if (!['group', 'supergroup'].includes(m.chat.type)) return;
        const st = m.new_chat_member.status;
        if (st === 'member' || st === 'administrator') {
          const fresh = !db.group(m.chat.id)?.pool;
          db.upsertGroup(m.chat.id, { title: m.chat.title || '', active: 1, added_by: m.from.id });
          if (fresh && m.old_chat_member.status !== 'member' && m.old_chat_member.status !== 'administrator') await welcome(m.chat.id);
        } else if (st === 'left' || st === 'kicked') {
          db.upsertGroup(m.chat.id, { active: 0 });
        }
        return;
      }
      if (u.callback_query) return await onCallback(u.callback_query);
      const msg = u.message;
      if (!msg) return;
      if (msg.chat.type === 'private') return await onPrivate(msg);
      if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return await onGroupMessage(msg);
    } catch (e) {
      log('handler error', e.message);
    }
  }

  return { handle, onPaid, adminSummary };
}
