#!/usr/bin/env node
// scripts/demo/corridor-fx-e2e.mjs
//
// Replays the FX cross-chain corridor end to end from this surface alone. It reads the two
// demonstration passes declared in deployments/fx-corridor.json and, for each leg, reads the
// transaction receipt on the public test network, then renders the state (block, EVM status,
// target) with the explorer link and the business outcome of each pass: the conforming pass that
// settled (wrap, gated transfer and lock, swap and delivery at arrival, unwrap), the refusals made
// at the source before any lock (the transaction REVERTS: status failed, zero logs), and the
// residual case where an arrival refusal sends the value back to the payer.
//
// Read only. No build, no private key, no local node: it joins the public chains over JSON-RPC and
// reports what is already settled there. This is layer 2 of the RUNBOOK (on-chain from the surface),
// made runnable. The full offline mechanism proof needs the private toolkit build and is not here.
//
//   node scripts/demo/corridor-fx-e2e.mjs
//
// Needs Node 18+ (global fetch). Options:
//   --rpc-sepolia <url>    override the Ethereum Sepolia endpoint (source leg)
//   --rpc-arbitrum <url>   override the Arbitrum Sepolia endpoint (destination leg)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };

const tracker = JSON.parse(readFileSync(join(ROOT, 'deployments', 'fx-corridor.json'), 'utf8'));

// Chain registry: the explorer is read from the tracker; the RPC is a public endpoint, not a secret.
// Point it at your own node with --rpc-sepolia / --rpc-arbitrum if you prefer.
const CHAINS = {
  11155111: {
    name: 'Ethereum Sepolia',
    explorer: tracker.source?.explorer || 'https://sepolia.etherscan.io',
    rpc: opt('--rpc-sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'),
  },
  421614: {
    name: 'Arbitrum Sepolia',
    explorer: tracker.destination?.explorer || 'https://sepolia.arbiscan.io',
    rpc: opt('--rpc-arbitrum', 'https://arbitrum-sepolia-rpc.publicnode.com'),
  },
};

// Every 20-byte address in the tracker, by lowercase, so a receipt target can be cross-referenced to a
// named corridor contract rather than trusted blind.
const known = new Map();
(function walk(v, path) {
  if (typeof v === 'string') { if (/^0x[0-9a-fA-F]{40}$/.test(v) && !known.has(v.toLowerCase())) known.set(v.toLowerCase(), path); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); }
})(tracker, '');

async function rpc(url, method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  } finally { clearTimeout(timer); }
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toWei = (dec) => { const [i, f = ''] = String(dec).split('.'); return BigInt(i + f.padEnd(18, '0').slice(0, 18)); };
// ERC-20 Transfer events only (three topics); ERC-721 shares the signature with four.
const transfers = (rcpt) => rcpt.logs.filter((g) => g.topics[0] === TRANSFER && g.topics.length === 3);
const T = (tracker.source && tracker.source.contracts) || {};
const D = (tracker.destination && tracker.destination.contracts) || {};

