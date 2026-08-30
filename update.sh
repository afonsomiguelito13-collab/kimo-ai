#!/data/data/com.termux/files/usr/bin/bash
#
# Kimo — updater.
#
# Replaces ~/kimo with the latest build. Your .env (API key) and any
# chats stored in the browser are kept.
#
#   bash update.sh
#
# Safety: the new copy is downloaded and verified BEFORE anything is deleted,
# so a failed download leaves your working install untouched.

set -u

# O paste.rs passou a rejeitar uploads acima de ~64 KB, então o build é
# publicado em partes e remontado aqui. XKIRO_URL continua funcionando para
# forçar uma origem única.
PARTS="https://paste.rs/yG5C5 https://paste.rs/OiCqe https://paste.rs/BIn7F https://paste.rs/e0NhX"
URL="${XKIRO_URL:-}"
APP="$HOME/kimo"
STAGE="$HOME/.kimo-stage.$$"
BACKUP="$HOME/.kimo-backup"

G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; D=$'\033[2m'; O=$'\033[0m'
C=$'\033[36m'
ok()   { printf '%s✓%s %s\n' "$G" "$O" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$O" "$*"; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$O"; }

cleanup() { rm -rf "$STAGE" 2>/dev/null; }
trap cleanup EXIT

die() {
  printf '\n%s✗ %s%s\n' "$R" "$*" "$O"
  if [ -d "$BACKUP" ] && [ ! -d "$APP" ]; then
    mv "$BACKUP" "$APP" && warn "restored your previous install — nothing was lost"
  fi
  exit 1
}

printf '\n%s  Kimo · update%s\n' "$B" "$O"

# ------------------------------------------------------- 1. stop it ---------
step "1. Stopping any running server"
# Only kill a node process that is actually THIS app: either it was started
# with the app's full path, or its working directory is the app folder.
# Matching on "node server.js" alone would kill unrelated servers.
killed=0
for pid in $(pgrep -x node 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  [ -d "/proc/$pid" ] || continue

  # argv[0] must really be node, and argv[1] must really be a server.js —
  # never trust a substring match against the whole command line, or we may
  # match this very script (its text mentions "node server.js").
  argv0=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n 1p)
  argv1=$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n 2p)
  [ "$(basename -- "${argv0:-x}" 2>/dev/null)" = "node" ] || continue
  case "$(basename -- "${argv1:-x}" 2>/dev/null)" in server.js) ;; *) continue ;; esac

  # Resolve argv[1] against the process's own cwd, then require it to be ours.
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  case "$argv1" in
    /*) target="$argv1" ;;
     *) target="$cwd/${argv1#./}" ;;
  esac
  [ "$target" = "$APP/server.js" ] || continue

  kill "$pid" 2>/dev/null && killed=$((killed + 1))
done

if [ "$killed" -gt 0 ]; then
  ok "stopped the running copy"
  sleep 1
else
  printf '%s  nothing was running%s\n' "$D" "$O"
fi

# ------------------------------------------------------- 2. download --------
step "2. Downloading the latest build"
mkdir -p "$STAGE" || die "cannot create a staging folder"

command -v curl >/dev/null 2>&1 || pkg install curl -y >/dev/null 2>&1
command -v unzip >/dev/null 2>&1 || pkg install unzip -y >/dev/null 2>&1

if [ -n "$URL" ]; then
  curl -sL --fail --connect-timeout 20 -o "$STAGE/app.b64" "$URL" \
    || die "download failed. Check your connection, or ask for a fresh link."
else
  : > "$STAGE/app.b64"
  n=0
  for u in $PARTS; do
    n=$((n + 1))
    curl -sL --fail --connect-timeout 20 -o "$STAGE/p.$n" "$u" \
      || die "download of part $n failed. Check your connection, or ask for a fresh link."
    cat "$STAGE/p.$n" >> "$STAGE/app.b64"
    rm -f "$STAGE/p.$n"
  done
fi

SIZE=$(wc -c < "$STAGE/app.b64" 2>/dev/null || echo 0)
[ "$SIZE" -gt 10000 ] || die "the download is only ${SIZE} bytes — the link has probably expired. Ask for a new one."

base64 -d "$STAGE/app.b64" > "$STAGE/app.zip" 2>/dev/null \
  || die "could not decode the download — it may be truncated."

# Verify it is a real archive before we touch the existing install.
unzip -tq "$STAGE/app.zip" >/dev/null 2>&1 \
  || die "the downloaded file is not a valid zip. The link may have expired."

unzip -q "$STAGE/app.zip" -d "$STAGE/unpacked" || die "unzip failed"

# Nao assumir o nome da pasta dentro do zip: o app ja se chamou xkiro-chat.
SRC=""
for d in "$STAGE/unpacked"/*/; do
  [ -f "$d/server.js" ] && { SRC="${d%/}"; break; }
