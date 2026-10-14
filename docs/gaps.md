# Gaps

Devnet only. The program at `6Ea4Sq…` is immutable. Source fixes below are not in that binary.

FYEO scan, 13 Oct 2026, commit `1f54fe2`. Ten findings. Triage:

1. Stale reference price. High. Real. No update path in the deployed binary. `refresh_reference` is in source for the next program id. Owner only. Same pinned feed.
2. Agent-supplied price feed. Medium. Real, and the same bug as 4 and 7. Source now pins the feed pubkey at init and refuses any other account on a spend. Not in the deployed binary.
3. Withdraw bypasses freeze. Medium. Accepted. Freeze stops the agent. Withdraw is the owner's recovery. The key that set the freeze is the key that can take the funds back. Blocking withdraw would lock the owner out of their own vault.
4. Same as 2.
5. Init snapshots an unchecked feed. Low. The owner is the signer. They choose the feed. The pin stops the agent from swapping it later. No Pyth program-id check, because the demo feed is a mock.
6. Run-token compare. Low. Fixed in the server. Constant-time compare.
7. Same as 2, on the DBC path. Source only. That path is not in the deployed binary.
8. Helius key in error strings. Low. Fixed in the server. Every error detail is redacted.
9. Demo run open by default. Low. Fixed in the server. No token means the endpoint refuses. Set `RAMPART_RUN_TOKEN` on the host if a run should be possible.
10. Same as 5. Info. No reachable exploit. Owner is the only caller.

Still open, and still not in any binary:

- No staleness window. A feed that says trading and has not published still passes.
- `guarded_dbc_transfer` is source and CI only.
- No swap. The vault does not call Meteora.

Do not move mainnet SOL until the feed pin, the refresh, and a staleness window are in the binary that would hold the funds.
