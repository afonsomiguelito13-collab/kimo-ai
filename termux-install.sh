#!/data/data/com.termux/files/usr/bin/bash
#
# xKiro Chat — one-shot Termux installer.
#
#   bash ~/storage/downloads/termux-install.sh
#
# Installs Node if missing, finds the zip in your Downloads, unpacks it into
# ~/xkiro-chat, optionally saves your API key, and starts the server.

set -u

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'
RED=$'\033[31m'; CYA=$'\033[36m'; OFF=$'\033[0m'

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$OFF"; exit 1; }
step() { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }

say ""
say "${CYA}  ╭──────────────────────────────╮${OFF}"
say "${CYA}  │${OFF}  ${BOLD}xKiro Chat${OFF} · Termux setup  ${CYA}│${OFF}"
say "${CYA}  ╰──────────────────────────────╯${OFF}"

# ---------------------------------------------------------------- node ------
step "1. Node.js"
if command -v node >/dev/null 2>&1; then
  ok "already installed ($(node -v))"
else
  say "${DIM}installing…${OFF}"
  pkg install nodejs -y >/dev/null 2>&1 || die "pkg install nodejs failed. Run: pkg update && pkg install nodejs"
  command -v node >/dev/null 2>&1 || die "node still not on PATH after install"
  ok "installed ($(node -v))"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18+ required, found $(node -v). Try: pkg upgrade nodejs"

command -v unzip >/dev/null 2>&1 || {
  say "${DIM}installing unzip…${OFF}"
  pkg install unzip -y >/dev/null 2>&1 || die "could not install unzip"
}
ok "unzip present"

# ------------------------------------------------------------- storage -----
step "2. Storage access"
if [ -d "$HOME/storage/downloads" ]; then
  ok "granted"
else
  warn "not set up — a permission dialog will appear, tap ALLOW"
  termux-setup-storage
  sleep 3
  [ -d "$HOME/storage/downloads" ] || die "still no access. Run 'termux-setup-storage' and tap Allow, then re-run this."
  ok "granted"
fi

# ----------------------------------------------------------------- zip -----
step "3. Locating xkiro-chat.zip"
ZIP=""
for c in "$HOME/storage/downloads/xkiro-chat.zip" "$HOME/xkiro-chat.zip" "$PWD/xkiro-chat.zip"; do
  [ -f "$c" ] && { ZIP="$c"; break; }
done
if [ -z "$ZIP" ]; then
  say "${DIM}searching shared storage…${OFF}"
  ZIP="$(find "$HOME/storage/shared" -iname 'xkiro-chat*.zip' -print -quit 2>/dev/null || true)"
fi
[ -n "$ZIP" ] || die "xkiro-chat.zip not found. Download it, then re-run. Searched Downloads and shared storage."
ok "found: $ZIP"

# --------------------------------------------------------------- unpack ----
step "4. Unpacking to ~/xkiro-chat"
if [ -d "$HOME/xkiro-chat" ]; then
  warn "~/xkiro-chat already exists"
  printf '  Replace it? Your .env is kept. [y/N] '
  read -r ans
  case "$ans" in
    [yY]*)
      [ -f "$HOME/xkiro-chat/.env" ] && cp "$HOME/xkiro-chat/.env" "$HOME/.xkiro-env.bak"
      rm -rf "$HOME/xkiro-chat"
      ;;
    *) say "  keeping what's there" ;;
  esac
fi

if [ ! -d "$HOME/xkiro-chat" ]; then
  cd "$HOME" || die "cannot cd to home"
  unzip -q "$ZIP" || die "unzip failed — the download may be incomplete"
  [ -f "$HOME/.xkiro-env.bak" ] && mv "$HOME/.xkiro-env.bak" "$HOME/xkiro-chat/.env" && ok "restored your .env"
fi
[ -f "$HOME/xkiro-chat/server.js" ] || die "server.js missing after unpack — bad zip?"
ok "unpacked"

# ------------------------------------------------------------------ key ----
step "5. API key"
cd "$HOME/xkiro-chat" || die "cannot enter ~/xkiro-chat"
if [ -f .env ] && grep -q 'sk-xt-' .env 2>/dev/null; then
  ok "already saved in .env"
else
  say "${DIM}Paste your key (starts with sk-xt-), or press Enter to skip${OFF}"
  say "${DIM}and add it in the app's Settings instead.${OFF}"
  printf '  key: '
  read -r KEY
  if [ -n "$KEY" ]; then
    case "$KEY" in
      sk-*) printf 'XKIRO_API_KEY=%s\n' "$KEY" > .env; chmod 600 .env; ok "saved to .env" ;;
      *)    warn "that doesn't look like an xKiro key — skipping. Use Settings in the app." ;;
    esac
  else
    say "  skipped — add it in Settings"
  fi
fi

# -------------------------------------------------------------- shortcut ---
step "6. Shortcut"
if grep -q 'alias chat=' "$HOME/.bashrc" 2>/dev/null; then
  ok "'chat' already set up"
else
  printf '\nalias chat="cd ~/xkiro-chat && node server.js"\n' >> "$HOME/.bashrc"
  ok "type 'chat' to start it next time (new session, or run: source ~/.bashrc)"
fi

# ----------------------------------------------------------------- start ---
step "Starting the server"
say ""
say "  Open your browser at ${BOLD}${CYA}http://localhost:3000${OFF}"
say "  ${DIM}Stop with Ctrl+C. Restart any time by typing: chat${OFF}"
say ""
sleep 1
exec node server.js
