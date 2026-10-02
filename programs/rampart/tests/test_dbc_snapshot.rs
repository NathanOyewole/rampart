//! Host-side tests for the DBC snapshot reader.
//!
//! `dbc::inspect_dbc_pool` is pure account-parsing plus Meteora's own quote
//! math: it touches no SVM state and CPIs into nothing. That makes it
//! testable without a built `.so`, so these run in the normal `cargo test`
//! pass, not just in the SBF job.

mod common;

use anchor_lang::{error::Error, AccountDeserialize, Discriminator, Space};
use common::{
    dbc_fixture, zero_copy_account_data, DbcFixture, DEEP_LIQUIDITY, MIGRATION_QUOTE_THRESHOLD,
    SHALLOW_LIQUIDITY,
};
use dynamic_bonding_curve::state::{PoolConfig, VirtualPool};
use rampart::dbc::{inspect_dbc_pool, DbcSnapshot};

const E_NOT_DBC_POOL: u32 = 6020;
const E_QUOTE_FAILED: u32 = 6023;

/// One SOL in lamports: a realistic trade size for the vault.
const TRADE: u64 = 1_000_000_000;
const NOW_TS: u64 = 1_700_000_000;
const NOW_SLOT: u64 = 300_000_000;

fn err_code(res: &anchor_lang::Result<DbcSnapshot>) -> u32 {
    match res {
        Ok(snapshot) => panic!(
            "expected an error, got progress {} bps / impact {} bps",
            snapshot.progress_bps, snapshot.price_impact_bps
        ),
        Err(Error::AnchorError(anchor_err)) => anchor_err.error_code_number,
        Err(other) => panic!("expected an anchor error, got {other:?}"),
    }
}

fn inspect(fixture: &DbcFixture, amount: u64) -> anchor_lang::Result<DbcSnapshot> {
    inspect_dbc_pool(
        &fixture.pool_data(),
        &fixture.config_data(),
        &fixture.config_key,
        amount,
        NOW_TS,
        NOW_SLOT,
    )
}

#[test]
fn healthy_pool_reads_progress_and_impact() {
    // 40% of the way to migration: comfortably past the 2_000 bps floor and
    // still short of the threshold, so the curve is still tradeable.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY);
    let snapshot = inspect(&fixture, TRADE).expect("deep pool must quote");

    assert_eq!(snapshot.progress_bps, 4_000);
    // A deep curve cannot be moved by a u64-sized quote, so impact is 0. This
    // is the "allowed" case: an ordinary trade on a liquid pool.
    assert_eq!(snapshot.price_impact_bps, 0);
}

#[test]
fn progress_tracks_quote_reserve() {
    for (reserve, expected) in [
        (MIGRATION_QUOTE_THRESHOLD / 2, 5_000u16),
        (MIGRATION_QUOTE_THRESHOLD * 9 / 10, 9_000),
    ] {
        let fixture = dbc_fixture(reserve, DEEP_LIQUIDITY);
        let snapshot = inspect(&fixture, TRADE).expect("deep pool must quote");
        assert_eq!(snapshot.progress_bps, expected, "reserve {reserve}");
    }
}

#[test]
fn tradeable_band_excludes_both_ends_of_the_curve() {
    // MAX_DBC_PROGRESS_BPS (8_000) only works if a pool inside the graduation
    // band still *quotes*. A completed curve fails inside `inspect_dbc_pool`
    // with DbcQuoteFailed, so if 85% also failed to quote, the handler would
    // report the wrong error and the ceiling would be dead code.
    //
    // `guarded_dbc_transfer` relies on exactly this: past the ceiling it must
    // see Ok(snapshot) with a high progress_bps, not an Err. Pinned here
    // because the matching integration test only runs in CI.
    let just_past_ceiling = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 85 / 100, DEEP_LIQUIDITY);
    let snapshot = inspect(&just_past_ceiling, TRADE).expect("85% must still quote");
    assert_eq!(snapshot.progress_bps, 8_500);
    assert!(
        snapshot.progress_bps > rampart::constants::MAX_DBC_PROGRESS_BPS,
        "the 85% fixture must sit above the ceiling, got {}",
        snapshot.progress_bps
    );

    // And the band edge itself is still inside the window.
    let at_ceiling = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY);
    let inside = inspect(&at_ceiling, TRADE).expect("40% must quote");
    assert!(
        inside.progress_bps > rampart::constants::MIN_DBC_PROGRESS_BPS
            && inside.progress_bps < rampart::constants::MAX_DBC_PROGRESS_BPS,
        "40% must sit inside the tradeable band, got {}",
        inside.progress_bps
    );

    // Sanity: the constants themselves.
    assert!(rampart::constants::MIN_DBC_PROGRESS_BPS < rampart::constants::MAX_DBC_PROGRESS_BPS);
    assert_eq!(rampart::constants::MAX_DBC_PROGRESS_BPS, 8_000);
}

#[test]
fn shallow_curve_reports_real_price_impact() {
    // The gate is only meaningful if impact is actually reachable, and it is
    // not on a deep curve. This pins that a shallow curve does move.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, SHALLOW_LIQUIDITY);
    let snapshot = inspect(&fixture, TRADE).expect("shallow pool must quote");
    assert_eq!(snapshot.progress_bps, 4_000);
    assert!(
        snapshot.price_impact_bps > 100,
        "1 SOL on a shallow curve should exceed 100 bps, got {}",
        snapshot.price_impact_bps
    );
}

