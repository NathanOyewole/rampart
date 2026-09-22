use anchor_lang::prelude::*;

use crate::constants::MAX_ALLOWLIST;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub treasury_bump: u8,
    pub bump: u8,
    pub frozen: bool,
    pub reference_price: i64,
    pub reference_expo: i32,
    pub timelock_slots: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub vault: Pubkey,
    pub daily_usd_cap_micro: u64,
    pub per_tx_usd_cap_micro: u64,
    pub max_slippage_bps: u16,
    pub epoch_len_slots: u64,
    pub allowlist_len: u32,
    pub allowlist: [Pubkey; MAX_ALLOWLIST],
    pub pending_exists: bool,
    pub pending_daily_usd_cap_micro: u64,
    pub pending_per_tx_usd_cap_micro: u64,
    pub pending_max_slippage_bps: u16,
    pub pending_epoch_len_slots: u64,
    pub pending_effective_slot: u64,
    pub pending_allowlist_len: u32,
    pub pending_allowlist: [Pubkey; MAX_ALLOWLIST],
}

#[account]
#[derive(InitSpace)]
pub struct SpendTracker {
    pub vault: Pubkey,
    pub epoch_slot: u64,
    pub spent_usd_micro: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub vault: Pubkey,
    pub key: Pubkey,
    pub active: bool,
}