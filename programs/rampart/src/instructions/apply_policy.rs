use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct ApplyPolicy<'info> {
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

pub fn handle_apply_policy(ctx: Context<ApplyPolicy>) -> Result<()> {
    let clock = Clock::get()?;
    let policy = &mut ctx.accounts.policy;
    if !policy.pending_exists {
        return err!(ErrorCode::NoPendingPolicy);
    }
    if clock.slot < policy.pending_effective_slot {
        return err!(ErrorCode::PolicyNotEffective);
    }

    policy.daily_usd_cap_micro = policy.pending_daily_usd_cap_micro;
    policy.per_tx_usd_cap_micro = policy.pending_per_tx_usd_cap_micro;
    policy.max_slippage_bps = policy.pending_max_slippage_bps;
    policy.epoch_len_slots = policy.pending_epoch_len_slots;
    policy.allowlist_len = policy.pending_allowlist_len;
    policy.allowlist = policy.pending_allowlist;
    policy.pending_exists = false;
    Ok(())
}