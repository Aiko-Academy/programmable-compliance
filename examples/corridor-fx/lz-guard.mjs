// LayerZero guard of the FX corridor (lot 7, 2026-10-18): a failed message is never silent.
// A failing execution (insufficient gas, revert) leaves the message stored at the endpoint, emits
// `LzReceiveAlert` and blocks the channel until it is replayed: the guard READS it, counts it, and exits with an error.
//
//   node examples/corridor-fx/lz-guard.mjs [--blocks N] [--textfile path]
//
// Sources: each channel (local OApp, remote eid, remote pair) comes from the tracer, never a literal. The RPCs
// are read by NAME in .env.local / .env at the repository root, or from PC_ENV_DIR (worktree: the .env files stay in
// the main checkout) (SEPOLIA_RPC_URL, ARBITRUM_SEPOLIA_RPC_URL), value never printed.
// Output: one JSON line, and a Prometheus text-format file if --textfile (counters for monitoring):
//   pc_lz_pending_messages{chain,oapp,srceid}  messages received (commit) but not executed (inboundNonce - lazyInboundNonce)
//   pc_lz_receive_alerts{chain,oapp}           LzReceiveAlert emitted toward this OApp over the block window
// Exit code 1 if either is non-zero. Recovery runbook: docs/corridor-fx-runbook-lz.md.
// DATA KEPT AS SPELLED, not prose: the two LINES printed below are matched by lz-guard.test.mjs;
// renaming them means editing both files in one pass.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Interface, zeroPadValue } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));

const ENDPOINT_ABI = [
  'function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)',
  'event LzReceiveAlert(address indexed receiver, address indexed executor, (uint32 srcEid, bytes32 sender, uint64 nonce) origin, bytes32 guid, uint256 gas, uint256 value, bytes message, bytes extraData, bytes reason)',
];

/** Pure logic, testable without network. `canaux`: [{ chain, oapp, srcEid, pending }], `alertes`: [{ chain, oapp, count }].  */
export function evaluer({ canaux, alertes }) {
  const enAttente = canaux.filter((c) => c.pending > 0n);
  const enAlerte = alertes.filter((a) => a.count > 0);
  const lignes = [];
  for (const c of enAttente) lignes.push(`${c.chain} ${c.oapp} srcEid ${c.srcEid} : ${c.pending} stored message(s), channel blocked until resumed`);
  for (const a of enAlerte) lignes.push(`${a.chain} ${a.oapp} : ${a.count} LzReceiveAlert over the window`);
  return { ok: lignes.length === 0, pendingTotal: enAttente.reduce((n, c) => n + c.pending, 0n), alertesTotal: enAlerte.reduce((n, a) => n + a.count, 0), lignes };
}

/** Prometheus text format of the two counters. */
export function exposer({ canaux, alertes }) {
  const out = ['# TYPE pc_lz_pending_messages gauge', '# TYPE pc_lz_receive_alerts gauge'];
  for (const c of canaux) out.push(`pc_lz_pending_messages{chain="${c.chain}",oapp="${c.oapp}",srceid="${c.srcEid}"} ${c.pending}`);
  for (const a of alertes) out.push(`pc_lz_receive_alerts{chain="${a.chain}",oapp="${a.oapp}"} ${a.count}`);
  return out.join('\n') + '\n';
}

function lireEnv(nom) {
  for (const f of ['.env.local', '.env']) {
    try {
      const m = readFileSync(join(process.env.PC_ENV_DIR || join(here, '..', '..', '..'), f), 'utf8').match(new RegExp(`^${nom}=(.*)$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '');
    } catch { /* file absent : try the other one */ }
  }
  if (process.env[nom]) return process.env[nom];
  throw new Error(`variable ${nom} not found (read by name in .env.local, .env or the environment)`);
}

async function main() {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const fenetre = Number(arg('--blocks') ?? 20000);
  const tr = JSON.parse(readFileSync(join(here, '..', '..', 'test-layerzero', 'deployments-leg', 'fx-corridor.json'), 'utf8'));
  const s = tr.source, d = tr.destination;
  // OApps that RECEIVE: the receiving adapter (Arbitrum) and the source adapter (Sepolia, return of the funds).
  const chaines = [
    { nom: 'sepolia', rpc: 'SEPOLIA_RPC_URL', endpoint: tr.lzEndpointV2, oapps: [s.contracts.SRC_ADAPTER_FX], pairs: [d.contracts.RECV_ADAPTER_EUR], srcEid: d.eid },
    { nom: 'arbitrum-sepolia', rpc: 'ARBITRUM_SEPOLIA_RPC_URL', endpoint: tr.lzEndpointV2, oapps: [d.contracts.RECV_ADAPTER_EUR], pairs: [s.contracts.SRC_ADAPTER_FX], srcEid: s.eid },
  ];
  const canaux = [], alertes = [];
  const iface = new Interface(ENDPOINT_ABI);
  for (const ch of chaines) {
    const provider = new JsonRpcProvider(lireEnv(ch.rpc));
    const ep = new Contract(ch.endpoint, ENDPOINT_ABI, provider);
    const tete = await provider.getBlockNumber();
    for (let i = 0; i < ch.oapps.length; i++) {
      const sender = zeroPadValue(ch.pairs[i], 32);
      const [committed, lazy] = await Promise.all([ep.inboundNonce(ch.oapps[i], ch.srcEid, sender), ep.lazyInboundNonce(ch.oapps[i], ch.srcEid, sender)]);
      canaux.push({ chain: ch.nom, oapp: ch.oapps[i], srcEid: ch.srcEid, pending: committed - lazy });
      const logs = await ep.queryFilter(ep.filters.LzReceiveAlert(ch.oapps[i]), Math.max(0, tete - fenetre), tete);
      alertes.push({ chain: ch.nom, oapp: ch.oapps[i], count: logs.length });
    }
    void iface;
  }
  const r = evaluer({ canaux, alertes });
  const heure = new Date().toISOString();
  console.log(JSON.stringify({ heure, fenetre_blocs: fenetre, ok: r.ok, pending: String(r.pendingTotal), alertes: r.alertesTotal, lignes: r.lignes }));
  const tf = arg('--textfile');
  if (tf) writeFileSync(tf, exposer({ canaux, alertes }));
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('lz-guard.mjs')) main().catch((e) => { console.error(`lz-guard: ${e.message}`); process.exit(2); });
