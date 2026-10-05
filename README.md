# Rampart

**On-chain policy vaults for AI trading agents on Solana.**

> The agent's wallet has **zero authority** over vault funds.

Rampart is a Solana program that holds an agent's trading capital in program-owned
PDAs and enforces a risk policy **on-chain** — directly in the instruction that
moves money. Agents keep their own keypairs and sign every transaction, but the
vault decides what they're allowed to do. A fully-compromised agent key can request
anything it wants; Rampart rejects whatever the policy forbids. There is nothing
off-chain to jailbreak.

**Live on devnet — [rampart.pxxl.click](https://rampart.pxxl.click)** (one click runs
the whole story against real devnet transactions).

## TL;DR

- Assets live in **PDAs owned by the Rampart program**, never in the agent's wallet.
- The agent signs *intents*; the policy is enforced **in the program's transfer path**
  — not a library the agent imports, so a jailbroken agent can't bypass it.
- Trading-specific risk desk, chain-enforced: allowlist destinations, per-tx +
  per-epoch USD caps, Pyth live-price slippage band, halted-feed rejection,
  owner-only kill switch, timelocked policy changes.
- Even a **jailbroken agent holding its own full key** cannot drain the vault.
  Worst case it fires a spend request the chain rejects. Proven by 37 tests,
  including 22 end-to-end runs inside an in-memory Solana VM in CI.

## Why on-chain?

Middleware, "AI wallets", and guardian services that wrap the agent in-process can
all be bypassed by the very thing they guard: if the agent's code executes the
check, a jailbroken agent skips it. Rampart moves the policy into the ledger
itself. The transfer instruction reads the policy PDA and the live Pyth feed at
execution time and either honors or rejects the intent. The agent key is a
*signer*, not an authority.

## How it works

### Accounts

| Account | Derivation | Purpose |
|---|---|---|
| `Vault` | `rampart_vault` [owner] | Owner, treasury bump, frozen flag, Pyth reference-price snapshot, timelock length |
| `Policy` | `rampart_policy` [vault] | Daily/per-tx USD caps, max slippage bps, epoch length, destination allowlist, pending timelocked policy |
| `SpendTracker` | `rampart_spend` [vault] | Per-epoch USD spent + epoch index |
| `Agent` | `rampart_agent` [vault, agent key] | Agent registry (the agent signs its own registration) |
| `Treasury` | `rampart_treasury` [vault] | System-owned PDA holding the capital |

### Instructions

- **`init_vault`** — owner creates vault + policy + spend tracker and snaps the
  Pyth reference price (caps must be non-zero).
- **`deposit` / `withdraw`** — owner moves SOL into/out of the treasury. Agents
  can never withdraw; the treasury is a PDA only the program can sign for.
- **`register_agent` / `unregister_agent`** — owner registers an agent key (agent
  co-signs its own registration so the PDA seed needs no instruction arg);
  deactivation is owner-only.
- **`freeze` / `unfreeze`** — **owner-only kill switch**. The agent's own key
  physically cannot flip it. A frozen vault rejects every spend.
- **`propose_policy` / `apply_policy`** — policy changes are two-step and
  **timelocked** (default 60 slots). The owner proposes; the change only becomes
  effective after the timelock elapses.
- **`guarded_transfer`** — the money-moving instruction. **Agent-only.** Rejects
  unless every guard below passes. **This is what runs on devnet.**
