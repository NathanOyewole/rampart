# Gaps

Devnet only. These are missing from the program, not from the demo.

1. Feed identity is unchecked. `price_feed` is an `UncheckedAccount`. Any account that decodes as a price can be passed. Pin the feed in policy, or check the owner.
2. No staleness window. `PriceHalted` is a status flag, not an age check.
3. Reference price is snapshotted at init and not refreshed. A slow drift can sit inside the band forever.
4. `guarded_dbc_transfer` is source and CI only. The deployed program cannot be upgraded.
5. No swap. The vault does not call Meteora.

Do not move mainnet SOL until 1–3 are in the binary that would hold the funds.
