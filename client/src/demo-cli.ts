import { RampartClient } from "./rampart.js";
import { RampartDemo, StepResult } from "./demo.js";
import { loadPayer } from "./env.js";

function logStep(s: StepResult) {
  const mark =
    s.status === "ok" ? "  OK  " :
    s.status === "rejected" ? "BLOCKED" :
    s.status === "info" ? "  ..  " : " FAIL  ";
  let line = `${mark}  #${String(s.seq).padStart(2, " ")}  ${s.label}`;
  if (s.status === "rejected") {
    line += `  [${s.errorName ?? s.errorCode ?? "rejected"}]`;
  }
  if (s.tx) line += `\n           ${s.tx}`;
  console.log(line);
}

async function main() {
  const payer = loadPayer();
  const client = new RampartClient(payer);
  console.log(`Rampart demo on ${client.connection.rpcEndpoint}`);
  console.log(`owner   ${payer.publicKey.toBase58()}`);
  console.log(`program ${client.program.programId.toBase58()}`);
  console.log(`mock    ${client.mockProgram.programId.toBase58()}`);
  console.log("");
  console.log("the agent wallet has ZERO authority over vault funds.");
  console.log("");

  const demo = new RampartDemo(client);
  try {
    await demo.run();
  } catch (e) {
    console.error("demo failed:", e);
  }

  console.log("");
  for (const s of demo.steps) logStep(s);
  console.log("");
  console.log(`${demo.status.toUpperCase()} — ${demo.steps.filter((s) => s.status === "rejected").length} guard blocks, ${demo.steps.filter((s) => s.status === "ok").length} accepted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});