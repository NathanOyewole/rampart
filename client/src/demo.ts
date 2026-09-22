import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { RampartClient, describeError, spendPda, treasuryPubkey } from "./rampart.js";
import { microToUsd, usdFromPyth } from "./env.js";
import { policyPda } from "./rampart.js";

export type StepStatus = "ok" | "rejected" | "info" | "error";

export interface StepResult {
  seq: number;
  label: string;
  status: StepStatus;
  detail: string;
  tx?: string;
  errorCode?: number;
  errorName?: string;
  ts: number;
}

export interface DemoConfig {
  dailyUsd: number;
  perTxUsd: number;
  depositSol: number;
  fairPriceUsd: number;
  pumpPriceUsd: number;
  allowlist: PublicKey[];
}

const DEFAULT_CFG: DemoConfig = {
  dailyUsd: 200,
  perTxUsd: 50,
  depositSol: 2,
  fairPriceUsd: 200,
  pumpPriceUsd: 204,
  allowlist: [],
};

const ERR_NAMES = new Map<number, string>([
  [6000, "Unauthorized"],
  [6001, "VaultFrozen"],
  [6002, "NotAgent"],
  [6003, "AgentInactive"],
  [6004, "DestinationNotAllowed"],
  [6005, "TreasuryDestination"],
  [6006, "AmountZero"],
  [6007, "PerTxCapExceeded"],
  [6008, "DailyCapExceeded"],
  [6009, "FeedTooShort"],
  [6010, "InvalidPrice"],
  [6011, "PriceHalted"],
  [6012, "PriceExponentInvalid"],
  [6013, "PriceDeviationTooHigh"],
  [6014, "InvalidCap"],
  [6015, "AllowlistTooLarge"],
  [6016, "PolicyNotEffective"],
  [6017, "NoPendingPolicy"],
  [6018, "MathOverflow"],
  [6019, "InsufficientBalance"],
]);

