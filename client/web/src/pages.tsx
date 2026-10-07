import { useEffect, useState } from "react";
import { CHANGELOG, EMPTY_BEFORE, type Scope } from "./changelog";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <header>
        <div className="brand">
          <a className="logo" href="/">▮ RAMPART</a>
          <span className="tag">policy vaults for trading agents</span>
        </div>
        <nav className="hdr-right">
          <a className="pill" href="/">demo</a>
          <a className="pill" href="/changelog">changelog</a>
          <a className="pill" href="/status">status</a>
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

const SCOPE: Record<Scope, string> = {
  live: "live",
  source: "source",
  ci: "ci",
  deploy: "deploy",
};

export function ChangelogPage() {
  return (
    <Shell>
      <section className="card page-card">
        <h3>Changelog</h3>
        <p className="step-detail">
          What changed on main, 2 Sep–7 Oct 2026. Live means the hosted demo or the deployed program. Source means the commit is real and the devnet binary did not move, because upgrade authority was renounced.
        </p>
        <p className="step-detail">{EMPTY_BEFORE}</p>
        {CHANGELOG.map((day) => (
          <article key={day.date} className="log-day">
            <h4 className="mono">{day.date}</h4>
            <ul className="steps">
              {day.entries.map((e) => (
                <li key={e.text} className="step">
                  <span className={`b ${e.scope === "live" ? "ok" : e.scope === "source" ? "info" : "error"}`}>{SCOPE[e.scope]}</span>
                  <div className="step-body">
                    <div className="step-detail">{e.text}</div>
                    {e.sha && (
                      <a className="txlink mono" href={`https://github.com/NathanOyewole/rampart/commit/${e.sha}`} target="_blank" rel="noreferrer">
                        {e.sha}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </Shell>
  );
}

interface Check {
  name: string;
  ok: boolean;
  level: "ok" | "warn" | "down";
  detail: string;
}

interface StatusBody {
  ok: boolean;
  state: "operational" | "degraded" | "down";
  rpc?: string;
  program?: string;
  owner?: string;
  uptime?: number;
  checkedAt?: string;
  latencyMs?: number;
  checks?: Check[];
  error?: string;
}

export function StatusPage() {
  const [body, setBody] = useState<StatusBody | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/status");
        const data = (await res.json()) as StatusBody;
        if (!stopped) {
          setBody(data);
          setOffline(false);
        }
      } catch {
        if (!stopped) setOffline(true);
      }
    };
    tick();
    const timer = setInterval(tick, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const state = offline ? "down" : body?.state ?? "down";
  return (
    <Shell>
      <section className="card page-card">
        <h3>Status</h3>
        <p className={`status-banner ${state}`}>
          {offline ? "page cannot reach the API" : body ? state : "checking"}
        </p>
        <p className="step-detail">
          Operational means the process is up, Helius answered, and the program account is on devnet. Degraded means the last demo run failed or the sponsor read is thin. This is not a mainnet claim.
        </p>
        {body && (
          <>
            <div className="row"><span className="k">checked</span><span className="v mono">{body.checkedAt}</span></div>
            <div className="row"><span className="k">latency</span><span className="v mono">{body.latencyMs} ms</span></div>
            <div className="row"><span className="k">uptime</span><span className="v mono">{body.uptime}s</span></div>
            <div className="row"><span className="k">rpc</span><span className="v mono">{body.rpc}</span></div>
            <div className="row"><span className="k">program</span><span className="v mono">{body.program}</span></div>
            <div className="row"><span className="k">sponsor</span><span className="v mono">{body.owner}</span></div>
            <ul className="steps">
              {(body.checks ?? []).map((c) => (
                <li key={c.name} className="step">
                  <span className={`b ${c.level === "ok" ? "ok" : c.level === "warn" ? "error" : "rejected"}`}>{c.level}</span>
                  <div className="step-body">
                    <div className="step-label">{c.name}</div>
                    <div className="step-detail">{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </Shell>
  );
}
