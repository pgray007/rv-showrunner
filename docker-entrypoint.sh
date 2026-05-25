#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_ROOT:-/config}"
PROFILES_DIR="$CONFIG_DIR/profiles"

if [ ! -d "$PROFILES_DIR" ]; then
  echo "[rv-showrunner] First boot: copying default profiles to $PROFILES_DIR"
  mkdir -p "$PROFILES_DIR"
  cp /app/profiles/*.yaml "$PROFILES_DIR/"
fi

mkdir -p "$CONFIG_DIR" "${OUTPUT_ROOT:-/rv-ready}" "${CACHE_ROOT:-/cache}"

exec "$@"
