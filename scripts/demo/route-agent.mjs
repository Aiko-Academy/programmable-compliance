#!/usr/bin/env node
// scripts/demo/route-agent.mjs
//
// The read-only route agent of the FX cross-chain corridor. It quotes the two exchange routes the arrival
// composer knows, on the public test network, and says which one it would pick:
//
//   route 0  direct  EURX to SGDX                  (one pool)
//   route 1  pivot   EURX to USDX to SGDX          (two pools)
//
// Rule (deterministic, readable): the route with the HIGHER SGDX output wins; on a tie the direct route
// wins (fewer hops, less gas); a route whose quote reverts (no liquidity) is set aside, and the decision
// says so. The contract bounds the agent: it only accepts a route identifier (no free path), and the
// floor `minOut` applies to the FINAL SGDX, so a wrong choice can only make the whole call fail, never
// deliver less than the floor. A judgement layer (a model) can sit on top of this output, for instance to
// set aside a thin pool; it replaces neither the rule nor the contract.
//
// Before quoting, it reads on the chain the three tokens of the paths and every pool, and refuses to continue
// if one of them is a wrapper (answers `underlying()`): the pools must hold base tokens, never wrappers.
//
// Read only. No build, no private key, no dependency: Node 18+ and JSON-RPC over fetch.
//
//   node scripts/demo/route-agent.mjs [--amount 50] [--tol-bps 30] [--rpc-arbitrum <url>] [--block <n>]
//
// `--block <n>` quotes at that block instead of the latest one (two readers of the same block must agree to the wei).
//
// The last line is GL1_FX_ROUTE=<json>: route, convertAmount and minOut of the chosen route, the values
// the sender puts in the compose payload and the destination attestation.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const RPC = opt('--rpc-arbitrum', 'https://arbitrum-sepolia-rpc.publicnode.com');
const TOL_BPS = BigInt(opt('--tol-bps', '30'));
const BLOCK = opt('--block', null);
const TAG = BLOCK === null ? 'latest' : '0x' + BigInt(BLOCK).toString(16);
const FEE = 100n; // all three pools sit at the 0.01% tier (deployments/fx-corridor.json, calibration)

const tr = JSON.parse(readFileSync(join(ROOT, 'deployments', 'fx-corridor.json'), 'utf8'));
const c = tr.destination.contracts;
const quoter = tr.destination.uniswapV3Canonical.QuoterV2;
const [EURX, SGDX, USDX] = [c.EURX_reception_TokenRep, c.SGDX_delivery_TokenRep, c.USDX_pivot_TokenRep];
const POOLS = [c.pool_EURX_SGDX, c.pool_EURX_USDX, c.pool_SGDX_USDX];

// 4-byte selectors, fixed by the signatures.
const SEL = {
  quoteSingle: '0xc6a5026a', // quoteExactInputSingle((address,address,uint256,uint24,uint160))
  quotePath: '0xcdca1753', // quoteExactInput(bytes,uint256)
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  symbol: '0x95d89b41',
  underlying: '0x6f307dc3',
};

