#!/bin/sh
# Checks the voice conversation's turn-taking (when you've finished, when you talk over the orb) with
# scripted audio levels and transcripts. No microphone needed.
set -e
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)/turn-taking"
swiftc -O Sources/Guardian/Conversation.swift Checks/main.swift -o "$OUT"
"$OUT"
