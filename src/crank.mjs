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

