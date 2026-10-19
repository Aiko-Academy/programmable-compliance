#!/usr/bin/env node
// scripts/demo/wiring-check.mjs
//
// Reads the LayerZero pathway of the FX corridor on both public test networks and compares it with the
// values pinned in deployments/fx-corridor.json under "wiring". For each chain it checks the peer, the
// send and receive libraries (explicitly set, not the default), the send and receive ULN config, the
// executor, and the enforced options.
//
// It also DISCOVERS which composers are registered on each adapter (it replays the `ComposerSet` events from
// `composersFromBlock`) and requires that set to EQUAL the announced list: a registered composer that is not
// announced, or an announced one that is not registered, is a difference. A composer that is removed must leave
// the announced list, not stay "registered" in the documentation.
//
// It reads the RAW values set by the application (getAppUlnConfig, executorConfigs), not the merged
// "effective" value, because only the raw value tells a pinned setting from an inherited default.
//
// Read only. No build, no private key, no dependency: JSON-RPC over fetch. Exit code 1 if any check
// differs, so the verdict is read from the exit code, not from a log.
//
//   node scripts/demo/wiring-check.mjs
//
// Needs Node 18+ (global fetch). Options:
//   --rpc-sepolia <url>    override the Ethereum Sepolia endpoint
//   --rpc-arbitrum <url>   override the Arbitrum Sepolia endpoint
//   --tracker <file>       read the expected values from another tracker file (default: the surface's own)
//   --require-contract-owner   fail when the adapter owner (which is also its delegate) is an EOA. The owner can
//                          replace the DVN set or the peer, so in production it is a multisig or a timelock.
//                          Without the flag an EOA owner is reported as a warning (acceptable on a demo).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };

const tracker = JSON.parse(readFileSync(opt('--tracker', join(ROOT, 'deployments', 'fx-corridor.json')), 'utf8'));
const wiring = tracker.wiring;
if (!wiring) { console.error('the tracker carries no "wiring" block'); process.exit(2); }
const ENDPOINT = tracker.lzEndpointV2;

const CHAINS = [
  { key: 'source', name: 'Ethereum Sepolia', rpc: opt('--rpc-sepolia', 'https://sepolia.gateway.tenderly.co') },
  { key: 'destination', name: 'Arbitrum Sepolia', rpc: opt('--rpc-arbitrum', 'https://sepolia-rollup.arbitrum.io/rpc') },
];

// 4-byte selectors of the read functions used below.
const SEL = {
  peers: '0xbb0b6a53', getSendLibrary: '0xb96a277f', isDefaultSendLibrary: '0xdc93c8a2',
  getReceiveLibrary: '0x402f8468', getAppUlnConfig: '0x39e3f938', executorConfigs: '0x4d963200',
  enforcedOptions: '0x5535d461', composers: '0x99b06189', eid: '0x416ecebf', owner: '0x8da5cb5b', delegates: '0x587cde1e',
};

const COMPOSER_SET = '0xf187b99b31c88b74fa21e883dccac0126dd2610a75243cf016e9d9530656bdaf'; // ComposerSet(address,bool)

const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const num = (n) => BigInt(n).toString(16).padStart(64, '0');
const lc = (a) => String(a).toLowerCase();
const addrOf = (w) => '0x' + w.slice(24);

// A public RPC answers "rate limit exceeded" under a burst of reads: retry with a growing pause, then fail loudly
// (a silent RPC is not a pass). Any other error is not retried.
async function rpcCall(rpc, method, params) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    if (!j.error) return j.result;
    if (attempt < 5 && /rate limit|429|too many|timeout/i.test(j.error.message)) { await new Promise((r) => setTimeout(r, 1000 * attempt)); continue; }
    throw new Error(j.error.message);
  }
}

async function ethCall(rpc, to, data) {
  try { return (await rpcCall(rpc, 'eth_call', [{ to, data }, 'latest'])).replace(/^0x/, ''); }
  catch (e) { throw new Error(`${to}: ${e.message}`); }
}
const words = (hex) => hex.match(/.{64}/g) ?? [];

