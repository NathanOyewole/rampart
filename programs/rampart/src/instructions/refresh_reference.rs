use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::ErrorCode;
use crate::pyth;
use crate::state::*;

#[derive(Accounts)]
pub struct RefreshReference<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: must be the feed pinned at init. Identity is the check.
    pub price_feed: UncheckedAccount<'info>,
}

pub fn handle_refresh_reference(ctx: Context<RefreshReference>) -> Result<()> {
    if ctx.accounts.price_feed.key() != ctx.accounts.vault.price_feed {
        return err!(ErrorCode::FeedMismatch);
    }
    let feed_data = ctx.accounts.price_feed.try_borrow_data()?;
    let price = pyth::decode_price(&feed_data)?;
    if price.expo != ctx.accounts.vault.reference_expo {
        return err!(ErrorCode::PriceExponentInvalid);
    }
    let vault = &mut ctx.accounts.vault;
    vault.reference_price = price.price;
    Ok(())
}
