#!/data/data/com.termux/files/usr/bin/bash
#
# Finds xkiro-chat.zip anywhere on your phone and sets it up.
#
#   bash find-zip.sh
#
# Handles the usual mess: the file landing in /sdcard/Download instead of
# ~/storage/downloads, storage permission not granted yet, browser renaming
# the file to xkiro-chat(1).zip, and so on.

set -u
G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; D=$'\033[2m'; O=$'\033[0m'

echo ""
echo "${B}Looking for xkiro-chat.zip…${O}"
echo ""

# 1. Storage permission -------------------------------------------------------
if [ ! -d "$HOME/storage" ]; then
  echo "${Y}Storage access isn't set up yet.${O}"
  echo "A permission dialog will appear — tap ${B}ALLOW${O}."
  echo ""
  read -r -p "Press Enter to continue… " _
  termux-setup-storage
  sleep 3
fi

# 2. Hunt for the zip ---------------------------------------------------------
SEARCH_DIRS=""
for d in \
  "$HOME/storage/downloads" \
  "$HOME/storage/shared/Download" \
  "$HOME/storage/shared/Downloads" \
  "$HOME/storage/shared" \
  "/sdcard/Download" \
  "/sdcard/Downloads" \
  "/sdcard" \
  "/storage/emulated/0/Download" \
  "/storage/emulated/0" \
  "$HOME"
do
  [ -d "$d" ] && SEARCH_DIRS="$SEARCH_DIRS $d"
done

if [ -z "$SEARCH_DIRS" ]; then
  echo "${R}No readable storage found at all.${O}"
  echo "Run: ${B}termux-setup-storage${O}  (and tap Allow), then try again."
  exit 1
fi

echo "${D}searching…${O}"
ZIP=""
# shellcheck disable=SC2086
for d in $SEARCH_DIRS; do
  found="$(find "$d" -maxdepth 3 -iname 'xkiro*chat*.zip' -print 2>/dev/null | head -1)"
  if [ -n "$found" ]; then ZIP="$found"; break; fi
done

if [ -z "$ZIP" ]; then
  echo ""
  echo "${R}Couldn't find it.${O}"
  echo ""
  echo "The zip has to be ${B}downloaded to your phone${O} first — it lives in"
  echo "the chat workspace, not on your device yet."
  echo ""
  echo "  1. Go back to the chat"
  echo "  2. Tap ${B}xkiro-chat.zip${O} in the file viewer"
  echo "  3. Tap download / save"
  echo "  4. Run this script again"
  echo ""
  echo "${D}Already downloaded it? Find it yourself with:${O}"
  echo "  find /sdcard /storage/emulated/0 -iname '*xkiro*' 2>/dev/null"
  echo ""
  exit 1
fi

echo "${G}✓${O} found: $ZIP"
echo ""

# 3. Unpack into the home directory (never onto FUSE storage) -----------------
cd "$HOME" || exit 1

if [ -d "$HOME/xkiro-chat" ]; then
  echo "${Y}~/xkiro-chat already exists.${O}"
  printf "Replace it? Your .env is kept. [y/N] "
  read -r ans
  case "$ans" in
    [yY]*)
      [ -f "$HOME/xkiro-chat/.env" ] && cp "$HOME/xkiro-chat/.env" "$HOME/.xkiro-env.bak"
      rm -rf "$HOME/xkiro-chat"
      ;;
    *) echo "Keeping it. Run: cd ~/xkiro-chat && node server.js"; exit 0 ;;
  esac
fi

command -v unzip >/dev/null 2>&1 || pkg install unzip -y >/dev/null 2>&1

unzip -q -o "$ZIP" || { echo "${R}unzip failed — the download may be incomplete.${O}"; exit 1; }

# Some browsers wrap the contents in an extra folder; normalise that.
if [ ! -f "$HOME/xkiro-chat/server.js" ]; then
  inner="$(find "$HOME" -maxdepth 3 -name server.js -path '*xkiro*' -print 2>/dev/null | head -1)"
  if [ -n "$inner" ]; then
    src="$(dirname "$inner")"
    [ "$src" != "$HOME/xkiro-chat" ] && rm -rf "$HOME/xkiro-chat" && mv "$src" "$HOME/xkiro-chat"
  fi
fi

[ -f "$HOME/xkiro-chat/server.js" ] || { echo "${R}server.js missing after unpack.${O}"; exit 1; }
[ -f "$HOME/.xkiro-env.bak" ] && mv "$HOME/.xkiro-env.bak" "$HOME/xkiro-chat/.env"

echo "${G}✓${O} unpacked to ~/xkiro-chat"

# 4. Node ---------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "${D}installing Node…${O}"
  pkg install nodejs -y >/dev/null 2>&1
fi
command -v node >/dev/null 2>&1 || { echo "${R}Node missing. Run: pkg install nodejs${O}"; exit 1; }
echo "${G}✓${O} node $(node -v)"

# 5. Shortcut -----------------------------------------------------------------
grep -q 'alias chat=' "$HOME/.bashrc" 2>/dev/null || \
  printf '\nalias chat="cd ~/xkiro-chat && node server.js"\n' >> "$HOME/.bashrc"

echo ""
echo "${B}Starting…${O}  open ${B}http://localhost:3000${O} in your browser"
echo "${D}Ctrl+C stops it. Next time just type: chat${O}"
echo ""
sleep 1

cd "$HOME/xkiro-chat" && exec node server.js
