import { Keypair, Transaction } from "@solana/web3.js";

export class KeypairWallet {
  readonly payer: Keypair;

  constructor(payer: Keypair) {
    this.payer = payer;
  }

  get publicKey() {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction>(tx: T): Promise<T> {
    tx.partialSign(this.payer);
    return tx;
  }

  async signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) tx.partialSign(this.payer);
    return txs;
  }
}