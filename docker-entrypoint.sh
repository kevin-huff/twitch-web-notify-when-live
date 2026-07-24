#!/bin/sh
set -e

DATA_DIR="$(dirname "${DB_PATH:-/data/notify.db}")"

# Volume hosts (Railway included) mount the data dir owned by root.
# Fix ownership, then drop to the unprivileged user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