done
[ -f "$STAGE/unpacked/server.js" ] && SRC="$STAGE/unpacked"
[ -n "$SRC" ] || die "server.js is missing from the archive — bad build?"

ok "downloaded and verified ($(du -h "$STAGE/app.zip" | cut -f1))"

# The built-in link is a snapshot: it was published before this copy existed,
# so on its own it can only ever fetch an OLDER build. Compare timestamps and
# refuse to go backwards unless the user passed an explicit XKIRO_URL.
NEW_V=$(cat "$SRC/VERSION" 2>/dev/null || echo "")
CUR_V=$(cat "$APP/VERSION" 2>/dev/null || echo "")
if [ -n "$CUR_V" ] && [ -n "$NEW_V" ] && [ -z "${XKIRO_URL:-}" ]; then
  if [ "$NEW_V" = "$CUR_V" ]; then
    printf '\n%s  You are already on the latest build (%s).%s\n' "$D" "$CUR_V" "$O"
    printf '%s  Nothing to do — your install was not touched.%s\n\n' "$D" "$O"
    exit 0
  fi
  # String compare is valid: timestamps are ISO-8601 UTC.
  if [ "$NEW_V" \< "$CUR_V" ]; then
    warn "the built-in link points at an OLDER build ($NEW_V < $CUR_V)"
    printf '%s  Refusing to downgrade. Your install was not touched.%s\n' "$D" "$O"
    printf '%s  To force it:  XKIRO_URL="<link>" bash ~/kimo/update.sh%s\n\n' "$D" "$O"
    exit 0
  fi
  ok "new build available ($CUR_V → $NEW_V)"
fi

# ------------------------------------------------------- 3. keep .env -------
step "3. Preserving your settings"
SAVED_ENV=""
if [ -f "$APP/.env" ]; then
  SAVED_ENV="$STAGE/.env.keep"
  cp "$APP/.env" "$SAVED_ENV"
  ok "API key saved"
else
  printf '%s  no .env to keep%s\n' "$D" "$O"
fi

# ------------------------------------------------- 4. swap in the new -------
step "4. Replacing the old version"
rm -rf "$BACKUP"
if [ -d "$APP" ]; then
  mv "$APP" "$BACKUP" || die "could not move the old install aside"
  printf '%s  old version set aside%s\n' "$D" "$O"
fi

mv "$SRC" "$APP" || die "could not install the new version"
ok "new version in place"

[ -n "$SAVED_ENV" ] && cp "$SAVED_ENV" "$APP/.env" && chmod 600 "$APP/.env" && ok "API key restored"

rm -rf "$BACKUP"

# ------------------------------------------------------- 5. shortcut --------
grep -q 'alias chat=' "$HOME/.bashrc" 2>/dev/null \
  || printf '\nalias chat="cd ~/kimo && node server.js"\n' >> "$HOME/.bashrc"
grep -q 'alias kimo-update=' "$HOME/.bashrc" 2>/dev/null \
  || printf 'alias kimo-update="bash ~/kimo/update.sh"\n' >> "$HOME/.bashrc"

# ------------------------------------------------------- 6. start -----------
step "Updated."
printf '\n  Open %s%shttp://localhost:3000%s\n' "$B" "$C" "$O"
printf '%s  Ctrl+C stops it · type "chat" to start it later%s\n' "$D" "$O"
printf '%s  update again any time with: kimo-update%s\n\n' "$D" "$O"
sleep 1

cd "$APP" || die "cannot enter $APP"
exec node server.js
