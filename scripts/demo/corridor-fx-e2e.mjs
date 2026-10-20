#!/usr/bin/env node
// scripts/demo/corridor-fx-e2e.mjs
//
// Verifies end to end, from this surface alone, the FX cross-chain corridor EURX to SGDX: the
// demonstration passes declared in deployments/fx-corridor.json (conforming, four refusals at the
// source, one arrival refusal with return of the funds). Every claim is read from the public test
// networks; every expected value comes from the tracker or from the ABIs of this repository, nothing
// is typed here.
//
// What it checks, per pass:
//   - each receipt, read live (status, target, sender);
//   - the token movements asserted from the logs, with exact amounts;
//   - the LINK between the two chains: the LayerZero guid born at the source lock (OFTSent, and the
//     packet itself) is the guid delivered at the arrival (ComposeDelivered, Delivered), and for the
//     returned pass the same guid is refused, returned, then a second guid carries the funds home;
//   - that the policy chain of the Policy Wrapper ran to completion on each gated transfer
//     (PolicyRunComplete), and that the sanctions non-membership policy is installed on that wrapper
//     (PolicyManager.getPolicies, read at the block before the transaction);
//   - for the conforming pass, that the route taken is the one the rule picks: both routes are quoted
//     with the QuoterV2 at the block BEFORE the swap (route-agent.mjs --block) and the better one is
//     the route used, and the SGDX delivered equals its quote;
//   - for each refusal at the source, that the transaction REVERTED for the reason the tracker names:
//     the call is replayed with eth_call at the block before, and the custom error (selector, policy
//     address, message) is decoded and compared; the gas used is below the gas limit (not an
//     out-of-gas); the balances of the payer and of the lock are read before and after;
//   - for the arrival refusal, the reason carried by the Refused event, the absence of any transfer
//     and of any completed policy run, and the order of the key revocation, the refusal, the
//     restoration and the return.
//
// What it cannot show, and says so: a check made off-chain by an institution node (a signature that
// was never made, a prover that exits with code 3) leaves nothing on a chain. Those statements are
// printed as "declared" and never counted as checks.
//
// Read only. No build, no private key, no local node, no dependency: JSON-RPC over fetch, and a small
// Keccak-256 inside this file to derive event and error selectors from the ABIs of abi/.
//
//   node scripts/demo/corridor-fx-e2e.mjs
//
// Needs Node 18+. Options:
//   --rpc-sepolia <url>    override the Ethereum Sepolia endpoint (source leg)
//   --rpc-arbitrum <url>   override the Arbitrum Sepolia endpoint (destination leg)
//   --skip-history         do not run the checks that need the chain state at an earlier block
//                          (replay of reverts, installed policies, route quotes, balances before);
//                          they are listed as skipped. Use it only on a node that prunes history.
//
// Exit code: 0 all checks confirmed; 1 at least one check failed (the chain does not say what the
// surface claims); 3 nothing failed but some checks could not be made (RPC unreachable, or history not
// served). A green exit therefore means every check was made and passed.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const SKIP_HISTORY = argv.includes('--skip-history');

const tracker = JSON.parse(readFileSync(join(ROOT, 'deployments', 'fx-corridor.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Keccak-256 (the Ethereum hash, not NIST SHA3), BigInt lanes. Self-tested at start.
// ---------------------------------------------------------------------------------------------
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
function keccakF(a) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) a[y + x] ^= d; }
    let cur = a[1];
    for (let i = 0; i < 24; i++) { const j = PILN[i]; const tmp = a[j]; a[j] = rotl(cur, ROTC[i]); cur = tmp; }
    for (let y = 0; y < 25; y += 5) { const t = a.slice(y, y + 5); for (let x = 0; x < 5; x++) a[y + x] = t[x] ^ (~t[(x + 1) % 5] & M64 & t[(x + 2) % 5]); }
    a[0] ^= RC[r];
  }
}
function keccak256(input) {
  const msg = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const rate = 136;
  const padLen = rate - (msg.length % rate);
  const padded = Buffer.concat([msg, Buffer.alloc(padLen)]);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) a[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(a);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(a[i], i * 8);
  return out.toString('hex');
}
if (keccak256('') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  || keccak256('Transfer(address,address,uint256)') !== 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
  console.error('internal error: the Keccak-256 self-test failed; nothing can be derived from the ABIs');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Selectors derived from the ABIs of this surface (the contract is the authority, not a label).
// ---------------------------------------------------------------------------------------------
const ABIS = new Map();
for (const f of readdirSync(join(ROOT, 'abi'))) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(readFileSync(join(ROOT, 'abi', f), 'utf8'));
  ABIS.set(f.replace(/\.json$/, ''), Array.isArray(j) ? j : j.abi || []);
}
const canon = (i) => (i.type.startsWith('tuple') ? `(${i.components.map(canon).join(',')})${i.type.slice(5)}` : i.type);
const sigOf = (e) => `${e.name}(${e.inputs.map(canon).join(',')})`;
function abiItem(contract, kind, name) {
  const it = (ABIS.get(contract) || []).find((x) => x.type === kind && x.name === name);
  if (!it) { console.error(`internal error: abi/${contract}.json has no ${kind} ${name}`); process.exit(2); }
  return it;
}
const topicOf = (sig) => '0x' + keccak256(sig);
const selOf = (sig) => '0x' + keccak256(sig).slice(0, 8);
const evTopic = (contract, name) => topicOf(sigOf(abiItem(contract, 'event', name)));
const errSel = (contract, name) => selOf(sigOf(abiItem(contract, 'error', name)));

