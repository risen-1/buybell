// Crypto invoices paid straight into the owner's wallets. The server never holds keys:
// it only reads the public blockchain to see whether a payment arrived.
//   USDT on TRON: each pending invoice gets a unique amount (extra 4 decimals) → exact match.
//   TON: the payment comment carries the invoice code; the amount must cover the quote.
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXPIRE = 24 * 3600000;

const b64ToHex = b64 => Buffer.from(b64, 'base64').toString('hex');

export function createPayments({ db, cfg, onPaid, log = console.log }) {
  async function tonPrice() {
    const j = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd').then(r => r.json());
    const p = j['the-open-network']?.usd;
    if (!p) throw new Error('TON price unavailable');
    return p;
  }

  function nonce() {
    const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    return 'BB' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => abc[b % abc.length]).join('');
  }

  async function create({ kind, ref, userId, usd, net }) {
    const user = db.get('SELECT ref_by FROM users WHERE id = ?', userId);
    const code = nonce();
    let amount, nano = null;
    if (net === 'trc20') {
      const taken = new Set(db.all("SELECT amount FROM invoices WHERE status = 'pending' AND net = 'trc20'").map(r => r.amount));
      do { amount = (usd + (1 + Math.floor(Math.random() * 9998)) / 10000).toFixed(4); } while (taken.has(amount));
    } else {
      const price = await tonPrice();
      const ton = Math.ceil(usd / price * 100) / 100;
      amount = ton.toFixed(2);
      nano = String(Math.round(ton * 1e9));
    }
    const commission = user?.ref_by ? Math.round(usd * cfg.refPercent) / 100 : 0;
    const r = db.run(`INSERT INTO invoices (kind, ref, user_id, usd, net, amount, nano, nonce, status, created, ref_by, commission)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`, kind, String(ref), userId, usd, net, amount, nano, code, Date.now(), user?.ref_by || null, commission);
    return db.get('SELECT * FROM invoices WHERE id = ?', r.lastInsertRowid);
  }

  async function checkTrc20(list) {
    const since = Math.min(...list.map(i => i.created)) - 10 * 60000;
    const j = await fetch(`https://api.trongrid.io/v1/accounts/${cfg.wallets.trc20}/transactions/trc20?only_to=true&limit=200&contract_address=${USDT_TRON}&min_timestamp=${since}`).then(r => r.json());
    const rows = (j.data || []).filter(r => r.to === cfg.wallets.trc20);
    for (const inv of list) {
      const want = Math.round(parseFloat(inv.amount) * 1e6);
      const hit = rows.find(r => +r.value === want && r.block_timestamp >= inv.created - 60000);
      if (hit) await markPaid(inv, hit.transaction_id);
    }
  }

  async function checkTon(list) {
    const since = Math.floor((Math.min(...list.map(i => i.created)) - 10 * 60000) / 1000);
    const j = await fetch(`https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(cfg.wallets.ton)}&limit=100&sort=desc&start_utime=${since}`).then(r => r.json());
    for (const inv of list) {
      for (const t of j.transactions || []) {
        const comment = (t.in_msg?.message_content?.decoded?.comment || '').toUpperCase();
        if (!comment.includes(inv.nonce)) continue;
        if (BigInt(t.in_msg.value || 0) * 100n >= BigInt(inv.nano) * 98n) { await markPaid(inv, b64ToHex(t.hash)); break; }
      }
    }
  }

  async function markPaid(inv, tx) {
    // The status guard makes this idempotent even if two checks overlap.
    const r = db.run("UPDATE invoices SET status = 'paid', tx = ?, paid_at = ? WHERE id = ? AND status = 'pending'", tx, Date.now(), inv.id);
    if (!r.changes) return;
    log('invoice paid', inv.id, inv.kind, inv.usd, tx);
    try { await onPaid(db.get('SELECT * FROM invoices WHERE id = ?', inv.id)); } catch (e) { log('onPaid error', e.message); }
  }

  async function checkAll() {
    db.run("UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND created < ?", Date.now() - EXPIRE);
    const pending = db.all("SELECT * FROM invoices WHERE status = 'pending'");
    const trc = pending.filter(i => i.net === 'trc20'), ton = pending.filter(i => i.net === 'ton');
    if (trc.length && cfg.wallets.trc20) await checkTrc20(trc).catch(e => log('trc20 check', e.message));
    if (ton.length && cfg.wallets.ton) await checkTon(ton).catch(e => log('ton check', e.message));
  }

  return {
    create, checkAll,
    async run() {
      for (;;) {
        await checkAll();
        await sleep(20000);
      }
    }
  };
}
