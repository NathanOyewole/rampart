use anchor_lang::prelude::*;

use crate::error::ErrorCode;

pub const PYTH_EXPO_OFFSET: usize = 0x14;
pub const PYTH_PRICE_OFFSET: usize = 0x30;
pub const PYTH_STATUS_OFFSET: usize = 0x44;
pub const PYTH_MIN_DATA_LEN: usize = 0x45;

pub const PYTH_STATUS_TRADING: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PythPrice {
    pub price: i64,
    pub expo: i32,
    pub status: u8,
}

fn read_i32(data: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_i64(data: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

pub fn decode_price(feed_data: &[u8]) -> Result<PythPrice> {
    if feed_data.len() < PYTH_MIN_DATA_LEN {
        return err!(ErrorCode::FeedTooShort);
    }
    let expo = read_i32(feed_data, PYTH_EXPO_OFFSET);
    let price = read_i64(feed_data, PYTH_PRICE_OFFSET);
    let status = feed_data[PYTH_STATUS_OFFSET];
    if price <= 0 {
        return err!(ErrorCode::InvalidPrice);
    }
    if status != PYTH_STATUS_TRADING {
        return err!(ErrorCode::PriceHalted);
    }
    Ok(PythPrice { price, expo, status })
}