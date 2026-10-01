//! Shared test fixtures.
//!
//! The Meteora DBC fixture is ported from Meteora's own validated unit test
//! `initialize_pool_and_config()` in
//! `programs/dynamic-bonding-curve/src/tests/test_swap.rs` at the revision this
//! crate depends on. Nothing here is invented: a hand-written pool of zeroes
//! cannot be quoted, so the curve parameters have to come from the same
//! construction Meteora uses to build a real pool.

#![allow(dead_code)]

use anchor_lang::prelude::*;
use dynamic_bonding_curve::{
    constants::{BASIS_POINT_MAX, MAX_CURVE_POINT, MAX_SQRT_PRICE},
    fee_math::pow,
    params::liquidity_distribution::{
        get_migration_threshold_price, LiquidityDistributionParameters,
    },
    state::{
        fee::VolatilityTracker, CollectFeeMode, LiquidityDistributionConfig, PoolConfig, VirtualPool,
    },
};

/// Meteora's test constant: 50k USDC of quote volume graduates the curve.
pub const MIGRATION_QUOTE_THRESHOLD: u64 = 50_000_000_000;
/// Meteora's test constant: 80 bps per bin.
pub const BIN_STEP: u16 = 80;
/// Meteora's test constant, giving a starting price of 0.20.
pub const SQRT_ACTIVE_ID: i32 = -100;

/// Deep-curve liquidity, verbatim from Meteora's test. Real liquidity 1e24.
/// A trade of a few SOL barely moves this curve, so price impact rounds to
/// 0 bps. Used for every "this should be allowed" case.
pub const DEEP_LIQUIDITY: u128 = 1_000_000_000_000_000_000_000_000u128 << 64;

/// Shallow-curve liquidity (real 45e9, stored Q64.64). Sized so that a 1 SOL
/// trade moves the curve price by roughly 200 bps: enough to exercise the
/// price-impact gate, which is unreachable on a deep curve because a u64 quote
/// amount cannot move it more than a fraction of a basis point.
pub const SHALLOW_LIQUIDITY: u128 = 45_000_000_000u128 << 64;

/// A DBC `(VirtualPool, PoolConfig)` pair plus the pubkeys they live at.
pub struct DbcFixture {
    pub pool_key: Pubkey,
    pub config_key: Pubkey,
    pub pool: VirtualPool,
    pub config: PoolConfig,
}

/// Port of Meteora's `get_price_from_id` (their
/// `src/tests/price_math.rs`). That module is `#[cfg(test)]` inside the DBC
/// crate, so it is not importable from here; this is the same five lines.
/// `sqrt_price = (1 + bin_step/10_000) ^ active_id`, in Q64.64.
fn sqrt_price_from_id(active_id: i32, bin_step: u16) -> u128 {
    const SCALE_OFFSET: u32 = 64;
    const ONE: u128 = 1u128 << SCALE_OFFSET;
    let bps = u128::from(bin_step) << SCALE_OFFSET;
    let base = ONE + bps / u128::from(BASIS_POINT_MAX);
    pow(base, active_id).expect("sqrt_price_from_id: pow overflow")
}

/// Build a valid DBC pool/config pair.
///
/// `quote_reserve` is the pool's current quote reserve, which is what rampart
/// turns into curve-progress bps (`reserve / migration_quote_threshold`).
/// `liquidity` is the Q64.64 liquidity of the single curve segment.
pub fn dbc_fixture(quote_reserve: u64, liquidity: u128) -> DbcFixture {
    let config_key = Pubkey::new_unique();
    let pool_key = Pubkey::new_unique();

    let sqrt_start_price = sqrt_price_from_id(SQRT_ACTIVE_ID, BIN_STEP);
    let curve = vec![LiquidityDistributionParameters {
        sqrt_price: MAX_SQRT_PRICE,
        liquidity,
    }];
    let migration_sqrt_price =
        get_migration_threshold_price(MIGRATION_QUOTE_THRESHOLD, sqrt_start_price, &curve)
            .expect("migration threshold price");

    let mut config = PoolConfig {
        migration_quote_threshold: MIGRATION_QUOTE_THRESHOLD,
        sqrt_start_price,
        migration_sqrt_price,
        collect_fee_mode: CollectFeeMode::OutputToken.into(),
        ..Default::default()
    };
    for i in 0..MAX_CURVE_POINT {
        config.curve[i] = if i < curve.len() {
            curve[i].to_liquidity_distribution_config()
        } else {
            LiquidityDistributionConfig {
                sqrt_price: MAX_SQRT_PRICE,
                liquidity: 0,
            }
        };
    }

    let mut pool = VirtualPool::default();
    pool.initialize(
        VolatilityTracker::default(),
        config_key,
        Pubkey::default(),
        Pubkey::default(),
        Pubkey::default(),
        Pubkey::default(),
        sqrt_start_price,
        0,
        0,
        1_000_000_000_000,
        0,
    );
    pool.quote_reserve = quote_reserve;

    DbcFixture {
        pool_key,
        config_key,
        pool,
        config,
    }
}

/// Serialize a zero-copy Anchor account the way the runtime stores it: the
/// 8-byte discriminator, then the Pod representation. `AccountDeserialize` for
/// a `#[account(zero_copy)]` struct checks the discriminator and then
/// `pod_read_unaligned`s the remainder, so a zeroed or mis-sized buffer is
/// rejected (or read as garbage) before any field is trusted.
pub fn zero_copy_account_data<T>(account: &T) -> Vec<u8>
where
    T: anchor_lang::Discriminator + anchor_lang::__private::bytemuck::Pod,
{
    let mut data = Vec::with_capacity(T::DISCRIMINATOR.len() + std::mem::size_of::<T>());
    data.extend_from_slice(T::DISCRIMINATOR);
    data.extend_from_slice(anchor_lang::__private::bytemuck::bytes_of(account));
    data
}

impl DbcFixture {
    pub fn pool_data(&self) -> Vec<u8> {
        zero_copy_account_data(&self.pool)
    }

    pub fn config_data(&self) -> Vec<u8> {
        zero_copy_account_data(&self.config)
    }

    /// A fixture whose `VirtualPool.config` points at a *different* pubkey
    /// than the `PoolConfig` account it is paired with. Proves the handler
    /// cannot be fed a healthy config next to somebody else's pool.
    pub fn with_config_mismatch(mut self) -> Self {
        self.pool.config = Pubkey::new_unique();
        self
    }
}
