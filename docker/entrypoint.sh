#!/bin/sh
set -eu

CHROME_UID="${CHROME_UID:-1100}"
CHROME_GID="${CHROME_GID:-1100}"
TALLYLAMP_DATA_DIR="${TALLYLAMP_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$TALLYLAMP_DATA_DIR" /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix || true
  cur="$(stat -c %u "$TALLYLAMP_DATA_DIR" 2>/dev/null || echo "")"
  if [ "$cur" != "$CHROME_UID" ]; then
    echo "entrypoint: chowning $TALLYLAMP_DATA_DIR to $CHROME_UID:$CHROME_GID" >&2
    chown -R "$CHROME_UID:$CHROME_GID" "$TALLYLAMP_DATA_DIR" || true
  fi
  exec setpriv --reuid="$CHROME_UID" --regid="$CHROME_GID" --init-groups -- "$0" "$@"
fi

export HOME=/home/tallylamp
export TALLYLAMP_DATA_DIR
export TALLYLAMP_XVFB="${TALLYLAMP_XVFB:-1}"

if [ -z "${ADMIN_SECRET:-}" ] && [ -f "$TALLYLAMP_DATA_DIR/admin.secret" ]; then
  ADMIN_SECRET="$(cat "$TALLYLAMP_DATA_DIR/admin.secret")"
  export ADMIN_SECRET
fi

exec node /app/dist/index.js
