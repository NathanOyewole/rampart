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

/// Maximum Meteora DBC curve progress (in basis points) a guarded DBC
/// transfer will act against.
///
/// The window between the floor and this ceiling is the tradeable band, and
/// the ceiling is the part that stops a graduation bot. Meteora's own
/// anti-sniping `RateLimiter` fights this by inflating fees, which a launchpad
/// can reconfigure and which never actually prevents the pool from being run
/// to threshold. The last 20% of a curve is where that happens: the quote
/// reserve is close to `migration_quote_threshold`, so a few SOL of buying
/// pressure graduates the token outright. An agent that can be talked into
/// "finish this one, it's nearly there" is the exact failure mode, and it is
/// cheaper to refuse than to detect afterwards.
///
/// A completed curve (10_000 bps) is already rejected earlier, inside
/// `inspect_dbc_pool`, because `quote_exact_in` fails once there is no curve
/// left to quote. This constant catches the band below that.
#[constant]
pub const MAX_DBC_PROGRESS_BPS: u16 = 8_000;