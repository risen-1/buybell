// Daily outreach leads: fresh crypto projects that have a Telegram community, each with a ready-to-send DM.
// Sources are public (DexScreener for projects, t.me pages for group type and size). Nothing is sent to the
// projects themselves: admins copy the text and send it by hand, which keeps the outreach account safe.
import { esc, usd } from './format.js';

const DS = 'https://api.dexscreener.com';
const CHAINS = { solana: 'Solana', ton: 'TON', bsc: 'BNB Chain', base: 'Base', ethereum: 'Ethereum' };
const PER_BATCH = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

export function leadMessage(l, bot, seed = 0) {
  const sym = '$' + l.symbol, chain = CHAINS[l.net] || l.net;
  const hooks = [
    `Hey! Saw ${sym} on ${chain}, nice momentum 🔥`,
    `Hi! Been watching ${sym}, the chart looks alive 👀`,
    `Hey ${sym} team! Love the activity on ${chain}.`
  ];
  return `${hooks[seed % hooks.length]}\n`
    + `I built BuyBell, a free buy-alert bot for Telegram groups. Every buy of ${sym} shows up in your chat with amount, market cap and chart link. Great for community hype.\n`
    + `Setup takes 30 seconds: add @${bot} to your group and send\n/setup ${l.token}\n`
    + `For early projects I'm giving 1 month of Pro free (no ads, custom GIF, whale alerts). Want it?`;
}