let id = 0;
async function ethCall(to, data) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [{ to, data }, TAG] }),
    });
    const j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    // a throttled endpoint is asked again; it is neither a revert nor an answer
    if (res.status === 429 || /rate limit|too many requests|capacity/i.test(j.error?.message || '')) {
      if (attempt >= 6) throw new Error(`endpoint throttled: ${j.error?.message || 'HTTP 429'}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    // only an execution revert means "no quote"; a node that cannot serve the block is a fault, not a revert
    if (j.error) {
      const e = new Error(j.error.message);
      e.revert = j.error.code === 3 || /revert/i.test(j.error.message || '');
      throw e;
    }
    return j.result;
  }
}
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const addr = (a) => word(a);
const wordAt = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const lastAddr = (hex) => '0x' + hex.slice(2 + 24, 2 + 64);
const f18 = (x) => { const s = x.toString().padStart(19, '0'); const i = s.slice(0, -18); const d = s.slice(-18).replace(/0+$/, ''); return d ? `${i}.${d}` : i; };
const text = (hex) => { const len = Number(wordAt(hex, 1)); return Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), 'hex').toString('utf8'); };

async function isWrapper(token) {
  try { const r = await ethCall(token, SEL.underlying); return r.length >= 66; }
  catch (e) { if (e.revert) return false; throw e; } // only a revert means "not a wrapper"; a network fault stops the agent
}

async function guard() {
  // the three tokens of the quoted paths, as the traceur names them
  for (const [name, t] of [['EURX', EURX], ['SGDX', SGDX], ['USDX', USDX]]) {
    if (await isWrapper(t)) throw new Error(`REFUSED: ${name} (${t}) is a wrapper. The paths must run on base tokens, never wrappers.`);
  }
  for (const pool of POOLS) {
    const [t0, t1] = [lastAddr(await ethCall(pool, SEL.token0)), lastAddr(await ethCall(pool, SEL.token1))];
    for (const [role, t] of [['token0', t0], ['token1', t1]]) {
      if (await isWrapper(t)) {
        const sym = text(await ethCall(t, SEL.symbol));
        throw new Error(`REFUSED: ${role} of pool ${pool} is ${sym} (${t}), a wrapper. Pools must hold base tokens, never wrappers.`);
      }
    }
  }
}

async function quote(route, call) {
  try { const out = await call(); return { route, out: wordAt(out, 0), gas: Number(wordAt(out, 3)) }; }
  catch (e) { if (!e.revert) throw e; return { route, out: null, error: e.message.slice(0, 100) }; }
}

async function main() {
  const amount = BigInt(Math.round(Number(opt('--amount', '50')) * 1e6)) * 10n ** 12n;
  await guard();
  const single = SEL.quoteSingle + addr(EURX) + addr(SGDX) + word(amount) + word(FEE) + word(0);
  const pathHex = [EURX, USDX, SGDX].map((a) => a.slice(2).toLowerCase())
    .reduce((acc, a, i) => acc + a + (i < 2 ? FEE.toString(16).padStart(6, '0') : ''), '');
  const padded = pathHex.padEnd(Math.ceil(pathHex.length / 64) * 64, '0');
  const multi = SEL.quotePath + word(0x40) + word(amount) + word(pathHex.length / 2) + padded;
  const quotes = [
    await quote(0, () => ethCall(quoter, single)),
    await quote(1, () => ethCall(quoter, multi)),
  ];
  const ok = quotes.filter((q) => q.out !== null);
  if (!ok.length) throw new Error('no route quotes');
  const best = ok.reduce((a, b) => (b.out > a.out ? b : a)); // tie: the first, the direct route
  const other = quotes.find((q) => q.route !== best.route);
  const minOut = best.out - (best.out * TOL_BPS) / 10000n;
  const reason = other.out === null
    ? `only route ${best.route} quotes (route ${other.route}: ${other.error})`
    : `route ${best.route} returns ${f18(best.out)} SGDX against ${f18(other.out)} for route ${other.route}`;

  console.log(`[${new Date().toISOString().slice(11, 19)}Z] quote for ${f18(amount)} EURX on ${RPC.replace('https://', '')}`);
  for (const q of quotes) console.log(`  route ${q.route} ${q.route === 0 ? 'direct EURX/SGDX      ' : 'pivot EURX/USDX/SGDX '}: ${q.out === null ? 'SET ASIDE (' + q.error + ')' : f18(q.out) + ' SGDX (estimated gas ' + q.gas + ')'}`);
  console.log(`  choice: route ${best.route}. ${reason}. floor ${f18(minOut)} SGDX (-${TOL_BPS} bps).`);
  console.log('GL1_FX_ROUTE=' + JSON.stringify({
    amountIn: amount.toString(), route: best.route, convertAmount: best.out.toString(), minOut: minOut.toString(), reason,
    quotes: quotes.map((q) => ({ route: q.route, out: q.out === null ? null : q.out.toString(), gas: q.gas ?? null })),
  }));
}
main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
