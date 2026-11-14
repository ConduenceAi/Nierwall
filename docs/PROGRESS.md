# Progress

Last updated: 2026-11-13 (night, IST). Deadline: 2026-11-14 23:59 UTC. Judging 16 Nov, results 18 Nov.

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | Repo scaffold, config templates | Done | pnpm workspace, `.env.example`, wallet template, MIT license |
| 2 | Brain core: prices, Rhea reader | Done, live-tested | Rhea health matches the Rhea SDK exactly. Aave was supported until 2026-11-14, then taken out to keep the focus on NEAR |
| 3 | Watch engine, scheduler, scenario mode, `pnpm demo`, `pnpm simulate` | Done, live-tested | 6 watch types; incidents open, escalate, remind, resolve, snooze; checks every 20 s near a limit, 60 s otherwise |
| 4 | Local API + WebSocket, Telegram bot | API done, Telegram untested | Telegram needs `TELEGRAM_BOT_TOKEN`; link it from the app's "Get alerts on Telegram" button |
| 5 | Memory service (Graphiti on embedded FalkorDB) | Done, live-tested | Extraction, search and the facts list checked with a real OpenAI key; facts are dated and the newest wins. Needs `OPENAI_API_KEY` |
| 6 | NEAR AI agent | Built, untested live | Attested, end-to-end encrypted, 7 tools, number check, seed-phrase tripwire, template fallback. Needs `NEAR_AI_API_KEY` |
| 7 | Fixes, NEAR Intents quotes, review and signing page | Done, signing untested | Live 1Click quotes with 5 checks; cash for a Rhea fix comes from whichever EVM network holds the most USDC; MetaMask is switched to each step's network. Signing needs your wallets (test with a tiny amount); blocked on demo accounts |
| 8 | MetaMask Snap (pre-sign checks) | Built, untested in MetaMask | Analysis tested with real calldata; needs MetaMask Flask in your browser |
| 9 | Mac menu-bar app (Swift) | Built, launched | Press ⌘⌥ for the Siri-style orb (top center, no background, edge glow): a hands-free conversation where a pause sends, it answers and listens again, you can talk over it, and Esc or silence ends it. Turn-taking checked offline (`apps/mac/scripts/check.sh`); voice, echo cancellation, overlay and notifications still need you at the screen |
| 10 | Always-on (launchd) + docs | Done | `pnpm always-on` installs it (you run it) |
| 11 | Holdings, token watches, portfolio mix | Done, live-tested | Every token in every wallet: an EVM wallet on all ten EVM networks NEAR Intents supports (a batched read per network, with a backup node each), NEAR via FastNEAR; price watches for any coin, priced by DefiLlama; mix targets as watches |
| 12 | Advisor (AI plans, Mac checks) | Checker live-tested, AI untested | Plans replayed against balances, loans and live quotes; review sessions built for swaps, moves and Rhea. AI sets floors, targets, alert severity and cost limits. Needs `NEAR_AI_API_KEY` to try the AI part |
| 13 | Snap: transaction simulation | Done, live-tested on Base | "You send / you get", mix targets with alternatives, bad rates, hidden approvals, failing transactions |
| 14 | Snap on every network | Done, live-tested on Ethereum, Arbitrum, Polygon, Avalanche | Simulation on 13 EVM networks, decoding elsewhere; NEAR transactions from MetaMask (NEP-518) decoded, including Rhea health and full-access keys |

## Before submitting

1. Put `NEAR_AI_API_KEY`, `OPENAI_API_KEY` and `TELEGRAM_BOT_TOKEN` in `.env` (never in the repo), then test chat,
   memory and Telegram.
2. Add your wallets to `config/wallets.json` (gitignored).
3. Try the Snap in a MetaMask Flask browser profile.
4. Try one real fix with a tiny amount.
5. Try voice and notifications on the Mac, then record the demo.
6. Make the GitHub repo public before the deadline, then submit.

## Log

- **2026-11-14 (morning)** Rhea only, for now: Aave is out of watching, fixes, plans, signing and the Snap, to keep
  the focus on NEAR. NEAR's price still comes from Rhea's oracle; ETH and USDC now come from the market. EVM wallets
  are still read on every network for cash. The demo's EVM wallet is now "Demo EVM wallet".
