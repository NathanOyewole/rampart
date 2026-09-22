use anchor_lang::prelude::*;

use crate::error::ErrorCode;

pub const MIN_EXPO: i32 = -12;
pub const MAX_EXPO: i32 = 3;

fn pow10(exponent: u32) -> u128 {
    let mut acc: u128 = 1;
    for _ in 0..exponent {
        acc = acc.saturating_mul(10);
    }
    acc
}

#[inline]
fn abs_diff_i64(a: i64, b: i64) -> u128 {
    if a >= b {
        (a as u128).wrapping_sub(b as u128)
    } else {
        (b as u128).wrapping_sub(a as u128)
    }
}

pub fn to_usd_micro(amount_lamports: u64, price_raw: i64, expo: i32) -> Result<u64> {
    if expo < MIN_EXPO || expo > MAX_EXPO {
        return err!(ErrorCode::PriceExponentInvalid);
    }
    if price_raw <= 0 {
        return err!(ErrorCode::InvalidPrice);
    }
    let product = (amount_lamports as u128)
        .checked_mul(price_raw as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    let divisor = 3i32 - expo;
    let divisor = if divisor < 0 {
        return err!(ErrorCode::PriceExponentInvalid);
    } else {
        pow10(divisor as u32)
    };
    let micro = product / divisor;
    Ok(u64::try_from(micro).map_err(|_| ErrorCode::MathOverflow)?)
}

pub fn deviation_bps(live: i64, reference: i64) -> Result<u64> {
    if reference <= 0 || live <= 0 {
        return err!(ErrorCode::InvalidPrice);
    }
    let diff = abs_diff_i64(live, reference);
    let scaled = diff
        .checked_mul(10_000)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok((scaled / reference as u128) as u64)
}