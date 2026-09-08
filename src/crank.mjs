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