- **2026-11-14 (morning)** Memory checked live with an OpenAI key: three messages became wallets, a loan, a goal
  and a preference linked by dated facts, and a search returned the right ones. Fixed two things it showed: the list
  of everything remembered read the wrong graph (Graphiti keeps each group in its own), and a changed limit left the
  old fact next to the new one, so the AI now gets each fact's date, newest first, and is told the newer one wins.
- **2026-11-13 (late night)** Your wallets on any EVM chain: an EVM wallet is read on all ten networks NEAR
  Intents supports (Ethereum, Base, Arbitrum, OP Mainnet, Polygon, BNB Chain, Gnosis, Avalanche, Berachain,
  Scroll), so holdings, the mix and fixes see money wherever it is. A Rhea fix takes USDC from the network that
  holds the most and sends it to NEAR through NEAR Intents; plans can name the network for each step, swap or move
  across networks (even within one wallet), and keep the right coin for fees on each. The review page switches
  MetaMask to each step's network. Every network now has a backup node (drpc.org) after Base's and Ethereum's
  default nodes went down tonight; Base now reads from mainnet.base.org first. README has a new "Chains and NEAR
  Intents" section. 62 tests pass; `pnpm demo` live: a demo wallet turns out to hold USDC on Arbitrum.
- **2026-11-13 (night)** Prices now come from DefiLlama's free coins API (no key, no monthly cap) instead of
  CoinGecko, whose free tier would run out in about a week of checking every minute. That covers watched coins
  and their 24-hour change, 90-day volatility, the backup when the ETH, NEAR and USDC oracles don't answer, and
  token prices in the Snap on all 17 networks (each chain's DefiLlama prefix checked live). CoinGecko is now only
  for finding coins by name and for the few prices DefiLlama doesn't have. 56 tests pass.
- **2026-11-13 (night)** Voice is now a conversation: press ⌘⌥ (no holding), talk, pause, and the orb answers and
  listens again until you press Esc or stay quiet for 8 seconds. You can talk over it: its voice plays through the
  same audio engine as the mic with Apple's echo cancellation, its own words are filtered out of what it hears, and
  it turns itself down as soon as you start talking. A pause is read from the mic level (Apple's transcriber only
  updates about once a second), waiting longer when your last word says more is coming ("and", "um"). Esc is
  registered only while the orb is open, with no permission needed. 15 offline checks with scripted audio.
- **2026-11-13 (evening)** The Snap now checks every transaction MetaMask sends, on any network: simulation where
  the network's node supports it (13 EVM networks), decoding elsewhere, tokens priced from the NEAR Intents list,
  then CoinGecko. NEAR transactions from MetaMask are decoded per NEP-518. 45 tests pass.
- **2026-11-13 (afternoon)** Advisor: the TEE planning model proposes plans and the Mac checks every step with
  live NEAR Intents quotes before you see them. The AI now proposes loan floors and repair targets from 90-day
  volatility, judges alert severity (with hard rails), and sets each plan's cost limit. Answers stay on NEAR AI's
  TEE models. Token watches for any CoinGecko coin; portfolio-mix targets. The Snap now simulates any Base
  transaction: what you send and get, mix targets with alternatives, bad rates, hidden approvals, failing
  transactions. Switched the NEAR RPC to FastNEAR after rpc.mainnet.near.org started refusing requests.
- **2026-11-13** Siri-style voice overlay: hold ⌘⌥ in any app and an orb appears over everything, with a glow
  around the screen. The orb reacts to your voice, swirls while thinking and pulses while speaking; answers come
  with their cards and fade away unless there's a button to press. ⌘⌥ is detected without keyboard
  permissions (modifier state plus key/click counters), and shortcuts like ⌘⌥Esc don't trigger it. Fixed the
  header orb's pulse and a case where the mic could stay on if you let go while the speech model was loading.
  Then, from feedback: the orb sits at the top center with no background. Answers are spoken, and anything with
  a button (a fix to sign, a watch to confirm) opens in the panel under the menu bar.
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
