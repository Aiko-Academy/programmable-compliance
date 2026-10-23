// Sanctions list root on BOTH chains (lot 6, 2026-10-18): publish the SAME root, then re-read it.
//   node examples/corridor-fx/sanctions-roots.mjs guard  [--list demo-sanctions-v1] [--expected 0x...] [--tolerance-s 600] [--max-age-s 604800]
//   node examples/corridor-fx/sanctions-roots.mjs publish --root 0x... --version N [--list demo-sanctions-v1]
//        (key read BY NAME: PUBLISHER_PRIVATE_KEY, defaulting to DEPLOYER_PRIVATE_KEY, the demonstration publisher)
// --expected: the root that the `prove-sanctions root` tool computes from the snapshot; the guard fails if a chain differs from it.
// The guard fails (code 1) if the roots differ, if the timestamp gap exceeds the tolerance, or if a root is
// stale. The registries are read from the circuit's tracer (`<chainId>-sanctions-nonmembership.json`, key SanctionsRootRegistry); as long as they are not
// deployed, the guard says so and exits with code 2: an absence is not a green.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, id } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const ABI = [
  'function current(bytes32 listId) view returns (tuple(bytes32 root, uint64 publishedAt, uint64 listVersion))',
  'function publish(bytes32 listId, bytes32 root, uint64 listVersion)',
  'function publisher() view returns (address)',
];
export const LISTE_PAR_DEFAUT = 'demo-sanctions-v1';
export const LIST_ID = id(LISTE_PAR_DEFAUT);
/** Default freshness window of the guard: the policies' one (`maxRootAge`, read by `listsOf`), 7 days.  */
export const FENETRE_PAR_DEFAUT_S = 604800;

/** Pure logic. `a` and `b`: { chain, root, publishedAt, listVersion }; `now` in seconds. Returns the list of discrepancies.  */
export function comparer(a, b, { toleranceS = 600, maxAgeS = FENETRE_PAR_DEFAUT_S, now = Math.floor(Date.now() / 1000) } = {}) {
  const e = [];
  for (const r of [a, b]) {
    if (!r.root || /^0x0+$/.test(r.root)) e.push(`${r.chain}: no root published`);
    else if (now - Number(r.publishedAt) > maxAgeS) e.push(`${r.chain}: stale root (${now - Number(r.publishedAt)} s, maximum ${maxAgeS} s)`);
  }
  if (a.root !== b.root) e.push(`different roots: ${a.chain} ${a.root} against ${b.chain} ${b.root}`);
  if (a.listVersion !== b.listVersion) e.push(`different list versions: ${a.listVersion} against ${b.listVersion}`);
  if (Math.abs(Number(a.publishedAt) - Number(b.publishedAt)) > toleranceS) e.push(`publication gap ${Math.abs(Number(a.publishedAt) - Number(b.publishedAt))} s beyond ${toleranceS} s`);
  return e;
}

function env(nom) {
  for (const f of ['.env.local', '.env']) {
    try {
      const m = readFileSync(join(process.env.PC_ENV_DIR || join(here, '..', '..', '..'), f), 'utf8').match(new RegExp(`^${nom}=(.*)$`, 'm'));
      // An EMPTY value is not a value: `.env.local` can carry `NOM=` and mask `.env` (empty RPC = localhost, silent loop).
      const v = m ? m[1].replace(/^["']|["']$/g, '') : '';
      if (v) return v;
    } catch { /* absent */ }
  }
  if (process.env[nom]) return process.env[nom];
  throw new Error(`variable ${nom} introuvable (lue par nom)`);
}

function lire(f) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

/** RPC: the variable if it exists, otherwise the testnet's public endpoint (no secret).  */
function rpcDe(c) {
  try { return env(c.rpc); } catch { return c.defaut; }
}

function chaines() {
  const root = join(here, '..', '..', 'deployments');
  return [
    { nom: 'sepolia', rpc: 'SEPOLIA_RPC_URL', defaut: 'https://ethereum-sepolia-rpc.publicnode.com', zk: lire(join(root, '11155111-sanctions-nonmembership.json')) },
    { nom: 'arbitrum-sepolia', rpc: 'ARBITRUM_SEPOLIA_RPC_URL', defaut: 'https://sepolia-rollup.arbitrum.io/rpc', zk: lire(join(root, '421614-sanctions-nonmembership.json')) },
  ].map((c) => ({ ...c, registre: c.zk.SanctionsRootRegistry }));
}

async function main() {
  const [mode] = process.argv.slice(2);
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const cs = chaines();
  const listId = id(arg('--list') ?? LISTE_PAR_DEFAUT);
  const manquants = cs.filter((c) => !c.registre).map((c) => c.nom);
  if (manquants.length) { console.error(`sanctions-roots: SanctionsRootRegistry not deployed on ${manquants.join(', ')} (zk tracker). Nothing to read.`); process.exit(2); }
  if (mode === 'publish') {
    const racine = arg('--root'), version = BigInt(arg('--version'));
    if (!/^0x[0-9a-fA-F]{64}$/.test(racine || '')) throw new Error('--root expected: 0x followed by 64 hex');
    let cle;
    try { cle = env('PUBLISHER_PRIVATE_KEY'); } catch { cle = env('DEPLOYER_PRIVATE_KEY'); }
    for (const c of cs) {
      const w = new Wallet(cle, new JsonRpcProvider(rpcDe(c)));
      const reg = new Contract(c.registre, ABI, w);
      // Sepolia prices code creation very high, but a publication is plain storage: wide fixed limit.
      await (await reg.publish(listId, racine, version, { gasLimit: 300000 })).wait();
      console.log(`${c.nom}: root published (version ${version})`);
    }
  } else if (mode !== 'guard') { console.error('usage: guard | publish'); process.exit(2); }
  const lus = [];
  for (const c of cs) {
    const r = await new Contract(c.registre, ABI, new JsonRpcProvider(rpcDe(c))).current(listId);
    lus.push({ chain: c.nom, root: r.root, publishedAt: r.publishedAt, listVersion: r.listVersion });
  }
  const ecarts = comparer(lus[0], lus[1], { toleranceS: Number(arg('--tolerance-s') ?? 600), maxAgeS: Number(arg('--max-age-s') ?? FENETRE_PAR_DEFAUT_S) });
  const attendue = arg('--expected');
  if (attendue) for (const l of lus) if (l.root.toLowerCase() !== attendue.toLowerCase()) ecarts.push(`${l.chain}: root ${l.root} differs from the snapshot's expected root ${attendue}`);
  console.log(JSON.stringify({ heure: new Date().toISOString(), ok: ecarts.length === 0, ecarts, lus: lus.map((l) => ({ ...l, publishedAt: String(l.publishedAt), listVersion: String(l.listVersion) })) }));
  process.exit(ecarts.length === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('sanctions-roots.mjs')) main().catch((e) => { console.error(`sanctions-roots : ${e.message}`); process.exit(2); });