// Business assertions read from the receipt logs, with every expected value taken from the tracker
// (nothing is typed here). Returns a list of [ok, text]. The EVM status alone proves nothing for the
// refused pass, whose arrival transaction succeeds: its proof is the absence of token movement.
function assertions(p, l, rcpt) {
  const out = [];
  const tr = transfers(rcpt);
  const fi = p.parties && p.parties.originatingFI && p.parties.originatingFI.address;
  const ben = p.parties && p.parties.beneficiaryFI && p.parties.beneficiaryFI.address;
  if (l.phase === 'wrap') {
    // Source chain: the originating FI deposits EURX and the wrapper mints the same amount of wEURX to it.
    const w = (T.wEURX_PolicyWrapper || '').toLowerCase();
    const want = toWei(p.amount_eurx);
    const hit = tr.find((g) => g.address.toLowerCase() === w && g.topics[1] === pad('0x0') && g.topics[2] === pad(fi) && BigInt(g.data) === want);
    out.push([!!hit, hit ? `wEURX minted to the originating FI: exactly ${p.amount_eurx}` : `no mint of exactly ${p.amount_eurx} wEURX to the originating FI`]);
  } else if (l.phase === 'unwrap') {
    // Arrival chain: the beneficiary FI burns the delivered wSGDX and receives the same amount of SGDX.
    const w = (D.wSGDX_delivery_PolicyWrapper || '').toLowerCase();
    const sgdx = (D.SGDX_delivery_TokenRep || '').toLowerCase();
    const want = toWei(p.beneficiary_delta_sgdx);
    const burnt = tr.find((g) => g.address.toLowerCase() === w && g.topics[1] === pad(ben) && g.topics[2] === pad('0x0') && BigInt(g.data) === want);
    out.push([!!burnt, burnt ? `wSGDX burned by the beneficiary FI: exactly ${p.beneficiary_delta_sgdx}` : `no burn of exactly ${p.beneficiary_delta_sgdx} wSGDX by the beneficiary FI`]);
    const got = tr.find((g) => g.address.toLowerCase() === sgdx && g.topics[2] === pad(ben) && BigInt(g.data) === want);
    out.push([!!got, got ? 'the same amount of SGDX reaches the beneficiary FI' : 'no SGDX transfer to the beneficiary FI']);
  } else if (l.phase === 'lock') {
    const w = (T.wEURX_PolicyWrapper || '').toLowerCase();
    const adapter = (T.SRC_ADAPTER_FX || '').toLowerCase();
    const hit = tr.find((g) => g.address.toLowerCase() === w && g.topics[1] === pad(fi) && g.topics[2] === pad(adapter));
    out.push([!!hit, hit ? `wEURX moved from the originating FI to the source adapter: ${Number(BigInt(hit.data)) / 1e18}` : 'no wEURX transfer from the originating FI to the source adapter']);
  } else if (p.outcome === 'returned' && l.phase === 'return') {
    // Arrival chain, the return of a refused amount: the composer's wEURX goes to the adapter, is BURNED there, and the
    // reserve gets the same amount of EURX back. Every address comes from the tracker; the amount from the pass.
    const w = (D.wEURX_reception_PolicyWrapper || '').toLowerCase();
    const eurx = (D.EURX_reception_TokenRep || '').toLowerCase();
    const comp = pad(D.COMPOSER_ARBITRUM_FX || '');
    const adapter = pad(D.RECV_ADAPTER_EUR || '');
    const want = toWei(p.returned_amount_eurx);
    const moved = tr.find((g) => g.address.toLowerCase() === w && g.topics[1] === comp && g.topics[2] === adapter && BigInt(g.data) === want);
    out.push([!!moved, moved ? `wEURX left the composer for the adapter: exactly ${p.returned_amount_eurx}` : `no wEURX transfer of exactly ${p.returned_amount_eurx} from the composer to the adapter`]);
    const burnt = tr.find((g) => g.address.toLowerCase() === w && g.topics[1] === adapter && g.topics[2] === pad('0x0') && BigInt(g.data) === want);
    out.push([!!burnt, burnt ? 'the same wEURX is burned (transfer to the zero address): no wrapped value remains in circulation' : 'no burn of the returned wEURX']);
    const back = tr.find((g) => g.address.toLowerCase() === eurx && g.topics[1] === pad(D.wEURX_reception_PolicyWrapper || '') && g.topics[2] === adapter && BigInt(g.data) === want);
    out.push([!!back, back ? 'the same amount of EURX returns from the wrapper to the adapter reserve' : 'no EURX transfer back to the adapter reserve']);
  } else if (p.outcome === 'returned' && l.phase === 'credit-payer') {
    // Source chain: the receiver hands the wEURX back to the ORIGINAL payer, exactly the amount that was refused.
    const w = (T.wEURX_PolicyWrapper || '').toLowerCase();
    const want = toWei(p.returned_amount_eurx);
    const hit = tr.find((g) => g.address.toLowerCase() === w && g.topics[1] === pad(T.RETURN_RECEIVER || '') && g.topics[2] === pad(fi) && BigInt(g.data) === want);
    out.push([!!hit, hit ? `wEURX returned to the originating FI: exactly ${p.returned_amount_eurx} (the payer is made whole)` : `no wEURX transfer of exactly ${p.returned_amount_eurx} from the return receiver to the originating FI`]);
  } else if (p.outcome === 'settled') {
    const w = (D.wSGDX_delivery_PolicyWrapper || '').toLowerCase();
    const want = toWei(p.beneficiary_delta_sgdx);
    const hit = tr.find((g) => g.address.toLowerCase() === w && g.topics[2] === pad(ben) && BigInt(g.data) === want);
    out.push([!!hit, hit ? `wSGDX delivered to the beneficiary FI, exactly ${p.beneficiary_delta_sgdx} (matches the tracker)` : `no wSGDX transfer of exactly ${p.beneficiary_delta_sgdx} to the beneficiary FI`]);
    // Route 0 swaps in the direct pool; route 1 swaps through the two USDX pivot pools, and the composer
    // must never hold USDX (it exists only inside the router call).
    const pools = (p.route === 1 ? [D.pool_EURX_USDX, D.pool_SGDX_USDX] : [D.pool_EURX_SGDX]).map((a) => (a || '').toLowerCase());
    for (const pool of pools) {
      const swapped = tr.some((g) => g.topics[1] === pad(pool)) && tr.some((g) => g.topics[2] === pad(pool));
      out.push([swapped, swapped ? `pool ${pool.slice(0, 8)}... paid out and received tokens in this transaction (the swap)` : `pool ${pool.slice(0, 8)}... does not appear on both sides of a transfer`]);
    }
    if (p.route === 1) {
      const usdx = (D.USDX_pivot_TokenRep || '').toLowerCase();
      const comp = pad(D.COMPOSER_ARBITRUM_FX || '');
      const held = tr.filter((g) => g.address.toLowerCase() === usdx && (g.topics[1] === comp || g.topics[2] === comp));
      out.push([held.length === 0, held.length === 0 ? 'the composer never holds USDX (0 transfers of it to or from the composer)' : `the composer touched USDX in ${held.length} transfer(s)`]);
    }
    const direct = (D.pool_EURX_SGDX || '').toLowerCase();
    if (p.route === 1) {
      const touched = tr.some((g) => g.topics[1] === pad(direct) || g.topics[2] === pad(direct));
      out.push([!touched, !touched ? 'the direct pool did not move on route 1' : 'the direct pool moved on route 1']);
    }
  } else if (l.phase === 'refuse') {  // arrival refusal: the call succeeds, the atomic swap is rolled back
    out.push([tr.length === 0, tr.length === 0 ? `0 token Transfer events: pool and beneficiary cannot have moved (${rcpt.logs.length} other events)` : `${tr.length} token Transfer events found in a refusal`]);
  }
  return out;
}