const EV = {
  Transfer: topicOf('Transfer(address,address,uint256)'),
  OFTSent: evTopic('ComplianceOFTAdapter', 'OFTSent'),
  AdapterDelivered: evTopic('ComplianceOFTAdapter', 'Delivered'),
  ComposerDelivered: evTopic('ArrivalComposerFX', 'Delivered'),
  Refused: evTopic('ArrivalComposerFX', 'Refused'),
  ReturnedToSource: evTopic('ArrivalComposerFX', 'ReturnedToSource'),
  ReturnedToPayer: evTopic('ReturnReceiver', 'ReturnedToPayer'),
  PolicyRunComplete: evTopic('PolicyManager', 'PolicyRunComplete'),
  // LayerZero Endpoint V2 events (the endpoint is LayerZero's, not part of abi/): fixed by its public interface.
  PacketSent: topicOf('PacketSent(bytes,bytes,address)'),
  ComposeDelivered: topicOf('ComposeDelivered(address,address,bytes32,uint16)'),
};
const SEL = {
  transfer: selOf('transfer(address,uint256)'),
  transferFrom: selOf('transferFrom(address,address,uint256)'),
  balanceOf: selOf('balanceOf(address)'),
  getPolicies: selOf(sigOf(abiItem('PolicyManager', 'function', 'getPolicies'))),
};
const ERR = {
  PolicyRunRejected: errSel('PolicyManager', 'PolicyRunRejected'),
  Error: selOf('Error(string)'),
  // raised by the beneficiary gate of the source adapter; an interface of this surface does not carry it
  ProofNotBound: selOf('ProofNotBound(string)'),
};

// ---------------------------------------------------------------------------------------------
// Chains, tracker reading
// ---------------------------------------------------------------------------------------------
const CHAINS = {
  11155111: {
    name: 'Ethereum Sepolia',
    explorer: tracker.source?.explorer || 'https://sepolia.etherscan.io',
    rpc: opt('--rpc-sepolia', ''), // empty: chosen by probe among RPC_CANDIDATES below
  },
  421614: {
    name: 'Arbitrum Sepolia',
    explorer: tracker.destination?.explorer || 'https://sepolia.arbiscan.io',
    // an endpoint that serves the state of old blocks, which the replay of the route rule and of the installed
    // policies needs (the official and several other public endpoints answer "historical state not available")
    rpc: opt('--rpc-arbitrum', ''),
  },
};
const T = (tracker.source && tracker.source.contracts) || {};
const D = (tracker.destination && tracker.destination.contracts) || {};
const lc = (s) => (s || '').toLowerCase();
const at = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), tracker);

// Default endpoints, tried in order when no --rpc-* flag is given. Public endpoints differ: some prune old receipts
// (a missing receipt reads as a failed check), some refuse log ranges over 10,000 blocks. An endpoint is kept only if
// it answers the right chain id AND serves the receipt of the most recent transaction of the tracker on that chain.
// A flag always wins and is never replaced.
const RPC_CANDIDATES = {
  11155111: ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
  421614: ['https://arbitrum-sepolia.gateway.tenderly.co', 'https://sepolia-rollup.arbitrum.io/rpc'],
};
function lastTxOn(chainId) {
  let tx = null;
  for (const p of Object.values(tracker.demonstration_passes || {})) {
    for (const l of (p && p.legs) || []) if (l.chainId === chainId && /^0x[0-9a-fA-F]{64}$/.test(l.tx || '')) tx = l.tx;
  }
  return tx;
}
async function probeRpc(chainId, url, tx) {
  try {
    const id = parseInt(await rpc(url, 'eth_chainId', []), 16);
    if (id !== chainId) return false;
    return !tx || (await rpc(url, 'eth_getTransactionReceipt', [tx])) != null;
  } catch { return false; }
}
for (const [id, list] of Object.entries(RPC_CANDIDATES)) {
  const c = CHAINS[id];
  if (c.rpc) continue;
  const tx = lastTxOn(Number(id));
  c.rpc = list[0];
  for (const url of list) if (await probeRpc(Number(id), url, tx)) { c.rpc = url; break; }
}

// Every 20-byte address in the tracker, with its paths. A receipt target is cross-referenced to a
// named corridor contract rather than trusted blind; the label prefers the contract sections over
// calibration, history and wiring records that repeat the same address.
const paths = new Map();
(function walk(v, path) {
  if (typeof v === 'string') { if (/^0x[0-9a-fA-F]{40}$/.test(v)) { const k = lc(v); paths.set(k, (paths.get(k) || []).concat(path)); } return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
})(tracker, '');
const RANK = (p) => (/^(source|destination)\.contracts\./.test(p) ? 0 : /^(zk|lzEndpointV2)/.test(p) ? 1 : /^(calibration|history|routes|pairing)/.test(p) ? 3 : 2);
const label = (a) => { const l = (paths.get(lc(a)) || []).slice().sort((x, y) => RANK(x) - RANK(y)); return l[0]; };

const pad = (a) => '0x' + lc(a).replace(/^0x/, '').padStart(64, '0');
const sel4 = (s) => s.padEnd(66, '0');                       // bytes4 as an indexed topic: left aligned
const toWei = (dec) => { const [i, f = ''] = String(dec).split('.'); return BigInt(i + f.padEnd(18, '0').slice(0, 18)); };
const f18 = (x) => { const s = BigInt(x).toString().padStart(19, '0'); const i = s.slice(0, -18); const d = s.slice(-18).replace(/0+$/, ''); return d ? `${i}.${d}` : i; };
const wordAt = (data, i) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const topicAddr = (t) => '0x' + t.slice(26);
const short = (a) => `${a.slice(0, 8)}...`;

// ---------------------------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------------------------
// A public endpoint that throttles answers with a rate-limit error: wait and ask again (up to 6 times) rather than
// report a defect of the surface that is only a busy endpoint.
async function rpcRaw(url, method, params) {
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
      const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
      const throttled = r.status === 429 || /rate limit|too many requests|capacity/i.test(j.error?.message || '');
      if (!throttled || attempt >= 6) return j;
    } finally { clearTimeout(timer); }
    await new Promise((res) => setTimeout(res, 1500 * attempt));
  }
}
async function rpc(url, method, params) {
  const j = await rpcRaw(url, method, params);
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}
// eth_call outcome: { ok, result } | { revert, data, message } | { unavailable, message }. A node that does
// not serve the state of an old block answers with an error that is NOT a revert: it is never read as one.
async function ethCall(chainId, tx, block) {
  let j;
  try { j = await rpcRaw(CHAINS[chainId].rpc, 'eth_call', [tx, block]); } catch (e) { return { unavailable: true, message: String(e.message).slice(0, 80) }; }
  if (!j.error) return { ok: true, result: j.result };
  const data = typeof j.error.data === 'string' && j.error.data.startsWith('0x') ? j.error.data : null;
  if (j.error.code === 3 || data || /revert/i.test(j.error.message || '')) return { revert: true, data, message: j.error.message };
  return { unavailable: true, message: String(j.error.message).slice(0, 80) };
}
const hexBlock = (n) => '0x' + n.toString(16);
const call = (to, sel, ...words) => ({ to, data: sel + words.map((w) => w.replace(/^0x/, '').padStart(64, '0')).join('') });

