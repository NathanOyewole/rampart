use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub agent: Signer<'info>,
    #[account(
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Agent::INIT_SPACE,
        seeds = [AGENT_SEED, vault.key().as_ref(), agent.key().as_ref()],
        bump
    )]
    pub agent_account: Account<'info, Agent>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_agent(ctx: Context<RegisterAgent>) -> Result<()> {
    let agent = &mut ctx.accounts.agent_account;
    agent.vault = ctx.accounts.vault.key();
    agent.key = ctx.accounts.agent.key();
    agent.active = true;
    Ok(())
}