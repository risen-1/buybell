import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader: KEY=VALUE lines, # comments. Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

export const cfg = {
  token: process.env.BOT_TOKEN || '',
  ownerId: num('OWNER_ID', 0),
  // Owner plus extra admins (ADMIN_IDS=id1,id2): all can run admin commands and get notifications.
  adminIds: [...new Set([process.env.OWNER_ID, ...(process.env.ADMIN_IDS || '').split(',')].map(Number).filter(n => n > 0))],
  wallets: { trc20: process.env.WALLET_TRC20 || '', ton: process.env.WALLET_TON || '' },
  proMonth: num('PRO_PRICE_MONTH', 29),
  proYear: num('PRO_PRICE_YEAR', 290),
  adPrices: { 1: num('AD_PRICE_1D', 15), 3: num('AD_PRICE_3D', 39), 7: num('AD_PRICE_7D', 79) },
  refPercent: num('REF_PERCENT', 20),
  geckoRpm: Math.min(30, num('GECKO_RPM', 25)),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'data/buybell.db')
};

export const payEnabled = () => !!(cfg.wallets.trc20 || cfg.wallets.ton);
