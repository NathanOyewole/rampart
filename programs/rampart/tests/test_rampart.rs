use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    rampart::constants::*,
    solana_account::Account,
    solana_instruction::error::InstructionError,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    solana_transaction_error::TransactionError,
};

const E_UNAUTHORIZED: u32 = 6000;
const E_FROZEN: u32 = 6001;
const E_NOT_AGENT: u32 = 6002;
const E_AGENT_INACTIVE: u32 = 6003;
const E_DEST_NOT_ALLOWED: u32 = 6004;
const E_TREASURY_DEST: u32 = 6005;
const E_PER_TX_CAP: u32 = 6007;
const E_DAILY_CAP: u32 = 6008;
const E_NOT_TRADING: u32 = 6011;
const E_DEV_TOO_HIGH: u32 = 6013;
const E_POLICY_NOT_EFFECTIVE: u32 = 6016;

const SOL_PRICE: i64 = 20_000_000_000;
const SOL_EXPO: i32 = -8;

const DAILY_CAP_MICRO: u64 = 100_000_000_000;
const PER_TX_CAP_MICRO: u64 = 10_000_000_000;
const EPOCH_SLOTS: u64 = 5000;

struct TestEnv {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    vault: Pubkey,
    policy: Pubkey,
    spend_tracker: Pubkey,
    treasury: Pubkey,
    feed: Pubkey,
    deposit_lamports: u64,
}

fn pda(program_id: &Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, program_id).0
}

fn feed_data(price: i64, expo: i32, status: u8) -> Vec<u8> {
    let mut data = vec![0u8; 0x100];
    data[0x14..0x18].copy_from_slice(&expo.to_le_bytes());
    data[0x30..0x38].copy_from_slice(&price.to_le_bytes());
    data[0x44] = status;
    data
}

fn send(
    svm: &mut LiteSVM,
    fee_payer: &Keypair,
    signers: &[&dyn Signer],
    ix: &Instruction,
) -> TransactionResult {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix.clone()], Some(&fee_payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
}

fn assert_custom(res: TransactionResult, expected: u32) {
    match res {
        Ok(_) => panic!("expected error {expected}, got success"),
        Err(f) => match f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
                assert_eq!(code, expected, "wrong custom error code")
            }
            other => panic!("expected Custom({expected}), got {other:?}"),
        },
    }
}

fn expect_ok(res: TransactionResult, context: &str) {
    if let Err(f) = res {
        panic!("{context} failed: {:?}", f.err);
    }
}

fn init_vault(env: &mut TestEnv) {
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::InitVault {
            daily_usd_cap_micro: DAILY_CAP_MICRO,
            per_tx_usd_cap_micro: PER_TX_CAP_MICRO,
        }
        .data(),
        rampart::accounts::InitVault {
            owner: env.owner.pubkey(),
            vault: env.vault,
            policy: env.policy,
            spend_tracker: env.spend_tracker,
            price_feed: env.feed,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner], &ix),
        "init_vault",
    );
}

fn register_agent(env: &mut TestEnv) {
    let agent_pda = pda(&rampart::id(), &[AGENT_SEED, env.vault.as_ref(), env.agent.pubkey().as_ref()]);
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::RegisterAgent {}.data(),
        rampart::accounts::RegisterAgent {
            owner: env.owner.pubkey(),
            agent: env.agent.pubkey(),
            vault: env.vault,
            agent_account: agent_pda,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner, &env.agent], &ix),
        "register_agent",
    );
}

fn deposit(env: &mut TestEnv, lamports: u64) {
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::Deposit {
            amount: lamports,
        }
        .data(),
        rampart::accounts::Deposit {
            owner: env.owner.pubkey(),
            vault: env.vault,
            treasury: env.treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner], &ix),
        "deposit",
    );
}

fn propose_allowlist(env: &mut TestEnv, dests: Vec<Pubkey>, daily: u64, per_tx: u64, slippage: u16, epoch: u64) {
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::ProposePolicy {
            daily_usd_cap_micro: daily,
            per_tx_usd_cap_micro: per_tx,
            max_slippage_bps: slippage,
            epoch_len_slots: epoch,
            allowlist: dests,
        }
        .data(),
        rampart::accounts::ProposePolicy {
            owner: env.owner.pubkey(),
            vault: env.vault,
            policy: env.policy,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner], &ix),
        "propose_policy",
    );
}

fn apply_policy(env: &mut TestEnv) -> TransactionResult {
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::ApplyPolicy {}.data(),
        rampart::accounts::ApplyPolicy {
            owner: env.owner.pubkey(),
            vault: env.vault,
            policy: env.policy,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.owner, &[&env.owner], &ix)
}

fn apply_policy_ok(env: &mut TestEnv) {
    expect_ok(apply_policy(env), "apply_policy");
}

