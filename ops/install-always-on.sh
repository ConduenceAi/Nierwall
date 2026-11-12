#!/bin/sh
# Installs launchd agents so the brain, memory service and menu-bar app start at login and restart if they crash.
# Undo with: ops/uninstall-always-on.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$HOME/Library/Logs/Guardian"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$LOGS" "$AGENTS"
for name in brain memory menubar; do
  src="$ROOT/ops/launchd/app.guardian.$name.plist"
  dst="$AGENTS/app.guardian.$name.plist"
  sed -e "s#__ROOT__#$ROOT#g" -e "s#__LOGS__#$LOGS#g" "$src" > "$dst"
  launchctl bootout "gui/$(id -u)/app.guardian.$name" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  echo "loaded app.guardian.$name"
done
echo "Logs: $LOGS. Keep the Mac plugged in and set it not to sleep (System Settings > Battery > Options)."
