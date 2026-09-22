use anchor_lang::prelude::*;

declare_id!("2xbNzbkEZ65hLzi9TgdMBcncup6a5CA1qi3QLVTrwQ2p");

pub const PYTH_EXPO_OFFSET: usize = 0x14;
pub const PYTH_PRICE_OFFSET: usize = 0x30;
pub const PYTH_STATUS_OFFSET: usize = 0x44;
pub const PYTH_MIN_DATA_LEN: usize = 0x45;

pub const STATUS_TRADING: u8 = 1;

#[error_code]
pub enum MockError {
    #[msg("feed account is too short to hold a Pyth price")]
    FeedTooShort,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    /// CHECK: unlocked account; must be owned by this program so the handler
    /// may write. The client creates it with SystemProgram.createAccount and
    /// transfers ownership to this program.
    #[account(mut)]
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[program]
pub mod oracle_mock {
    use super::*;

    /// Writes a Pyth-v2-layout price into a mock feed account owned by this
    /// program. Rampart decodes feeds using the real Pyth account layout
    /// (expo @0x14, price @0x30, status @0x44) without trusting ownership, so
    /// a mock feed under our control makes devnet demos deterministic while
    /// exercising the exact same decode path.
    pub fn set_price(ctx: Context<SetPrice>, price: i64, expo: i32, status: u8) -> Result<()> {
        let mut data = ctx.accounts.feed.try_borrow_mut_data()?;
        if data.len() < PYTH_MIN_DATA_LEN {
            return err!(MockError::FeedTooShort);
        }
        data[PYTH_EXPO_OFFSET..PYTH_EXPO_OFFSET + 4].copy_from_slice(&expo.to_le_bytes());
        data[PYTH_PRICE_OFFSET..PYTH_PRICE_OFFSET + 8].copy_from_slice(&price.to_le_bytes());
        data[PYTH_STATUS_OFFSET] = status;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_encoding_offsets() {
        assert_eq!(PYTH_EXPO_OFFSET, 0x14);
        assert_eq!(PYTH_PRICE_OFFSET, 0x30);
        assert_eq!(PYTH_STATUS_OFFSET, 0x44);
    }
}