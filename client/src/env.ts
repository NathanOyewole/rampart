import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr"
);
export const MOCK_PROGRAM_ID = new PublicKey(
  "2xbNzbkEZ65hLzi9TgdMBcncup6a5CA1qi3QLVTrwQ2p"
);

// explorer.solana.com returns HTTP 429 for a single IP after a few requests,
// so it is not used as the default anywhere. Solscan is the primary
// human-facing explorer; solana.fm is a fallback.
export const EXPLORER_URL = "https://solscan.io";
export const EXPLORER_URL_FALLBACK = "https://solana.fm";

// RPC selection, in order of precedence:
//   1. RAMPART_RPC          -- explicit URL (any provider)
//   2. HELIUS_API_KEY       -- Helius devnet, free tier is enough for the demo
//   3. devnet.rpcpool.com   -- keyless fallback
//
// The public api.devnet.solana.com endpoint is deliberately NOT the default:
// a confirmed transaction there routinely took >6s and the endpoint is
// aggressively rate-limited per IP, which stalled the multi-tx demo.
function resolveRpcUrl(): string {
  const raw =
    process.env.RAMPART_RPC ||
    (process.env.HELIUS_API_KEY
      ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : "https://devnet.rpcpool.com");
  // Dashboard env fields commonly carry stray whitespace or wrapping quotes from
  // a copy-paste. web3.js asserts on the raw string and dies with a message
  // that never shows the offending value, so normalise and fail legibly.
  const url = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `RAMPART_RPC must start with http:// or https:// (got ${JSON.stringify(raw.slice(0, 80))})`
    );
  }
  return url;
}

export const RPC_URL = resolveRpcUrl();

export const VAULT_SEED = Buffer.from("rampart_vault");
export const TREASURY_SEED = Buffer.from("rampart_treasury");
export const POLICY_SEED = Buffer.from("rampart_policy");
export const SPEND_SEED = Buffer.from("rampart_spend");
export const AGENT_SEED = Buffer.from("rampart_agent");

export const PYTH_EXPO_OFFSET = 0x14;
export const PYTH_PRICE_OFFSET = 0x30;
export const PYTH_STATUS_OFFSET = 0x44;
export const PYTH_MIN_DATA_LEN = 0x45;
export const STATUS_TRADING = 1;

export const DBC_PROGRAM_ID = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
);

// A real DBC pool + its config, created once (e.g. via Meteora's Invent CLI or
// launchpad scaffold) and reused across demo runs — not created fresh per run,
// since a bonding curve needs actual trading history to be interesting.
// Unset in environments where a pool hasn't been created yet; demo steps that
// need it are skipped with an "info" note rather than failing the whole run.
export const DBC_POOL = process.env.RAMPART_DBC_POOL
  ? new PublicKey(process.env.RAMPART_DBC_POOL)
  : undefined;
export const DBC_CONFIG = process.env.RAMPART_DBC_CONFIG
  ? new PublicKey(process.env.RAMPART_DBC_CONFIG)
  : undefined;

export function loadPayer(): Keypair {
  const b64 = process.env.RAMPART_WALLET_B64;
  if (b64) {
    const decoded = Buffer.from(b64, "base64");
    try {
      const parsed = JSON.parse(decoded.toString("utf8"));
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    } catch {
      return Keypair.fromSecretKey(Uint8Array.from(decoded));
    }
  }
  const path = process.env.RAMPART_WALLET ?? "../target/deploy/devnet-wallet.json";
  const raw = readFileSync(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export function usdFromPyth(priceRaw: number, expo: number): number {
  return priceRaw * 10 ** expo;
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}