- **`guarded_dbc_transfer`** — adds Meteora DBC bonding-curve guards on top.
  **Not in the deployed binary — see [Deployment scope](#deployment-scope-what-is-and-isnt-live).**

### The guard stack (all evaluated inside `guarded_transfer`)

1. **Not frozen** — owner kill switch is a hard gate.
2. **Registered + active agent** — registry PDA derived from the signing key.
3. **Destination allowlisted** — must be on the policy allowlist, and it can't be
   the treasury itself.
4. **Balance check** — amount must exist in the treasury.
5. **Pyth live price** — feed decoded on-chain: trading status required,
   non-positive price rejected, halted/stale feed rejected.
6. **Deviation band** — live Pyth price must stay within `max_slippage_bps` of the
   vault's reference price. Slippage is enforced on-chain, not trusted from an API.
7. **Per-tx USD cap** — USD value computed from lamports × Pyth price (u128 math,
   exponent-bounded).
8. **Per-epoch (daily) USD cap** — rolling spend tracker; crossing into a new
   `epoch_len_slots` window resets spent.

Both USD caps are computed from the *live feed*, so a large amount can't be
laundered through a price-print discrepancy — the amount gate and the price sanity
gate are both on-chain.

## Deployment scope (what is and isn't live)

Stated plainly, because it is the difference between what you can click and what is
only proven in CI:

| Component | In source | CI-tested | Live on devnet `6Ea4Sq…` |
|---|---|---|---|
| `guarded_transfer` + full guard stack | yes | yes (22 litesvm e2e) | **yes** |
| `guarded_dbc_transfer` (DBC guard stack) | yes | yes (12 host-side + litesvm) | **no** |
| `MAX_DBC_PROGRESS_BPS` graduation cliff guard | yes | yes | **no** |

The devnet program was published with `solana program deploy --final`, which
renounces the upgrade authority — to the system program address, permanently. It
can never be set again, and the deployed binary predates the DBC work. Shipping the
DBC path therefore requires a **new program ID**.

We chose not to redeploy for two reasons: the deployed binary already demonstrates
the entire thesis (8 refusals, every one enforced on-chain, none of which touch the
DBC path), and a new address would invalidate the program links already published
in this README and in the submission. So the DBC guard stack ships as
**source + CI-proven tests**, described below as what it is — not as a live feature.

You can verify the immutability yourself: fetch the program account, read
`ProgramData`, and the authority field at offset 8..40 is
`11111111111111111111111111111111`.

## The DBC guard stack (`guarded_dbc_transfer`, not yet deployed)

Generic spend control is a solved problem — Cap, Safe, Turnkey and Coinbase all
encode allowlists and caps. What none of them do is price a position against the
curve it is about to move. `guarded_dbc_transfer` adds four checks on top of the
stack above, and they run **before** any funds move:

1. **Both accounts are real** — the pool and config must deserialize as genuine
   `VirtualPool` / `PoolConfig` layout, be owned by the DBC program, and the pool
   must actually belong to the config it was paired with. A self-made account that
   looks healthy is worthless; mis-sized accounts return an error instead of
   panicking.
2. **Owner-approved pool** — the agent names the pool, so the owner must have
   allowlisted that exact pool. Otherwise a jailbroken agent points at any curve
   it likes.
3. **Tradeable progress band — 20% to 80% of the curve.** Both ends are refusals:
   - *Floor* (`PoolTooEarly`): a pool with no trading history is not a pool you
     size a position against.
   - *Ceiling* (`PoolTooLate`): near `migration_quote_threshold` a few SOL of
     buying pressure **graduates the token outright**. That is the trade a volume
     bot is paid to make, and it is exactly what an agent gets talked into by
     "finish this one, it is nearly there". Meteora's own defence is a
     fee-schedule `RateLimiter` — fees do not stop a graduation, and the launchpad
     that owns the config can configure it away. Putting the gate in the *trader's*
     vault means the pool creator cannot relax it.
   - A completed curve (100%) fails separately as `DbcQuoteFailed`, because there
     is no curve left to price.
4. **Price-impact cap** — the requested size is priced through **Meteora's own
   quote math**, and the resulting curve-price movement must sit inside the owner's
   `max_slippage_bps`. The vault funds the trade, so the agent must not be able to
   pick a pool where its own size wrecks the entry price. Measured on real Meteora
   fixtures: 0.1 SOL = 98 bps (passes a 100 bps cap), 1 SOL = 1008 bps (rejected),
   5 SOL = 5535 bps (rejected).

**Scope, stated plainly:** this gates and releases capital; it does not execute
the swap. Meteora DBC swaps require the `pool_authority` PDA to sign, and we are
not willing to hand a second signer authority over the treasury to get there. The
vault's job is to decide *whether the money may move*, on-chain, where the agent
cannot argue with it.

## Safety properties (what the live demo shows)

Every row below is an observed on-chain rejection from a real devnet run, not a
description of intended behaviour.

| Threat | On-chain outcome | Code |
|---|---|---|
| Agent sends funds to a non-allowlisted address | `DestinationNotAllowed` | `6004` |
| Agent spends more than its per-tx cap | `PerTxCapExceeded` | `6007` |
| Agent drains the vault across many txs in one epoch | `DailyCapExceeded` | `6008` |
| Owner freezes the vault mid-run | `VaultFrozen` | `6001` |
| Owner loosens the policy mid-run | `PolicyNotEffective` (timelock) | `6016` |
| Oracle pumped above the slippage band while the agent spends | `PriceDeviationTooHigh` | `6013` |
| Pyth feed halted / stale | `PriceHalted` | `6011` |
| Agent attempts an owner-signed action | refused — no owner signature exists | client-side¹ |

¹ `withdraw` requires the **owner** to sign. An agent holds no key for that slot, so
web3.js throws during `partialSign` and the transaction is never sent — there is no
on-chain error code to report. The UI labels it
`OwnerSignatureRequired (agent key cannot sign for the owner's vault)` rather than
inventing a code. A compromised agent key cannot produce this state on any
reachable instruction.

## Proof: 37 tests (22 end-to-end, 12 host-side, 3 unit)

`programs/rampart/tests/test_rampart.rs` drives a full in-memory Solana VM
(`litesvm`) against the SBF build:

- `drain_blocked_to_non_allowlisted_dest`
- `happy_path_allowlisted_transfer`
- `per_tx_cap_enforced`
- `daily_cap_enforced_and_resets_by_epoch`
- `frozen_vault_rejects_agent_spend`
- `jailbroken_agent_alone_cannot_build_freeze_or_withdraw`
- `owner_can_withdraw`
- `unregistered_caller_cannot_spend`
- `deactivated_agent_cannot_spend`
- `oracle_pump_outside_slippage_is_blocked`
- `halted_feed_is_blocked`
- `policy_change_requires_timelock`
- `treasury_self_destination_blocked`
- `dbc_happy_path_on_allowlisted_pool`
- `dbc_pool_must_be_allowlisted_by_the_owner`
- `dbc_accounts_must_be_owned_by_the_dbc_program`
- `dbc_pool_must_belong_to_the_config_it_is_paired_with`
- `dbc_pool_below_min_progress_is_rejected`
- `dbc_pool_past_max_progress_is_rejected`
- `dbc_completed_curve_is_rejected`
- `dbc_price_impact_beyond_slippage_is_rejected`
- `dbc_guard_still_honours_the_daily_cap`

`programs/rampart/tests/test_dbc_snapshot.rs` runs 12 host-side tests against real
Meteora pool/config fixtures (built from Meteora's own account types and curve
math) and needs no built `.so`, so they run anywhere:

- `healthy_pool_reads_progress_and_impact`
- `progress_tracks_quote_reserve`
- `tradeable_band_excludes_both_ends_of_the_curve`
- `shallow_curve_reports_real_price_impact`
- `impact_grows_with_trade_size`
- `completed_curve_cannot_be_quoted`
- `pool_must_belong_to_the_supplied_config`
- `wrong_discriminator_is_not_a_pool`
- `zeroed_pool_is_not_our_pool`
- `mis_sized_accounts_are_rejected_not_fatal`
- `fixture_bytes_round_trip_through_anchor`
- `fixture_sizes_match_anchor_init_space`

Plus 3 unit tests covering USD micro-math, deviation-bps rounding, and the
anchor error-code numbering. Meteora's `dynamic-bonding-curve` is pinned to an exact
revision in `Cargo.lock`, so the fixtures cannot drift under a `cargo update`.

## Live on devnet (watch the drain get blocked)

| Entity | Address | Explorer |
|---|---|---|
| Rampart program | `6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr` | [program](https://explorer.solana.com/address/6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr?cluster=devnet) |
| Oracle-mock program (deterministic feed) | `2xbNzbkEZ65hLzi9TgdMBcncup6a5CA1qi3QLVTrwQ2p` | [program](https://explorer.solana.com/address/2xbNzbkEZ65hLzi9TgdMBcncup6a5CA1qi3QLVTrwQ2p?cluster=devnet) |
| Demo sponsor wallet (owner) | `2QXPxqAR41JEDdPgdQp2MX3S4F26xNAX4uDn2sqtvS5h` | [wallet](https://explorer.solana.com/address/2QXPxqAR41JEDdPgdQp2MX3S4F26xNAX4uDn2sqtvS5h?cluster=devnet) |

Press **RUN DEMO** and the dashboard creates a fresh sponsored vault, registers an
agent, and fires a scripted series of spends. Every guard either honors the intent
or rejects it **on-chain**. One run finishes with **8 blocked beats, every one
tagged with its error name** and a per-step explorer link:

1. **Timelock** — a proposed policy change is not yet effective → `PolicyNotEffective`.
2. **Per-tx cap** — the agent tries to send past the $10/tx cap → `PerTxCapExceeded`.
3. **Oracle pump** — the mock feed is pushed $200 → $204; the spend now deviates past
   the 100 bps band → `PriceDeviationTooHigh`.
4. **Non-allowlisted destination** — the agent points at an address the owner never
   approved → `DestinationNotAllowed`.
5. **Daily cap** — cumulative spend crosses the $40/epoch cap → `DailyCapExceeded`.
6. **Freeze** — the owner flips the kill switch; the *same* agent key that could
   previously spend now gets `VaultFrozen` on every attempt.
7. **Owner withdraw** — the agent attempts an owner-signed withdrawal →
   `OwnerSignatureRequired`.
8. **Recovery** — the owner unfreezes and the vault is usable again, proving the
   freeze is a reversible control rather than a brick.

The demo vaults hold **0.4 SOL**, and the USD caps scale proportionally to it, so
the same beats fire on a smaller balance. The owner never hands the agent a
withdrawal path — the treasury is a PDA, and only the program can sign for it.

Each RUN sponsors a fresh runner wallet funded from the sponsor wallet and sweeps
the remainder back afterwards, so runs are repeatable and never collide with a
previous vault. A run costs roughly **0.015 SOL** in devnet fees and rent.

Run it locally:

```bash
cd client
pnpm install
pnpm run build:web
pnpm start        # http://localhost:8788
```

The sponsor wallet needs devnet SOL. The public faucet rate-limits aggressively; if
`RUN` reports it cannot fund a runner, top the sponsor up rather than lowering the
deposit.

## Deploy as a public web app

One long-running Node process (Express) serves both the SPA and the API, so a host
is just "build + start". **Not a serverless target** — a demo run keeps ~40 seconds
of on-chain transactions open, which would blow past serverless timeouts (Vercel is
not recommended for RUN; use a long-running host).

`client/Dockerfile` handles all of this: Node 22, pnpm installed globally (not via
corepack), frozen-lockfile install, Vite build, then `pnpm start`. Pxxl detects it
and runs a Web Service on the injected `$PORT`.

Environment:

| Var | Required | Purpose |
|---|---|---|
| `RAMPART_WALLET_B64` | yes | base64 of the JSON wallet file, so the host needs no keyfile on disk |
| `RAMPART_RPC` | no | defaults to the public devnet endpoint; a Helius key is strongly recommended |
| `PORT` | no | assigned by the platform |
| `RAMPART_RUN_TOKEN` | no | when set, `POST /api/demo/run` and `/api/demo/reset` require `x-rampart-token` |

Produce the base64 on any machine:

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content target/deploy/devnet-wallet.json -Raw).Trim()))
```

Pxxl setup, matching the live deployment:

- Source: this repository, branch `main`
- **Base directory: `client`** — the Docker build context
- Project domain: `rampart.pxxl.click`
- Leave Install/Build/Start as-is; the Dockerfile governs all three
- Add `RAMPART_WALLET_B64` and `RAMPART_RPC` as environment variables

After launch, verify in this order: `/healthz` (confirm `api-key=REDACTED` and your
sponsor address), then `/api/state` (confirm live Pyth data), then a full **RUN
DEMO** from the UI. Railway and Fly.io are equivalent.

> **Security note.** `RAMPART_RUN_TOKEN` is unset on the current deployment, so
> anyone who knows the URL can spend devnet SOL by pressing RUN. Set it, or put the
> domain behind Pxxl's password protection, before treating the URL as private.

## Build & test

The SBF build and the full 37-test suite run in CI
(`.github/workflows/build-sbf.yml`, ubuntu). The built `target/deploy/rampart.so` is
uploaded as a `rampart-so` artifact on every green run, and release tags attach it
plus both IDLs and a `CHECKSUMS.txt` to a GitHub release.

Local verification on a Windows/GNU box:

```bash
cargo +stable-x86_64-pc-windows-gnu check -p rampart
cargo +stable-x86_64-pc-windows-gnu test -p rampart --lib        # 3 unit tests
cargo +stable-x86_64-pc-windows-gnu test -p rampart --test test_dbc_snapshot  # 12, no .so needed
```

The 22 litesvm tests need a real SBF `.so` (a placeholder file makes `add_program`
fail with `InvalidAccountData`). Build it in CI, then download the artifact to run
them locally:

```bash
gh run download <run-id> --name rampart-so --dir target/deploy/ci
cp target/deploy/ci/rampart.so target/deploy/rampart.so
cargo +stable-x86_64-pc-windows-gnu test -p rampart --test test_rampart
```

Interactive testing (deploy + transact) uses that `.so` against devnet — the
"Live on devnet" section above runs the full story. A local validator works on this
box via the agave 2.x toolchain (see `docs/agave-2x-windows.md`).

## Repo layout

```
programs/rampart/src/            program source
  state.rs                       Vault / Policy / SpendTracker / Agent accounts
  constants.rs                   PDA seeds + defaults (allowlist 16, timelock 60, epoch 2160, slippage 100bps)
  error.rs                       error codes (anchor 6000-based = enum index + 6000)
  math.rs                        USD micro math + deviation_bps
  pyth.rs                        on-chain Pyth v2 price decode
  instructions/                  one module per instruction
programs/rampart/tests/          22 litesvm e2e + 12 host-side DBC fixture tests
client/                          TypeScript SDK, demo runner, SPA and API server
  src/rampart.ts                 Anchor client + error decoding
  src/demo.ts                    scripted demo sequence
  server/index.ts                Express API + static SPA
  web/                           React dashboard
  Dockerfile                     Pxxl / container build
docs/mainnet-ready.md            go-live policy + code findings
docs/agave-2x-windows.md         local validator on Windows
.github/workflows/build-sbf.yml  CI: SBF build + tests + artifact
```

## Roadmap

- **Swap path** (Jupiter CPI) — the MVP proves the thesis with the transfer path
  fully enforced on-chain; the swap path (priced against the same on-chain Pyth
  feed, capped the same way) is the next iteration.
- **DBC guard stack live** — publish the already-tested `guarded_dbc_transfer`
  under a new program ID and run it against real Meteora pools.
- **Guard daemon** — off-chain monitor that watches spends and can trigger the
  owner kill switch.
- **Squads multisig** — escalate big-tx approval to a multisig PDA for sub-owners.
- **Mainnet** — audit-first: threat-model doc (already drafted in
  `docs/mainnet-ready.md`), external review, property/fuzz tests, upgrade-authority
  step-down, staged TVL rollout. The hackathon build stays on devnet.