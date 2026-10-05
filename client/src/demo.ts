import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { RampartClient, describeError, spendPda, treasuryPubkey } from "./rampart.js";
import { microToUsd, usdFromPyth, DBC_POOL, DBC_CONFIG } from "./env.js";
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
  /** Overrides the auto-sized runner funding. Leave unset to size from balance. */
  fundSol?: number;
}

const DEFAULT_CFG: DemoConfig = {
  dailyUsd: 200,
  perTxUsd: 50,
  // Caps and transfer sizes below are quoted at the 2 SOL design point and
  // scaled to whatever this deposits, so the demo runs on any sponsor balance
  // instead of demanding a top-up.
  depositSol: 0.4,
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
  [6020, "NotADbcPool"],
  [6021, "PoolTooEarly"],
  [6022, "PoolNotAllowed"],
  [6023, "DbcQuoteFailed"],
  [6024, "PoolPriceImpactTooHigh"],
  [6025, "PoolTooLate"],
  // Anchor evaluates every `#[account(...)]` constraint before the handler
  // body runs, so an authorisation denial surfaces as the constraint's own
  // code rather than the program's error. Mapped so the UI can name it.
  [2000, "AccountNotMutable (Anchor)"],
  [2001, "HasOneFailed (Anchor)"],
  [2002, "OwnerSignatureRequired (Anchor)"],
  [2003, "ConstraintFailed (Anchor)"],
  [2004, "NotAccountOwner (Anchor)"],
  [2006, "SeedsMismatch (Anchor)"],
]);

const priceRaw = (usd: number) => Math.round(usd * 1e8);
const sol = (n: number) => Math.round(n * LAMPORTS_PER_SOL);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FUND_SOL = 3;
const FUND_FEE_RESERVE_SOL = 0.005;
// Headroom above depositSol so the runner can pay transaction fees too. Solana
// fees are ~0.000005 SOL, so 0.05 covers a full multi-tx run with room to spare
// and keeps the sponsor's affordability check meaningful on a small balance.
const FUND_SOL_BUFFER = 0.05;

// Must exceed CONFIRM_TIMEOUT_MS (90s) so a live-but-slow step is never
// reaped out from under itself. 5 confirmation attempts x 90s is the real
// ceiling on a single step, so allow a little more than one attempt.
const STALL_MS = Number(process.env.RAMPART_STALL_MS ?? 180_000);

const BALANCE_TTL_MS = Number(process.env.RAMPART_BALANCE_TTL_MS ?? 5_000);

export class RampartDemo {
  client: RampartClient;
  cfg: DemoConfig;
  steps: StepResult[] = [];
  status: "idle" | "running" | "done" | "failed" = "idle";
  error?: string;

  feed?: PublicKey;
  agent?: Keypair;
  destination?: PublicKey;
  private destinationKp?: Keypair;
  vault?: PublicKey;

  constructor(client: RampartClient, cfg: Partial<DemoConfig> = {}) {
    this.client = client;
    this.cfg = { ...DEFAULT_CFG, ...cfg };
  }

  private seq = 0;
  private startedAt?: number;
  private rec(
    status: StepStatus,
    label: string,
    detail: string,
    extra: Partial<StepResult> = {}
  ) {
    this.steps.push({ seq: this.seq++, label, status, detail, ts: Date.now(), ...extra });
    return this;
  }

  private balanceCache?: { key: string; at: number; sol: number };

  private async cachedBalance(
    conn: Connection,
    owner: PublicKey
  ): Promise<number> {
    const key = owner.toBase58();
    const now = Date.now();
    const hit = this.balanceCache;
    if (hit && hit.key === key && now - hit.at < BALANCE_TTL_MS) return hit.sol;
    const sol = (await conn.getBalance(owner)) / LAMPORTS_PER_SOL;
    this.balanceCache = { key, at: now, sol };
    return sol;
  }

  /** Clears demo state so RUN can be pressed again. */
  reset(): void {
    this.status = "idle";
    this.error = undefined;
    this.steps = [];
    this.seq = 0;
    this.vault = undefined;
  }

