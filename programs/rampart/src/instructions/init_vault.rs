use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::pyth;
use crate::state::*;

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = owner,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = owner,
        space = 8 + SpendTracker::INIT_SPACE,
        seeds = [SPEND_SEED, vault.key().as_ref()],
        bump
    )]
    pub spend_tracker: Account<'info, SpendTracker>,
    /// CHECK: pyth price feed account, read-only.
    pub price_feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_vault(
    ctx: Context<InitVault>,
    daily_usd_cap_micro: u64,
    per_tx_usd_cap_micro: u64,
) -> Result<()> {
    if daily_usd_cap_micro == 0 || per_tx_usd_cap_micro == 0 {
        return err!(ErrorCode::InvalidCap);
    }

    let feed_data = ctx.accounts.price_feed.try_borrow_data()?;
    let price = pyth::decode_price(&feed_data)?;

    let vault_key = ctx.accounts.vault.key();
    let t_bump = treasury_bump(&vault_key)?;

    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.treasury_bump = t_bump;
    vault.bump = ctx.bumps.vault;
    vault.frozen = false;
    vault.reference_price = price.price;
    vault.reference_expo = price.expo;
    vault.timelock_slots = DEFAULT_TIMELOCK_SLOTS;

    let policy = &mut ctx.accounts.policy;
    policy.vault = ctx.accounts.vault.key();
    policy.daily_usd_cap_micro = daily_usd_cap_micro;
    policy.per_tx_usd_cap_micro = per_tx_usd_cap_micro;
    policy.max_slippage_bps = DEFAULT_SLIPPAGE_BPS;
    policy.epoch_len_slots = DEFAULT_EPOCH_SLOTS;
    policy.allowlist_len = 0;
    policy.pending_exists = false;

    let tracker = &mut ctx.accounts.spend_tracker;
    tracker.vault = ctx.accounts.vault.key();
    tracker.epoch_slot = 0;
    tracker.spent_usd_micro = 0;
    tracker.bump = ctx.bumps.spend_tracker;

    Ok(())
}

pub fn treasury_bump(vault_key: &Pubkey) -> Result<u8> {
    let (_, bump) = Pubkey::find_program_address(
        &[TREASURY_SEED, vault_key.as_ref()],
        &crate::id(),
    );
    Ok(bump)
}

pub fn treasury_pubkey(vault_key: &Pubkey, bump: u8) -> Pubkey {
    Pubkey::create_program_address(
        &[TREASURY_SEED, vault_key.as_ref(), &[bump]],
        &crate::id(),
    )
    .unwrap()
}