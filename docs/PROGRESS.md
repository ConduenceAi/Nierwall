# Progress

Last updated: 2026-11-14 (afternoon, IST). Deadline: 2026-11-14 23:59 UTC. Judging 16 Nov, results 18 Nov.

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | Repo scaffold, config templates | Done | pnpm workspace, `.env.example`, wallet template, MIT license |
| 2 | Brain core: prices, Rhea reader | Done, live-tested | Rhea health matches the Rhea SDK exactly. Aave was supported until 2026-11-14, then taken out to keep the focus on NEAR |
| 3 | Watch engine, scheduler, scenario mode, `pnpm demo`, `pnpm simulate` | Done, live-tested | 6 watch types; incidents open, escalate, remind, resolve, snooze; checks every 20 s near a limit, 60 s otherwise |
| 4 | Local API + WebSocket, Telegram bot | API done, Telegram untested | Telegram needs `TELEGRAM_BOT_TOKEN`; link it from the app's "Get alerts on Telegram" button |
| 5 | Memory service (Graphiti on embedded FalkorDB) | Done, live-tested | Extraction, search and the facts list checked with a real OpenAI key; facts are dated and the newest wins. Needs `OPENAI_API_KEY` |
| 6 | NEAR AI agent | Done, live-tested | Setup, wallets, floors and planning answered live on NEAR AI, end to end encrypted, with TEE attestation for the gateway and both models; 14 tools, number check with one self-correction, seed-phrase tripwire, template fallback |
| 7 | Fixes, NEAR Intents quotes, review and signing page | Done, signing untested | Live 1Click quotes with 5 checks; cash for a Rhea fix comes from whichever EVM network holds the most USDC; MetaMask is switched to each step's network. Signing needs your wallets (test with a tiny amount); blocked on demo accounts |
| 8 | MetaMask Snap (pre-sign checks) | Built, untested in MetaMask | Analysis tested with real calldata; needs MetaMask Flask in your browser |
| 9 | Mac menu-bar app (Swift) | Built, launched | Press ⌘⌥ for the Siri-style orb (centered a fifth of the way down, no background, edge glow): a hands-free conversation where a pause sends, it answers and listens again, you can talk over it, and Esc or silence ends it. Turn-taking checked offline (`apps/mac/scripts/check.sh`); voice, echo cancellation, overlay and notifications still need you at the screen |
| 10 | Always-on (launchd) + docs | Done | `pnpm always-on` installs it (you run it) |
| 11 | Holdings, token watches, portfolio mix | Done, live-tested | Every token in every wallet: an EVM wallet on all ten EVM networks NEAR Intents supports (a batched read per network, with a backup node each), NEAR via FastNEAR; price watches for any coin, priced by DefiLlama; mix targets as watches |
| 12 | Advisor (AI plans, Mac checks) | Checker live-tested, AI untested | Plans replayed against balances, loans and live quotes; review sessions built for swaps, moves and Rhea. AI sets floors, targets, alert severity and cost limits. Needs `NEAR_AI_API_KEY` to try the AI part |
| 13 | Snap: transaction simulation | Done, live-tested on Base | "You send / you get", mix targets with alternatives, bad rates, hidden approvals, failing transactions |
| 14 | Snap on every network | Done, live-tested on Ethereum, Arbitrum, Polygon, Avalanche | Simulation on 13 EVM networks, decoding elsewhere; NEAR transactions from MetaMask (NEP-518) decoded, including Rhea health and full-access keys |

## Before submitting

1. Put `NEAR_AI_API_KEY`, `OPENAI_API_KEY` and `TELEGRAM_BOT_TOKEN` in `.env` (never in the repo), then test chat,
   memory and Telegram.