  /**
   * A run is stalled if it is marked running but has recorded nothing for
   * STALL_MS. Every step awaits a devnet confirmation and those are now
   * individually timeboxed, so a silent run this old is wedged, not slow.
   * Without this the UI polls "running" forever and RUN keeps 409ing.
   */
  reapStalledRun(now = Date.now()): boolean {
    if (this.status !== "running") return false;
    const last = this.steps.length
      ? this.steps[this.steps.length - 1].ts
      : this.startedAt ?? now;
    if (now - last < STALL_MS) return false;
    this.status = "failed";
    this.error = `run stalled: no progress for ${Math.round(
      (now - last) / 1000
    )}s (RPC unresponsive?) -- press reset and try again`;
    this.rec("info", "run reaped", this.error);
    return true;
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

  // For guards whose outcome legitimately depends on live external state (e.g. a
  // real DBC pool): record whichever result actually happens. A program-level
  // rejection is shown as a block with its error name; anything else (network,
  // signing) is still a real failure and is rethrown.
  private async attemptEither(label: string, fn: () => Promise<string>) {
    try {
      const sig = await fn();
      this.rec("ok", label, `accepted, tx ${sig}`, { tx: sig });
      return sig;
    } catch (e) {
      const d = this.norm(e);
      if (d.name || d.code) {
        this.rec("rejected", label, `blocked on-chain: ${d.name ?? d.code}`, {
          errorCode: d.code,
          errorName: d.name,
        });
        return undefined;
      }
      this.rec("error", label, `failed: ${e}`, {});
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
    // Keep the keypair: every accepted transfer lands here, so without it the
    // demo's spend is unrecoverable and repeated RUNs drain the sponsor.
    this.destinationKp = kp;
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

    // The UI polls this every couple of seconds and a public devnet RPC
    // round-trip is ~1s and heavily rate-limited, so an uncached balance here
    // makes the whole dashboard feel broken. A few seconds of staleness on a
    // SOL balance is invisible and costs nothing.
    const walletBalance = await this.cachedBalance(c.connection, owner);

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
    this.startedAt = Date.now();

    const sponsor = this.client;
    const sponsorKey = sponsor.payer.publicKey;

    // Size the funding from what the sponsor can actually afford. A hardcoded
    // FUND_SOL silently broke the demo on any wallet holding less than it --
    // the transfer can never succeed, and (before the confirm timeout existed)
    // that surfaced as an indefinite hang rather than an error.
    //
    // Public devnet RPCs are load-balanced across nodes that can lag or
    // rate-limit, and a single bad getBalance has been observed reporting
    // 0.005 SOL for a wallet holding 2.8. Trusting one read makes the demo
    // refuse to start for no reason, so retry and take the max.
    const needed = sol(this.cfg.depositSol + FUND_FEE_RESERVE_SOL + FUND_SOL_BUFFER);
    let affordable = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      affordable = await sponsor.connection.getBalance(sponsorKey);
      if (affordable >= needed) break;
      if (attempt < 2) {
        this.rec(
          "info",
          "re-reading sponsor balance",
          `RPC reported ${(affordable / LAMPORTS_PER_SOL).toFixed(4)} SOL, ` +
            `need ~${(needed / LAMPORTS_PER_SOL).toFixed(3)} -- retrying`
        );
        await wait(1200);
      }
    }
    const target = needed;
    const fundLamports =
      this.cfg.fundSol != null
        ? sol(this.cfg.fundSol)
        : Math.max(0, Math.min(target, affordable - sol(FUND_FEE_RESERVE_SOL)));

    if (fundLamports < sol(this.cfg.depositSol)) {
      this.status = "failed";
      this.error =
        `sponsor wallet holds ${(affordable / LAMPORTS_PER_SOL).toFixed(4)} SOL, ` +
        `needs about ${(this.cfg.depositSol + FUND_FEE_RESERVE_SOL).toFixed(3)} ` +
        `to fund a runner and deposit ${this.cfg.depositSol} SOL -- top it up ` +
        `(devnet: solana airdrop 5) or lower depositSol`;
      this.rec("error", "cannot start: sponsor underfunded", this.error);
      throw new Error(this.error);
    }

    const fundSol = fundLamports / LAMPORTS_PER_SOL;
    const runner = Keypair.generate();
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sponsorKey,
        toPubkey: runner.publicKey,
        lamports: fundLamports,
      })
    );
    this.rec("info", "sponsor funds runner wallet", `${fundSol.toFixed(3)} SOL → ${runner.publicKey.toBase58().slice(0, 8)}… (fresh owner + fee payer, so RUN is repeatable)`);
    await sponsor.provider.sendAndConfirm(fundTx);

    this.client = new RampartClient(runner, sponsor.connection.rpcEndpoint);
    const c = this.client;

    // Every cap and transfer amount in this demo is written against a 2 SOL
    // deposit. Scale them together so the same beats stay internally
    // consistent on a smaller vault instead of tripping InsufficientBalance.
    const scale = this.cfg.depositSol / 2;
    const amt = (n: number) => sol(n * scale);
    const dailyUsd = this.cfg.dailyUsd * scale;
    const perTxUsd = this.cfg.perTxUsd * scale;

    const reclaim = async () => {
      if (!this.vault) return;
      try {
        const v = await c.fetchVault(this.vault);
        if (v.frozen) {
          await c.unfreeze(this.vault);
        }
        const treasury = treasuryPubkey(this.vault, (v as { treasuryBump: number }).treasuryBump);
        const tBal = await c.connection.getBalance(treasury);
        if (tBal > 0) {
          const sig = await c.withdraw(this.vault, tBal);
          this.rec("info", "runner reclaims treasury", `withdrew ${(tBal / LAMPORTS_PER_SOL).toFixed(3)} SOL back to runner`, { tx: sig });
        }
      } catch {
        /* best effort */
      }
      try {
        const rBal = await c.connection.getBalance(runner.publicKey);
        const refund = rBal - sol(FUND_FEE_RESERVE_SOL);
        if (refund > 0) {
          const sig = await c.provider.sendAndConfirm(
            new Transaction().add(
              SystemProgram.transfer({ fromPubkey: runner.publicKey, toPubkey: sponsorKey, lamports: refund })
            )
          );
          this.rec("info", "runner refunds sponsor", `returned ${(refund / LAMPORTS_PER_SOL).toFixed(3)} SOL`, { tx: sig });
        }
      } catch {
        /* best effort */
      }
      // Sweep the destination account too. The four accepted transfers really
      // do leave the vault, and this keypair is the only way to get that SOL
      // back to the sponsor; without it every RUN costs ~0.2 SOL permanently.
      const dk = this.destinationKp;
      if (dk) {
        try {
          const dBal = await c.connection.getBalance(dk.publicKey);
          if (dBal > 0) {
            const sig = await c.provider.sendAndConfirm(
              new Transaction().add(
                SystemProgram.transfer({ fromPubkey: dk.publicKey, toPubkey: sponsorKey, lamports: dBal })
              ),
              [dk]
            );
            this.rec("info", "runner reclaims destination", `swept ${(dBal / LAMPORTS_PER_SOL).toFixed(3)} SOL of demo spend back to sponsor`, { tx: sig });
          }
        } catch {
          /* best effort */
        }
      }
    };

    try {
      const dest = await this.ensureDestination();
      this.rec("info", "destination account", `created ${dest.toBase58()}`);

      const feed = await c.createFeed(priceRaw(this.cfg.fairPriceUsd));
      this.feed = feed.publicKey;
      this.rec("info", "mock oracle feed", `feed ${feed.publicKey.toBase58()} at $${this.cfg.fairPriceUsd}`);

      const { vault, sig } = await c.initVault(
        Math.round(dailyUsd * 1e6),
        Math.round(perTxUsd * 1e6),
        feed.publicKey
      );
      this.vault = vault;
      this.rec("ok", "init_vault", `vault ${vault.toBase58()} · caps $${dailyUsd}/day $${perTxUsd}/tx · reference price snapshot $${this.cfg.fairPriceUsd}`, { tx: sig });

      const baseAllowlist = this.cfg.allowlist.length ? this.cfg.allowlist : [dest];
      // A DBC pool must be explicitly approved by the owner to be referenced.
      const allowlist = DBC_POOL ? [...baseAllowlist, DBC_POOL] : baseAllowlist;
      const pSig = await c.proposePolicy(vault, {
        dailyUsdCapMicro: Math.round(dailyUsd * 1e6),
        perTxUsdCapMicro: Math.round(perTxUsd * 1e6),
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

      await this.attempt(`deposit ${this.cfg.depositSol} SOL`, () => c.deposit(vault, sol(this.cfg.depositSol)));

      await this.attempt(
        "guard: allowlisted transfer 0.1 SOL",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.1)),
        { detail: "0.1 SOL = $20 < per-tx $50 cap" }
      );

      await this.attempt(
        "guard: per-tx cap → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.3)),
        { expectReject: true }
      );

      await c.setPrice(feed.publicKey, priceRaw(this.cfg.pumpPriceUsd), -8, 1);
      this.rec("info", "oracle pump +2%", `mock feed now $${this.cfg.pumpPriceUsd}`);

      await this.attempt(
        "guard: price deviation → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.1)),
        { expectReject: true }
      );

      await c.setPrice(feed.publicKey, priceRaw(this.cfg.fairPriceUsd), -8, 1);
      this.rec("info", "oracle restored", `mock feed back to $${this.cfg.fairPriceUsd}`);

      const rand = Keypair.generate().publicKey;
      await this.attempt(
        "guard: non-allowlisted destination → blocked",
        () => c.guardedTransfer(vault, agent, rand, feed.publicKey, amt(0.1)),
        { expectReject: true }
      );

// The daily cap is cumulative, so one oversized transfer can only ever trip
  // the per-tx cap and the daily path is never reached. Four transfers of $48
  // (under the $50 per-tx cap): the first three fit both caps, the fourth
  // crosses the $200 daily ceiling while every single transfer stays legal.
  await this.attempt(
    "guard: daily spend 1 of 4",
    () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.24)),
  );
  await this.attempt(
    "guard: daily spend 2 of 4",
    () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.24)),
  );
  await this.attempt(
    "guard: daily spend 3 of 4",
    () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.24)),
  );
  await this.attempt(
    "guard: daily cap blocked",
    () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.24)),
    { expectReject: true }
  );

      if (DBC_POOL && DBC_CONFIG) {
        // Bind to locals: TS will not carry the narrowing of imported consts
        // into a callback, so passing DBC_POOL directly fails typecheck.
        const pool = DBC_POOL;
        const config = DBC_CONFIG;
        this.rec(
          "info",
          "DBC guard: pool gates",
          "owner-approved pool, a tradeable curve-progress band, and a price-impact cap are enforced on-chain before any funds move"
        );
        // Outcome depends on the live pool: it passes only if the pool sits inside
        // the progress band (past the floor, clear of the graduation cliff) and the
        // trade's curve price impact is within the policy's slippage band; otherwise
        // the named guard error is shown.
        await this.attemptEither(
          "guard: DBC-gated transfer 0.05 SOL",
          () =>
            c.guardedDbcTransfer(vault, agent, dest, feed.publicKey, pool, config, amt(0.05))
        );
      } else {
        this.rec(
          "info",
          "DBC guard step skipped",
          "no RAMPART_DBC_POOL / RAMPART_DBC_CONFIG configured for this environment"
        );
      }

      await this.attempt("owner freezes vault", () => c.freeze(vault));

      await this.attempt(
        "guard: frozen vault → blocked",
        () => c.guardedTransfer(vault, agent, dest, feed.publicKey, amt(0.05)),
        { expectReject: true }
      );

      await this.attempt(
        "guard: agent tries to withdraw → blocked",
        () => c.withdrawAs(vault, agent, amt(0.1)),
        { expectReject: true }
      );

      const uSig = await c.unfreeze(vault);
      this.rec("ok", "owner unfreezes vault", `recovered`, { tx: uSig });

      const finalState = await this.readState();
      this.rec("info", "final position", `treasury ${Number(finalState.treasuryBalance ?? 0).toFixed(3)} SOL · spent $${finalState.spend?.spentUsd ?? "—"}`);
      await reclaim();
      this.status = "done";
    } catch (e) {
      await reclaim();
      this.status = "failed";
      this.error = String(e);
      throw e;
    }
  }
}

export { policyPda };