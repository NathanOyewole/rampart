# Rampart

On-chain policy vaults for trading agents on Solana.

The agent signs. The program decides. Funds sit in program-owned PDAs, and the policy is enforced in the instruction that moves them. A compromised agent key can request a drain. It cannot sign one.

Live demo: [rampart.pxxl.click](https://rampart.pxxl.click)

First commit 22 September 2026 (`e993972`, the policy vault and CI). World's Fair deadline 12 October 2026. There is no earlier history, and there was no 25 September submission.

## What is live

The devnet program was deployed with `solana program deploy --final`. Upgrade authority is the system program (`11111111111111111111111111111111`) and cannot be set again.

| | Source | CI | Devnet `6Ea4Sq…` |
|---|---|---|---|
| `guarded_transfer` and the guard stack below | yes | yes | yes |
| `guarded_dbc_transfer` and the 20–80% curve band | yes | yes | no |

The DBC path needs a new program id. It is not in the binary a judge hits.

Verify immutability: fetch the program account, read `ProgramData`, authority at offset 8..40.

## Guards

On the live instruction, before lamports move:

- destination allowlist
- per-tx USD cap
- per-epoch USD cap
- Pyth price band against the vault's reference
- halted feed
- owner freeze
- timelock on policy changes
- agent cannot withdraw (withdraw requires the owner signature; the transaction is never sent)

Observed refusals from the devnet demo:

| Refusal | Code |
|---|---|
| `DestinationNotAllowed` | 6004 |
| `PerTxCapExceeded` | 6007 |
| `DailyCapExceeded` | 6008 |
| `VaultFrozen` | 6001 |
| `PolicyNotEffective` | 6016 |
| `PriceDeviationTooHigh` | 6013 |
| `PriceHalted` | 6011 |

`PriceHalted` is a halted feed, not a staleness check. Feed pinning and a staleness window are not in this program.

## Accounts

| Account | Seeds | Holds |
|---|---|---|
| Vault | `rampart_vault`, owner | owner, frozen, reference price, timelock |
| Policy | `rampart_policy`, vault | caps, slippage, allowlist, pending policy |
| SpendTracker | `rampart_spend`, vault | epoch spend |
| Agent | `rampart_agent`, vault, agent | registry |
| Treasury | `rampart_treasury`, vault | the capital |

## DBC guard

In source and CI only. Four checks before funds move: real Meteora pool and config, owner-allowlisted pool, curve progress between 20% and 80%, price impact inside `max_slippage_bps`.

It gates and releases capital. It does not call Meteora. A swap needs `pool_authority` to sign, and that second signer is not worth the custody.

`PoolTooLate` is 6025. Existing codes were not renumbered.

## Demo

[rampart.pxxl.click](https://rampart.pxxl.click) runs the live stack against devnet. Changelog and status are `/changelog` and `/status`.

| | |
|---|---|
| Program | `6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr` |
| Oracle mock | `2xbNzbkEZ65hLzi9TgdMBcncup6a5CA1qi3QLVTrwQ2p` |
| Sponsor | `2QXPxqAR41JEDdPgdQp2MX3S4F26xNAX4uDn2sqtvS5h` |

Each run funds a fresh runner from the sponsor and sweeps it back. A run is about 0.015 SOL in fees and rent. The deposit defaults to 0.4 SOL. Caps scale with it.

```bash
cd client
pnpm install
pnpm run build:web
pnpm start
```

RPC is `RAMPART_RPC`, else Helius devnet from `HELIUS_API_KEY`. Do not point this demo at the public devnet RPC.

## Host

`client/Dockerfile` is the deploy. Long-running process, not a serverless function. A run holds confirmations open for longer than a function timeout.

| Var | |
|---|---|
| `RAMPART_WALLET_B64` | sponsor keypair, base64 JSON or raw bytes |
| `HELIUS_API_KEY` or `RAMPART_RPC` | `RAMPART_RPC` wins |
| `RAMPART_RUN_TOKEN` | optional gate on RUN and RESET |
| `PORT` | host-assigned |

Base directory on the host is `client`. `/healthz` redacts `api-key`. If `RAMPART_RUN_TOKEN` is unset, anyone who can open the URL can spend the sponsor's devnet SOL.

## Tests

37 in CI: 22 litesvm end-to-end, 12 host-side DBC fixtures, 3 unit. Workflow: `.github/workflows/build-sbf.yml`. Names are the test functions in `programs/rampart/tests/`.

## Layout

```
programs/rampart/src/     program
programs/oracle-mock/     deterministic feed for the demo
client/                   SDK, demo, API, SPA
docs/gaps.md              what is not built
```

## Not built

Feed identity is not pinned. There is no staleness window. The reference price is not re-snapped. No mainnet. No swap execution.
