pub mod constants;
pub mod error;
pub mod instructions;
pub mod math;
pub mod pyth;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::ErrorCode;
pub use instructions::*;
pub use state::*;

declare_id!("6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr");

#[program]
pub mod rampart {
    use super::*;

    pub fn init_vault(
        ctx: Context<InitVault>,
        daily_usd_cap_micro: u64,
        per_tx_usd_cap_micro: u64,
    ) -> Result<()> {
        handle_init_vault(ctx, daily_usd_cap_micro, per_tx_usd_cap_micro)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        handle_deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        handle_withdraw(ctx, amount)
    }

    pub fn register_agent(ctx: Context<RegisterAgent>) -> Result<()> {
        handle_register_agent(ctx)
    }

    pub fn unregister_agent(ctx: Context<UnregisterAgent>) -> Result<()> {
        handle_unregister_agent(ctx)
    }

    pub fn freeze(ctx: Context<SetFrozen>) -> Result<()> {
        handle_freeze(ctx)
    }

    pub fn unfreeze(ctx: Context<SetFrozen>) -> Result<()> {
        handle_unfreeze(ctx)
    }

    pub fn propose_policy(
        ctx: Context<ProposePolicy>,
        daily_usd_cap_micro: u64,
        per_tx_usd_cap_micro: u64,
        max_slippage_bps: u16,
        epoch_len_slots: u64,
        allowlist: Vec<Pubkey>,
    ) -> Result<()> {
        handle_propose_policy(
            ctx,
            daily_usd_cap_micro,
            per_tx_usd_cap_micro,
            max_slippage_bps,
            epoch_len_slots,
            allowlist,
        )
    }

    pub fn apply_policy(ctx: Context<ApplyPolicy>) -> Result<()> {
        handle_apply_policy(ctx)
    }

    pub fn guarded_transfer(ctx: Context<GuardedTransfer>, amount: u64) -> Result<()> {
        handle_guarded_transfer(ctx, amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_math_sol200() {
        let micro = crate::math::to_usd_micro(1_000_000_000, 20_000_000_000i64, -8).unwrap();
        assert_eq!(micro, 200_000_000);
    }

    #[test]
    fn deviation_bps_matches() {
        assert_eq!(crate::math::deviation_bps(20_000_000_000, 20_000_000_000).unwrap(), 0);
        assert_eq!(
            crate::math::deviation_bps(20_200_000_000, 20_000_000_000).unwrap(),
            100
        );
        assert_eq!(
            crate::math::deviation_bps(19_800_000_000, 20_000_000_000).unwrap(),
            100
        );
    }

    #[test]
    fn error_code_numbers() {
        fn code(e: anchor_lang::error::Error) -> u32 {
            match e {
                anchor_lang::error::Error::AnchorError(ae) => ae.error_code_number,
                other => {
                    eprintln!("got non-anchor error {other:?}");
                    panic!("expected AnchorError");
                }
            }
        }
        eprintln!(
            "DestinationNotAllowed code={}",
            code(ErrorCode::DestinationNotAllowed.into())
        );
        eprintln!(
            "DailyCapExceeded code={}",
            code(ErrorCode::DailyCapExceeded.into())
        );
        eprintln!(
            "PerTxCapExceeded code={}",
            code(ErrorCode::PerTxCapExceeded.into())
        );
        eprintln!(
            "VaultFrozen code={}",
            code(ErrorCode::VaultFrozen.into())
        );
    }
}