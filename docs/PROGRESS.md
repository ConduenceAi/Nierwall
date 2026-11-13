# Progress

Last updated: 2026-11-13 (afternoon, IST). Deadline: 2026-11-14 23:59 UTC. Judging 16 Nov, results 18 Nov.

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | Repo scaffold, config templates | Done | pnpm workspace, `.env.example`, wallet template, MIT license |
| 2 | Brain core: prices, Aave + Rhea readers | Done, live-tested | Rhea health matches the Rhea SDK exactly; Aave matches the protocol within 2% |
| 3 | Watch engine, scheduler, scenario mode, `pnpm demo`, `pnpm simulate` | Done, live-tested | 6 watch types; incidents open, escalate, remind, resolve, snooze; checks every 20 s near a limit, 60 s otherwise |
| 4 | Local API + WebSocket, Telegram bot | API done, Telegram untested | Telegram needs `TELEGRAM_BOT_TOKEN`; link it from the app's "Get alerts on Telegram" button |
| 5 | Memory service (Graphiti on embedded FalkorDB) | Built, extraction untested | Starts and serves reads; extraction and search need `OPENAI_API_KEY` |
| 6 | NEAR AI agent | Built, untested live | Attested, end-to-end encrypted, 7 tools, number check, seed-phrase tripwire, template fallback. Needs `NEAR_AI_API_KEY` |
| 7 | Fixes, NEAR Intents quotes, review and signing page | Done, signing untested | Live 1Click quotes with 5 checks; signing needs your wallets (test with a tiny amount); blocked on demo accounts |
| 8 | MetaMask Snap (pre-sign checks) | Built, untested in MetaMask | Analysis tested with real calldata; needs MetaMask Flask in your browser |
| 9 | Mac menu-bar app (Swift) | Built, launched | Hold ⌘⌥ for the Siri-style overlay (orb, edge glow, spoken answers). Rendered and checked offscreen; voice, overlay and notifications still need you at the screen |
| 10 | Always-on (launchd) + docs | Done | `pnpm always-on` installs it (you run it) |

## Before submitting

1. Put `NEAR_AI_API_KEY`, `OPENAI_API_KEY` and `TELEGRAM_BOT_TOKEN` in `.env` (never in the repo), then test chat,
   memory and Telegram.
2. Add your wallets to `config/wallets.json` (gitignored).
3. Try the Snap in a MetaMask Flask browser profile.
4. Try one real fix with a tiny amount.
5. Try voice and notifications on the Mac, then record the demo.
6. Make the GitHub repo public before the deadline, then submit.

## Log

- **2026-11-13** Siri-style voice overlay: hold ⌘⌥ in any app and an orb appears over everything, with a glow
  around the screen. The orb reacts to your voice, swirls while thinking and pulses while speaking; answers come
  with their cards and fade away unless there's a button to press. ⌘⌥ is detected without keyboard
  permissions (modifier state plus key/click counters), and shortcuts like ⌘⌥Esc don't trigger it. Fixed the
  header orb's pulse and a case where the mic could stay on if you let go while the speech model was loading.
- **2026-11-12 (night)** Renamed to Nierwall everywhere users see it: app, Snap, Telegram, signing page, docs.
  Internal names still say guardian. README rewritten for readers; this tracker moved here. Added a "Get alerts on
  Telegram" button to the app and `pnpm simulate` for demo price drops. `pnpm demo` now includes a public USDC
  holder on Base, so it shows the NEAR Intents fix with a live quote. Signing is refused for demo accounts.
  Code pushed to github.com/ConduenceAi/Nierwall (private).
- **2026-11-12 (evening)** All ten parts built; 21 tests pass (17 unit, 4 live mainnet). Mac app compiles and
  connects. Snap builds; its analysis flags "withdraw all cbBTC" on a real Aave position as critical
  (health 1.62 → 0.14). Memory service runs on embedded FalkorDB (no Docker). Alert → fix → review works on live
  data: a SIMULATED NEAR -9% drop opens an alert whose first fix moves USDC from Base to NEAR through NEAR Intents
  (live quote: ~1,298.80 USDC arrives in ~35 s) and repays on Rhea; opening the review creates a real deposit
  address and all 5 checks pass.
- **2026-11-12 (afternoon)** Brain core and watch loop working on live mainnet data. Prices come from the
  protocols' own oracles (Chainlink via Aave, Pyth via Rhea) with CoinGecko as fallback, because Pyth's public
  price API now requires a key.
- **2026-11-12** Plan agreed.
