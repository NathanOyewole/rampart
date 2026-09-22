import {
  AnchorProvider,
  BN,
  Idl,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Signer,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { KeypairWallet } from "./wallet.js";
import {
  AGENT_SEED,
  MOCK_PROGRAM_ID,
  POLICY_SEED,
  PROGRAM_ID,
  RPC_URL,
  SPEND_SEED,
  TREASURY_SEED,
  VAULT_SEED,
} from "./env.js";

export interface VaultState {
  owner: PublicKey;
  treasuryBump: number;
  bump: number;
  frozen: boolean;
  referencePrice: BN;
  referenceExpo: number;
  timelockSlots: BN;
}

export interface PolicyState {
  vault: PublicKey;
  dailyUsdCapMicro: BN;
  perTxUsdCapMicro: BN;
  maxSlippageBps: number;
  epochLenSlots: BN;
  allowlistLen: number;
  allowlist: PublicKey[];
  pendingExists: boolean;
  pendingDailyUsdCapMicro: BN;
  pendingPerTxUsdCapMicro: BN;
  pendingMaxSlippageBps: number;
  pendingEpochLenSlots: BN;
  pendingEffectiveSlot: BN;
  pendingAllowlistLen: number;
  pendingAllowlist: PublicKey[];
}

export interface SpendState {
  vault: PublicKey;
  epochSlot: BN;
  spentUsdMicro: BN;
  bump: number;
}

const idl = JSON.parse(
  readFileSync(new URL("../idl/rampart.json", import.meta.url), "utf8")
) as Idl;
const mockIdl = JSON.parse(
  readFileSync(new URL("../idl/oracle-mock.json", import.meta.url), "utf8")
) as Idl;

export function makeProvider(payer: Keypair, rpc: string = RPC_URL) {
  const connection = new Connection(rpc, "confirmed");
  const provider = new AnchorProvider(
    connection,
    new KeypairWallet(payer) as unknown as Wallet,
    { commitment: "confirmed", skipPreflight: false }
  );
  const original = provider.sendAndConfirm.bind(provider);
  provider.sendAndConfirm = async (
    tx: Transaction,
    signers?: Signer[],
    options?: Parameters<AnchorProvider["sendAndConfirm"]>[2]
  ) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        const blockhash = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash.blockhash;
        tx.feePayer ??= payer.publicKey;
        tx.signatures = [];
        tx.partialSign(payer, ...(signers ?? []));
      }
      try {
        return await original(tx, signers, options);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("was not confirmed")) {
          throw e;
        }
        lastErr = e;
      }
    }
    throw lastErr;
  };
  return { connection, provider };
}

export function makePrograms(provider: AnchorProvider) {
  const program = new Program(idl, provider);
  const mockProgram = new Program(mockIdl, provider);
  return { program, mockProgram };
}

export function pda(seeds: Buffer[]): PublicKey {
  const [key] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
  return key;
}

export function vaultPda(owner: PublicKey): PublicKey {
  return pda([VAULT_SEED, owner.toBuffer()]);
}

export function policyPda(vault: PublicKey): PublicKey {
  return pda([POLICY_SEED, vault.toBuffer()]);
}

export function spendPda(vault: PublicKey): PublicKey {
  return pda([SPEND_SEED, vault.toBuffer()]);
}

export function agentPda(vault: PublicKey, agent: PublicKey): PublicKey {
  return pda([AGENT_SEED, vault.toBuffer(), agent.toBuffer()]);
}

export function treasuryPubkey(vault: PublicKey, bump: number): PublicKey {
  return PublicKey.createProgramAddressSync(
    [TREASURY_SEED, vault.toBuffer(), Buffer.from([bump])],
    PROGRAM_ID
  );
}

export interface ErrDesc {
  code?: number;
  name?: string;
  msg?: string;
}

export function describeError(e: unknown): ErrDesc {
  const err = e as {
    error?: { errorCode?: { number?: number }; name?: string; msg?: string };
    logs?: string[];
    message?: string;
  };
  if (err?.error?.errorCode?.number != null) {
    return {
      code: err.error.errorCode.number,
      name: err.error.name,
      msg: err.error.msg,
    };
  }
  const logs = err?.logs ?? [];
  if (logs) {
    const m = logs.join("\n").match(/Custom\((\d+)\)/g);
    if (m && m.length) {
      const last = m[m.length - 1].match(/(\d+)/)?.[0];
      if (last) return { code: Number(last) };
    }
    const nm = logs.join("\n").match(/ProgramError:\s*(.+)/);
    if (nm) return { name: nm[1].trim() };
  }
  const msg = err?.message;
  const mentions = logs.join("\n");
  const codeMatch = mentions.match(/instruction at offset[\s\S]*?(\d+)/);
  if (codeMatch) return { code: Number(codeMatch[1]) };
  if (msg) return { msg };
  return {};
}

export class RampartClient {
  connection: Connection;
  provider: AnchorProvider;
  program: Program;
  mockProgram: Program;
  payer: Keypair;

  constructor(payer: Keypair, rpc: string = RPC_URL) {
    const { connection, provider } = makeProvider(payer, rpc);
    const { program, mockProgram } = makePrograms(provider);
    this.connection = connection;
    this.provider = provider;
    this.program = program;
    this.mockProgram = mockProgram;
    this.payer = payer;
  }

  // ---- mock oracle feed ----

