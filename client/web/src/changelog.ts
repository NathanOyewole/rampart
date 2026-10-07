export type Scope = "live" | "source" | "ci" | "deploy";

export interface Entry {
  scope: Scope;
  text: string;
  sha?: string;
}

export interface Day {
  date: string;
  entries: Entry[];
}

/** Curated from main, 2 Sep–7 Oct 2026. First commit is 22 Sep. No history before that. */
export const CHANGELOG: Day[] = [
  {
    date: "2026-10-07",
    entries: [
      { scope: "live", sha: "145de64", text: "Run stays on the configured Helius endpoint. A single getBalance that reported 0.005 SOL no longer aborts the demo. The check keeps the max of getBalance and getAccountInfo, and only shrinks the deposit if that read is actually thin." },
    ],
  },
  {
    date: "2026-10-06",
    entries: [
      { scope: "live", sha: "2ddae1d", text: "iPhone, Android, and iPad layout. The vault column was painting over the run log. iPad stacks the log and puts the cards in two columns. Phones are one column, with 44px actions." },
      { scope: "live", sha: "1a1618f", text: "Notched phones. viewport-fit=cover and safe-area padding so the header is not under the status bar." },
    ],
  },
  {
    date: "2026-10-05",
    entries: [
      { scope: "deploy", sha: "6f409ac", text: "Dockerfile so the host runs a web service, not a static app. /api and /healthz exist because the Express server ships with the page." },
      { scope: "deploy", sha: "8bfc6c5", text: "Container boot. pnpm is installed globally. corepack was crashing on a missing cache dir." },
      { scope: "deploy", sha: "05253b9", text: "RAMPART_RPC is trimmed and quote-stripped before web3.js sees it. A wrapped env value was killing startup with 'Endpoint URL must start with http:'." },
      { scope: "live", sha: "98045df", text: "Demo deposit sized to the sponsor. A 0.5 SOL ask against a thinner balance aborted every run before a transaction." },
      { scope: "live", sha: "8e6806b", text: "Agent-withdraw beat is named OwnerSignatureRequired. web3.js throws before the transaction is sent, so there is no on-chain error code to invent." },
      { scope: "source", sha: "6ded422", text: "README rewritten against the deployed program. Test count is 37, not 13. guarded_dbc_transfer is not in the devnet binary. Upgrade authority was renounced." },
    ],
  },
  {
    date: "2026-10-03",
    entries: [
      { scope: "live", sha: "e0cde7d", text: "Server boots under Node 22. BN comes from bn.js, not an Anchor named export that does not exist. Daily-cap beat now sends four sub-cap transfers so DailyCapExceeded can actually fire. Agent withdraw passes the real owner and signs with the agent." },
      { scope: "live", sha: "93ff158", text: "Caps and transfer sizes scale off the deposit. A full run was verified on Helius at a 0.5 SOL deposit: 11 accepted, 7 refused, each refusal named." },
      { scope: "live", sha: "8db7bb2", text: "Accepted transfers are swept back to the sponsor. A run was permanently spending about 0.2 SOL because the destination keypair was discarded." },
      { scope: "live", sha: "97cdf1c", text: "/healthz no longer prints the Helius api-key. RUN and RESET can be gated with RAMPART_RUN_TOKEN." },
    ],
  },
  {
    date: "2026-10-02",
    entries: [
      { scope: "live", sha: "493b36f", text: "A wedged confirmation no longer bricks the dashboard. Confirmations time out, a stalled run is reaped, RESET recovers it, and RUN retries once on 409." },
      { scope: "live", sha: "b25992f", text: "Explorer links go to Solscan, with SolanaFM as the fallback. explorer.solana.com was 429ing a single IP." },
      { scope: "source", sha: "366146b", text: "PoolTooLate (6025). Source refuses a Meteora curve past 80% progress. Tradeable band in source is 20–80%. Not in the deployed binary." },
      { scope: "source", sha: "9755fd5", text: "DBC guard stack documented. The vault gates and releases. It does not call Meteora, because a swap would need the pool authority to sign." },
    ],
  },
  {
    date: "2026-10-01",
    entries: [
      { scope: "source", sha: "24d01ec", text: "Meteora DBC guard merged from pull request 1. In source and CI. The devnet program was already deployed with upgrade authority renounced, so this did not change the live binary." },
      { scope: "ci", sha: "0356a12", text: "DBC tests run against a real Meteora pool fixture. A zero-copy length panic on that fixture is fixed." },
    ],
  },
  {
    date: "2026-09-28",
    entries: [
      { scope: "source", sha: "23b2b5f", text: "DBC gate checks pool health instead of inventing a price the curve did not return. CPI feature enabled on the dynamic-bonding-curve dependency so the program can read it." },
    ],
  },
  {
    date: "2026-09-27",
    entries: [
      { scope: "source", sha: "bd9684d", text: "First Meteora DBC-priced guard, next to the existing Pyth guard. Client wiring followed the same day. Still source-only relative to the renounced devnet program." },
    ],
  },
  {
    date: "2026-09-22",
    entries: [
      { scope: "live", sha: "e993972", text: "Policy vault program. init, deposit, withdraw, register agent, freeze, timelocked policy, guarded transfer. Allowlist, per-tx cap, daily cap, Pyth band. Error codes from 6000." },
      { scope: "live", sha: "6680ab4", text: "Oracle-mock program so a demo can move the feed without waiting on Pyth." },
      { scope: "live", sha: "66acf95", text: "Devnet client, demo runner, API, and the dashboard. First full run: 8 accepts, 7 on-chain blocks." },
      { scope: "live", sha: "517d945", text: "Each run funds a fresh runner and reclaims the treasury, so RUN can be repeated." },
      { scope: "deploy", sha: "e61d73e", text: "Server can boot from RAMPART_WALLET_B64. That is what a hosted deploy uses." },
      { scope: "source", sha: "5eb8c99", text: "Mainnet-readiness note. Feed pin, staleness, and reference re-snap are written down as not built." },
    ],
  },
];

export const EMPTY_BEFORE = "2 Sep–21 Sep 2026: no commits. The repo starts 22 Sep.";
