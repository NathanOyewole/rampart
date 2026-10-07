import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RampartClient } from "../src/rampart.js";
import { RampartDemo } from "../src/demo.js";
import { loadPayer, RPC_URL, PROGRAM_ID, MOCK_PROGRAM_ID } from "../src/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8788);
const payer = loadPayer();

const client = new RampartClient(payer, RPC_URL);
const demo = new RampartDemo(client);

const app = express();
app.use(cors());
app.use(express.json());

const redact = (endpoint: string) => endpoint.replace(/([?&]api-key=)[^&]*/gi, "$1REDACTED");

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    rpc: redact(client.connection.rpcEndpoint),
    program: PROGRAM_ID.toBase58(),
    mockProgram: MOCK_PROGRAM_ID.toBase58(),
    owner: payer.publicKey.toBase58(),
    uptime: Math.round(process.uptime()),
  });
});


app.get("/api/status", async (_req, res) => {
  const started = Date.now();
  const checks: { name: string; ok: boolean; level: "ok" | "warn" | "down"; detail: string }[] = [];
  let heliusOk = false;
  let programOk = false;
  try {
    const slot = await client.connection.getSlot("confirmed");
    heliusOk = true;
    checks.push({ name: "helius", ok: true, level: "ok", detail: `slot ${slot}` });
  } catch (e) {
    checks.push({ name: "helius", ok: false, level: "down", detail: String(e).slice(0, 180) });
  }
  try {
    const info = await client.connection.getAccountInfo(PROGRAM_ID);
    programOk = !!info;
    checks.push({
      name: "program",
      ok: programOk,
      level: programOk ? "ok" : "down",
      detail: programOk ? "account present on devnet" : "missing on this cluster",
    });
  } catch (e) {
    checks.push({ name: "program", ok: false, level: "down", detail: String(e).slice(0, 180) });
  }
  try {
    const bal = await client.connection.getBalance(payer.publicKey, "confirmed");
    const sol = bal / 1_000_000_000;
    const thin = sol < 0.08;
    checks.push({
      name: "sponsor",
      ok: !thin,
      level: thin ? "warn" : "ok",
      detail: `${sol.toFixed(3)} SOL`,
    });
  } catch (e) {
    checks.push({ name: "sponsor", ok: false, level: "warn", detail: String(e).slice(0, 180) });
  }
  checks.push({
    name: "demo",
    ok: demo.status !== "failed",
    level: demo.status === "failed" ? "warn" : "ok",
    detail: demo.error ? `${demo.status}: ${demo.error.slice(0, 160)}` : demo.status,
  });
  const state = !heliusOk || !programOk ? "down" : checks.some((c) => c.level === "warn") ? "degraded" : "operational";
  res.status(state === "down" ? 503 : 200).json({
    ok: state === "operational",
    state,
    rpc: redact(client.connection.rpcEndpoint),
    program: PROGRAM_ID.toBase58(),
    mockProgram: MOCK_PROGRAM_ID.toBase58(),
    owner: payer.publicKey.toBase58(),
    uptime: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    checks,
  });
});

app.get("/api/state", async (_req, res) => {
  try {
    res.json(await demo.readState());
  } catch (e) {
    const err = String(e);
    const messageOverride = err.includes("no program") ? "program not deployed on this network yet" : undefined;
    res.status(503).json({ error: messageOverride ?? err });
  }
});

// RUN and RESET spend the sponsor wallet, so they stay owner-only unless a token
// is explicitly configured for a shared/public judge link.
const runToken = process.env.RAMPART_RUN_TOKEN;
const gate = (req: express.Request, res: express.Response): boolean => {
  if (!runToken) return true;
  const given = req.get("x-rampart-token") ?? req.query.token;
  if (given === runToken) return true;
  res.status(401).json({ error: "run token required" });
  return false;
};

app.post("/api/demo/run", async (req, res) => {
  if (!gate(req, res)) return;
  demo.reapStalledRun();
  if (demo.status === "running") {
    res.status(409).json({ error: "demo already running" });
    return;
  }
  demo
    .run()
    .catch(() => {
      /* status captured in demo.error */
    });
  res.status(202).json({ ok: true, status: "running" });
});

// Recovers a wedged run without a server restart. A run that has produced no
// step for STALL_MS cannot still be making progress: every step awaits a devnet
// confirmation, and those are individually timeboxed now.
app.post("/api/demo/reset", (req, res) => {
  if (!gate(req, res)) return;
  const was = demo.status;
  demo.reset();
  res.json({ ok: true, was, status: demo.status });
});

app.get("/api/demo/status", (_req, res) => {
  demo.reapStalledRun();
  res.json({
    status: demo.status,
    error: demo.error,
    steps: demo.steps,
    summary: {
      ok: demo.steps.filter((s) => s.status === "ok").length,
      rejected: demo.steps.filter((s) => s.status === "rejected").length,
      info: demo.steps.filter((s) => s.status === "info").length,
    },
  });
});

const webDist = join(__dirname, "..", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(join(webDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`rampart api on http://localhost:${PORT}`);
  console.log(`rpc ${redact(client.connection.rpcEndpoint)}`);
  console.log(`owner ${payer.publicKey.toBase58()}`);
  if (!existsSync(webDist)) {
    console.log("web not built yet — run `pnpm build:web`");
  }
});