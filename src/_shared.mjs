// Shared by the serverless functions: connection, keys from the environment, markets.
// VELQUE_KEY     oracle key: reference price, keeper, faucet (mints the test tokens)
// VELQUE_MM_KEY  market maker key for the test market
// CRON_SECRET    secret in the cron URL: only that call moves the market maker
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import cfg from '../config.mjs';

export { cfg };
export const conn = new Connection(process.env.VELQUE_RPC || cfg.rpc, 'confirmed');
export const quoteMint = new PublicKey(cfg.quoteMint);
export const quoteProg = new PublicKey(cfg.quoteProg);

/** Markets from the config; the old flat config yields a single market. */
export const markets = (cfg.markets || [{
  symbol: cfg.referenceSource.symbol, baseSymbol: cfg.baseSymbol, market: cfg.market, baseMint: cfg.baseMint, baseProg: cfg.baseProg,
  baseDecimals: cfg.baseDecimals, checkMint: cfg.referenceSource.checkMint,
}]).map((m) => ({
  ...m, marketKey: new PublicKey(m.market), baseMintKey: new PublicKey(m.baseMint), baseProgKey: new PublicKey(m.baseProg),
}));

// backward compatibility: the first market
export const market = markets[0].marketKey;
export const baseMint = markets[0].baseMintKey;

export function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
