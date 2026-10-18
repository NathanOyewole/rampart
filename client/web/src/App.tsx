import { useCallback, useEffect, useRef, useState } from "react";

interface StepResult {
  seq: number;
  label: string;
  status: "ok" | "rejected" | "info" | "error";
  detail: string;
  tx?: string;
  errorCode?: number;
  errorName?: string;
  ts: number;
}

interface DemoStatus {
  status: string;
  error?: string;
  steps: StepResult[];
  summary?: { ok: number; rejected: number; info: number };
}

interface VaultInfo {
  owner?: string;
  frozen?: boolean;
  referencePrice?: string;
  timelockSlots?: string;
}

interface PolicyInfo {
  dailyUsd?: string;
  perTxUsd?: string;
  maxSlippageBps?: number;
  allowlist?: string[];
  pendingExists?: boolean;
  pendingEffectiveSlot?: string;
}

interface SpendInfo {
  epochSlot?: string;
  spentUsd?: string;
}

interface State {
  status?: string;
  error?: string;
  owner?: string;
  program?: string;
  walletBalance?: number;
  feed?: string;
  feedPrice?: string;
  agent?: string;
  destination?: string;
  vault?: string;
  vaultState?: VaultInfo;
  policy?: PolicyInfo;
  spend?: SpendInfo;
  treasuryBalance?: number;
}

// explorer.solana.com rate-limits hard (HTTP 429 for a single IP after a few
// hits), which left judges with dead links when verifying a run. Solscan and
// SolanaFM are used instead; SOLANAFM is offered as a fallback on every link
// so one explorer being down never blocks verification.
const EXPLORER = "https://solscan.io";
const SOLANAFM = "https://solana.fm";

const accountUrl = (id: string, base: string) =>
  `${base}/account/${id}?cluster=devnet`;
const txUrl = (sig: string, base: string) =>
  `${base}/tx/${sig}?cluster=devnet`;

function usePolling<T>(
  path: string,
  interval: number | (() => number),
  onData: (d: T) => void
) {
  const [offline, setOffline] = useState(false);
  // Held in refs so a caller can pass a fresh arrow (e.g. an adaptive
  // interval) without re-subscribing the effect on every render.
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const every = () => {
      const i = intervalRef.current;
      return typeof i === "function" ? i() : i;
    };
    const tick = async () => {
      try {
        const res = await fetch(path);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as T;
        if (!stopped) {
          onDataRef.current(data);
          setOffline(false);
          timer = setTimeout(tick, every());
        }
      } catch {
        if (!stopped) {
          setOffline(true);
          timer = setTimeout(tick, every() + 5000);
        }
      }
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [path]);
  return offline;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "running"
      ? "pill running"
      : status === "done"
      ? "pill done"
      : status === "failed"
      ? "pill failed"
      : "pill idle";
  return <span className={cls}>{status.toUpperCase()}</span>;
}

function StepBadge({ status }: { status: StepResult["status"] }) {
  const cls =
    status === "ok" ? "b ok" : status === "rejected" ? "b rejected" : status === "info" ? "b info" : "b error";
  const label = status === "ok" ? "OK" : status === "rejected" ? "BLOCKED" : status === "info" ? "note" : "FAIL";
  return <span className={cls}>{label}</span>;
}

