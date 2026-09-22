use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
pub struct SetFrozen<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,
}

pub fn handle_freeze(ctx: Context<SetFrozen>) -> Result<()> {
    ctx.accounts.vault.frozen = true;
    Ok(())
}

pub fn handle_unfreeze(ctx: Context<SetFrozen>) -> Result<()> {
    ctx.accounts.vault.frozen = false;
    Ok(())
}