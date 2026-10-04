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

