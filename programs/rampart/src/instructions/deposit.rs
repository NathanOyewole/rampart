use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

use super::init_vault::treasury_pubkey;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    /// CHECK: system-owned treasury PDA.
    #[account(
        mut,
        address = treasury_pubkey(&vault.key(), vault.treasury_bump)
    )]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    if amount == 0 {
        return err!(ErrorCode::AmountZero);
    }
    let cpi = CpiContext::new(
        system_program::ID,
        system_program::Transfer {
            from: ctx.accounts.owner.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
        },
    );
    system_program::transfer(cpi, amount)?;
    Ok(())
}