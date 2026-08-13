// Bundle each function into a single file under api/. web3.js pulls in
// CommonJS and ESM dependencies that a serverless runtime cannot resolve
// reliably, so the functions ship fully bundled and need no node_modules.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('api', { recursive: true });
for (const name of ['crank', 'faucet']) {
  await build({
    entryPoints: [`src/${name}.mjs`],
    outfile: `api/${name}.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  });
}
console.log('api built');
