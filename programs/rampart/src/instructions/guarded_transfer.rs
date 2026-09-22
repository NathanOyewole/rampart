use anchor_lang::{prelude::*, AccountDeserialize};
use anchor_lang::system_program;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::math;
use crate::pyth;
use crate::state::*;

use super::init_vault::treasury_pubkey;

#[derive(Accounts)]
pub struct GuardedTransfer<'info> {
    pub agent: Signer<'info>,
    /// CHECK: agent registry PDA; existence + contents validated in handler so a
    /// never-registered key reports NotAgent instead of a generic anchor error.
    #[account(mut)]
    pub agent_account: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = !vault.frozen @ ErrorCode::VaultFrozen,
        seeds = [VAULT_SEED, vault.owner.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = vault)]
    pub policy: Account<'info, Policy>,
    #[account(mut, has_one = vault)]
    pub spend_tracker: Box<Account<'info, SpendTracker>>,
    /// CHECK: destination must be allowlisted.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: pyth price feed account, read-only.
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: system-owned treasury PDA.
    #[account(
        mut,
        address = treasury_pubkey(&vault.key(), vault.treasury_bump)
    )]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_guarded_transfer(ctx: Context<GuardedTransfer>, amount: u64) -> Result<()> {
    if amount == 0 {
        return err!(ErrorCode::AmountZero);
    }

    let agent_account = load_agent(
        ctx.accounts.agent_account.as_ref(),
        &ctx.accounts.vault.key(),
        &ctx.accounts.agent.key(),
    )?;

    let policy = &ctx.accounts.policy;
    let destination = ctx.accounts.destination.key();
    if destination == ctx.accounts.treasury.key() {
        return err!(ErrorCode::TreasuryDestination);
    }
    let allowlisted = (0..policy.allowlist_len)
        .any(|i| policy.allowlist[i as usize] == destination);
    if !allowlisted {
        return err!(ErrorCode::DestinationNotAllowed);
    }

    if ctx.accounts.treasury.lamports() < amount {
        return err!(ErrorCode::InsufficientBalance);
    }

    let feed_data = ctx.accounts.price_feed.try_borrow_data()?;
    let price = pyth::decode_price(&feed_data)?;
    drop(feed_data);

    if price.expo != ctx.accounts.vault.reference_expo {
        return err!(ErrorCode::PriceExponentInvalid);
    }
    let dev = math::deviation_bps(price.price, ctx.accounts.vault.reference_price)?;
    if dev > policy.max_slippage_bps as u64 {
        return err!(ErrorCode::PriceDeviationTooHigh);
    }

    let usd_micro = math::to_usd_micro(amount, price.price, price.expo)?;
    if usd_micro > policy.per_tx_usd_cap_micro {
        return err!(ErrorCode::PerTxCapExceeded);
    }

    let clock = Clock::get()?;
    let epoch = clock.slot / policy.epoch_len_slots;
    let tracker = &mut ctx.accounts.spend_tracker;
    if tracker.epoch_slot != epoch {
        tracker.epoch_slot = epoch;
        tracker.spent_usd_micro = 0;
    }
    let new_spent = tracker
        .spent_usd_micro
        .checked_add(usd_micro)
        .ok_or(ErrorCode::MathOverflow)?;
    if new_spent > policy.daily_usd_cap_micro {
        return err!(ErrorCode::DailyCapExceeded);
    }
    tracker.spent_usd_micro = new_spent;

    drop(agent_account);

    let vault_key = ctx.accounts.vault.key();
    let treasury_bump = ctx.accounts.vault.treasury_bump;
    let seeds: &[&[u8]] = &[TREASURY_SEED, vault_key.as_ref(), &[treasury_bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let cpi = CpiContext::new_with_signer(
        system_program::ID,
        system_program::Transfer {
            from: ctx.accounts.treasury.to_account_info(),
            to: ctx.accounts.destination.to_account_info(),
        },
        signer_seeds,
    );
    system_program::transfer(cpi, amount)?;

    Ok(())
}

fn load_agent<'a>(info: &AccountInfo<'a>, vault_key: &Pubkey, agent_key: &Pubkey) -> Result<Agent> {
    if info.data_is_empty() {
        return err!(ErrorCode::NotAgent);
    }
    let (expected_pda, _) = Pubkey::find_program_address(
        &[AGENT_SEED, vault_key.as_ref(), agent_key.as_ref()],
        &crate::id(),
    );
    if expected_pda != info.key() {
        return err!(ErrorCode::NotAgent);
    }
    let mut data: &[u8] = &info.try_borrow_data()?;
    let agent = match Agent::try_deserialize(&mut data) {
        Ok(agent) => agent,
        Err(_) => return err!(ErrorCode::NotAgent),
    };
    if agent.vault != *vault_key || agent.key != *agent_key {
        return err!(ErrorCode::NotAgent);
    }
    if !agent.active {
        return err!(ErrorCode::AgentInactive);
    }
    Ok(agent)
}