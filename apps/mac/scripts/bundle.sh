#!/bin/sh
# Builds Nierwall.app from the Swift package. Ad-hoc signed for running on this Mac.
# For distribution: sign with a Developer ID, enable Hardened Runtime, and notarize.
set -e
cd "$(dirname "$0")/.."
swift build -c release
APP=build/Nierwall.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Guardian "$APP/Contents/MacOS/Guardian"
cp Resources/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP" >/dev/null
echo "Built $(pwd)/$APP"