#[test]
fn impact_grows_with_trade_size() {
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, SHALLOW_LIQUIDITY);
    let small = inspect(&fixture, TRADE / 10).expect("quote");
    let large = inspect(&fixture, TRADE).expect("quote");
    assert!(
        large.price_impact_bps > small.price_impact_bps,
        "bigger trade must move the price more: {} vs {}",
        large.price_impact_bps,
        small.price_impact_bps
    );
}

#[test]
fn pool_must_belong_to_the_supplied_config() {
    // An agent hands in a healthy PoolConfig next to a pool that was created
    // under a different config: the config could be quoting a good curve while
    // the pool has none of its liquidity.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY)
        .with_config_mismatch();
    assert_eq!(err_code(&inspect(&fixture, TRADE)), E_NOT_DBC_POOL);
}

#[test]
fn completed_curve_cannot_be_quoted() {
    // At the migration threshold the curve is complete: there is no price left
    // to read, so the trade must be refused rather than priced at zero.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD, DEEP_LIQUIDITY);
    assert_eq!(err_code(&inspect(&fixture, TRADE)), E_QUOTE_FAILED);
}

#[test]
fn zeroed_pool_is_not_our_pool() {
    // A well-formed but unregistered pool body: all fields zero, so its
    // `config` points nowhere near the PoolConfig it was handed.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY);
    let zeroes = vec![0u8; fixture.pool_data().len()];
    let res = inspect_dbc_pool(
        &zeroes,
        &fixture.config_data(),
        &fixture.config_key,
        TRADE,
        NOW_TS,
        NOW_SLOT,
    );
    assert_eq!(err_code(&res), E_NOT_DBC_POOL);
}

#[test]
fn wrong_discriminator_is_not_a_pool() {
    // A pool body with the discriminator scribbled out. A zeroed body fails
    // the field checks; this fails the header check.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY);
    let mut data = fixture.pool_data();
    data[0] ^= 0xff;
    let res = inspect_dbc_pool(
        &data,
        &fixture.config_data(),
        &fixture.config_key,
        TRADE,
        NOW_TS,
        NOW_SLOT,
    );
    assert_eq!(err_code(&res), E_NOT_DBC_POOL);
}

#[test]
fn mis_sized_accounts_are_rejected_not_fatal() {
    // Regression: Anchor's zero-copy `try_deserialize` calls
    // `bytemuck::pod_read_unaligned`, which PANICS unless the buffer is exactly
    // 8 + size_of::<T>() bytes. These accounts are `UncheckedAccount`s, so
    // before the length guard in `dbc::deserialize_zero_copy` each of these
    // cases aborted the program (SIGABRT) instead of returning NotADbcPool.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY);
    let exact = fixture.pool_data();

    for delta in [-8i32, 8, 64] {
        let mut data = exact.clone();
        if delta < 0 {
            data.truncate(data.len() - (-delta) as usize);
        } else {
            data.extend(std::iter::repeat(0u8).take(delta as usize));
        }
        let res = inspect_dbc_pool(
            &data,
            &fixture.config_data(),
            &fixture.config_key,
            TRADE,
            NOW_TS,
            NOW_SLOT,
        );
        assert_eq!(err_code(&res), E_NOT_DBC_POOL, "pool delta {delta}");
    }

    // Same for the config side, and for a buffer that is far too short to hold
    // the discriminator at all.
    let config_exact = fixture.config_data();
    let mut data = config_exact.clone();
    data.extend_from_slice(&[0u8; 16]);
    let res = inspect_dbc_pool(
        &exact,
        &data,
        &fixture.config_key,
        TRADE,
        NOW_TS,
        NOW_SLOT,
    );
    assert_eq!(err_code(&res), E_NOT_DBC_POOL, "config too long");

    let res = inspect_dbc_pool(
        &exact,
        &config_exact[..4],
        &fixture.config_key,
        TRADE,
        NOW_TS,
        NOW_SLOT,
    );
    assert_eq!(err_code(&res), E_NOT_DBC_POOL, "config too short");
}

#[test]
fn fixture_sizes_match_anchor_init_space() {
    // Pins the assumption the length guard is built on: for a zero-copy Anchor
    // account, INIT_SPACE is the Pod size, and the stored buffer is the
    // discriminator plus that.
    assert_eq!(VirtualPool::INIT_SPACE, std::mem::size_of::<VirtualPool>());
    assert_eq!(PoolConfig::INIT_SPACE, std::mem::size_of::<PoolConfig>());
    assert_eq!(VirtualPool::DISCRIMINATOR.len(), 8);
    assert_eq!(PoolConfig::DISCRIMINATOR.len(), 8);
}

#[test]
fn fixture_bytes_round_trip_through_anchor() {
    // Guards the fixture itself: if a future DBC bump changes the struct
    // layout, the serialized bytes and the deserializer stay in agreement.
    let fixture = dbc_fixture(MIGRATION_QUOTE_THRESHOLD * 2 / 5, DEEP_LIQUIDITY);
    let data = zero_copy_account_data(&fixture.pool);
    let mut slice: &[u8] = &data;
    let decoded = VirtualPool::try_deserialize(&mut slice).expect("roundtrip");
    assert_eq!(decoded.config, fixture.config_key);
    assert_eq!(decoded.quote_reserve, fixture.pool.quote_reserve);
    assert_eq!(decoded.sqrt_price, fixture.pool.sqrt_price);
}
