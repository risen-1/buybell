// Rotates active paid ads under alerts in free groups; impressions are buffered and flushed once a minute.
export function createAds(db) {
  let cache = [], loaded = 0, turn = 0;
  const pending = new Map();

  function active() {
    if (Date.now() - loaded > 30000) {
      db.run("UPDATE ads SET status = 'expired' WHERE status = 'active' AND ends < ?", Date.now());
      cache = db.all("SELECT id, text, url FROM ads WHERE status = 'active' AND starts <= ? AND ends > ?", Date.now(), Date.now());
      loaded = Date.now();
    }
    return cache;
  }

  setInterval(() => {
    for (const [id, n] of pending) db.run('UPDATE ads SET impressions = impressions + ? WHERE id = ?', n, id);
    pending.clear();
  }, 60000).unref();

  return {
    pick() {
      const list = active();
      if (!list.length) return null;
      const ad = list[turn++ % list.length];
      pending.set(ad.id, (pending.get(ad.id) || 0) + 1);
      return ad;
    },
    refresh() { loaded = 0; }
  };
}
