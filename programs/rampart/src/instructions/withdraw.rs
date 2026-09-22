use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::state::*;

use super::init_vault::treasury_pubkey;

#[derive(Accounts)]
pub struct Withdraw<'info> {
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

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    if amount == 0 {
        return err!(ErrorCode::AmountZero);
    }
    if ctx.accounts.treasury.lamports() < amount {
        return err!(ErrorCode::InsufficientBalance);
    }
    let vault_key = ctx.accounts.vault.key();
    let treasury_bump = ctx.accounts.vault.treasury_bump;
    let seeds: &[&[u8]] = &[TREASURY_SEED, vault_key.as_ref(), &[treasury_bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let cpi = CpiContext::new_with_signer(
        system_program::ID,
        system_program::Transfer {
            from: ctx.accounts.treasury.to_account_info(),
            to: ctx.accounts.owner.to_account_info(),
        },
        signer_seeds,
    );
    system_program::transfer(cpi, amount)?;
    Ok(())
}