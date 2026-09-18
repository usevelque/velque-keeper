// POST /api/faucet { wallet }: test tokens for every market, once per wallet.
// 100 of each test stock and 50,000 tUSDC to the associated token accounts, plus
// a little SOL for fees if the wallet has almost none.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { conn, signer, markets, quoteMint, quoteProg, json } from './_shared.mjs';

const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const U = 1_000_000n;
const BASE_DROP = 100n;
const QUOTE_DROP = 50_000n * U;
const SOL_DROP = 40_000_000; // 0.04 SOL
const SOL_FLOOR = 10_000_000;

const ata = (owner, mint, prog) => PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA)[0];
const createAtaIx = (payer, owner, mint, prog) => new TransactionInstruction({
  programId: ATA,
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata(owner, mint, prog), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: prog, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1]), // CreateIdempotent
});
const mintToIx = (mint, prog, dest, authority, amount) => {
  const d = Buffer.alloc(9); d[0] = 7; d.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: prog, keys: [
    { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false }], data: d });
};

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

