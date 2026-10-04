# velque-keeper

The off-chain service that keeps a [Velque](https://usevelque.xyz) market in step with Nasdaq. It runs as three serverless functions.

| Endpoint | What it does |
| --- | --- |
| `GET /api/crank` | Posts the reference price while Nasdaq is open, clears auction windows, runs the opening cross, moves the Day book into the night auction after the close, closes empty window books |
| `POST /api/faucet` | Test market only: hands a new wallet test stock tokens and test USDC, once |
| market maker (inside the crank) | Test market only: keeps two-sided quotes so the book is never empty |

Everything the crank does on chain can be done by anyone. `clear`, `close_day` and `close_book` are permissionless instructions. The only privileged action is posting the reference price, which needs the market's oracle key.

