import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "6Ea4SqpMwVE57cghBU4LqhZBSs573cQ8o8FXDitKUHEr"
);
export const MOCK_PROGRAM_ID = new PublicKey(
  "2xbNzbkEZ65hLzi9TgdMBcncup6a5CA1qi3QLVTrwQ2p"
);

export const EXPLORER_URL = "https://explorer.solana.com";

export const RPC_URL =
  process.env.RAMPART_RPC ?? "https://api.devnet.solana.com";

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