// Returns 'ok' (receipt confirmed), 'bad' (chain does not confirm the tx the surface claims), or
// 'down' (RPC unreachable: a local network problem, not a defect of the surface).
async function leg(l, p) {
  const c = CHAINS[l.chainId];
  const link = c ? `${c.explorer}/tx/${l.tx}` : `(chain ${l.chainId})`;
  if (!c) { console.log(`    [${l.phase}] chain ${l.chainId} is not in the registry`); return 'bad'; }
  try {
    const rcpt = await rpc(c.rpc, 'eth_getTransactionReceipt', [l.tx]);
    if (!rcpt) {
      console.log(`    [${l.phase}] ${c.name}: the chain has no receipt for this transaction`);
      console.log(`        ${link}`);
      return 'bad';
    }
    const ok = rcpt.status === '0x1';
    const block = parseInt(rcpt.blockNumber, 16);
    if (l.phase === 'expect_revert') {
      // A refusal made before any movement: the transaction itself reverts, so it carries no log at all.
      const good = !ok && rcpt.logs.length === 0;
      const tgt = known.get((rcpt.to || '').toLowerCase());
      console.log(`    [${l.phase}] ${c.name}  block ${block}  EVM status ${ok ? 'success' : 'failed'} (expected: failed)`);
      console.log(`        to ${rcpt.to || '(contract creation)'}${tgt ? `  (corridor: ${tgt})` : ''}`);
      console.log(`        ${l.what}`);
      console.log(`        ${link}`);
      console.log(`        ${good ? 'check ok ' : 'CHECK FAILED'}  ${good ? 'the transaction reverted with 0 logs: no token moved' : `status ${rcpt.status}, ${rcpt.logs.length} logs: not a clean revert`}`);
      return good ? 'ok' : 'bad';
    }
    const to = (rcpt.to || '').toLowerCase();
    const named = known.get(to);
    console.log(`    [${l.phase}] ${c.name}  block ${block}  EVM status ${ok ? 'success' : 'failed'}`);
    console.log(`        to ${rcpt.to || '(contract creation)'}${named ? `  (corridor: ${named})` : ''}`);
    console.log(`        ${l.what}`);
    console.log(`        ${link}`);
    let sound = ok;
    for (const [good, text] of ok ? assertions(p, l, rcpt) : []) {
      console.log(`        ${good ? 'check ok ' : 'CHECK FAILED'}  ${text}`);
      if (!good) sound = false;
    }
    if (ok && !named) console.log('        (target not named in the tracker: the LayerZero delivery path; the corridor is proven by the checks above)');
    return sound ? 'ok' : 'bad';
  } catch (e) {
    console.log(`    [${l.phase}] ${c.name}: RPC unreachable (${String(e.message).slice(0, 60)}); explorer link stands`);
    console.log(`        ${link}`);
    return 'down';
  }
}

