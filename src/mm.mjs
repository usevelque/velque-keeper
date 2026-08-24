// Market maker for the test market. Called from the keeper only by cron (with the secret).
//
// Day: keeps two quote levels on each side around the reference (±0.2% and
// ±0.6%). If the reference moves more than 0.1% away from a quote, it cancels
// the quote and places it again. Claims the proceeds of filled orders (claim_day).
// Dark: if it has no orders in the current window, it places one GTC buy and
// one GTC sell at ±1% from the last reference. These orders carry over from
// window to window by themselves and at the open pass through the cross into
// the day book. Claims what was filled in cleared windows.
//
// It never trades against itself and does not paint volume: a trade happens
// only when someone hits one of its quotes.
import { Transaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import * as V from 'velque-sdk/client';

const DAY_LEVELS = [{ bps: 20n, usd: 2_500n }, { bps: 60n, usd: 6_000n }];
const NIGHT = { bps: 100n, usd: 4_000n };
const REQUOTE_BPS = 20n;
const U = 1_000_000n;

const floorTick = (p, t) => (p / t) * t;
const ceilTick = (p, t) => ((p + t - 1n) / t) * t;

function qtyFor(usd, price, lot, baseDec) {
  const BU = 10n ** BigInt(baseDec);
  const q = (usd * U * BU) / price;
  return (q / lot) * lot;
}

/** Account balance; null if it could not be read (then no top-up is made). */
async function balance(conn, acc) {
  try { return BigInt((await conn.getTokenAccountBalance(acc)).value.amount); } catch { return null; }
}

const mintToIx = (prog, mint, dest, authority, amount) => {
  const d = Buffer.alloc(9); d[0] = 7; d.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: prog, keys: [
    { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false }], data: d });
};