const priceRaw = (usd: number) => Math.round(usd * 1e8);
const sol = (n: number) => Math.round(n * LAMPORTS_PER_SOL);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RampartDemo {
  client: RampartClient;
  cfg: DemoConfig;
  steps: StepResult[] = [];
  status: "idle" | "running" | "done" | "failed" = "idle";
  error?: string;

  feed?: PublicKey;
  agent?: Keypair;
  destination?: PublicKey;
  vault?: PublicKey;

  constructor(client: RampartClient, cfg: Partial<DemoConfig> = {}) {
    this.client = client;
    this.cfg = { ...DEFAULT_CFG, ...cfg };
  }

  private seq = 0;
  private rec(
    status: StepStatus,
    label: string,
    detail: string,
    extra: Partial<StepResult> = {}
  ) {
    this.steps.push({ seq: this.seq++, label, status, detail, ts: Date.now(), ...extra });
    return this;
  }

  private norm(e: unknown): { code?: number; name?: string } {
    const d = describeError(e);
    if (d.code != null && !d.name) d.name = ERR_NAMES.get(d.code) ?? "UnknownError";
    return d;
  }

  private async attempt(
    label: string,
    fn: () => Promise<string>,
    opts: { expectReject?: boolean; detail?: string } = {}
  ) {
    try {
      const sig = await fn();
      if (opts.expectReject) {
        this.rec("error", label, `expected rejection but tx landed ${sig}`, { tx: sig });
        throw new Error(`unexpected success for: ${label}`);
      }
      this.rec("ok", label, opts.detail ?? `accepted, tx ${sig}`, { tx: sig });
      return sig;
    } catch (e) {
      if (opts.expectReject) {
        const d = this.norm(e);
        this.rec("rejected", label, `blocked on-chain: ${d.name ?? d.code ?? "error"}`, {
          errorCode: d.code,
          errorName: d.name,
        });
        return undefined;
      }
      const d = this.norm(e);
      this.rec("error", label, `failed: ${d.name ?? d.code ?? e}`, { errorCode: d.code, errorName: d.name });
      throw e;
    }
  }

  private async ensureDestination(): Promise<PublicKey> {
    if (this.destination) return this.destination;
    const kp = Keypair.generate();
    const lamports =
      await this.client.connection.getMinimumBalanceForRentExemption(0);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: this.client.payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports,
        space: 0,
        programId: SystemProgram.programId,
      })
    );
    await this.client.provider.sendAndConfirm(tx, [kp]);
    this.destination = kp.publicKey;
    return kp.publicKey;
  }

  async readState() {
    const c = this.client;
    const owner = c.payer.publicKey;
    let vault: Record<string, unknown> | undefined;
    let policy: Record<string, unknown> | undefined;
    let spend: Record<string, unknown> | undefined;
    let treasuryBalance: number | undefined;
    let feedPrice: string | undefined;

    if (this.vault) {
      try {
        const v = await c.fetchVault(this.vault);
        vault = {
          owner: v.owner.toBase58(),
          frozen: v.frozen,
          referencePrice: usdFromPyth(v.referencePrice.toNumber(), v.referenceExpo).toFixed(2),
          timelockSlots: v.timelockSlots.toString(),
        };
        const p = await c.fetchPolicy(policyPda(this.vault));
        policy = {
          dailyUsd: microToUsd(p.dailyUsdCapMicro.toNumber()).toFixed(2),
          perTxUsd: microToUsd(p.perTxUsdCapMicro.toNumber()).toFixed(2),
          maxSlippageBps: p.maxSlippageBps,
          allowlist: p.allowlist.slice(0, p.allowlistLen).map((k) => k.toBase58()),
          pendingExists: p.pendingExists,
          pendingEffectiveSlot: p.pendingExists ? p.pendingEffectiveSlot.toString() : undefined,
        };
        const t = await c.fetchSpend(spendPda(this.vault));
        spend = {
          epochSlot: t.epochSlot.toString(),
          spentUsd: microToUsd(t.spentUsdMicro.toNumber()).toFixed(2),
        };
        const treasury = treasuryPubkey(this.vault, (v as { treasuryBump: number }).treasuryBump);
        treasuryBalance = (await c.connection.getBalance(treasury)) / LAMPORTS_PER_SOL;
      } catch (e) {
        vault = { error: String(e) };
      }
    }

    if (this.feed) {
      try {
        const f = await c.decodeFeed(this.feed);
        feedPrice = usdFromPyth(Number(f.price), f.expo).toFixed(2);
      } catch (e) {
        feedPrice = `decode error: ${String(e)}`;
      }
    }

    const walletBalance = (await c.connection.getBalance(owner)) / LAMPORTS_PER_SOL;

    return {
      status: this.status,
      error: this.error,
      owner: owner.toBase58(),
      program: c.program.programId.toBase58(),
      mockProgram: c.mockProgram.programId.toBase58(),
      walletBalance,
      feed: this.feed?.toBase58(),
      feedPrice,
      agent: this.agent?.publicKey.toBase58(),
      destination: this.destination?.toBase58(),
      vault: this.vault?.toBase58(),
      vaultState: vault,
      policy,
      spend,
      treasuryBalance,
    };
  }

  async run(): Promise<void> {
    if (this.status === "running") throw new Error("demo already running");
    this.status = "running";
    this.error = undefined;
    this.steps = [];
    this.seq = 0;

    const c = this.client;
    try {
      const dest = await this.ensureDestination();
      this.rec("info", "destination account", `created ${dest.toBase58()}`);

      const feed = await c.createFeed(priceRaw(this.cfg.fairPriceUsd));
      this.feed = feed.publicKey;
      this.rec("info", "mock oracle feed", `feed ${feed.publicKey.toBase58()} at $${this.cfg.fairPriceUsd}`);

      const { vault, sig } = await c.initVault(
        Math.round(this.cfg.dailyUsd * 1e6),
        Math.round(this.cfg.perTxUsd * 1e6),
        feed.publicKey
      );
      this.vault = vault;
      this.rec("ok", "init_vault", `vault ${vault.toBase58()} · caps $${this.cfg.dailyUsd}/day $${this.cfg.perTxUsd}/tx · reference price snapshot $${this.cfg.fairPriceUsd}`, { tx: sig });

      const allowlist = this.cfg.allowlist.length ? this.cfg.allowlist : [dest];
      const pSig = await c.proposePolicy(vault, {
        dailyUsdCapMicro: Math.round(this.cfg.dailyUsd * 1e6),
        perTxUsdCapMicro: Math.round(this.cfg.perTxUsd * 1e6),
        maxSlippageBps: 100,
        epochLenSlots: 2160,
        allowlist,
      });
      this.rec("ok", "propose_policy", `allowlist [${allowlist.map((k) => k.toBase58().slice(0, 8))}] pending`, { tx: pSig });

      const pol = await c.fetchPolicy(policyPda(vault));
      const eff = pol.pendingEffectiveSlot.toNumber();
      const now = await c.connection.getSlot();
      this.rec("info", "policy timelock", `effective at slot ${eff} (~${Math.max(0, Math.round((eff - now) * 0.4))}s)`);

      await this.attempt(
        "apply_policy too early → blocked",
        () => c.applyPolicy(vault),
        { expectReject: true }
      );

      let slot = now;
      while (slot < eff) {
        this.rec("info", "waiting for timelock", `slot ${slot}/${eff}`);
        await wait(2000);
        slot = await c.connection.getSlot();
      }
      this.rec("info", "timelock elapsed", `slot ${slot} >= ${eff}`);

      const aSig = await c.applyPolicy(vault);
      this.rec("ok", "apply_policy", `allowlist live`, { tx: aSig });

      const agent = Keypair.generate();
      this.agent = agent;
      const rSig = await c.registerAgent(vault, agent);
      this.rec("ok", "register_agent", `agent ${agent.publicKey.toBase58().slice(0, 8)}…`, { tx: rSig });

      await this.attempt("deposit 2 SOL", () => c.deposit(vault, sol(this.cfg.depositSol)));

      await this.attempt(
        "guard: allowlisted transfer 0.1 SOL",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, sol(0.1)),
        { detail: "0.1 SOL = $20 < per-tx $50 cap" }
      );

      await this.attempt(
        "guard: per-tx cap → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, sol(0.3)),
        { expectReject: true }
      );

      await c.setPrice(feed.publicKey, priceRaw(this.cfg.pumpPriceUsd), -8, 1);
      this.rec("info", "oracle pump +2%", `mock feed now $${this.cfg.pumpPriceUsd}`);

      await this.attempt(
        "guard: price deviation → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, sol(0.1)),
        { expectReject: true }
      );

      await c.setPrice(feed.publicKey, priceRaw(this.cfg.fairPriceUsd), -8, 1);
      this.rec("info", "oracle restored", `mock feed back to $${this.cfg.fairPriceUsd}`);

      const rand = Keypair.generate().publicKey;
      await this.attempt(
        "guard: non-allowlisted destination → blocked",
        () => c.guardedTransfer(vault, agent, rand, feed.publicKey, sol(0.1)),
        { expectReject: true }
      );

      await this.attempt(
        "guard: daily cap → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, sol(0.95)),
        { expectReject: true }
      );

      await this.attempt("owner freezes vault", () => c.freeze(vault));

      await this.attempt(
        "guard: frozen vault → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, sol(0.05)),
        { expectReject: true }
      );

      await this.attempt(
        "guard: agent tries to withdraw → blocked",
        () => c.withdrawAs(vault, agent, sol(0.1)),
        { expectReject: true }
      );

      const uSig = await c.unfreeze(vault);
      this.rec("ok", "owner unfreezes vault", `recovered`, { tx: uSig });

      const finalState = await this.readState();
      this.rec("info", "final position", `treasury ${Number(finalState.treasuryBalance ?? 0).toFixed(3)} SOL · spent $${finalState.spend?.spentUsd ?? "—"}`);
      this.status = "done";
    } catch (e) {
      this.status = "failed";
      this.error = String(e);
      throw e;
    }
  }
}

export { policyPda };