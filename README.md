# velque-keeper

The off-chain service that keeps a [Velque](https://usevelque.xyz) market in step with Nasdaq. It runs as three serverless functions.

| Endpoint | What it does |
| --- | --- |
| `GET /api/crank` | Posts the reference price while Nasdaq is open, clears auction windows, runs the opening cross, moves the Day book into the night auction after the close, closes empty window books |
| `POST /api/faucet` | Test market only: hands a new wallet test stock tokens and test USDC, once |
| market maker (inside the crank) | Test market only: keeps two-sided quotes so the book is never empty |

Everything the crank does on chain can be done by anyone. `clear`, `close_day` and `close_book` are permissionless instructions. The only privileged action is posting the reference price, which needs the market's oracle key.

## What one crank call does

For every market, in order:

**Nasdaq open**

1. If the reference is older than a minute, fetch the last trade from two sources, multiply by the token's dividend multiplier and post it. A fresh reference is what makes the market Day.
2. If orders are waiting in the auction window, clear it right away. This is the opening cross: one price for everything that built up overnight, and the unfilled part of until-cancelled orders moves into the Day book.

**Nasdaq closed**

1. Post nothing. After `max_age` the reference goes stale and the market is Dark on its own.
2. Clear any window whose timer has ended.
3. If resting Day orders are left, move them into the current window as until-cancelled orders.

**Always**

- Close settled window books that had no trades, so their rent returns to whoever paid it. This runs on every call, so a close that failed once is retried a minute later.

Calls are idempotent. Two cranks racing each other is expected and handled.

## Reference price

`velque-sdk/reference` does the work:

- last trade from api.nasdaq.com and from Yahoo Finance, each less than three minutes old;
- the two have to agree within 0.5%, and the average is used;
- if only one answers, it is used only when the token price on Jupiter is within 3% of it;
- otherwise nothing is posted.

The share price is multiplied by the Token-2022 `ScaledUiAmount` multiplier read from the mint, because xStocks pay dividends by raising that multiplier instead of changing balances.

## The test-market maker

On the test market a market maker quotes both sides so there is always something to trade against. It is deliberately simple:

- **Day:** two levels per side at 0.2% and 0.6% from the reference. A quote is cancelled and replaced when the reference moves more than 0.1% away from it.
- **Dark:** one until-cancelled bid and one ask at 1% from the last reference. They carry from window to window by themselves and reach the Day book through the opening cross.
- It never trades with itself (the program skips an owner's own orders) and it does not generate volume. A trade happens only when someone else hits a quote.

Its orders are labelled in the app.

## Running it

```bash
npm install
npm run build        # bundles src/ into api/ with esbuild
vercel deploy --prod
```

Environment:

| Variable | Purpose |
| --- | --- |
| `VELQUE_KEY` | Oracle key (JSON array). Posts the reference, pays rent for new window books, runs the faucet |
| `VELQUE_MM_KEY` | Market maker key (test market only) |
| `VELQUE_RPC` | RPC endpoint. A keyed endpoint is strongly recommended: public ones rate-limit |
| `CRON_SECRET` | Only calls carrying `?key=<secret>` move the market maker |

Schedule `GET /api/crank?key=<CRON_SECRET>` once a minute. Called with the secret, the function answers `202` immediately and finishes the work in the background, so a scheduler with a short timeout does not see failures.

Markets are listed in [`config.mjs`](config.mjs).

