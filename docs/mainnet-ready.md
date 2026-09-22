# Mainnet readiness & audit roadmap

Rampart is **devnet-first**. The hackathon build (transfer-path MVP) stays on
devnet through the Sept 25 submission. This document is the honest plan for
what has to happen **before any mainnet SOL moves** — and the current gaps in
the code that an audit must answer. Read top to bottom: the phase order is the
deploy order.

## Policy: when is it safe to switch?

Switch when **every** gate in each phase below is closed. Nothing about the
program's safety is "approximate" — either a guard is enforced on-chain
(allowinglist, caps, band, freeze) or it isn't. The gates that are NOT yet
on-chain are listed under "Audit findings to fix first"; the rest is process.

| Phase | Gate | Condition |
|---|---|---|
| 0 — hackathon | — | Devnet demo only. This week. |
| 1 — audit | All "findings to fix" merged; external review clean | No live funds. |
| 2 — pilot | Small cap ($100–$500 TVL), owner-monitored, kill switch armed | < 2 weeks, zero incidents. |
| 3 — scale | Guard daemon + alerts live; staged cap increases | Per-capacity, not per-schedule. |

Owners and agents keep their own keypairs the whole time — Rampart is not
custody. The risk being gated is **program bugs**, not wallet custody.
Even so: fix-forward, never "ship and hope."

## Audit findings to fix first (in-code, concrete)

These are the reviewer-grade gaps found in the current source. They are
**correct** for the devnet demo (the owner picks the feed, the mock feed is
trusted) and **wrong** for mainnet.

1. **Feed identity is not verified on-chain.**
   `init_vault` and `guarded_transfer` take `price_feed: UncheckedAccount` and
   call `pyth::decode_price(&data)` with no owner or address check
   (`instructions/init_vault.rs`, `instructions/guarded_transfer.rs`,
   `pyth.rs`). Anyone can pass any account whose bytes decode. Mainnet fix: pin
   the per-asset Pyth price account pubkey in the Policy (one of the allowlist
   slots or a dedicated field), and/or check `price_feed.owner == <pyth program>`.

2. **No staleness check.**
   `decode_price` checks `status == trading` and `price > 0` but never compares
   the feed's publish timestamp against `clock`. A frozen-but-"trading" orphan
   feed (or one an attacker can hold) prices spends at yesterday's print.
   Mainnet fix: require `now - publish_time` within a window (feed
   type-dependent), validated in `pyth.rs`.

3. **Reference price never refreshes.**
   The vault's `reference_price`/`reference_expo` are set once in `init_vault`
   and nothing updates them (`apply_policy` swaps caps/allowlist only). If the
   asset trends away from the snap, spends fail-closed (`PriceDeviationTooHigh`)
   until… there is no "until". The vault becomes inert. Safe, but an operator
   footgun. Mainnet fix: owner-only `snap_reference` instruction, and/or define
   the deviation band relative to the **live feed** only (the band exists to
   catch mid-spend manipulation, not long-term drift).

4. **Rounding is floor, not exact.**
   `to_usd_micro` truncates (`product / divisor`). Per-tx/daily caps are in
   whole micro-USD, so a stream of cap-boundary spends can exceed the exact cap
   by < 1 micro per tx. Negligible, but a litesvm property test should pin it:
   "sum of spends in an epoch never exceeds `daily_usd_cap_micro` rounded up."

5. **Price-exponent edge handling.**
   `to_usd_micro` accepts `expo` in `[-12, 3]`; `divisor = 10^(3-expo)`. For
   `expo = 3`, divisor is `1` and `product` must fit `u128` — with `amount`
   near `u64::MAX` and `price_raw > ~1.8e19` the checked multiply rejects.
   Fuzz the boundary: max lamports, max price, each expo, +/-1 lamport.

## Upstream design attributes to keep (do not regress)

- **Allowlist + treasury-self check** — destination can't be the treasury
  (`TreasuryDestination`) and must be allowlisted.
- **Caps computed from the live feed, in the money-moving instruction** — a
  large amount can't launder through a forged price print; amount gate and
  price gate share one decode.
- **Owner-only kill switch** the agent key cannot flip (`set_frozen.rs`),
  **timelocked policy** changes (`propose_policy`+, `PolicyNotEffective`).
- **Registry derived from the signer** (`register_agent` is co-signed) — no
  instruction arg can spoof an agent PDA.
- **Anchor 6000-based error codes** — every guard has a name; the demo and UI
  surface them for replayable forensics.

## Test & review program

1. **Extend the litesvm suite** (currently 13 tests in
   `programs/rampart/tests/test_rampart.rs`) with:
   - boundary spends: `per_tx_cap ± 1 µUSD`, then a burst of `cap` spends until
     `DailyCapExceeded`; assert the exact-cap rounding bound.
   - expo sweep `-12..=3`: max lamport amounts, `MathOverflow` cases.
   - max-allowlist (16 addresses), empty allowlist, duplicate entries.
   - epoch wraparound exactly at slot boundaries.
   - timelock: propose→apply before/after the 60-slot window, pending overwrite.
   - adversarial feed: wrong-owner account, correct bytes, halted status, stale
     publish (once staleness is implemented).
2. **External audit** — run after the findings above are merged and tests pass.
   Solana/Anchor reviewers: OtterSec, Sec3, or an independent Anchor reviewer.
   Scope: the 4 findings, the guard stack, and PDA-derivation/payer hygiene.
   No real funds until the report is addressed with written rationale.
3. **Property/fuzz** (second pass) — port the arithmetic to a host-side model
   (`cargo fuzz` or a proptest on `math.rs`) and property-check
   `deviation_bps` and `to_usd_micro` against a reference implementation.

## Operations before scale

- **Guard daemon** — off-chain watcher tailing vault txs; alerts on repeated
  rejections and spends approaching the daily cap; can trigger the owner
  kill-switch webhook. (Also enables the "who checks the checker" story: the
  chain carries the log, the daemon just reads it.)
- **Upgrade authority** — deploy with upgrade authority = owner key, then move
  it to a Squads multisig (2-of-3) before any meaningful TVL. Freeze/partial
  revoke path exercised in a dry run.
- **Key hygiene** — no keys in env/logs/repos (the current devnet sponsor key
  is a throwaway devnet keypair; never the mainnet key). Fee payer = the agent's
  own wallet; RPC key rotated if a provider token is used.
- **Fee & liveness** — swap path (Jupiter CPI) must price against the **same
  on-chain Pyth band** used in `guarded_transfer`, never trust Jupiter's output
  slippage; Jito tip policy for mainnet confirmation concerns.
- **Exit plan** — the owner can always `withdraw`; document the operator runbook
  for "freeze then withdraw" under duress.

## When you're ready (the go-live checklist)

- [ ] Findings 1–3 fixed on-chain (feed pin, staleness, re-snap), 4–5 proven by
      tests, external audit clean.
- [ ] Fresh mainnet keypair generated and stored offline (never committed).
- [ ] Program deployed to mainnet with upgrade authority on a Squads multisig.
- [ ] Pilot vault funded ≤ $500, owner-operated, kill switch armed, daemon
      watching.
- [ ] Two clean pilot weeks → raise caps in stages, each staged rise gated on
      the previous stage's metrics.

## Hackathon stance

For Sept 25: **devnet.** The demo, dashboard, and pitch are all live on devnet
— that is the submission. This roadmap is the post-submission contract: mainnet
is gated on audit + pilot, never on a deadline.