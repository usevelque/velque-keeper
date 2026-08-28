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

async function sendBatches(conn, payer, ixs, per = 3) {
  const sigs = [];
  for (let i = 0; i < ixs.length; i += per) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }),
      ...ixs.slice(i, i + per),
    );
    tx.feePayer = payer.publicKey;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(payer);
    const sig = await conn.sendRawTransaction(tx.serialize());
    sigs.push(conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed').then((r) => (r.value.err ? `err ${JSON.stringify(r.value.err)}` : 'ok')).catch((e) => `err ${String(e.message).slice(0, 60)}`));
  }
  return Promise.all(sigs);
}

/**
 * One market maker pass over a market. oracle is needed to top up the market
 * maker with test tokens (it mints them on devnet).
 */
export async function makeMarket({ conn, m, mk, mm, oracle, quoteMint, quoteProg, now }) {
  const report = { did: [] };
  const R = mk.reference;
  if (!R || R === 0n) return report;
  const baseAcc = V.ata(mm.publicKey, m.baseMintKey, m.baseProgKey);
  const quoteAcc = V.ata(mm.publicKey, quoteMint, quoteProg);
  const BU = 10n ** BigInt(m.baseDecimals);

  // top up test tokens if the market maker has run low
  const [bb, qb] = await Promise.all([balance(conn, baseAcc), balance(conn, quoteAcc)]);
  const top = [];
  if (bb !== null && bb < 300n * BU) top.push(mintToIx(m.baseProgKey, m.baseMintKey, baseAcc, oracle.publicKey, 1_000n * BU));
  if (qb !== null && qb < 300_000n * U) top.push(mintToIx(quoteProg, quoteMint, quoteAcc, oracle.publicKey, 1_000_000n * U));
  if (top.length) { await sendBatches(conn, oracle, top, 2); report.did.push('topup'); }

  const ixs = [];
  const sess = V.session(mk, now);
  const tick = mk.tick;
  const lot = mk.lot;

  if (sess === 'day') {
    const day = await V.readDay(conn, m.marketKey);
    const mine = day.slots.filter((s) => s.owner.equals(mm.publicKey));
    const targets = DAY_LEVELS.flatMap((l) => {
      const bid = floorTick((R * (10_000n - l.bps)) / 10_000n, tick);
      const ask = ceilTick((R * (10_000n + l.bps)) / 10_000n, tick);
      return [
        { side: V.BUY, sideName: 'buy', price: bid, qty: qtyFor(l.usd, bid, lot, m.baseDecimals) },
        { side: V.SELL, sideName: 'sell', price: ask, qty: qtyFor(l.usd, ask, lot, m.baseDecimals) },
      ];
    });
    const tol = (R * REQUOTE_BPS) / 10_000n;
    const used = new Set();
    for (const s of mine) {
      if (s.status === 'moved' || (s.qty === 0n && s.status === 'live')) { ixs.push(V.claimDayIx({ owner: mm.publicKey, mk, index: s.index, baseAcc, quoteAcc })); continue; }
      const t = targets.findIndex((x, i) => !used.has(i) && x.sideName === s.side && (s.price > x.price ? s.price - x.price : x.price - s.price) <= tol);
      if (t >= 0) {
        used.add(t);
        if (s.owed > 0n) ixs.push(V.claimDayIx({ owner: mm.publicKey, mk, index: s.index, baseAcc, quoteAcc }));
      } else {
        ixs.push(V.cancelDayIx({ owner: mm.publicKey, mk, index: s.index, baseAcc, quoteAcc }));
      }
    }
    targets.forEach((t, i) => {
      if (!used.has(i) && t.qty > 0n) ixs.push(V.placeDayIx({ owner: mm.publicKey, mk, side: t.side, price: t.price, qty: t.qty, baseAcc, quoteAcc }));
    });
    if (ixs.length) report.did.push(`day ${ixs.length} ix`);
  } else {
    // Dark: GTC orders in the current window, if not placed yet
    if (now < mk.windowEnd - 8) {
      const book = await V.readBook(conn, V.bookPda(m.marketKey, mk.auctionId));
      const live = book ? book.orders.filter((o) => o.owner.equals(mm.publicKey) && o.status === 'live') : [];
      const hasBid = live.some((o) => o.side === 'buy');
      const hasAsk = live.some((o) => o.side === 'sell');
      const bid = floorTick((R * (10_000n - NIGHT.bps)) / 10_000n, tick);
      const ask = ceilTick((R * (10_000n + NIGHT.bps)) / 10_000n, tick);
      if (!hasBid) ixs.push(V.placeIx({ owner: mm.publicKey, mk, side: V.BUY, price: bid, qty: qtyFor(NIGHT.usd, bid, lot, m.baseDecimals), src: quoteAcc, tif: V.TIF_GTC }));
      if (!hasAsk) ixs.push(V.placeIx({ owner: mm.publicKey, mk, side: V.SELL, price: ask, qty: qtyFor(NIGHT.usd, ask, lot, m.baseDecimals), src: baseAcc, tif: V.TIF_GTC }));
    }
    // claim fills and refunds in the most recent cleared windows
    const ids = [];
    for (let i = 1n; i <= 3n && mk.auctionId - i >= 0n; i++) ids.push(mk.auctionId - i);
    const keys = ids.map((id) => V.bookPda(m.marketKey, id));
    const infos = await conn.getMultipleAccountsInfo(keys);
    for (let i = 0; i < keys.length; i++) {
      if (!infos[i]) continue;
      const b = await V.readBook({ getAccountInfo: async () => infos[i] }, keys[i]);
      if (!b?.cleared) continue;
      for (const o of b.orders) {
        if (o.owner.equals(mm.publicKey) && o.status === 'live' && (o.filled > 0n || o.escrow > 0n)) {
          ixs.push(V.claimIx({ owner: mm.publicKey, mk, book: keys[i], index: o.index, baseDest: baseAcc, quoteDest: quoteAcc }));
        }
      }
    }
    if (ixs.length) report.did.push(`night ${ixs.length} ix`);
  }
  if (ixs.length) report.tx = await sendBatches(conn, mm, ixs, 3);
  return report;
}
