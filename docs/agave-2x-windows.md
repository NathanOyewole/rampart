# Local Solana validator on native Windows

`solana-test-validator` from the **agave 4.x** toolchain does **not** work on
native Windows: it fails while unpacking `genesis.tar.bz2` before any program
code runs.

- Error: `Failed to create ledger ... io error: Error checking to unpack genesis
  archive: IO error: Access is denied. (os error 5)`
- Reproducible as elevated admin, at any disk location, with Defender
  exclusions, and with a clean PATH. Not Defender, not tar-on-PATH, not folder
  permissions.
- Upstream: anza-xyz/agave issue #24 ("solana-test-validator does not work
  properly on Windows"). The old external `tar`/`bzip2` shell-out was replaced
  by the native tar crate (PR #3079), but the 4.x line still fails inside
  `agave_snapshots::unarchive` / `hardened_unpack` on Windows.

## Working recipe: agave 2.1.19 side-install

The 2.x line works (genesis unpack is fine). Install it into its own data dir so
the primary 4.3.0 toolchain is untouched:

1. Download `https://release.anza.xyz/v2.1.19/agave-install-init-x86_64-pc-windows-msvc.exe`.
2. Elevated: `agave-install-init-2.1.19.exe 2.1.19 --data-dir C:\Users\Olufemi\.local\share\solana2 --no-modify-path`
   (the installer may appear to hang after copying — the install actually lands;
   it also creates `active_release` automatically).
3. Verify: `C:\Users\Olufemi\.local\share\solana2\active_release\bin\solana.exe --version`
   → `2.1.19`.
4. Run the validator **elevated** (it needs `SeLockMemoryPrivilege`; non-elevated
   → `Os { code: 1314 }` panic in `solana-test-validator.rs:117`):

```powershell
$bin = "C:\Users\Olufemi\.local\share\solana2\active_release\bin"
& "$bin\solana-test-validator.exe" --reset --ledger C:\Users\Public\rampart-ledger --rpc-port 8899
```

## Caveats

- `solana-keygen`/`solana airdrop` etc. from the 2.x bin are usable for the
  local cluster. The primary toolchain remains agave 4.3.0 (build/deploy to
  devnet).
- Programs built with platform-tools v1.57 (4.x) should load on a 2.1.19
  validator; if you ever hit an SBF loader mismatch locally, rebuild the `.so`
  with the 2.x `cargo-build-sbf` for local-only runs.
- The devnet demo is the product story; the local validator is only an offline
  convenience.