// Chain identity: the endpoint must be the chain it is configured as (a mistyped --rpc would read another chain).
const chainState = new Map();
async function chainReady(chainId) {
  if (chainState.has(chainId)) return chainState.get(chainId);
  let st;
  try {
    const id = parseInt(await rpc(CHAINS[chainId].rpc, 'eth_chainId', []), 16);
    st = id === chainId ? { ok: true } : { ok: false, wrong: id };
  } catch (e) { st = { ok: false, down: String(e.message).slice(0, 60) }; }
  chainState.set(chainId, st);
  return st;
}

// ---------------------------------------------------------------------------------------------
// Checks. Each check is { s: 'ok' | 'bad' | 'unv' | 'skip', t: text }.
// ---------------------------------------------------------------------------------------------
const ok = (t) => ({ s: 'ok', t });
const bad = (t) => ({ s: 'bad', t });
const unv = (t) => ({ s: 'unv', t });
const skip = (t) => ({ s: 'skip', t });
const verdict = (cond, tOk, tBad) => (cond ? ok(tOk) : bad(tBad));

const ERC20_ALL = (rcpt) => rcpt.logs.filter((g) => g.topics[0] === EV.Transfer && g.topics.length === 3);
const evs = (rcpt, topic0, addr) => rcpt.logs.filter((g) => g.topics[0] === topic0 && (!addr || lc(g.address) === lc(addr)));
const findTransfer = (rcpt, token, from, to, amount) => ERC20_ALL(rcpt).find((g) => lc(g.address) === lc(token)
  && (from === undefined || g.topics[1] === from) && (to === undefined || g.topics[2] === to) && (amount === undefined || BigInt(g.data) === amount));

// The policy chain of a wrapper ran to completion on a gated transfer: PolicyRunComplete is only emitted
// when every installed policy accepted.
function policyRan(rcpt, manager, wrapper, selector) {
  return rcpt.logs.some((g) => g.topics[0] === EV.PolicyRunComplete && lc(g.address) === lc(manager)
    && g.topics[2] === pad(wrapper) && g.topics[3] === sel4(selector));
}
// The sanctions policy is installed on the wrapper for that selector, read at the block before.
async function policyInstalled(chainId, manager, wrapper, selector, policy, block, name) {
  if (SKIP_HISTORY) return skip(`${name} installed on the wrapper (history skipped)`);
  const r = await ethCall(chainId, call(manager, SEL.getPolicies, wrapper, selector.padEnd(66, '0')), hexBlock(block - 1));
  if (!r.ok) return unv(`policies installed on the wrapper could not be read at block ${block - 1} (${r.message})`);
  const h = r.result, n = Number(wordAt(h, 1));
  const list = []; for (let i = 0; i < n; i++) list.push('0x' + h.slice(2 + (2 + i) * 64 + 24, 2 + (3 + i) * 64));
  return verdict(list.map(lc).includes(lc(policy)), `${name} ${short(policy)} is installed on the wrapper policy chain (${n} policies) when the transfer runs`,
    `${name} ${short(policy)} is NOT among the ${n} policies installed on the wrapper`);
}
async function balanceOf(chainId, token, holder, block) {
  const r = await ethCall(chainId, call(token, SEL.balanceOf, holder), hexBlock(block));
  return r.ok ? BigInt(r.result) : null;
}

