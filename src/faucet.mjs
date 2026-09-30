// POST /api/faucet { wallet }: test tokens for every market, once per wallet.
// 100 of each test stock and 50,000 tUSDC to the associated token accounts, plus
// a little SOL for fees if the wallet has almost none.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { conn, signer, markets, quoteMint, quoteProg, json } from './_shared.mjs';

const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const U = 1_000_000n;
const BASE_DROP = 100n;
const QUOTE_DROP = 50_000n * U;
const SOL_DROP = 20_000_000; // 0.02 SOL
const SOL_FLOOR = 10_000_000;
// SOL is given out only from the surplus: the same key pays rent for the market
// books, and the faucet must not drain it
const SOL_RESERVE = 250_000_000;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  let wallet;
  try {
    wallet = new PublicKey((await readBody(req)).wallet);
  } catch {
    return json(res, 400, { error: 'bad wallet' });
  }
  try {
    const me = signer();
    const qAta = ata(wallet, quoteMint, quoteProg);
    if (await conn.getAccountInfo(qAta)) {
      return json(res, 429, { error: 'This wallet already has test tokens.' });
    }
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    for (const m of markets) {
      tx.add(createAtaIx(me.publicKey, wallet, m.baseMintKey, m.baseProgKey),
        mintToIx(m.baseMintKey, m.baseProgKey, ata(wallet, m.baseMintKey, m.baseProgKey), me.publicKey, BASE_DROP * 10n ** BigInt(m.baseDecimals)));
    }
    tx.add(createAtaIx(me.publicKey, wallet, quoteMint, quoteProg), mintToIx(quoteMint, quoteProg, qAta, me.publicKey, QUOTE_DROP));
    let sol = 0;
    if ((await conn.getBalance(wallet)) < SOL_FLOOR && (await conn.getBalance(me.publicKey)) > SOL_RESERVE) {
      tx.add(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: wallet, lamports: SOL_DROP }));
      sol = SOL_DROP / 1e9;
    }
    const sig = await sendAndConfirmTransaction(conn, tx, [me], { commitment: 'confirmed' });
    return json(res, 200, { ok: true, sig, base: Number(BASE_DROP), bases: markets.map((m) => m.baseSymbol), quote: Number(QUOTE_DROP / U), sol });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
}
