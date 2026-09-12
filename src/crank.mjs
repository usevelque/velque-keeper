// GET /api/crank: keeps every market in step with Nasdaq. Repeated calls are safe.
// The app calls it on load and when the window timer reaches zero; cron calls
// it once a minute with a secret (?key=CRON_SECRET), and only that call moves
// the market maker of the test market.
//
// Nasdaq open: reference = the stock's last Nasdaq trade (api.nasdaq.com and
// Yahoo, which must agree) times the token's ScaledUiAmount multiplier, signed
// by the market's oracle key. A fresh reference means Day on chain. If overnight
// orders are waiting in the window, it is cleared right away: this is the
// opening cross, and GTC remainders rest in the day book.
// Nasdaq closed: the reference is no longer updated and goes stale after maxAge.
// In Dark, expired windows are cleared and live day orders move into the auction.
import { Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { conn, signer, mmSigner, markets, quoteMint, quoteProg, chainNow, json } from './_shared.mjs';
import * as V from 'velque-sdk/client';
import { nasdaqReference } from 'velque-sdk/reference';
import { makeMarket } from './mm.mjs';

async function reference(m, mk, now) {
  const mint = await conn.getAccountInfo(m.baseMintKey);
  const multiplier = V.scaledMultiplier(mint?.data, now);
  return nasdaqReference({ symbol: m.symbol, tick: mk.tick, multiplier, jupiterMint: m.checkMint, nowSec: now });
}

// Books with no trades, holding only carried-over or cancelled orders, add
// nothing to the log: close them, and the rent goes back to whoever paid it.
// Books with trades stay on chain as the auction log.
async function closeIdleBooks(me, m, uptoId) {
  const ids = [];
  for (let i = 0n; i <= 14n && uptoId - i >= 0n; i++) ids.push(uptoId - i);
  const keys = ids.map((id) => V.bookPda(m.marketKey, id));
  const infos = await conn.getMultipleAccountsInfo(keys);
  const ixs = [];
  for (let i = 0; i < keys.length; i++) {
    if (!infos[i]) continue;
    const b = await V.readBook({ getAccountInfo: async () => infos[i] }, keys[i]);
    if (b && b.volume === 0n && V.isSettled(b)) ixs.push(V.closeBookIx({ book: keys[i], payer: b.payer }));
  }
  if (!ixs.length) return 0;
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(...ixs.slice(0, 8)), [me], { commitment: 'confirmed' });
    return Math.min(ixs.length, 8);
  } catch {
    return 0;
  }
}

const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })];
const send = (me, ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...budget(), ...ixs), [me], { commitment: 'confirmed' });
// race with another call: the window is already cleared or open, or there is nothing to move
const RACE = ['custom program error: 0x5', 'custom program error: 0x8', 'custom program error: 0xf', 'custom program error: 0x4'];
const isRace = (e) => RACE.some((c) => String(e.message || e).includes(c));

async function runMarket(m, me, now, open) {
  let mk = await V.readMarket(conn, m.marketKey);
  const done = [];
  let cleared = null;
  let oracle;
  const book = await V.readBook(conn, V.bookPda(m.marketKey, mk.auctionId));
  const hasOrders = !!book && book.orders.some((o) => o.status === 'live');

  if (open) {
    const ixs = [];
    const stale = now - mk.refAt > 60;
    const ref = stale ? await reference(m, mk, now) : null;
    if (ref?.price && me.publicKey.equals(mk.authority)) {
      ixs.push(V.setReferenceIx({ authority: me.publicKey, market: m.marketKey, price: ref.price }));
      done.push('reference');
      oracle = { share: ref.share, multiplier: ref.multiplier, sources: ref.sources };
    } else if (ref) oracle = { skipped: ref.reason };
    const dayAfter = ixs.length > 0 || V.session(mk, now) === 'day';
    // in Day a window with orders is cleared right away (the cross); there is no point waiting on an empty one
    if (hasOrders && (dayAfter || now >= mk.windowEnd)) { ixs.push(V.clearIx({ cranker: me.publicKey, mk })); done.push(dayAfter ? 'cross' : 'clear'); cleared = mk.auctionId; }
    if (ixs.length) {
      try { await send(me, ixs); } catch (e) { if (!isRace(e)) throw e; done.push('race'); }
    }
  } else {
    if (now >= mk.windowEnd) {
      try { await send(me, [V.clearIx({ cranker: me.publicKey, mk })]); done.push('clear'); cleared = mk.auctionId; } catch (e) { if (!isRace(e)) throw e; done.push('race'); }
      mk = await V.readMarket(conn, m.marketKey);
    }
    if (V.session(mk, now) === 'dark') {
      const day = await V.readDay(conn, m.marketKey);
      if (day.bids.length + day.asks.length > 0) {
        try { await send(me, [V.closeDayIx({ cranker: me.publicKey, mk })]); done.push('close_day'); } catch (e) { if (!isRace(e)) throw e; }
      }
    }
  }

  const out = { symbol: m.symbol, done, oracle };
  if (cleared !== null) {
    const b = await V.readBook(conn, V.bookPda(m.marketKey, cleared));
    Object.assign(out, { auctionId: Number(cleared), clearPrice: b ? Number(b.clearPrice) / 1e6 : null, volume: b ? Number(b.volume) / 10 ** m.baseDecimals : 0 });
  }
  out.mk = await V.readMarket(conn, m.marketKey);
  // idle books are swept on every call: if a close failed once (RPC limit),
  // the rent must not stay locked
  if (out.mk.auctionId > 0n) out.closed = await closeIdleBooks(me, m, out.mk.auctionId - 1n);
  return out;
}

