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
import { waitUntil } from '@vercel/functions';

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

const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })];
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

export default async function handler(req, res) {
  try {
    const me = signer();
    const url = new URL(req.url, 'http://local');
    const onlyM = url.searchParams.get('m');
    const cron = !!process.env.CRON_SECRET && url.searchParams.get('key') === process.env.CRON_SECRET;
    const mm = cron ? mmSigner() : null;
    const now = await chainNow();
    const open = V.nasdaqOpen(now);
    // the oracle pays book rent and fees: without SOL the market stalls, and that must show in the logs
    const sol = await conn.getBalance(me.publicKey).catch(() => null);
    if (sol !== null && sol < 60_000_000) console.error(`ORACLE LOW ON SOL: ${sol / 1e9} (${me.publicKey.toBase58()})`);
    // the market order rotates every minute: the last one in the queue hits the
    // public RPC limit more often, and it should not always be the same market
    const shift = Math.floor(now / 60) % markets.length;
    const rotated = markets.slice(shift).concat(markets.slice(0, shift));
    const list = onlyM ? markets.filter((m) => m.symbol === onlyM) : rotated;

    // markets run one at a time: the public devnet RPC throttles parallel requests
    const one = async (m) => {
      try {
        const r = await runMarket(m, me, now, open);
        if (mm) {
          try { r.mm = await makeMarket({ conn, m, mk: r.mk, mm, oracle: me, quoteMint, quoteProg, now: await chainNow() }); } catch (e) { r.mm = { error: String(e.message || e).slice(0, 160) }; }
        }
        r.session = V.session(r.mk, await chainNow());
        delete r.mk;
        return r;
      } catch (e) {
        return { symbol: m.symbol, error: String(e.message || e).slice(0, 200) };
      }
    };
    const work = (async () => { const out = []; for (const m of list) out.push(await one(m)); return out; })();
    // cron waits at most 30 s for a response: reply at once, the work continues in the background
    if (cron) {
      waitUntil(work.then((r) => console.log(JSON.stringify({ cron: true, markets: r }, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))));
      return json(res, 202, { accepted: true, cron: true, markets: list.map((m) => m.symbol) });
    }
    const results = await work;
    // backward compatibility: the first market's fields at the top level
    const first = results.find((r) => r.symbol === markets[0].symbol) || results[0] || {};
    return json(res, 200, { nasdaq: open ? 'open' : 'closed', session: first.session, done: first.done, oracle: first.oracle, cron, oracleSol: sol === null ? null : sol / 1e9, markets: results });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
}