fn guarded_transfer(env: &mut TestEnv, amount: u64, dest: Pubkey, use_feed: Pubkey) -> TransactionResult {
    let agent_pda = pda(&rampart::id(), &[AGENT_SEED, env.vault.as_ref(), env.agent.pubkey().as_ref()]);
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::GuardedTransfer { amount }.data(),
        rampart::accounts::GuardedTransfer {
            agent: env.agent.pubkey(),
            agent_account: agent_pda,
            vault: env.vault,
            policy: env.policy,
            spend_tracker: env.spend_tracker,
            destination: dest,
            price_feed: use_feed,
            treasury: env.treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut env.svm, &env.agent, &[&env.agent], &ix)
}

fn setup() -> TestEnv {
    let mut svm = LiteSVM::new();
    let owner = Keypair::new();
    let agent = Keypair::new();

    let feed_key = Pubkey::new_unique();
    let feed = Account {
        lamports: 1_000_000_000,
        data: feed_data(SOL_PRICE, SOL_EXPO, 1),
        owner: system_program::ID,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(feed_key, feed.clone()).unwrap();

    let program_id = rampart::id();
    let vault = pda(&program_id, &[VAULT_SEED, owner.pubkey().as_ref()]);
    let treasury = pda(&system_program::ID, &[TREASURY_SEED, vault.as_ref()]);
    let policy = pda(&program_id, &[POLICY_SEED, vault.as_ref()]);
    let spend_tracker = pda(&program_id, &[SPEND_SEED, vault.as_ref()]);

    svm.airdrop(&owner.pubkey(), 100_000_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 1_000_000_000_000).unwrap();

    let mut env = TestEnv {
        svm,
        owner,
        agent,
        vault,
        policy,
        spend_tracker,
        treasury,
        feed: feed_key,
        deposit_lamports: 0,
    };

    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/rampart.so"
    ));
    env.svm.add_program(program_id, bytes).unwrap();

    init_vault(&mut env);
    register_agent(&mut env);
    let deposit_lamports = 100_000_000_000;
    deposit(&mut env, deposit_lamports);
    env.deposit_lamports = deposit_lamports;

    env
}

fn treasury_lamports(env: &TestEnv) -> u64 {
    env.svm.get_account(&env.treasury).unwrap().lamports
}

#[test]
fn drain_blocked_to_non_allowlisted_dest() {
    let mut env = setup();
    let attacker_dest = Pubkey::new_unique();
    let before = treasury_lamports(&env);
    let feed = env.feed;
    assert_custom(
        guarded_transfer(&mut env, 10_000_000_000, attacker_dest, feed),
        E_DEST_NOT_ALLOWED,
    );
    assert_eq!(treasury_lamports(&env), before, "no lamports may move");
}

#[test]
fn happy_path_allowlisted_transfer() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let before = treasury_lamports(&env);
    let feed = env.feed;
    expect_ok(
        guarded_transfer(&mut env, 5_000_000_000, dest, feed),
        "guarded_transfer",
    );
    assert_eq!(treasury_lamports(&env), before - 5_000_000_000);
    assert_eq!(env.svm.get_account(&dest).unwrap().lamports, 5_000_000_000);

    let mut data: &[u8] = &env.svm.get_account(&env.spend_tracker).unwrap().data;
    let tracker = rampart::state::SpendTracker::try_deserialize(&mut data).unwrap();
    assert_eq!(tracker.spent_usd_micro, 1_000_000_000);
}

#[test]
fn per_tx_cap_enforced() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, 1_000_000_000, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let before = treasury_lamports(&env);
    let feed = env.feed;
    assert_custom(
        guarded_transfer(&mut env, 100_000_000_000, dest, feed),
        E_PER_TX_CAP,
    );
    assert_eq!(treasury_lamports(&env), before);
}

#[test]
fn daily_cap_enforced_and_resets_by_epoch() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], 1_500_000_000, 1_000_000_000_000, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let feed = env.feed;
    expect_ok(
        guarded_transfer(&mut env, 5_000_000_000, dest, feed),
        "first spend within daily cap",
    );

    let before = treasury_lamports(&env);
    assert_custom(
        guarded_transfer(&mut env, 5_000_000_000, dest, feed),
        E_DAILY_CAP,
    );
    assert_eq!(treasury_lamports(&env), before);

    env.svm.warp_to_slot(200 + EPOCH_SLOTS + 1);
    expect_ok(
        guarded_transfer(&mut env, 5_000_000_000, dest, feed),
        "spend after epoch rollover",
    );
}

#[test]
fn frozen_vault_rejects_agent_spend() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let freeze_ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::Freeze {}.data(),
        rampart::accounts::SetFrozen {
            owner: env.owner.pubkey(),
            vault: env.vault,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner], &freeze_ix),
        "freeze",
    );

    let before = treasury_lamports(&env);
    let feed = env.feed;
    assert_custom(
        guarded_transfer(&mut env, 5_000_000_000, dest, feed),
        E_FROZEN,
    );
    assert_eq!(treasury_lamports(&env), before);
}