// getAppUlnConfig returns one dynamic struct: (uint64, uint8, uint8, uint8, address[], address[]).
function decodeUln(hex) {
  const w = words(hex);
  const base = Number(BigInt('0x' + w[0])) / 32; // offset of the struct, in words
  const s = (i) => w[base + i];
  const arr = (offWord) => {
    const at = base + Number(BigInt('0x' + offWord)) / 32;
    const n = Number(BigInt('0x' + w[at]));
    return Array.from({ length: n }, (_, k) => addrOf(w[at + 1 + k]));
  };
  return {
    confirmations: Number(BigInt('0x' + s(0))), requiredCount: Number(BigInt('0x' + s(1))),
    optionalCount: Number(BigInt('0x' + s(2))), threshold: Number(BigInt('0x' + s(3))),
    required: arr(s(4)), optional: arr(s(5)),
  };
}
// enforcedOptions returns `bytes`: offset word, length word, then the data.
function decodeBytes(hex) {
  const w = words(hex.padEnd(Math.ceil(hex.length / 64) * 64, '0'));
  const len = Number(BigInt('0x' + w[1]));
  return '0x' + hex.slice(128, 128 + len * 2);
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => lc(x) === lc(b[i]));


// Replays `ComposerSet` from `from` to the head. Public RPCs cap the block range of a log query, so the range is
// paged and halved on a range error; an RPC that has pruned the history is an ERROR, never a silent empty set.
async function discoverComposers(rpc, adapter, from) {
  const head = Number(BigInt(await rpcCall(rpc, 'eth_blockNumber', [])));
  const events = [];
  let page = 5_000_000;
  for (let a = from; a <= head;) {
    const b = Math.min(a + page - 1, head);
    try {
      const logs = await rpcCall(rpc, 'eth_getLogs', [{ address: adapter, topics: [COMPOSER_SET], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
      events.push(...logs);
      a = b + 1;
    } catch (e) {
      if (/pruned|history/i.test(e.message)) throw new Error(`history unavailable on this RPC (${e.message}); pass an archive endpoint`);
      if (page <= 2_000) throw e;
      page = Math.floor(page / 4); // "range too large" or "too many results": smaller pages
    }
  }
  events.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
  const state = new Map();
  for (const e of events) state.set('0x' + e.topics[1].slice(26).toLowerCase(), BigInt(e.data) === 1n);
  return [...state].filter(([, on]) => on).map(([a]) => a).sort();
}

let bad = 0;
const say = (ok, label) => { console.log(`  ${ok ? 'ok  ' : 'DIFF'}  ${label}`); if (!ok) bad++; };

for (const c of CHAINS) {
  const p = wiring[c.key];
  console.log(`\n== ${c.name} (chain ${p.chainId}), adapter ${p.adapter}`);
  try {
    const adapter = p.adapter;
    const eid = BigInt('0x' + (await ethCall(c.rpc, ENDPOINT, SEL.eid))).toString();
    say(Number(eid) === p.eid, `endpoint.eid() = ${eid}, expected ${p.eid} (witness: this is the right chain)`);

    const owner = addrOf(words(await ethCall(c.rpc, adapter, SEL.owner))[0]);
    const delegate = addrOf(words(await ethCall(c.rpc, ENDPOINT, SEL.delegates + word(adapter)))[0]);
    say(lc(owner) === lc(delegate), 'adapter delegate equals adapter owner');
    const ownerIsContract = (await rpcCall(c.rpc, 'eth_getCode', [owner, 'latest'])).length > 2;
    if (flag('--require-contract-owner')) say(ownerIsContract, `owner ${owner} is a contract (multisig or timelock)`);
    else console.log(`  ${ownerIsContract ? 'info' : 'WARN'}  owner ${owner} is ${ownerIsContract ? 'a contract' : 'an EOA: acceptable on a demo, not in production'}`);

    const peer = words(await ethCall(c.rpc, adapter, SEL.peers + num(p.remoteEid)))[0];
    say(addrOf(peer) === lc(p.remoteAdapter), `peer(${p.remoteEid}) is the remote adapter`);

    const isDefSend = BigInt('0x' + words(await ethCall(c.rpc, ENDPOINT, SEL.isDefaultSendLibrary + word(adapter) + num(p.remoteEid)))[0]) === 1n;
    const sendLib = addrOf(words(await ethCall(c.rpc, ENDPOINT, SEL.getSendLibrary + word(adapter) + num(p.remoteEid)))[0]);
    say(!isDefSend, 'send library is pinned (not the default)');
    say(lc(sendLib) === lc(p.sendLibrary), `send library is ${p.sendLibrary}`);

    const rw = words(await ethCall(c.rpc, ENDPOINT, SEL.getReceiveLibrary + word(adapter) + num(p.remoteEid)));
    say(BigInt('0x' + rw[1]) === 0n, 'receive library is pinned (not the default)');
    say(lc(addrOf(rw[0])) === lc(p.receiveLibrary), `receive library is ${p.receiveLibrary}`);

    for (const [label, lib] of [['send', p.sendLibrary], ['receive', p.receiveLibrary]]) {
      const u = decodeUln(await ethCall(c.rpc, lib, SEL.getAppUlnConfig + word(adapter) + num(p.remoteEid)));
      const ok = u.confirmations === p.confirmations && u.requiredCount === p.requiredDVNs.length && u.optionalCount === 255
        && u.threshold === 0 && sameList(u.required, p.requiredDVNs) && sameList(u.optional, p.optionalDVNs);
      say(ok, `${label} ULN: ${u.confirmations} confirmations, required DVN ${u.required.join(',')} (${p.requiredDVNNames.join(',')}), no optional DVN (explicit)`);
    }

    const ex = words(await ethCall(c.rpc, p.sendLibrary, SEL.executorConfigs + word(adapter) + num(p.remoteEid)));
    say(Number(BigInt('0x' + ex[0])) === p.maxMessageSize && lc(addrOf(ex[1])) === lc(p.executor), `executor ${p.executor}, max message ${p.maxMessageSize} bytes`);

    for (const comp of p.composers || []) {
      const reg = BigInt('0x' + words(await ethCall(c.rpc, adapter, SEL.composers + word(comp)))[0]) === 1n;
      say(reg, `composer ${comp} is registered on the adapter`);
    }
    if (p.composersFromBlock !== undefined) {
      const found = await discoverComposers(c.rpc, adapter, p.composersFromBlock);
      const announced = (p.composers || []).map(lc).sort();
      const extra = found.filter((x) => !announced.includes(x));
      const missing = announced.filter((x) => !found.includes(x));
      say(extra.length === 0 && missing.length === 0,
        `registered composers (replayed from block ${p.composersFromBlock}) equal the announced list: ${found.length} registered, ${announced.length} announced${extra.length ? `; registered but NOT announced: ${extra.join(',')}` : ''}${missing.length ? `; announced but NOT registered: ${missing.join(',')}` : ''}`);
    }

    for (const [label, type] of [['SEND', 1], ['SEND_AND_CALL', 2]]) {
      const got = decodeBytes(await ethCall(c.rpc, adapter, SEL.enforcedOptions + num(p.remoteEid) + num(type)));
      say(got === p.enforcedOptions[label], `enforced options ${label}: ${got === '0x' ? 'none' : got}`);
    }
  } catch (e) {
    say(false, `read failed (${String(e.message).slice(0, 90)}); a silent RPC is not a pass`);
  }
}

console.log(bad === 0 ? '\nwiring-check: 0 difference. The pathway is pinned as the tracker says.' : `\nwiring-check: ${bad} difference(s).`);
process.exit(bad === 0 ? 0 : 1);
