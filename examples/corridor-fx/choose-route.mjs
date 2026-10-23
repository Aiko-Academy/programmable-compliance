#!/usr/bin/env node
// The FX corridor's routing agent: quotes BOTH change routes on Arbitrum Sepolia and picks the best one.
//   route 0: direct EURX/SGDX (quoteExactInputSingle, the direct pool's tier)
//   route 1: USD pivot, EURX -> USDX -> SGDX (quoteExactInput on the two-hop path)
//
// RULE (deterministic, re-readable): the route whose OUTPUT IN SGDX is highest; on a tie, direct
// (fewer hops, less gas); a route whose quote reverts (no liquidity) is DROPPED, and the
// choice SAYS SO. The contract bounds the rest: it knows only these two paths (the agent supplies only an
// identifier), and the `minOut` floor applies to the final SGDX. A bad choice can therefore only make
// the call fail (atomic refusal), never deliver less than the floor.
//
// A layer of judgment (a model) can sit ON TOP of this output, for instance to drop a route
// with thin liquidity; it neither replaces the rule nor bypasses the contract.
//
// Output: the machine block PC_FX_ROUTE={...} (last line), consumed by SendCrossChainFX
// (ROUTE, CONVERT_AMOUNT, MIN_OUT). Read-only: no transaction.
//   --amount 50   EURX amount (default 50)      --tol-bps 30   floor tolerance (default 30 bps)
//   --block N      quotes at this block (default: the last one): used by the non-derivation test against the public route-agent.mjs
//   --force-route 0|1  forces the route (demonstration pass of a route the market would not pick);
//                      the decision is then marked `forcee` and the best route stays listed.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract, formatUnits, parseUnits, solidityPacked } from 'ethers';
import { garantirPoolEnJetonsDeBase } from './pool-base-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tr = JSON.parse(readFileSync(join(here, '..', '..', 'test-layerzero', 'deployments-leg', 'fx-corridor.json'), 'utf8'));
const dst = tr.destination, c = dst.contracts;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const AMOUNT = parseUnits(arg('amount', '50'), 18);
const TOL_BPS = BigInt(arg('tol-bps', '30'));
const FORCE = arg('force-route', null);
const BLOCK = arg('block', null);
const OV = BLOCK === null ? {} : { blockTag: Number(BLOCK) };   // read override: same block as the other agent
const FEE_DIRECT = 100, FEE_EUR_USD = 100, FEE_USD_SGD = 100;

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256 gasEstimate)',
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[],uint32[],uint256 gasEstimate)',
];
const provider = new JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL, undefined, { cacheTimeout: -1 });
const quoter = new Contract(dst.uniswapV3Canonical.QuoterV2, QUOTER_ABI, provider);
const wraps = [c.wEURX_reception_PolicyWrapper, c.wSGDX_delivery_PolicyWrapper];
const f = (x) => formatUnits(x, 18);

async function cote(nom, appel) {
  try { const r = await appel(); return { route: nom, out: r[0], gas: Number(r[3]) }; }
  catch (e) { return { route: nom, out: null, erreur: String(e.shortMessage || e.message).slice(0, 120) }; }
}

async function main() {
  const at = new Date().toISOString();
  // guard: each pool consulted is in base tokens (the owner's rule, read on the chain).
  for (const p of [c.pool_EURX_SGDX, c.pool_EURX_USDX_fee100, c.pool_SGDX_USDX_fee100].filter(Boolean)) {
    await garantirPoolEnJetonsDeBase({ provider, pool: p, wrapsConnus: wraps });
  }
  const eurx = c.EURX_reception_TokenRep, sgdx = c.SGDX_delivery_TokenRep, usdx = c.USDX_pivot_TokenRep;
  const path = solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'], [eurx, FEE_EUR_USD, usdx, FEE_USD_SGD, sgdx]);
  const quotes = [
    await cote(0, () => quoter.quoteExactInputSingle.staticCall({ tokenIn: eurx, tokenOut: sgdx, amountIn: AMOUNT, fee: FEE_DIRECT, sqrtPriceLimitX96: 0n }, OV)),
    usdx ? await cote(1, () => quoter.quoteExactInput.staticCall(path, AMOUNT, OV)) : { route: 1, out: null, erreur: 'USDX absent from the tracer' },
  ];
  const ok = quotes.filter((q) => q.out !== null);
  if (ok.length === 0) throw new Error('no route quotes: ' + JSON.stringify(quotes.map((q) => q.erreur)));
  // best output; on a tie, direct (lowest index).
  const meilleure = ok.reduce((a, b) => (b.out > a.out ? b : a));
  const best = FORCE === null ? meilleure : ok.find((q) => q.route === Number(FORCE));
  if (!best) throw new Error(`route ${FORCE} forced but it does not quote`);
  const other = ok.find((q) => q.route !== best.route);
  const minOut = best.out - (best.out * TOL_BPS) / 10000n;
  const raisonBase = other
    ? `route ${best.route} returns ${f(best.out)} SGDX against ${f(other.out)} for route ${other.route} (gap ${(Number(best.out - other.out) / Number(other.out) * 1e4).toFixed(2)} bps)`
    : `only route ${best.route} quotes (${quotes.find((q) => q.route !== best.route)?.erreur})`;
  const raison = FORCE === null ? raisonBase : `FORCED (route ${FORCE}) ; the rule would have taken route ${meilleure.route} : ${raisonBase}`;

  console.log(`[${at.slice(11, 19)}Z] quoting ${f(AMOUNT)} EURX`);
  for (const q of quotes) console.log(`  route ${q.route} ${q.route === 0 ? 'direct EURX/SGDX      ' : 'pivot EURX/USDX/SGDX '}: ${q.out === null ? 'DROPPED (' + q.erreur + ')' : f(q.out) + ' SGDX  (estimated gas ' + q.gas + ')'}`);
  console.log(`  choice : route ${best.route}. ${raison}. floor ${f(minOut)} SGDX (-${TOL_BPS} bps).`);
  console.log('PC_FX_ROUTE=' + JSON.stringify({
    at, amountIn: AMOUNT.toString(), route: best.route, forcee: FORCE !== null, convertAmount: best.out.toString(), minOut: minOut.toString(), tolBps: Number(TOL_BPS), raison,
    quotes: quotes.map((q) => ({ route: q.route, out: q.out === null ? null : q.out.toString(), gas: q.gas ?? null, erreur: q.erreur ?? null })),
  }));
}
main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
