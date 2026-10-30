#!/usr/bin/env bash
# BuyBell installer for a fresh Ubuntu/Debian server.
#   curl -fsSL https://raw.githubusercontent.com/<you>/buybell/main/scripts/install.sh | sudo BUYBELL_REPO=https://github.com/<you>/buybell.git bash
set -euo pipefail

REPO="${BUYBELL_REPO:-}"
DIR=/opt/buybell

if [ "$(id -u)" != "0" ]; then echo "Please run as root (put sudo in front)."; exit 1; fi
if [ -z "$REPO" ] && [ ! -d "$DIR/.git" ]; then echo "Set BUYBELL_REPO to your GitHub repository URL."; exit 1; fi

echo "==> Installing system packages"
apt-get update -y -qq
apt-get install -y -qq curl git ca-certificates sqlite3 >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Getting BuyBell"
# The checkout is owned by the buybell user; let root run git in it (install, update).
git config --global --get-all safe.directory | grep -qx "$DIR" || git config --global --add safe.directory "$DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
id -u buybell >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin buybell
mkdir -p "$DIR/data"

getenv() { grep "^$1=" "$DIR/.env" | head -1 | cut -d= -f2- || true; }
setenv() { { grep -v "^$1=" "$DIR/.env" || true; printf '%s=%s\n' "$1" "$2"; } > "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env"; }

# ask_valid NAME PROMPT REGEX required|optional [secret]
# Re-asks until the answer looks right. Strips spaces/CR that terminals add on paste.
# Enter keeps the current value. Secret input stays hidden (never in screenshots).
ask_valid() {
  local cur v; cur="$(getenv "$1")"
  while :; do
    if [ -n "${5:-}" ]; then read -r -s -p "$2" v < /dev/tty || true; echo >&2; else read -r -p "$2" v < /dev/tty || true; fi
    v="$(printf '%s' "$v" | tr -d '[:space:]')"
    [ -z "$v" ] && v="$cur"
    if [ -z "$v" ] && [ "$4" = optional ]; then echo "   - skipped (you can add it later with: buybell config)" >&2; break; fi
    if [ -n "$v" ] && [[ "$v" =~ $3 ]]; then
      if [ -n "${5:-}" ]; then echo "   ✓ saved (bot id ${v%%:*})" >&2; else echo "   ✓ saved" >&2; fi
      break
    fi
    echo "   ✗ That doesn't look right. Please copy it again and paste with a right-click." >&2
  done
  setenv "$1" "$v"
}

configure() {
  [ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
  echo
  echo "==> Settings (paste with a right-click, then press Enter)"
  ask_valid BOT_TOKEN 'Bot token from @BotFather (stays hidden): ' '^[0-9]+:[A-Za-z0-9_-]{30,}$' required secret
  ask_valid OWNER_ID 'Your Telegram numeric id (from @userinfobot): ' '^[0-9]{5,}$' required
  ask_valid WALLET_TRC20 'USDT TRC20 receiving address (starts with T, Enter to skip): ' '^T[1-9A-HJ-NP-Za-km-z]{33}$' optional
  ask_valid WALLET_TON 'TON receiving address (starts with UQ, Enter to skip): ' '^(UQ|EQ)[A-Za-z0-9_-]{46}$' optional
  chmod 600 "$DIR/.env"
}
if [ ! -f "$DIR/.env" ] || [ "${1:-}" = "--configure" ]; then configure; fi
chown -R buybell:buybell "$DIR"

echo "==> Creating service"
cat > /etc/systemd/system/buybell.service <<EOF
[Unit]
Description=BuyBell Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
User=buybell
WorkingDirectory=$DIR
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Daily database backup, one file per weekday (7 rolling copies).
cat > /etc/cron.d/buybell-backup <<EOF
15 3 * * * buybell sqlite3 $DIR/data/buybell.db ".backup $DIR/data/backup-\$(date +\%u).db"
EOF

# Helper command: buybell status | logs | restart | update | config
cat > /usr/local/bin/buybell <<'EOF'
#!/usr/bin/env bash
case "${1:-status}" in
  status)  systemctl status buybell --no-pager ;;
  logs)    journalctl -u buybell -f -n 100 ;;
  restart) systemctl restart buybell && echo "restarted" ;;
  update)  git -C /opt/buybell pull && chown -R buybell:buybell /opt/buybell && systemctl restart buybell && echo "updated" ;;
  config)  nano /opt/buybell/.env && systemctl restart buybell ;;
  *)       echo "usage: buybell status|logs|restart|update|config" ;;
esac
EOF
chmod +x /usr/local/bin/buybell

systemctl daemon-reload
systemctl enable -q buybell
systemctl restart buybell
sleep 4
echo
if systemctl is-active -q buybell; then
  echo "✅ BuyBell is running."
  journalctl -u buybell -n 5 --no-pager -o cat
else
  echo "❌ BuyBell did not start. Recent log:"
  journalctl -u buybell -n 20 --no-pager -o cat
fi
echo
echo "Commands: buybell status | buybell logs | buybell restart | buybell update | buybell config"