  async createFeed(priceRaw: number, expo = -8, status = 1): Promise<Keypair> {
    const feed = Keypair.generate();
    const space = 0x45;
    const lamports = await this.connection.getMinimumBalanceForRentExemption(
      space
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: feed.publicKey,
        lamports,
        space,
        programId: MOCK_PROGRAM_ID,
      })
    );
    const sig = await this.provider.sendAndConfirm(tx, [feed]);
    await this.setPrice(feed.publicKey, priceRaw, expo, status);
    return feed;
  }

  async setPrice(feed: PublicKey, priceRaw: number, expo: number, status: number) {
    const tx = await this.mockProgram.methods
      .setPrice(new BN(priceRaw), expo, status)
      .accounts({
        feed,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    return this.provider.sendAndConfirm(tx);
  }

  async decodeFeed(feed: PublicKey) {
    const info = await this.connection.getAccountInfo(feed);
    if (!info) throw new Error("feed account not found");
    const data = info.data;
    if (data.length < 0x45) throw new Error("feed account too short");
    const expo = data.readInt32LE(0x14);
    const price = data.readBigInt64LE(0x30);
    const status = data[0x44];
    return { expo, price, status, data };
  }

  // ---- vault ops ----

  async initVault(
    dailyUsdCapMicro: number,
    perTxUsdCapMicro: number,
    feed: PublicKey
  ): Promise<{ vault: PublicKey; sig: string }> {
    const owner = this.payer.publicKey;
    const vault = vaultPda(owner);
    const sig = await this.program.methods
      .initVault(new BN(dailyUsdCapMicro), new BN(perTxUsdCapMicro))
      .accounts({
        owner,
        vault,
        policy: policyPda(vault),
        spendTracker: spendPda(vault),
        priceFeed: feed,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { vault, sig };
  }

  async deposit(vault: PublicKey, amountLamports: number): Promise<string> {
    const owner = this.payer.publicKey;
    const v = await this.fetchVault(vault);
    const treasury = treasuryPubkey(vault, v.treasuryBump);
    return this.program.methods
      .deposit(new BN(amountLamports))
      .accounts({
        owner,
        vault,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async withdraw(vault: PublicKey, amountLamports: number) {
    const owner = this.payer.publicKey;
    const v = await this.fetchVault(vault);
    const treasury = treasuryPubkey(vault, v.treasuryBump);
    return this.program.methods
      .withdraw(new BN(amountLamports))
      .accounts({
        owner,
        vault,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async registerAgent(vault: PublicKey, agent: Keypair) {
    const owner = this.payer.publicKey;
    const acct = agentPda(vault, agent.publicKey);
    return this.program.methods
      .registerAgent()
      .accounts({
        owner,
        agent: agent.publicKey,
        vault,
        agentAccount: acct,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();
  }

  async unregisterAgent(vault: PublicKey, agentKey: PublicKey) {
    const owner = this.payer.publicKey;
    const acct = agentPda(vault, agentKey);
    return this.program.methods
      .unregisterAgent()
      .accounts({ owner, vault, agentAccount: acct })
      .rpc();
  }

  async freeze(vault: PublicKey) {
    return this.program.methods
      .freeze()
      .accounts({ owner: this.payer.publicKey, vault })
      .rpc();
  }

  async unfreeze(vault: PublicKey) {
    return this.program.methods
      .unfreeze()
      .accounts({ owner: this.payer.publicKey, vault })
      .rpc();
  }

  async proposePolicy(
    vault: PublicKey,
    opts: {
      dailyUsdCapMicro: number;
      perTxUsdCapMicro: number;
      maxSlippageBps: number;
      epochLenSlots: number;
      allowlist: PublicKey[];
    }
  ) {
    return this.program.methods
      .proposePolicy(
        new BN(opts.dailyUsdCapMicro),
        new BN(opts.perTxUsdCapMicro),
        opts.maxSlippageBps,
        new BN(opts.epochLenSlots),
        opts.allowlist
      )
      .accounts({
        owner: this.payer.publicKey,
        vault,
        policy: policyPda(vault),
      })
      .rpc();
  }

  async applyPolicy(vault: PublicKey) {
    return this.program.methods
      .applyPolicy()
      .accounts({
        owner: this.payer.publicKey,
        vault,
        policy: policyPda(vault),
      })
      .rpc();
  }

  async guardedTransfer(
    vault: PublicKey,
    agent: Keypair,
    destination: PublicKey,
    feed: PublicKey,
    amountLamports: number
  ) {
    const v = await this.fetchVault(vault);
    const treasury = treasuryPubkey(vault, v.treasuryBump);
    return this.program.methods
      .guardedTransfer(new BN(amountLamports))
      .accounts({
        agent: agent.publicKey,
        agentAccount: agentPda(vault, agent.publicKey),
        vault,
        policy: policyPda(vault),
        spendTracker: spendPda(vault),
        destination,
        priceFeed: feed,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();
  }

  async withdrawAs(vault: PublicKey, signerKp: Keypair, amountLamports: number) {
    const v = await this.fetchVault(vault);
    const treasury = treasuryPubkey(vault, v.treasuryBump);
    const tx = await this.program.methods
      .withdraw(new BN(amountLamports))
      .accounts({
        owner: signerKp.publicKey,
        vault,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    tx.feePayer = this.payer.publicKey;
    return this.provider.sendAndConfirm(tx, [signerKp]);
  }

  // ---- reads ----

  async fetchVault(key: PublicKey): Promise<VaultState> {
    return (await (this.program.account as any).vault.fetch(key)) as unknown as VaultState;
  }

  async fetchPolicy(key: PublicKey): Promise<PolicyState> {
    return (await (this.program.account as any).policy.fetch(key)) as unknown as PolicyState;
  }

  async fetchSpend(key: PublicKey): Promise<SpendState> {
    return (await (this.program.account as any).spendTracker.fetch(key)) as unknown as SpendState;
  }

  lamports(sol: number): number {
    return Math.round(sol * LAMPORTS_PER_SOL);
  }
}

export { LAMPORTS_PER_SOL };