// Decode a revert: PolicyRunRejected(bytes4,address,string) | ProofNotBound(string) | Error(string).
function decodeRevert(data) {
  if (!data || data.length < 10) return null;
  const s = data.slice(0, 10), b = '0x' + data.slice(10);
  const str = (off) => { const o = Number(wordAt(b, off / 32)) * 2; const len = Number(BigInt('0x' + b.slice(2 + o, 2 + o + 64))); return Buffer.from(b.slice(2 + o + 64, 2 + o + 64 + len * 2), 'hex').toString('utf8'); };
  try {
    if (s === ERR.PolicyRunRejected) return { error: 'PolicyRunRejected', selector: '0x' + b.slice(2, 10), policy: '0x' + b.slice(2 + 64 + 24, 2 + 128), message: str(64) };
    if (s === ERR.ProofNotBound || s === ERR.Error) return { error: s === ERR.Error ? 'Error' : 'ProofNotBound', message: str(0) };
  } catch { /* fall through */ }
  return { error: s };
}
// Compare a decoded revert with what the tracker names for that leg (`expect`).
function matchRevert(d, ex) {
  if (!d) return bad('the call did not return a decodable revert');
  const why = [];
  if (d.error !== ex.error) why.push(`error ${d.error}, expected ${ex.error}`);
  if (ex.selector && d.selector !== SEL[ex.selector]) why.push(`gated selector ${d.selector}, expected ${ex.selector}`);
  if (ex.policy) { const p = at(ex.policy); if (lc(d.policy) !== lc(p)) why.push(`policy ${d.policy}, expected ${ex.policy} (${p})`); }
  if (ex.contains && !(d.message || '').includes(ex.contains)) why.push(`message "${d.message}" lacks "${ex.contains}"`);
  const what = `${d.error}${d.policy ? ` by ${label(d.policy) || d.policy}` : ''}: "${d.message || ''}"`;
  return why.length ? bad(`revert reason differs from the tracker: ${why.join('; ')}`) : ok(`reverted for the reason the tracker names: ${what}`);
}

// LayerZero: the guid of a packet is embedded in the encoded packet that PacketSent carries
// (version 1, nonce 8, srcEid 4, sender 32, dstEid 4, receiver 32, guid 32, message).
function packetGuid(g) {
  const off = Number(wordAt(g.data, 0)) * 2, len = Number(BigInt('0x' + g.data.slice(2 + off, 2 + off + 64)));
  const pkt = g.data.slice(2 + off + 64, 2 + off + 64 + len * 2);
  return '0x' + pkt.slice(81 * 2, 113 * 2);
}

// Route rule, checked against the chain: quote both routes at the block BEFORE the swap and require that
// the route used is the better one and that the SGDX delivered is that quote.
function routeCheck(p, block, delivered) {
  if (SKIP_HISTORY) return [skip('route rule replayed at the block before the swap (history skipped)')];
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'demo', 'route-agent.mjs'), '--amount', String(p.amount_eurx), '--block', String(block - 1), '--rpc-arbitrum', CHAINS[421614].rpc],
    { encoding: 'utf8', timeout: 90000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('GL1_FX_ROUTE='));
  if (r.status !== 0 || !line) return [unv(`route quotes at block ${block - 1} could not be made (${((r.stderr || '').trim().split('\n').pop() || 'no answer').slice(0, 90)})`)];
  const q = JSON.parse(line.slice('GL1_FX_ROUTE='.length));
  const out = [];
  const [direct, pivot] = [0, 1].map((i) => q.quotes.find((x) => x.route === i)?.out);
  out.push(verdict(q.route === p.route,
    `at block ${block - 1} the rule picks route ${q.route}, the route the pass used (${p.route === 1 ? 'pivot' : 'direct'}): ${f18(p.route === 1 ? pivot : direct)} SGDX against ${f18(p.route === 1 ? direct : pivot)} for the other route`,
    `at block ${block - 1} the rule picks route ${q.route}, the pass used route ${p.route}`));
  out.push(verdict(BigInt(q.convertAmount) === delivered, 'the SGDX delivered equals the quote of the chosen route, to the wei',
    `the SGDX delivered (${f18(delivered)}) differs from the quote of the chosen route (${f18(q.convertAmount)})`));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Legs. Each returns a list of checks; `ctx` carries the guids and blocks of the pass from leg to leg.
// ---------------------------------------------------------------------------------------------
const wei = (p) => toWei(p.amount_eurx);
const parties = (p) => ({ fi: p.parties?.originatingFI?.address, ben: p.parties?.beneficiaryFI?.address });

