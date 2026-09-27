use anchor_lang::prelude::*;

#[constant]
pub const VAULT_SEED: &[u8] = b"rampart_vault";

#[constant]
pub const TREASURY_SEED: &[u8] = b"rampart_treasury";

#[constant]
pub const POLICY_SEED: &[u8] = b"rampart_policy";

#[constant]
pub const SPEND_SEED: &[u8] = b"rampart_spend";

#[constant]
pub const AGENT_SEED: &[u8] = b"rampart_agent";

#[constant]
pub const MAX_ALLOWLIST: usize = 16;

#[constant]
pub const DEFAULT_TIMELOCK_SLOTS: u64 = 60;

#[constant]
pub const DEFAULT_EPOCH_SLOTS: u64 = 2160;

#[constant]
pub const DEFAULT_SLIPPAGE_BPS: u16 = 100;

/// Minimum Meteora DBC curve progress (in basis points, 10_000 = fully
/// graduated) required before a guarded DBC transfer will release funds
/// against a pool priced off that curve. Guards against acting on a pool
/// that has barely any trading history yet.
#[constant]
pub const MIN_DBC_PROGRESS_BPS: u16 = 2_000;