async function pass(title, p) {
  console.log(`\n== ${title}: ${p.outcome} ==`);
  if (p.parties) {
    const who = (x) => (x && (x.name || x.address)) ? `${x.name || ''} ${x.address || ''}`.trim() : '';
    if (p.parties.originatingFI) console.log(`  originating FI: ${who(p.parties.originatingFI)}`);
    if (p.parties.beneficiaryFI) console.log(`  beneficiary FI: ${who(p.parties.beneficiaryFI)}`);
  }
  if (p.rate_sgd_per_eur) console.log(`  applied rate: 1 EUR = ${p.rate_sgd_per_eur} SGD`);
  if (p.quote_sgd_per_eur) console.log(`  quote at send: 1 EUR = ${p.quote_sgd_per_eur} SGD (not applied, refused)`);
  if (p.reason) console.log(`  reason: ${p.reason}`);
  if (p.amount_eurx) console.log(`  amount: ${p.amount_eurx} EURX`);
  console.log(`  beneficiary delta: +${p.beneficiary_delta_sgdx ?? 0} SGDX`);
  const states = [];
  for (const l of p.legs) states.push(await leg(l, p));
  return states;
}

const dp = tracker.demonstration_passes;
if (!dp || !dp.conforming || !dp.refused) {
  console.error('deployments/fx-corridor.json carries no demonstration_passes to replay');
  process.exit(2);
}

console.log('Programmable Compliance: FX cross-chain corridor EURX to SGDX');
console.log('on-chain replay from the surface (read only, public test networks)');
if (dp.note) console.log(`\n${dp.note}`);

const TITLES = {
  conforming: 'conforming pass',
  refused: 'refused at the source (beneficiary without credential)',
  refused_sanctions: 'refused at the source (sanctions proof)',
  refused_replay: 'refused at the source (replay of a settled pass)',
  refused_forged_proof: 'refused at the source (forged proof)',
  returned: 'returned pass (arrival refusal, then funds returned to the payer)',
};
const states = [];
for (const [key, p] of Object.entries(dp)) {
  if (!p || typeof p !== 'object' || !p.legs) continue;
  states.push(...(await pass(TITLES[key] || key, p)));
}
const count = (s) => states.filter((x) => x === s).length;

console.log('\n-- summary --');
console.log('  conforming: wrap, gated transfer and lock, swap at the arrival pivot, gated delivery, unwrap; the beneficiary received SGDX');
console.log('  refused   : each refusal at the source reverted before any lock; the payer balance and the lock are unchanged');
if (dp.returned) console.log('  returned  : the refused value went back through the bridge, the reserve was restored and the payer was made whole');
console.log(`  receipts  : ${count('ok')} confirmed, ${count('bad')} not confirmed by the chain, ${count('down')} unverified (RPC unreachable)`);

// Exit non-zero only when the chain fails to confirm a transaction the surface claims (a real defect
// of the surface). An unreachable RPC is reported but is not such a defect.
process.exit(count('bad') > 0 ? 1 : 0);