#[test]
fn jailbroken_agent_cannot_freeze_unfreeze_or_withdraw() {
    let mut env = setup();

    let freeze_ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::Freeze {}.data(),
        rampart::accounts::SetFrozen {
            owner: env.owner.pubkey(),
            vault: env.vault,
        }
        .to_account_metas(None),
    );
    assert_custom(
        send(&mut env.svm, &env.agent, &[&env.agent], &freeze_ix),
        E_UNAUTHORIZED,
    );

    let withdraw_ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::Withdraw {
            amount: 10_000_000_000,
        }
        .data(),
        rampart::accounts::Withdraw {
            owner: env.agent.pubkey(),
            vault: env.vault,
            treasury: env.treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert_custom(
        send(&mut env.svm, &env.agent, &[&env.agent], &withdraw_ix),
        E_UNAUTHORIZED,
    );
}

#[test]
fn owner_can_withdraw() {
    let mut env = setup();
    let before_owner = env.svm.get_account(&env.owner.pubkey()).unwrap().lamports;
    let withdraw_ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::Withdraw {
            amount: 10_000_000_000,
        }
        .data(),
        rampart::accounts::Withdraw {
            owner: env.owner.pubkey(),
            vault: env.vault,
            treasury: env.treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner], &withdraw_ix),
        "owner withdraw",
    );
    assert!(
        env.svm.get_account(&env.owner.pubkey()).unwrap().lamports > before_owner
    );
}

#[test]
fn unregistered_caller_cannot_spend() {
    let mut env = setup();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000_000).unwrap();
    let dest = Pubkey::new_unique();

    let agent_pda = pda(&rampart::id(), &[AGENT_SEED, env.vault.as_ref(), stranger.pubkey().as_ref()]);
    let ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::GuardedTransfer {
            amount: 1_000_000_000,
        }
        .data(),
        rampart::accounts::GuardedTransfer {
            agent: stranger.pubkey(),
            agent_account: agent_pda,
            vault: env.vault,
            policy: env.policy,
            spend_tracker: env.spend_tracker,
            destination: dest,
            price_feed: env.feed,
            treasury: env.treasury,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert_custom(
        send(&mut env.svm, &stranger, &[&stranger], &ix),
        E_NOT_AGENT,
    );
}

#[test]
fn deactivated_agent_cannot_spend() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let agent_pda = pda(&rampart::id(), &[AGENT_SEED, env.vault.as_ref(), env.agent.pubkey().as_ref()]);
    let unreg_ix = Instruction::new_with_bytes(
        rampart::id(),
        &rampart::instruction::UnregisterAgent {}.data(),
        rampart::accounts::UnregisterAgent {
            owner: env.owner.pubkey(),
            vault: env.vault,
            agent_account: agent_pda,
        }
        .to_account_metas(None),
    );
    expect_ok(
        send(&mut env.svm, &env.owner, &[&env.owner], &unreg_ix),
        "unregister_agent",
    );

    let feed = env.feed;
    assert_custom(
        guarded_transfer(&mut env, 1_000_000_000, dest, feed),
        E_AGENT_INACTIVE,
    );
}

#[test]
fn oracle_pump_outside_slippage_is_blocked() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let bad_feed = Pubkey::new_unique();
    env.svm
        .set_account(
            bad_feed,
            Account {
                lamports: 1_000_000_000,
                data: feed_data(SOL_PRICE * 2, SOL_EXPO, 1),
                owner: system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let before = treasury_lamports(&env);
    assert_custom(
        guarded_transfer(&mut env, 5_000_000_000, dest, bad_feed),
        E_DEV_TOO_HIGH,
    );
    assert_eq!(treasury_lamports(&env), before);
}

#[test]
fn halted_feed_is_blocked() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let halted_feed = Pubkey::new_unique();
    env.svm
        .set_account(
            halted_feed,
            Account {
                lamports: 1_000_000_000,
                data: feed_data(SOL_PRICE, SOL_EXPO, 2),
                owner: system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    assert_custom(
        guarded_transfer(&mut env, 5_000_000_000, dest, halted_feed),
        E_NOT_TRADING,
    );
}

#[test]
fn policy_change_requires_timelock() {
    let mut env = setup();
    let dest = Pubkey::new_unique();
    propose_allowlist(&mut env, vec![dest], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);

    assert_custom(apply_policy(&mut env), E_POLICY_NOT_EFFECTIVE);
}

#[test]
fn treasury_self_destination_blocked() {
    let mut env = setup();
    let treasury = env.treasury;
    propose_allowlist(&mut env, vec![treasury], DAILY_CAP_MICRO, PER_TX_CAP_MICRO, 100, EPOCH_SLOTS);
    env.svm.warp_to_slot(200);
    apply_policy_ok(&mut env);

    let treasury = env.treasury;
    let feed = env.feed;
    assert_custom(
        guarded_transfer(&mut env, 1_000_000_000, treasury, feed),
        E_TREASURY_DEST,
    );
}
