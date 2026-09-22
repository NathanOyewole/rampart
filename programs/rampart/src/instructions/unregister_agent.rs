use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
pub struct UnregisterAgent<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        mut,
        has_one = vault,
        seeds = [AGENT_SEED, vault.key().as_ref(), agent_account.key.as_ref()],
        bump
    )]
    pub agent_account: Account<'info, Agent>,
}

pub fn handle_unregister_agent(_ctx: Context<UnregisterAgent>) -> Result<()> {
    _ctx.accounts.agent_account.active = false;
    Ok(())
}