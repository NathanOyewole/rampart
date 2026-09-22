use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the vault owner can perform this action")]
    Unauthorized,
    #[msg("The vault is frozen")]
    VaultFrozen,
    #[msg("Caller is not a registered agent of this vault")]
    NotAgent,
    #[msg("The agent has been deactivated")]
    AgentInactive,
    #[msg("Destination is not allowlisted")]
    DestinationNotAllowed,
    #[msg("Destination cannot be the vault treasury")]
    TreasuryDestination,
    #[msg("Transfer amount must be greater than zero")]
    AmountZero,
    #[msg("Per-transaction USD cap exceeded")]
    PerTxCapExceeded,
    #[msg("Daily USD cap exceeded")]
    DailyCapExceeded,
    #[msg("Pyth price account is too short to decode")]
    FeedTooShort,
    #[msg("Pyth price is non-positive")]
    InvalidPrice,
    #[msg("Pyth price feed is not trading")]
    PriceHalted,
    #[msg("Price exponent is out of the supported range")]
    PriceExponentInvalid,
    #[msg("Live price deviates from vault reference price beyond slippage")]
    PriceDeviationTooHigh,
    #[msg("Cap values must be greater than zero")]
    InvalidCap,
    #[msg("Allowlist exceeds maximum size")]
    AllowlistTooLarge,
    #[msg("Policy change is not yet effective")]
    PolicyNotEffective,
    #[msg("No pending policy change")]
    NoPendingPolicy,
    #[msg("Integer overflow during price math")]
    MathOverflow,
    #[msg("Amount exceeds vault balance")]
    InsufficientBalance,
}