async function legChecks(l, p, rcpt, txn, ctx) {
  const out = [];
  const { fi, ben } = parties(p);
  const block = parseInt(rcpt.blockNumber, 16);
  const succeeded = rcpt.status === '0x1';
  const want = wei(p);
  const tr = ERC20_ALL(rcpt);
  const srcEid = tracker.wiring?.destination?.remoteEid, dstEid = tracker.wiring?.source?.remoteEid;

  if (l.phase === 'expect_revert') {
    const ex = l.expected_revert || {};
    out.push(verdict(!succeeded, 'the transaction failed at EVM level (a reverted transaction carries no log by construction)', `status ${rcpt.status}: the transaction did not revert`));
    out.push(verdict(lc(rcpt.to) === lc(T.SRC_ADAPTER_FX), `sent to the source adapter ${short(T.SRC_ADAPTER_FX)}, the entry of the corridor`, `sent to ${rcpt.to}, not to the source adapter`));
    out.push(verdict(lc(rcpt.from) === lc(fi), 'sent by the originating FI', `sent by ${rcpt.from}, not by the originating FI`));
    const gasLimit = parseInt(txn.gas, 16), gasUsed = parseInt(rcpt.gasUsed, 16);
    out.push(verdict(gasUsed < gasLimit, `gas used ${gasUsed} of ${gasLimit}: not an out-of-gas`, `gas used ${gasUsed} equals the limit ${gasLimit}: this may be an out-of-gas, not a refusal`));
    if (SKIP_HISTORY) {
      out.push(skip('revert reason replayed at the block before (history skipped)'));
    } else {
      const r = await ethCall(l.chainId, { from: txn.from, to: txn.to, data: txn.input, value: txn.value, gas: txn.gas }, hexBlock(block - 1));
      if (r.ok) out.push(bad(`replayed at block ${block - 1} the call SUCCEEDS: the chain does not refuse it`));
      else if (r.unavailable) out.push(unv(`the call could not be replayed at block ${block - 1} (${r.message})`));
      else out.push(matchRevert(decodeRevert(r.data), ex));
      // balances of the payer wrapper balance and of the lock, read before and after the transaction
      const reads = [['payer wEURX', T.wEURX_PolicyWrapper, fi], ['EURX locked at the adapter', T.EURX_TokenRep, T.SRC_ADAPTER_FX]];
      for (const [name, token, holder] of reads) {
        const [b0, b1] = [await balanceOf(l.chainId, token, holder, block - 1), await balanceOf(l.chainId, token, holder, block)];
        out.push(b0 === null || b1 === null ? unv(`${name}: balance could not be read at block ${block - 1}`)
          : verdict(b0 === b1, `${name}: ${f18(b0)} before and after (read at blocks ${block - 1} and ${block})`, `${name}: ${f18(b0)} before, ${f18(b1)} after`));
      }
    }
    for (const d of l.declared_offchain || []) out.push({ s: 'declared', t: d });
    return out;
  }

  if (!succeeded) return [bad(`EVM status failed for a leg that must succeed`)];

  if (l.phase === 'wrap') {
    const hit = findTransfer(rcpt, T.wEURX_PolicyWrapper, pad('0x0'), pad(fi), want);
    out.push(verdict(!!hit, `wEURX minted to the originating FI: exactly ${p.amount_eurx}`, `no mint of exactly ${p.amount_eurx} wEURX to the originating FI`));
  } else if (l.phase === 'lock') {
    const hit = findTransfer(rcpt, T.wEURX_PolicyWrapper, pad(fi), pad(T.SRC_ADAPTER_FX), want);
    out.push(verdict(!!hit, `wEURX moved from the originating FI to the source adapter: exactly ${p.amount_eurx}`, `no wEURX transfer of exactly ${p.amount_eurx} from the originating FI to the source adapter`));
    out.push(verdict(policyRan(rcpt, T.AtelierPolicyManager, T.wEURX_PolicyWrapper, SEL.transferFrom),
      'the policy chain of the wEURX wrapper ran to completion on transferFrom (PolicyRunComplete): every installed policy accepted before the token moved',
      'no PolicyRunComplete for the wEURX wrapper on transferFrom'));
    out.push(await policyInstalled(l.chainId, T.AtelierPolicyManager, T.wEURX_PolicyWrapper, SEL.transferFrom, tracker.zk.source.ZkSanctionsWrapperPolicy, block, 'sanctions non-membership policy'));
    const sent = evs(rcpt, EV.OFTSent, T.SRC_ADAPTER_FX)[0];
    if (!sent) out.push(bad('no OFTSent from the source adapter: nothing was sent through LayerZero'));
    else {
      ctx.guid = sent.topics[1];
      out.push(verdict(Number(wordAt(sent.data, 0)) === dstEid && wordAt(sent.data, 1) === want && wordAt(sent.data, 2) === want,
        `LayerZero send to endpoint id ${dstEid}: exactly ${p.amount_eurx} sent and received, guid ${short(ctx.guid)}`, `OFTSent differs: dstEid ${Number(wordAt(sent.data, 0))}, sent ${f18(wordAt(sent.data, 1))}, received ${f18(wordAt(sent.data, 2))}`));
      const pk = evs(rcpt, EV.PacketSent, tracker.lzEndpointV2)[0];
      out.push(verdict(pk && packetGuid(pk) === ctx.guid, 'the LayerZero packet itself carries that guid (PacketSent from the Endpoint V2)', 'the PacketSent of the Endpoint V2 does not carry the guid of OFTSent'));
    }
    if (p.guid) out.push(verdict(ctx.guid === p.guid, 'the guid of the lock is the guid the tracker records for this pass', `the guid of the lock (${short(ctx.guid || '0x')}) differs from the tracker (${short(p.guid)})`));
  } else if (l.phase === 'swap+deliver') {
    const w = D.wSGDX_delivery_PolicyWrapper;
    const delivered = toWei(p.beneficiary_delta_sgdx);
    const cd = evs(rcpt, EV.ComposeDelivered, tracker.lzEndpointV2)[0];
    out.push(verdict(cd && wordAt(cd.data, 2) === BigInt(ctx.guid || 0) && lc(topicAddr('0x' + cd.data.slice(2 + 64, 2 + 128))) === lc(D.COMPOSER_ARBITRUM_FX),
      `LINK: the Endpoint composes the message of guid ${short(ctx.guid || '0x')}, born at the source lock, into the arrival composer`,
      'the composed message is not the guid born at the source lock'));
    const cdel = evs(rcpt, EV.ComposerDelivered, D.COMPOSER_ARBITRUM_FX)[0];
    out.push(verdict(cdel && cdel.topics[1] === ctx.guid && topicAddr(cdel.topics[2]) === lc(ben) && wordAt(cdel.data, 0) === want && wordAt(cdel.data, 1) === delivered,
      `the composer delivered for that guid: ${p.amount_eurx} EURX in, ${f18(delivered)} SGDX out, to the beneficiary FI`, 'the composer Delivered event differs from the source lock or the tracker'));
    const hit = findTransfer(rcpt, w, undefined, pad(ben), delivered);
    out.push(verdict(!!hit, `wSGDX delivered to the beneficiary FI, exactly ${f18(delivered)} (matches the tracker)`, `no wSGDX transfer of exactly ${f18(delivered)} to the beneficiary FI`));
    out.push(verdict(policyRan(rcpt, D.AtelierPolicyManager, w, SEL.transfer),
      'the policy chain of the wSGDX wrapper ran to completion on the delivery (PolicyRunComplete): the payee is verified before the token moves', 'no PolicyRunComplete for the wSGDX wrapper on the delivery'));
    out.push(await policyInstalled(l.chainId, D.AtelierPolicyManager, w, SEL.transfer, tracker.zk.destination.ZkSanctionsWrapperPolicy, block, 'sanctions non-membership policy'));
    // Route 0 swaps in the direct pool; route 1 swaps through the two USDX pivot pools. Each pool must receive and
    // pay out in this transaction; the composer must never hold USDX (it exists only inside the router call), and
    // the composer takes part in the transaction (so "never holds USDX" is not vacuous).
    const pools = (p.route === 1 ? [D.pool_EURX_USDX, D.pool_SGDX_USDX] : [D.pool_EURX_SGDX]);
    const comp = pad(D.COMPOSER_ARBITRUM_FX);
    for (const pool of pools) {
      const [inn, outt] = [tr.some((g) => g.topics[2] === pad(pool)), tr.some((g) => g.topics[1] === pad(pool))];
      out.push(verdict(inn && outt, `pool ${short(pool)} received and paid out tokens in this transaction (the swap)`, `pool ${short(pool)} does not appear on both sides of a transfer`));
    }
    const mine = tr.filter((g) => g.topics[1] === comp || g.topics[2] === comp).length;
    out.push(verdict(mine > 0, `the composer takes part in the transaction (${mine} token transfers), so the next check is not vacuous`, 'the composer appears in no transfer of this transaction'));
    if (p.route === 1) {
      const held = tr.filter((g) => lc(g.address) === lc(D.USDX_pivot_TokenRep) && (g.topics[1] === comp || g.topics[2] === comp));
      out.push(verdict(held.length === 0, 'the composer never holds USDX (0 transfers of it to or from the composer)', `the composer touched USDX in ${held.length} transfer(s)`));
      const touched = tr.some((g) => g.topics[1] === pad(D.pool_EURX_SGDX) || g.topics[2] === pad(D.pool_EURX_SGDX));
      out.push(verdict(!touched, 'the direct pool did not move on route 1', 'the direct pool moved on route 1'));
    }
    // rate and distance to the reference, recomputed from the amounts
    const rate = Number(delivered) / Number(want);
    out.push(verdict(Math.abs(rate - p.rate_sgd_per_eur) < 1e-9, `applied rate ${rate.toFixed(6)} SGD per EUR recomputed from the amounts (tracker: ${p.rate_sgd_per_eur})`, `rate ${rate} recomputed from the amounts differs from the tracker ${p.rate_sgd_per_eur}`));
    const gap = (rate / tracker.reference_fx.sgd_per_eur - 1) * 1e4;
    out.push(verdict(Math.abs(gap - p.gap_to_reference_bps) < 0.1, `distance to the reference rate ${gap.toFixed(1)} bps (tracker: ${p.gap_to_reference_bps})`, `distance to the reference ${gap.toFixed(2)} bps differs from the tracker ${p.gap_to_reference_bps}`));
    out.push(...routeCheck(p, block, delivered));
  } else if (l.phase === 'unwrap') {
    const w = D.wSGDX_delivery_PolicyWrapper, sgdx = D.SGDX_delivery_TokenRep, delivered = toWei(p.beneficiary_delta_sgdx);
    const burnt = findTransfer(rcpt, w, pad(ben), pad('0x0'), delivered);
    out.push(verdict(!!burnt, `wSGDX burned by the beneficiary FI: exactly ${f18(delivered)}`, `no burn of exactly ${f18(delivered)} wSGDX by the beneficiary FI`));
    const got = findTransfer(rcpt, sgdx, undefined, pad(ben), delivered);
    out.push(verdict(!!got, 'the same amount of SGDX reaches the beneficiary FI', 'no SGDX transfer to the beneficiary FI'));
  } else if (l.phase === 'revoke-key' || l.phase === 'restore-key') {
    out.push(verdict(lc(rcpt.to) === lc(D.TestSeal), `sent to the demonstration attestation seal ${short(D.TestSeal)}`, `sent to ${rcpt.to}, not to the seal`));
    out.push({ s: 'declared', t: 'an operator act on a demonstration seal (test key): the receipt shows the call, not the key state; the order of blocks below shows the window' });
  } else if (l.phase === 'refuse') {
    const ex = l.expected_refusal || {};
    out.push(verdict(tr.length === 0, `0 token Transfer events: pool and beneficiary cannot have moved (${rcpt.logs.length} other events)`, `${tr.length} token Transfer events found in a refusal`));
    const cd = evs(rcpt, EV.ComposeDelivered, tracker.lzEndpointV2)[0];
    out.push(verdict(cd && wordAt(cd.data, 2) === BigInt(ctx.guid || 0), `LINK: the refused message is the guid ${short(ctx.guid || '0x')} born at the source lock`, 'the refused message is not the guid born at the source lock'));
    const rf = evs(rcpt, EV.Refused, D.COMPOSER_ARBITRUM_FX)[0];
    if (!rf) out.push(bad('no Refused event from the arrival composer'));
    else {
      out.push(verdict(rf.topics[1] === ctx.guid && topicAddr(rf.topics[2]) === lc(ben) && wordAt(rf.data, 0) === want,
        `the composer recorded the refusal for that guid, the payer amount ${p.amount_eurx} EURX and the beneficiary FI`, 'the Refused event differs from the source lock'));
      const off = Number(wordAt(rf.data, 1)) * 2, len = Number(BigInt('0x' + rf.data.slice(2 + off, 2 + off + 64)));
      out.push(matchRevert(decodeRevert('0x' + rf.data.slice(2 + off + 64, 2 + off + 64 + len * 2)), ex));
    }
    out.push(verdict(!policyRan(rcpt, D.AtelierPolicyManager, D.wSGDX_delivery_PolicyWrapper, SEL.transfer) && evs(rcpt, EV.ComposerDelivered, D.COMPOSER_ARBITRUM_FX).length === 0,
      'no completed policy run and no Delivered event: the gate stopped the delivery', 'a policy run or a Delivered event appears in a refusal'));
  } else if (l.phase === 'return') {
    const w = D.wEURX_reception_PolicyWrapper, eurx = D.EURX_reception_TokenRep, adapter = pad(D.RECV_ADAPTER_EUR);
    const back = wei({ amount_eurx: p.returned_amount_eurx });
    const moved = findTransfer(rcpt, w, pad(D.COMPOSER_ARBITRUM_FX), adapter, back);
    out.push(verdict(!!moved, `wEURX left the composer for the adapter: exactly ${p.returned_amount_eurx}`, `no wEURX transfer of exactly ${p.returned_amount_eurx} from the composer to the adapter`));
    const burnt = findTransfer(rcpt, w, adapter, pad('0x0'), back);
    out.push(verdict(!!burnt, 'the same wEURX is burned (transfer to the zero address): no wrapped value remains in circulation', 'no burn of the returned wEURX'));
    const res = findTransfer(rcpt, eurx, pad(w), adapter, back);
    out.push(verdict(!!res, 'the same amount of EURX returns from the wrapper to the adapter reserve', 'no EURX transfer back to the adapter reserve'));
    const rs = evs(rcpt, EV.ReturnedToSource, D.COMPOSER_ARBITRUM_FX)[0];
    out.push(verdict(rs && rs.topics[1] === ctx.guid && topicAddr(rs.topics[2]) === lc(fi) && wordAt(rs.data, 1) === back,
      `LINK: ReturnedToSource names the refused guid ${short(ctx.guid || '0x')}, the original payer and exactly ${p.returned_amount_eurx}`, 'ReturnedToSource differs from the refused guid, the payer or the amount'));
    const sent = evs(rcpt, EV.OFTSent, D.RECV_ADAPTER_EUR)[0];
    if (!sent) out.push(bad('no OFTSent from the arrival adapter: the return was not sent through LayerZero'));
    else {
      ctx.guid2 = sent.topics[1];
      out.push(verdict(Number(wordAt(sent.data, 0)) === srcEid && wordAt(sent.data, 1) === back, `LayerZero send back to endpoint id ${srcEid}: exactly ${p.returned_amount_eurx}, new guid ${short(ctx.guid2)}`, 'the return send differs in destination or amount'));
      const pk = evs(rcpt, EV.PacketSent, tracker.lzEndpointV2)[0];
      out.push(verdict(pk && packetGuid(pk) === ctx.guid2, 'the packet of the return carries that second guid', 'the PacketSent of the return does not carry the second guid'));
    }
  } else if (l.phase === 'credit-payer') {
    const back = wei({ amount_eurx: p.returned_amount_eurx });
    const hit = findTransfer(rcpt, T.wEURX_PolicyWrapper, pad(T.RETURN_RECEIVER), pad(fi), back);
    out.push(verdict(!!hit, `wEURX returned to the originating FI: exactly ${p.returned_amount_eurx} (the payer is made whole)`, `no wEURX transfer of exactly ${p.returned_amount_eurx} from the return receiver to the originating FI`));
    const cd = evs(rcpt, EV.ComposeDelivered, tracker.lzEndpointV2)[0];
    out.push(verdict(ctx.guid2 && cd && wordAt(cd.data, 2) === BigInt(ctx.guid2), `LINK: the Endpoint delivers the return packet of guid ${short(ctx.guid2 || '0x')}`, 'the delivered packet is not the return packet'));
    const rp = evs(rcpt, EV.ReturnedToPayer, T.RETURN_RECEIVER)[0];
    out.push(verdict(rp && rp.topics[1] === ctx.guid2 && topicAddr(rp.topics[2]) === lc(fi) && wordAt(rp.data, 0) === back, 'ReturnedToPayer names the return guid, the original payer and the exact amount', 'ReturnedToPayer differs from the return guid, the payer or the amount'));
    out.push(verdict(policyRan(rcpt, T.AtelierPolicyManager, T.wEURX_PolicyWrapper, SEL.transfer), 'the source policy chain ran to completion on the gated transfer back to the payer (PolicyRunComplete)', 'no PolicyRunComplete on the transfer back to the payer'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const tally = { ok: 0, bad: 0, unv: 0, skip: 0, declared: 0 };
const legs = { ok: 0, bad: 0, unv: 0 };
const PREFIX = { ok: 'check ok   ', bad: 'CHECK FAILED', unv: 'UNVERIFIED  ', skip: 'skipped     ', declared: 'declared    ' };

async function leg(l, p, ctx) {
  const c = CHAINS[l.chainId];
  if (!c) { console.log(`    [${l.phase}] chain ${l.chainId} is not in the registry`); tally.bad++; legs.bad++; return; }
  const link = `${c.explorer}/tx/${l.tx}`;
  const ready = await chainReady(l.chainId);
  if (!ready.ok) {
    console.log(`    [${l.phase}] ${c.name}: ${ready.wrong ? `the endpoint answers chain id ${ready.wrong}, not ${l.chainId}` : `RPC unreachable (${ready.down})`}; explorer link stands`);
    console.log(`        ${link}`);
    if (ready.wrong) { tally.bad++; legs.bad++; } else { tally.unv++; legs.unv++; }
    return;
  }
  let rcpt, txn;
  try {
    [rcpt, txn] = [await rpc(c.rpc, 'eth_getTransactionReceipt', [l.tx]), await rpc(c.rpc, 'eth_getTransactionByHash', [l.tx])];
  } catch (e) {
    console.log(`    [${l.phase}] ${c.name}: RPC unreachable (${String(e.message).slice(0, 60)}); explorer link stands`);
    console.log(`        ${link}`);
    tally.unv++; legs.unv++; return;
  }
  if (!rcpt || !txn) {
    console.log(`    [${l.phase}] ${c.name}: the chain has no receipt for this transaction`);
    console.log(`        ${link}`);
    tally.bad++; legs.bad++; return;
  }
  const block = parseInt(rcpt.blockNumber, 16);
  const okStatus = rcpt.status === '0x1';
  const named = label(rcpt.to || '');
  ctx.blocks[l.phase] = block;
  console.log(`    [${l.phase}] ${c.name}  block ${block}  EVM status ${okStatus ? 'success' : 'failed'}${l.phase === 'expect_revert' ? ' (expected: failed)' : ''}`);
  console.log(`        to ${rcpt.to || '(contract creation)'}${named ? `  (corridor: ${named})` : ''}`);
  console.log(`        ${l.what}`);
  console.log(`        ${link}`);
  const checks = await legChecks(l, p, rcpt, txn, ctx);
  let worst = 'ok';
  for (const k of checks) {
    console.log(`        ${PREFIX[k.s]}  ${k.t}`);
    tally[k.s]++;
    if (k.s === 'bad') worst = 'bad'; else if (k.s === 'unv' && worst !== 'bad') worst = 'unv';
  }
  legs[worst]++;
}

async function pass(title, p) {
  console.log(`\n== ${title}: ${p.outcome} ==`);
  const who = (x) => (x && (x.name || x.address) ? `${x.name || ''} ${x.address || ''}`.trim() : '');
  if (p.parties?.originatingFI) console.log(`  originating FI: ${who(p.parties.originatingFI)}`);
  if (p.parties?.beneficiaryFI) console.log(`  beneficiary FI: ${who(p.parties.beneficiaryFI)}`);
  if (p.rate_sgd_per_eur) console.log(`  applied rate: 1 EUR = ${p.rate_sgd_per_eur} SGD`);
  if (p.reason) console.log(`  reason: ${p.reason}`);
  if (p.amount_eurx) console.log(`  amount: ${p.amount_eurx} EURX`);
  console.log(`  beneficiary delta: +${p.beneficiary_delta_sgdx ?? 0} SGDX`);
  const ctx = { guid: null, guid2: null, blocks: {} };
  for (const l of p.legs) await leg(l, p, ctx);
  // returned pass: the order of the key window on the arrival chain (revoked, refused, restored, returned)
  const b = ctx.blocks;
  if (p.outcome === 'returned' && ['revoke-key', 'refuse', 'restore-key', 'return'].every((k) => b[k])) {
    const inOrder = b['revoke-key'] < b.refuse && b.refuse < b['restore-key'] && b['restore-key'] < b.return;
    const k = verdict(inOrder, `ORDER on Arbitrum Sepolia: key revoked (block ${b['revoke-key']}), delivery refused (${b.refuse}), key restored (${b['restore-key']}), funds returned (${b.return})`,
      `the key window is out of order: revoke ${b['revoke-key']}, refuse ${b.refuse}, restore ${b['restore-key']}, return ${b.return}`);
    console.log(`    [order] ${PREFIX[k.s]}  ${k.t}`);
    tally[k.s]++;
    if (k.s === 'bad') legs.bad++;
  }
}

const dp = tracker.demonstration_passes;
if (!dp || !dp.conforming || !dp.refused) {
  console.error('deployments/fx-corridor.json carries no demonstration_passes to replay');
  process.exit(2);
}

console.log('Programmable Compliance: FX cross-chain corridor EURX to SGDX');
console.log(`end-to-end verification from the surface (read only, public test networks), ${new Date().toISOString().slice(0, 19)}Z`);
if (dp.note) console.log(`\n${dp.note}`);

const TITLES = {
  conforming: 'conforming pass',
  refused: 'refused at the source (attestation bound to another beneficiary)',
  refused_sanctions: 'refused at the source (sanctions proof)',
  refused_replay: 'refused at the source (replay of a settled pass)',
  refused_forged_proof: 'refused at the source (forged proof)',
  returned: 'returned pass (arrival refusal, then funds returned to the payer)',
};
for (const [key, p] of Object.entries(dp)) {
  if (!p || typeof p !== 'object' || !p.legs) continue;
  await pass(TITLES[key] || key, p);
}

console.log('\n-- summary --');
console.log('  conforming: wrap, gated transfer and lock, one guid carried by LayerZero, swap at the arrival pivot on the route the rule picks, gated delivery, unwrap');
console.log('  refused   : each refusal reverted at the source, for the reason the tracker names, before any lock; the payer balance and the lock are unchanged');
if (dp.returned) console.log('  returned  : the refused value went back through the bridge under a second guid, the reserve was restored and the payer was made whole');
if (Array.isArray(dp.not_played) && dp.not_played.length) {
  console.log('  not played in these passes (so not shown by this script):');
  for (const n of dp.not_played) console.log(`    - ${n}`);
}
console.log(`  transactions: ${legs.ok} fully confirmed, ${legs.bad} with a failed check, ${legs.unv} with a check that could not be made`);
console.log(`  checks      : ${tally.ok} passed, ${tally.bad} failed, ${tally.unv} unverified, ${tally.skip} skipped, ${tally.declared} declared (off-chain, not checks)`);

// 1: the chain does not say what the surface claims. 3: nothing failed but a check could not be made. 0: every
// check was made and passed (a run with --skip-history exits 0 but says that checks were skipped).
const code = tally.bad > 0 ? 1 : tally.unv > 0 ? 3 : 0;
console.log(`  result      : ${code === 1 ? 'FAILED'
  : code === 3 ? 'INCOMPLETE (RPC unreachable or history not served): not a green result'
    : tally.skip > 0 ? `no check failed, but ${tally.skip} were skipped by --skip-history: not a full result`
      : 'every check was made and passed'}`);
process.exit(code);