2. Add your wallets in the shield, and connect the ones Nierwall should send fixes to (NEAR wallet or MetaMask).
3. Try the Snap in a MetaMask Flask browser profile.
4. Try one real fix with a tiny amount.
5. Try voice and notifications on the Mac, then record the demo (the demo portfolio's story is in the README).
6. Make the GitHub repo public before the deadline, then submit.

## Log

- **2026-11-14 (evening)** Solana, read only, and a realistic demo. A Solana address can be added like any other:
  SOL and the tokens NEAR Intents lists there (USDC and others) are read from public Solana nodes and priced, SOL
  has its own slice in the portfolio mix, and NEAR Intents can send to a Solana wallet, but nothing is ever sent from
  one. The demo is now a fixed portfolio at live prices, about $160: NEAR with a Rhea loan (health about 1.4), ETH and
  USDC on Base, SOL and USDC on Solana, with two rules (30% in stablecoins, 10 USDC kept on Base). Buying about $15
  of ETH with the Base USDC breaks both: the plan check rejects it and the AI proposes swapping NEAR into ETH on Base
  with NEAR Intents instead; in MetaMask, the Snap warns about both, and its reserve rule now covers swaps, not only
  transfers. `pnpm demo --portfolio` runs the story live; it matched those numbers. Asked on NEAR AI, the agent named both
  broken rules with their numbers and proposed a checked $11.50 buy that keeps both (56 s). The shield now shows just
  **Add wallet** (its fields open on click) and **Connect wallet**, each explained behind an (i), and its switches line
  up. 76 brain tests pass.
- **2026-11-14 (late afternoon)** Watching and sending are now separate, from feedback. In the shield you type a
  wallet's address and a name to watch it (read-only: balances, loans, alerts). **Connect a wallet** opens the browser
  page, where you pick Meteor or any other NEAR wallet from NEAR Connect's list, or MetaMask for EVM networks; only a
  connected wallet can be sent fixes and swaps to approve, and connecting a watched address upgrades it. The plan
  checker rejects a step that sends from a read-only wallet, the review page refuses one too, each step opens the
  wallet app its wallet was connected with, and the AI asks which wallet to use when more than one could do it. Cards
  for a read-only wallet show **Connect to send**. MetaMask signs EVM steps, with the NEAR Intents cross-chain fixes
  and plans, and the Snap with its Transaction safety switch stays as it was. Checked: the connect page in headless
  Chrome (11 NEAR wallets, no Ethereum Wallets entry; MetaMask says to install it when missing), the wallet API in
  memory, and offscreen renders of the panel.
- **2026-11-14 (mid-afternoon, later)** A new look, from feedback. The panel opens on your wallets; the chat is
  behind the button at the top right, and opens on its own for an alert or an answer with something to click.
  Everything is Nierwall blue (#3B82F6), black and white: the panel (white on black), the orb, the edge glow, the
  menu-bar icon's alert state, and the connect, review and Snap install pages. Red is kept only for danger: a
  critical alert, the liquidation end of the health gauge, a failed check. The orb is 25% bigger (80 pt), sits a
  fifth of the way down the screen, and has a very thin silver rim with a shine that travels around it. Checked
  in offscreen renders of the orb and both panel views.
- **2026-11-14 (mid-afternoon)** Meteor is the only wallet to connect, for now. The connect page has one Meteor
  button (MetaMask's is gone), and NEAR steps of a fix always go to Meteor; the orb names Meteor whenever a NEAR
  wallet is connected. Typing a NEAR account or a 0x address still works, EVM steps still sign in MetaMask, and the
  transaction-safety Snap is unchanged. Fixed a bug found while testing it in Chrome: the page's security policy
  blocked the wallet's code, which NEAR Connect runs as inline scripts in a sandboxed frame, so Meteor never opened
  on the connect or review page. Each load now gets a fresh nonce that NEAR Connect passes on; clicking Connect
  Meteor opens Meteor's window (extension, web or phone).
- **2026-11-14 (afternoon)** Nierwall starts empty, and the orb sets it up. No built-in wallets: you connect a wallet
  on a local page (Meteor, MetaMask or another; only the address is read) or by saying a NEAR account, and every
  NEAR wallet is checked for a Rhea loan. Demo accounts and transaction safety are off until turned on; the Snap says
  its checks are off until then. The panel has a Connections view. The orb offers to send a fix to your wallet only
  once you've connected one, and names Meteor when that's how you connected. Addresses are removed from chat text
  before it reaches memory.
  Tested live with NEAR AI credits: setup, connecting by voice, a proposed floor and a planning question all answered
  on NEAR AI, encrypted end to end. Found and fixed three things on the way: NEAR AI's encrypted path fails on any
  tool result that is a JSON array ("Upstream request failed", even `[1,2]`), so results are always objects now;
  the chat model spent ~25 s on hidden reasoning per answer, so everyday answers use low reasoning effort (4 s) while
  planning keeps it; and a reply with a number no tool gave now gets one chance to correct itself instead of turning
  into a template answer. 70 tests pass.
- **2026-11-14 (noon)** NEAR AI checked live with a real key: the gateway's and `z-ai/glm-5.3-flash`'s TEE attestation
  verify (about 15 s), and chat answers wait on credits (402 until a spending limit is set). The planning model
  `z-ai/glm-5.3` is now a third-party model without model attestation, so the default planner is
  `deepseek-ai/DeepSeek-V4.1-Flash-1017`, which runs in NEAR AI's TEEs and verified live. Until then planning
  quietly used the chat model.
- **2026-11-14 (late morning)** The orb sends transactions through Meteor: when an answer is a fix or plan, it says
  what it does and asks "Should I send it to Meteor?". A clear yes opens the review page on Meteor (NEAR Connect,
  straight to the extension), which asks for each step as it becomes ready; you approve in Meteor, and the orb and a
  notification say when it's done or a step failed. Anything but a clear yes sends nothing (15 new offline checks).
  Adding collateral on Rhea is now a real transaction (plain NEAR is wrapped in the same call). 65 tests pass.
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