// Reads the public t.me preview: is it a group, a channel or a person, and how many members.
export async function tgInfo(url) {
  const m = String(url).match(/(?:t|telegram)\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/?(?:\?.*)?$/);
  if (!m) return { link: url, kind: 'invite', members: 0 };
  const name = m[1];
  let html = '';
  try { html = await (await fetch(`https://t.me/${name}`)).text(); } catch { return { link: `https://t.me/${name}`, kind: 'unknown', members: 0 }; }
  const extra = (html.match(/tgme_page_extra">\s*([^<]+)</) || [])[1] || '';
  const n = extra.match(/([\d][\d\s,]*)\s+(members|subscribers)/);
  const members = n ? +n[1].replace(/[\s,]/g, '') : 0;
  const kind = /members/.test(extra) ? 'group' : /subscribers/.test(extra) ? 'channel' : /tgme_page_title/.test(html) ? 'person' : 'unknown';
  // A channel often links its chat in the description.
  let chat = null;
  if (kind === 'channel') {
    const desc = (html.match(/tgme_page_description[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    const other = [...desc.matchAll(/(?:t|telegram)\.me\/([A-Za-z0-9_]{4,})/g)].map(x => x[1]).find(x => x.toLowerCase() !== name.toLowerCase());
    if (other) chat = `https://t.me/${other}`;
  }
  return { link: `https://t.me/${name}`, kind, members, chat };
}

export function createLeads({ db, tg, cfg, log = console.log, me }) {
  db.raw.exec('CREATE TABLE IF NOT EXISTS leads (key TEXT PRIMARY KEY, symbol TEXT, link TEXT, sent INTEGER)');

  async function candidates() {
    const lists = await Promise.all([
      `${DS}/token-profiles/latest/v1`, `${DS}/token-profiles/recent-updates/v1`, `${DS}/community-takeovers/latest/v1`,
      `${DS}/token-boosts/latest/v1`, `${DS}/token-boosts/top/v1`
    ].map(u => getJson(u).catch(e => { log('leads source', e.message); return []; })));
    const tracked = new Set(db.all('SELECT token FROM groups WHERE token IS NOT NULL').map(r => r.token.toLowerCase()));
    const seen = new Set(db.all('SELECT key FROM leads').map(r => r.key));
    const items = new Map();
    for (const list of lists) for (const t of Array.isArray(list) ? list : []) {
      if (!CHAINS[t.chainId] || !t.tokenAddress) continue;
      const key = `${t.chainId}:${t.tokenAddress}`;
      if (items.has(key) || seen.has(key) || tracked.has(t.tokenAddress.toLowerCase())) continue;
      const tgLink = (t.links || []).find(l => l.type === 'telegram' || /(?:t|telegram)\.me\//.test(l.url || ''));
      if (tgLink) items.set(key, { key, net: t.chainId, token: t.tokenAddress, telegram: tgLink.url });
    }
    const byNet = {};
    for (const it of items.values()) (byNet[it.net] ||= []).push(it);
    for (const [net, arr] of Object.entries(byNet)) {
      for (let i = 0; i < arr.length; i += 30) {
        const chunk = arr.slice(i, i + 30);
        let pairs = [];
        try { pairs = await getJson(`${DS}/tokens/v1/${net}/${chunk.map(c => c.token).join(',')}`); } catch (e) { log('leads market', e.message); }
        for (const c of chunk) {
          const p = (pairs || []).filter(x => x.baseToken?.address === c.token).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
          if (p) Object.assign(c, { symbol: p.baseToken.symbol, mcap: p.marketCap || p.fdv || 0, vol: p.volume?.h24 || 0, liq: p.liquidity?.usd || 0, buys: p.txns?.h24?.buys || 0 });
        }
      }
    }
    // Small-to-mid projects with real trading: they want hype tools and often have no buy bot yet.
    return [...items.values()]
      .filter(c => c.symbol && c.mcap >= 30e3 && c.mcap <= 50e6 && c.vol >= 5e3 && c.liq >= 5e3)
      .sort((a, b) => b.buys - a.buys);
  }

  async function find(limit = PER_BATCH) {
    const out = [];
    for (const c of await candidates()) {
      const info = await tgInfo(c.telegram);
      await sleep(400);
      if (info.kind === 'channel' && info.chat) {
        const chat = await tgInfo(info.chat);
        if (chat.kind === 'group') Object.assign(info, { link: chat.link, kind: 'group', members: chat.members });
      }
      if (info.kind === 'unknown') continue;
      out.push({ ...c, ...info });
      if (out.length >= limit) break;
    }
    return out;
  }

  const KIND = { group: '👥 group', channel: '📢 channel (find its chat in the description)', person: '👤 person (likely the dev, DM directly)', invite: '🔒 invite link' };

  async function send(to = cfg.adminIds) {
    let list;
    try { list = await find(); } catch (e) { log('leads', e.message); list = []; }
    if (!list.length) {
      for (const id of to) await tg.send(id, '🎯 No new leads right now. Try /leads again in a few hours.').catch(() => {});
      return 0;
    }
    const head = `🎯 <b>${list.length} new leads</b>\n\n`
      + `For each one:\n1. Open the link and join\n2. If there is <b>no buy bot</b> yet, find the owner/admin\n3. Tap the message below to copy it and send it to them\n\n`
      + `Max 10–15 DMs a day so the account stays safe.`;
    for (const id of to) await tg.send(id, head).catch(e => log('leads head', id, e.message));
    let i = 0;
    for (const l of list) {
      i++;
      const text = `<b>${i}. $${esc(l.symbol)}</b> · ${CHAINS[l.net]} · mcap ${usd(l.mcap)} · ${l.buys.toLocaleString('en-US')} buys/24h\n`
        + `${KIND[l.kind] || l.kind}${l.members ? ` · ${l.members.toLocaleString('en-US')}` : ''}: ${esc(l.link)}\n\n`
        + `<code>${esc(leadMessage(l, me(), i))}</code>`;
      for (const id of to) await tg.send(id, text).catch(e => log('lead', id, e.message));
      db.run('INSERT OR IGNORE INTO leads (key, symbol, link, sent) VALUES (?, ?, ?, ?)', l.key, l.symbol, l.link, Date.now());
      await sleep(300);
    }
    db.count('leads', list.length);
    return list.length;
  }

  return { find, send };
}
