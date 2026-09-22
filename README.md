# Rampart

**On-chain policy vaults for AI trading agents on Solana.**

> The agent's wallet has **zero authority** over vault funds.

Rampart is a Solana program that holds an agent's trading capital in program-owned
PDAs and enforces a risk policy **on-chain** — directly in the instruction that
moves money. Agents keep their own keypairs and sign every transaction, but the
vault decides what they're allowed to do. A fully-compromised agent key can request
anything it wants; Rampart rejects whatever the policy forbids. There is nothing
off-chain to jailbreak.

## TL;DR

- Assets live in **PDAs owned by the Rampart program**, never in the agent's wallet.
- The agent signs *intents*; the policy is enforced **in the program's transfer path**
  — not a library the agent imports, so a jailbroken agent can't bypass it.
- Trading-specific risk desk, chain-enforced: allowlist destinations, per-tx +
  per-epoch USD caps, Pyth live-price slippage band, halted-feed rejection,
  owner-only kill switch, timelocked policy changes.
- Even a **jailbroken agent holding its own full key** cannot drain the vault.
  Worst case it fires a spend request the chain rejects. Proven by 13 litesvm
  integration tests running in CI.

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
  unless every guard below passes.

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

## Safety properties (the demo)

| Threat | On-chain outcome |
|---|---|
| Jailbroken agent sends funds to a non-allowlisted address | `DestinationNotAllowed` |
| Agent spends more than its per-tx cap | `PerTxCapExceeded` |
| Agent drains the vault across many txs in one epoch | `DailyCapExceeded` |
| Oracle pumped above slippage while the agent spends | `PriceDeviationTooHigh` |
| Pyth feed halted / stale | `PriceHalted` |
| Owner freezes the vault mid-heist | `VaultFrozen` — every subsequent spend rejected |
| Compromised agent key tries to unfreeze / withdraw | `Unauthorized` — only the owner signs those |
| Owner wants to loosen the policy mid-heist | 60-slot timelock forces a warning window |

## Proof: 13 litesvm integration tests

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

## Build & test

The SBF build + the full 13-test suite run in CI
(`.github/workflows/build-sbf.yml`, ubuntu). The built `target/deploy/rampart.so`
is uploaded as a `rampart-so` artifact on every green run.

Local verification on this Windows/GNU box (no MSVC SBF build locally):

```bash
cargo +stable-x86_64-pc-windows-gnu check -p rampart
cargo +stable-x86_64-pc-windows-gnu test -p rampart --lib   # unit tests
```

Interactive testing (deploy + transact) uses the CI-built `rampart.so` against a
Solana validator or devnet — see the demo-agent docs.

## Program ID

`6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr` (Anchor 1.2 / Solana 4.3.0)

## Repo layout

```
programs/rampart/src/            program source
  state.rs                       Vault / Policy / SpendTracker / Agent accounts
  constants.rs                   PDA seeds + defaults (allowlist 16, timelock 60, epoch 2160, slippage 100bps)
  error.rs                       error codes
  math.rs                        USD micro math + deviation_bps
  pyth.rs                        on-chain Pyth v2 price decode
  instructions/                  one module per instruction
programs/rampart/tests/          litesvm integration suite
.github/workflows/build-sbf.yml  CI: SBF build + tests + artifact
```

## Roadmap

- **Swap path** (Jupiter CPI) — currently the MVP proves the thesis with the
  transfer path fully enforced on-chain; the swap path is the next iteration.
- **Guard daemon** — off-chain monitor that watches spends and can trigger the
  owner kill switch.
- **Demo agent** — a script that signs intents as the agent and showcases the
  drain being blocked live on devnet.