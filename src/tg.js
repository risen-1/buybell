// Thin Telegram Bot API client: no dependencies, handles flood limits and per-chat pacing.
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createTg(token, log = console.log) {
  const base = `https://api.telegram.org/bot${token}/`;

  async function call(method, params = {}, tries = 3) {
    let j;
    try {
      const res = await fetch(base + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
      j = await res.json();
    } catch (e) {
      if (tries > 1) { await sleep(2000); return call(method, params, tries - 1); }
      throw e;
    }
    if (j.ok) return j.result;
    if (j.error_code === 429 && tries > 1) {
      await sleep(((j.parameters?.retry_after) || 1) * 1000 + 250);
      return call(method, params, tries - 1);
    }
    const err = new Error(`${method}: ${j.description}`);
    err.code = j.error_code;
    err.migrateTo = j.parameters?.migrate_to_chat_id;
    throw err;
  }

  const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

  // Groups allow ~20 messages/minute; alerts are paced per chat so bursts never get the bot muted.
  const queues = new Map();
  function enqueue(chatId, job) {
    let q = queues.get(chatId);
    if (!q) { q = { jobs: [], running: false }; queues.set(chatId, q); }
    if (q.jobs.length >= 25) q.jobs.shift();
    q.jobs.push(job);
    if (!q.running) drain(chatId, q);
  }
  async function drain(chatId, q) {
    q.running = true;
    while (q.jobs.length) {
      const job = q.jobs.shift();
      try { await job(); } catch (e) { log('send failed', chatId, e.message); }
      await sleep(3100);
    }
    q.running = false;
  }

  return {
    call,
    send: (chat_id, text, extra = {}) => call('sendMessage', { chat_id, text, ...html, ...extra }),
    edit: (chat_id, message_id, text, extra = {}) => call('editMessageText', { chat_id, message_id, text, ...html, ...extra }).catch(e => { if (!/not modified/.test(e.message)) throw e; }),
    answer: (id, text = '', alert = false) => call('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => {}),
    sendMedia(chat_id, type, file_id, caption, extra = {}) {
      const method = type === 'photo' ? 'sendPhoto' : type === 'video' ? 'sendVideo' : 'sendAnimation';
      const key = type === 'photo' ? 'photo' : type === 'video' ? 'video' : 'animation';
      return call(method, { chat_id, [key]: file_id, caption, parse_mode: 'HTML', ...extra });
    },
    enqueue,
    async isAdmin(chatId, userId) {
      try {
        const m = await call('getChatMember', { chat_id: chatId, user_id: userId });
        return m.status === 'creator' || m.status === 'administrator';
      } catch (e) { return false; }
    },
    async *updates() {
      let offset = 0;
      for (;;) {
        try {
          const list = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
          for (const u of list) { offset = u.update_id + 1; yield u; }
        } catch (e) {
          log('getUpdates error', e.message);
          await sleep(5000);
        }
      }
    }
  };
}
