use anchor_lang::prelude::*;

use dynamic_bonding_curve::state::{PoolConfig, VirtualPool};
use dynamic_bonding_curve_sdk::quote_exact_in::quote_exact_in;

use crate::error::ErrorCode;

/// Health readings taken from a live Meteora DBC pool. Both values are ratios,
/// so they are unit-free: no oracle is needed for a token that has no price
/// feed yet, and there is no exponent to reconcile with the vault's Pyth
/// reference.
pub struct DbcSnapshot {
    /// Curve progress toward migration in basis points:
    /// quote_reserve / migration_quote_threshold, capped at 10_000.
    pub progress_bps: u16,
    /// Price impact of buying `quote_amount` on the curve, in basis points,
    /// computed from the pool's sqrt price before/after via Meteora's own
    /// quote math (`quote_exact_in`). Assumes the pool's quote mint is SOL /
    /// wSOL (9 decimals) so `quote_amount` can be expressed in lamports.
    pub price_impact_bps: u64,
}

/// Deserialize a DBC `VirtualPool` + `PoolConfig` pair and read its health.
///
/// The caller is responsible for verifying both accounts are owned by the DBC
/// program before passing their bytes in. This function verifies the pool
/// actually belongs to the supplied config, so an agent can't mix a healthy
/// config with a different pool.
pub fn inspect_dbc_pool(
    pool_data: &[u8],
    config_data: &[u8],
    config_key: &Pubkey,
    quote_amount: u64,
    current_timestamp: u64,
    current_slot: u64,
) -> Result<DbcSnapshot> {
    let mut pool_slice: &[u8] = pool_data;
    let pool = VirtualPool::try_deserialize(&mut pool_slice)
        .map_err(|_| error!(ErrorCode::NotADbcPool))?;

    let mut config_slice: &[u8] = config_data;
    let config = PoolConfig::try_deserialize(&mut config_slice)
        .map_err(|_| error!(ErrorCode::NotADbcPool))?;

    // Copy fields out by value (zero-copy structs; avoid holding references).
    let pool_config_key: Pubkey = pool.config;
    if pool_config_key != *config_key {
        return err!(ErrorCode::NotADbcPool);
    }

    let reserve: u64 = pool.quote_reserve;
    let threshold: u64 = config.migration_quote_threshold;
    let current_sqrt: u128 = pool.sqrt_price;
    if threshold == 0 || current_sqrt == 0 {
        return err!(ErrorCode::NotADbcPool);
    }

    let progress = ((reserve as u128) * 10_000 / (threshold as u128)).min(10_000);

    // Errors here also cover "curve already complete" and "pool not active".
    let quote = quote_exact_in(
        &pool,
        &config,
        false, // quote -> base: the agent is buying the token
        current_timestamp,
        current_slot,
        quote_amount,
        false, // no referral
        false, // not the creator's first-swap bundle
    )
    .map_err(|_| error!(ErrorCode::DbcQuoteFailed))?;

    // sqrt_price is Q64.64. Price ratio = (next_sqrt / current_sqrt)^2.
    let next_sqrt: u128 = quote.next_sqrt_price;
    let sqrt_ratio_bps = next_sqrt
        .checked_mul(10_000)
        .ok_or(ErrorCode::MathOverflow)?
        / current_sqrt;
    let price_ratio_bps = sqrt_ratio_bps
        .checked_mul(sqrt_ratio_bps)
        .ok_or(ErrorCode::MathOverflow)?
        / 10_000;
    let impact = price_ratio_bps.saturating_sub(10_000);

    Ok(DbcSnapshot {
        progress_bps: progress as u16,
        price_impact_bps: u64::try_from(impact).unwrap_or(u64::MAX),
    })
}
