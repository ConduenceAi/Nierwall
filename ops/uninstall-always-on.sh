#!/bin/sh
set -e
for name in brain memory menubar; do
  launchctl bootout "gui/$(id -u)/app.guardian.$name" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/app.guardian.$name.plist"
  echo "removed app.guardian.$name"
done
