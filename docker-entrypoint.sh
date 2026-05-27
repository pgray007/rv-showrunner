#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_ROOT:-/config}"
PROFILES_DIR="$CONFIG_DIR/profiles"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
LEGACY_CONFIG_FILE="$CONFIG_DIR/config.json"

if [ ! -d "$PROFILES_DIR" ]; then
  echo "[rv-showrunner] First boot: copying default profiles to $PROFILES_DIR"
  mkdir -p "$PROFILES_DIR"
  cp /app/profiles/*.yaml "$PROFILES_DIR/"
fi

mkdir -p "$CONFIG_DIR" "${OUTPUT_ROOT:-/rv-ready}" "${CACHE_ROOT:-/cache}"

if [ ! -f "$SETTINGS_FILE" ] && [ -f "$LEGACY_CONFIG_FILE" ]; then
  echo "[rv-showrunner] Migrating legacy config.json to settings.json"
  cp "$LEGACY_CONFIG_FILE" "$SETTINGS_FILE"
fi

exec "$@"
