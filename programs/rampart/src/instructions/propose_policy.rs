use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct ProposePolicy<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault)]
    pub policy: Account<'info, Policy>,
}

pub fn handle_propose_policy(
    ctx: Context<ProposePolicy>,
    daily_usd_cap_micro: u64,
    per_tx_usd_cap_micro: u64,
    max_slippage_bps: u16,
    epoch_len_slots: u64,
    allowlist: Vec<Pubkey>,
) -> Result<()> {
    if daily_usd_cap_micro == 0 || per_tx_usd_cap_micro == 0 {
        return err!(ErrorCode::InvalidCap);
    }
    if allowlist.len() > MAX_ALLOWLIST {
        return err!(ErrorCode::AllowlistTooLarge);
    }

    let clock = Clock::get()?;
    let policy = &mut ctx.accounts.policy;
    policy.pending_exists = true;
    policy.pending_daily_usd_cap_micro = daily_usd_cap_micro;
    policy.pending_per_tx_usd_cap_micro = per_tx_usd_cap_micro;
    policy.pending_max_slippage_bps = max_slippage_bps;
    policy.pending_epoch_len_slots = epoch_len_slots;
    policy.pending_effective_slot = clock.slot.checked_add(ctx.accounts.vault.timelock_slots)
        .ok_or(ErrorCode::MathOverflow)?;
    policy.pending_allowlist_len = allowlist.len() as u32;
    for (i, key) in allowlist.iter().enumerate() {
        policy.pending_allowlist[i] = *key;
    }
    Ok(())
}