use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;

use dynamic_bonding_curve::state::{PoolConfig, VirtualPool};
use dynamic_bonding_curve_sdk::quote::quote_exact_in;

use crate::error::ErrorCode;

/// Amount of quote-mint base units used purely to probe the curve for an
/// effective spot price. This is NOT the agent's actual trade size — it's a
/// small fixed reference amount so the derived price is stable and cheap to
/// compute. Denominated in the quote mint's smallest unit.
pub const PRICE_PROBE_QUOTE_AMOUNT: u64 = 1_000_000;

/// Fixed-point scale used for the derived price, chosen so it can be fed
/// straight into `math::to_usd_micro` / `math::deviation_bps` the same way a
/// Pyth (price, expo) pair is.
pub const DBC_PRICE_EXPO: i32 = -6;

pub struct DbcPrice {
    pub price: i64,
    pub expo: i32,
    /// Curve progress toward migration, in basis points (0 = just created,
    /// 10_000 = fully graduated into DAMM v2).
    ///
    /// OPEN ITEM: the exact field/method exposed by `VirtualPool` for this
    /// varies by crate version — confirm against the installed version's
    /// docs/IDL (`cargo doc -p dynamic-bonding-curve --open`) before relying
    /// on this in production. `pool_progress_bps` below is a placeholder
    /// that must be wired to the real field/helper.
    pub progress_bps: u16,
}

/// Decode a live DBC pool + its config into an effective spot price and
/// curve-progress reading, using Meteora's own quote math rather than
/// hand-rolled curve arithmetic.
pub fn decode_dbc_price(
    pool_data: &[u8],
    config_data: &[u8],
    current_timestamp: u64,
    current_slot: u64,
) -> Result<DbcPrice> {
    let mut pool_slice: &[u8] = pool_data;
    let pool =
        VirtualPool::try_deserialize(&mut pool_slice).map_err(|_| error!(ErrorCode::NotADbcPool))?;

    let mut config_slice: &[u8] = config_data;
    let config = PoolConfig::try_deserialize(&mut config_slice)
        .map_err(|_| error!(ErrorCode::NotADbcPool))?;

    let quote = quote_exact_in(
        &pool,
        &config,
        false, // probing quote-for-base to derive an effective base price
        current_timestamp,
        current_slot,
        PRICE_PROBE_QUOTE_AMOUNT,
        false,
    )
    .map_err(|_| error!(ErrorCode::InvalidPrice))?;

    if quote.amount_out == 0 {
        return err!(ErrorCode::InvalidPrice);
    }

    let price_scaled = (PRICE_PROBE_QUOTE_AMOUNT as u128)
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_div(quote.amount_out as u128))
        .ok_or(ErrorCode::MathOverflow)?;

    let price = i64::try_from(price_scaled).map_err(|_| ErrorCode::MathOverflow)?;

    // OPEN ITEM: replace with the verified progress accessor for the
    // installed crate version.
    let progress_bps = pool_progress_bps(&pool, &config)?;

    Ok(DbcPrice {
        price,
        expo: DBC_PRICE_EXPO,
        progress_bps,
    })
}

/// Placeholder — must be replaced with the verified way to read curve
/// progress toward migration on the installed `dynamic-bonding-curve`
/// version before this guard can be trusted in a live demo.
fn pool_progress_bps(_pool: &VirtualPool, _config: &PoolConfig) -> Result<u16> {
    // TODO: wire to the real field/helper (e.g. reserves vs migration
    // threshold, or a dedicated progress accessor if one exists on this
    // crate version). Returning 0 here fails safe: until this is verified,
    // every pool reads as "too early" and guarded_dbc_transfer will reject
    // rather than silently pass an unverified check.
    Ok(0)
}
