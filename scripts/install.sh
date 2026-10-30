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
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
id -u buybell >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin buybell
mkdir -p "$DIR/data"

ask() { local v; read -r -p "$1" v < /dev/tty; echo "$v"; }
# Hidden input for secrets, so the token never shows on screen or in screenshots.
ask_secret() { local v; read -r -s -p "$1" v < /dev/tty; echo " (hidden, saved)" >&2; echo "$v"; }
setenv() { if grep -q "^$1=" "$DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$DIR/.env"; else echo "$1=$2" >> "$DIR/.env"; fi; }

configure() {
  [ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
  echo
  echo "==> Settings (press Enter to keep a value empty)"
  setenv BOT_TOKEN "$(ask_secret 'Bot token from @BotFather (paste it, it stays hidden): ')"
  setenv OWNER_ID "$(ask 'Your Telegram numeric id (from @userinfobot): ')"
  setenv WALLET_TRC20 "$(ask 'Your USDT TRC20 receiving address (starts with T): ')"
  setenv WALLET_TON "$(ask 'Your TON receiving address (starts with UQ): ')"
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
