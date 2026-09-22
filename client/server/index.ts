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

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    rpc: client.connection.rpcEndpoint,
    program: PROGRAM_ID.toBase58(),
    mockProgram: MOCK_PROGRAM_ID.toBase58(),
    owner: payer.publicKey.toBase58(),
    uptime: Math.round(process.uptime()),
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

app.post("/api/demo/run", async (_req, res) => {
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

app.get("/api/demo/status", (_req, res) => {
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
  console.log(`rpc ${client.connection.rpcEndpoint}`);
  console.log(`owner ${payer.publicKey.toBase58()}`);
  if (!existsSync(webDist)) {
    console.log("web not built yet — run `pnpm build:web`");
  }
});