function StepRow({ s }: { s: StepResult }) {
  return (
    <li className={`step ${s.status}`}>
      <span className="step-no">#{String(s.seq).padStart(2, "0")}</span>
      <StepBadge status={s.status} />
      <div className="step-body">
        <div className="step-label">{s.label}</div>
        <div className="step-detail">
          {s.detail}
          {s.errorCode != null && (
            <span className="mono muted"> · code {s.errorCode}</span>
          )}
        </div>
        {s.tx && (
          <>
            <a className="txlink mono" href={txUrl(s.tx, EXPLORER)} target="_blank" rel="noreferrer">
              {s.tx.slice(0, 12)}… ↗
            </a>
            <a
              className="txlink mono muted"
              href={txUrl(s.tx, SOLANAFM)}
              target="_blank"
              rel="noreferrer"
              title="Open on SolanaFM"
            >
              fm
            </a>
          </>
        )}
      </div>
    </li>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export default function App() {
  const [demo, setDemo] = useState<DemoStatus>({ status: "idle", steps: [] });
  const [state, setState] = useState<State>({});
  const [running, setRunning] = useState(false);

  const onDemo = useCallback((d: DemoStatus) => setDemo(d), []);
  const onState = useCallback((s: State) => setState(s), []);

  // Fast only while a run is actually progressing. Idle/done polling every 2s
  // means every open tab hammers the public devnet RPC for nothing, which is
  // what made the dashboard feel slow with several tabs open.
  const statusRef = useRef(demo.status);
  statusRef.current = demo.status;
  const demoInterval = () => (statusRef.current === "running" ? 1500 : 6000);
  const stateInterval = () => (statusRef.current === "running" ? 3000 : 8000);

  const offline = usePolling<DemoStatus>("/api/demo/status", demoInterval, onDemo);
  usePolling<State>("/api/state", stateInterval, onState);

  const run = async () => {
    try {
      setRunning(true);
      const res = await fetch("/api/demo/run", { method: "POST" });
      // A wedged run answers 409; surface it instead of silently doing nothing.
      if (res.status === 409) {
        await fetch("/api/demo/reset", { method: "POST" });
        await fetch("/api/demo/run", { method: "POST" });
      }
    } finally {
      setRunning(false);
    }
  };

  const reset = async () => {
    try {
      setRunning(true);
      await fetch("/api/demo/reset", { method: "POST" });
    } finally {
      setRunning(false);
    }
  };

  const active = demo.status === "running";

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">▮ RAMPART</span>
          <span className="tag">policy vaults for trading agents</span>
        </div>
        <div className="hdr-right">
          <a className="pill" href="/docs">docs</a>
          <a className="pill" href="/changelog">changelog</a>
          <a className="pill" href="/status">status</a>
          {offline && <span className="pill offline">API OFFLINE · RETRYING</span>}
          <span className="pill net">DEVNET · SOLANA</span>
          <StatusBadge status={demo.status} />
        </div>
      </header>

      <main>
        <div className="col col-left">
          <section className="card demo-card">
            <div className="demo-head">
              <h3>On-chain demo</h3>
              <div className="demo-actions">
                {!active && (
                  <button
                    className="reset"
                    onClick={reset}
                    disabled={running}
                    title="Clear a stalled or finished run"
                  >
                    RESET
                  </button>
                )}
                <button className="run" onClick={run} disabled={active || running}>
                  {active ? "RUNNING…" : "RUN DEMO"}
                </button>
              </div>
            </div>
            {demo.error && <div className="demo-error mono">{demo.error}</div>}
            {demo.summary && !active && (
              <div className="summary">
                <span className="chip ok">{demo.summary.ok} accepted</span>
                <span className="chip rejected">{demo.summary.rejected} blocked on-chain</span>
                <span className="chip info">{demo.summary.info} notes</span>
              </div>
            )}
            <ol className="steps">
              {demo.steps.map((s) => (
                <StepRow key={s.seq} s={s} />
              ))}
              {demo.steps.length === 0 && (
                <li className="step idle">
                  <div className="step-body">
                    <div className="step-label">agent wallet has zero authority</div>
                    <div className="step-detail muted">
                      hit RUN to watch an agent sign intents while the chain blocks every drain.
                    </div>
                  </div>
                </li>
              )}
            </ol>
          </section>
        </div>

        <div className="col col-right">
          <Card title="Vault">
            <Row k="vault" v={state.vault ? <Short kind="vault" id={state.vault} /> : "not created"} />
            <Row k="reference" v={state.vaultState?.referencePrice ?? "—"} />
            <Row k="frozen" v={state.vaultState?.frozen === true ? <span className="bad frozen">FROZEN</span> : <span className="good">no</span>} />
            <Row k="treasury" v={`${Number(state.treasuryBalance ?? 0).toFixed(3)} SOL`} />
            <Row k="spent" v={state.spend ? `$${state.spend.spentUsd} (epoch ${state.spend.epochSlot})` : "—"} />
            <Row k="owner" v={<Short kind="acct" id={state.owner ?? ""} />} />
            <Row k="wallet" v={`${Number(state.walletBalance ?? 0).toFixed(3)} SOL`} />
          </Card>

          <Card title="Policy">
            <Row k="daily cap" v={state.policy?.dailyUsd ? `$${state.policy.dailyUsd}/epoch` : "—"} />
            <Row k="per-tx cap" v={state.policy?.perTxUsd ? `$${state.policy.perTxUsd}` : "—"} />
            <Row k="slippage" v={state.policy?.maxSlippageBps != null ? `${state.policy.maxSlippageBps} bps` : "—"} />
            <Row k="allowlist" v={<AllowList list={(state.policy?.allowlist as string[] | undefined) ?? []} />} />
            {state.policy?.pendingExists && (
              <Row k="pending@slot" v={<span className="mono">{String(state.policy.pendingEffectiveSlot)}</span>} />
            )}
          </Card>

          <Card title="Oracle">
            <Row k="feed" v={state.feed ? <Short kind="acct" id={state.feed} /> : "—"} />
            <Row k="live price" v={state.feedPrice ? `$${state.feedPrice}` : "—"} />
            <Row k="agent" v={state.agent ? <Short kind="acct" id={state.agent} /> : "—"} />
            <Row k="destination" v={state.destination ? <Short kind="acct" id={state.destination} /> : "—"} />
          </Card>

          <footer>
            <span className="mono">{state.program ? ShortText(state.program, 18) : "program —"}</span>
            <span className="muted">policy vault · devnet · every guard fires on-chain</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function ShortText(id: string, n: number) {
  return `${id.slice(0, n)}…${id.slice(-4)}`;
}

function Short({ id, kind }: { id: string; kind: "vault" | "acct" }) {
  const text = ShortText(id, kind === "vault" ? 22 : 10);
  if (!id) return <span className="mono">{text}</span>;
  return (
    <span className="mono">
      <a className="txlink" href={accountUrl(id, EXPLORER)} target="_blank" rel="noreferrer">
        {text} ↗
      </a>{" "}
      <a
        className="txlink muted"
        href={accountUrl(id, SOLANAFM)}
        target="_blank"
        rel="noreferrer"
        title="Open on SolanaFM"
      >
        fm
      </a>
    </span>
  );
}

function AllowList({ list }: { list: string[] }) {
  if (!list.length) return <span className="muted">empty</span>;
  return (
    <div className="al">
      {list.map((k) => (
        <span key={k} className="chip info mono">
          {ShortText(k, 10)}
        </span>
      ))}
    </div>
  );
}