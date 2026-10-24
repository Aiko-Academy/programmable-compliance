#!/usr/bin/env node
// VIVANTE (live) passes of the FX corridor on Sepolia and Arbitrum Sepolia, after the hardening of 2026-10-18.
//
// node examples/corridor-fx/live-pass.mjs fonds     [--amount 1000]   prepare: arrival reserve, payer's holdings
// node examples/corridor-fx/live-pass.mjs conforme  [--amount 1000]   wrap, conditioned send, lock, exchange, delivery, unwrap
// node examples/corridor-fx/live-pass.mjs refus     [--amount 1000]   beneficiary without credential: refused AT THE SOURCE
// node examples/corridor-fx/live-pass.mjs retour    [--amount 1000]   residual case: refused at arrival, then funds returned
// node examples/corridor-fx/live-pass.mjs agent     [--amount 1000]   compliant pass paid by the agent under FI FR's mandate (vLEI)
// node examples/corridor-fx/live-pass.mjs refus-vlei                   the payer presents a REVOKED OOR: no attestation, nothing is sent
// node examples/corridor-fx/live-pass.mjs agent-out-of-mandate [--amount 300000]  beyond the mandate ceiling: refused before any send
// node examples/corridor-fx/live-pass.mjs vol                          FI SG2 presents FI FR's attestation: runFor refuses, nothing is sent
// node examples/corridor-fx/live-pass.mjs contrepartie-inattendue      the payer expects a different LEI: KYC_CP refuses before any send
// --dry   (default) reads, computes, prints the plan and the balances, writes nothing
// --execute        broadcasts (testnet demos only; simulate first = run without --execute). The vLEI refusal modes
// (refus-vlei, agent-out-of-mandate, vol, contrepartie-inattendue) NEVER broadcast: --execute there only writes
// their result file.
//
// vLEI (2026-10-22), active as soon as the tracer carries VleiAttestationPolicy on BOTH chains; without it, everything is unchanged.
// It is KYC_CP, knowledge of the counterparty, played BEFORE value moves (before even the wrap):
// - the FI SG1 node, before signing its arrival attestation, has the PAYER's vLEI presentation verified (its OOR, or the
// agent's mandate and the granter's OOR upstream), its wallet linkage and its LEI against the expected LEI;
// - FI FR, before sending, has the BENEFICIARY's vLEI presentation, its linkage and its expected LEI verified, then replays
// in read mode the arrival policy (runFor on Arbitrum).
// The attester (toolkit/vlei/attester/attester.mjs) then signs the EIP-712 proofs that each wrapper's policy verifies at the
// gated transfer (payer at the source, beneficiary at arrival); the VleiReliedUpon event keeps the record.
// Env: PC_VLEI_PAYER (record, default fi-fr-payeur), PC_VLEI_BENEFICIARY (default fi-sg1-beneficiaire), PC_VLEI_LEI_PAYER and
// PC_VLEI_LEI_BENEFICIARY (expected LEIs, default those of the fi-fr-payeur and fi-sg1-beneficiaire records), VLEI_ATTESTER_PRIVATE_KEY
// (by name), PC_FX_TRACKER (another tracer, read). Pinned TEST root (not GLEIF), fictional LEIs prefixed DEMO.
//
// Everything is READ: addresses from the tracer `fx-corridor.json`, chain balances and events, Policy Manager checks.
// Keys sourced by NAME (DEPLOYER_PRIVATE_KEY, BANK_FR_PRIVATE_KEY, BANK_SG1_PRIVATE_KEY, NODE_DEMO_KEY) in .env.local
// at the repository root (or PC_ENV_DIR from a worktree), never printed. Sends go through txutil.mjs.
// Output: live-result.json (conforme), live-result-refusal.json (refusal at the source), live-result-return.json (return),
// live-result-<mode>.json for agent, refus-vlei, agent-out-of-mandate, vol and contrepartie-inattendue.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Wallet, Contract, Interface, AbiCoder, SigningKey, zeroPadValue, toBeHex, parseUnits, formatUnits, id as idOf, keccak256,
  toUtf8String, getBytes,
} from 'ethers';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { fournisseur, avecEssais, envoyer } from './txutil.mjs';
import { attester as attesterVlei, PROOF_ABI, POLICY_ABI as VLEI_ABI, partie as partieVlei, cleLei } from '../../vlei/attester/attester.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const toolkit = join(here, '..', '..');
const TRACEUR = process.env.PC_FX_TRACKER || join(toolkit, 'test-layerzero', 'deployments-leg', 'fx-corridor.json');
const EXECUTE = process.argv.includes('--execute');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const MODE = process.argv[2];
const MONTANT = parseUnits(arg('--amount', MODE === 'agent-out-of-mandate' ? '300000' : '1000'), 18); // beyond the mandate (250 000) by default
const ORG = idOf('node');
const fmt = (x) => formatUnits(x, 18);
const log = (m) => console.log(m);

function chargerEnv() {
  const dir = process.env.PC_ENV_DIR || join(toolkit, '..');
  for (const f of ['.env', '.env.local']) {
    try {
      for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
        const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* fichier absent */ }
  }
}
function cle(nom) { const v = process.env[nom]; if (!v) throw new Error(`variable ${nom} not found (read by name)`); return v; }

const ERC20 = [
  'function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)', 'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)',
];
const WRAP = [
  ...ERC20, 'function depositFor(address,uint256) returns (bool)', 'function withdrawTo(address,uint256) returns (bool)',
  'function totalSupply() view returns (uint256)', 'function underlying() view returns (address)', 'function owner() view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event TokenWrap(address indexed from, address indexed to, uint256 amount, address underlying)',
  'event TokenUnwrap(address indexed from, address indexed to, uint256 amount, address underlying)',
];
const ADAPTER = [
  'function stageContext(bytes)', 'function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),bool) view returns (tuple(uint256 nativeFee,uint256 lzTokenFee))',
  'function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),(uint256 nativeFee,uint256 lzTokenFee),address) payable returns (tuple(bytes32 guid,uint64 nonce,tuple(uint256 nativeFee,uint256 lzTokenFee) fee),tuple(uint256 amountSentLD,uint256 amountReceivedLD))',
  'function beneficiaryGate() view returns (address)', 'function inboundAmount(bytes32) view returns (uint256)',
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
];
const COMPOSER = [
  'function composePayloadFor(address,uint256,uint256,bytes) pure returns (bytes)',
  'function composePayloadForRoute(address,uint256,uint8,uint256,bytes) pure returns (bytes)',
  'function lastRefusal() view returns (bytes)', 'function refusals(bytes32) view returns (address payer,uint32 srcEid,uint8 state,uint256 amount)',
  'function surplus(bytes32) view returns (uint256)', 'function quoteReturn(bytes32,(bytes debitAttestation,bytes creditAttestation,bytes extraOptions)) view returns (uint256)',
  'function returnToSource(bytes32,(bytes debitAttestation,bytes creditAttestation,bytes extraOptions)) payable',
  'event Delivered(bytes32 indexed guid, address indexed beneficiary, uint256 amountInEur, uint256 amountOutSgd)',
  'event Refused(bytes32 indexed guid, address indexed beneficiary, uint256 amountInEur, bytes reason)',
  'event SurplusKept(bytes32 indexed guid, uint256 attestedOut, uint256 surplus)',
  'event ReturnedToSource(bytes32 indexed guid, address indexed payer, uint32 srcEid, uint256 amountLD)',
];
const SEAL = ['function digest((bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp)) view returns (bytes32)'];
const BINDING = [
  'function commitment(bytes16,address,address,uint256,address,string) view returns (bytes32)',
  'function rangeCommitment(bytes16,address,address,bytes32,address,string) view returns (bytes32)',
  'function rangeRef(uint128,uint128) pure returns (bytes32)',
];
const QUOTER = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)'];
const POOL = ['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'];
const GATE = ['function entryOf(address) view returns (tuple(bool present,uint40 credentialExpiresAt,uint64 mirroredAt))', 'function requireValid(address,bytes) view'];
const CREDS = ['function registerCredential(bytes32,bytes32,uint40,bytes)', 'function isValid(bytes32,bytes32) view returns (bool)'];
const IDS = ['function getIdentity(address) view returns (bytes32)'];
const ITEMS = 'tuple(uint8 kind,bytes32 orgId,tuple(bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp) sig,bytes32 r,bytes32 s,bytes32 qx,bytes32 qy)[]';
const CODES = ['customer-due-diligence', 'sanctions-screening', 'transaction-threshold'];
const MANAGER_EVENTS = [
  'event PolicyRunComplete(address indexed sender, address indexed target, bytes4 selector, uint8 result)',
  'error PolicyRunRejected(bytes4 selector, address policy, string reason)',
];
const ERRS = new Interface([
  ...MANAGER_EVENTS,
  'error BeneficiaryNotMirrored(address beneficiary)', 'error BeneficiaryMirrorStale(address beneficiary, uint64 mirroredAt, uint32 maxAge)',
  'error BeneficiaryCredentialExpired(address beneficiary, uint40 expiredAt)', 'error ProofNotAuthentic(string checkCode)',
  'error ProofMissingCheck(string checkCode)', 'error ProofNotBound(string checkCode)', 'error ProofStale(string checkCode)',
  'error ProofBelowThreshold(string checkCode)', 'error ProofRangeIncoherent(uint256 signedMin,uint256 signedMax,uint256 payloadMin,uint256 payloadMax)',
  'error PriceOutsideReference(uint256 out,uint256 referenceFloor)', 'error OutBelowAttested(uint256 out,uint256 attestedOut)',
  'error TooLittleReceived()', 'error PolicyRejected(string reason)',
]);

/** Decode a revert reason in clear text, inventing nothing: error name and arguments, otherwise the raw bytes. */
export function raison(data) {
  if (!data || data === '0x') return 'empty revert';
  try {
    const e = ERRS.parseError(data);
    return `${e.name}(${e.args.map((a) => String(a)).join(', ')})`;
  } catch { return `selecteur ${String(data).slice(0, 10)} non decode`; }
}

function ctx() {
  chargerEnv();
  const tr = JSON.parse(readFileSync(TRACEUR, 'utf8'));
  const sep = fournisseur('sepolia'), arb = fournisseur('arbitrum');
  const s = tr.source.contracts, d = tr.destination.contracts;
  const w = (nom, p) => new Wallet(cle(nom), p);
  const noeud = new Wallet(cle('NODE_DEMO_KEY'));
  const c = {
    tr, sep, arb, s, d, noeud,
    // PC_PAYER_KEY=BANK_SG1_PRIVATE_KEY (2026-10-20): a payer OTHER than FI FR. The key is sourced by NAME; the payer becomes the address it
    // derives from, and the check "the key derives from the tracer's address" then applies to that address.
    walletPayeur: w(process.env.PC_PAYER_KEY || 'BANK_FR_PRIVATE_KEY', sep), walletBenef: w('BANK_SG1_PRIVATE_KEY', arb),
    payer: process.env.PC_PAYER_KEY ? new Wallet(cle(process.env.PC_PAYER_KEY)).address : tr.parties.adresses.payeur, benef: tr.parties.adresses.beneficiaire,
    deployerSep: w('DEPLOYER_PRIVATE_KEY', sep), deployerArb: w('DEPLOYER_PRIVATE_KEY', arb),
    eurxSep: new Contract(s.EURX_TokenRep, ERC20, sep), wSrc: new Contract(s.wEURX_PolicyWrapper, WRAP, sep),
    adapter: new Contract(s.SRC_ADAPTER_FX, ADAPTER, sep),
    eurxArb: new Contract(d.EURX_reception_TokenRep, ERC20, arb), sgdx: new Contract(d.SGDX_delivery_TokenRep, ERC20, arb),
    wEurArb: new Contract(d.wEURX_reception_PolicyWrapper, WRAP, arb), wSgd: new Contract(d.wSGDX_delivery_PolicyWrapper, WRAP, arb),
    composer: new Contract(d.COMPOSER_ARBITRUM_FX, COMPOSER, arb),
    sealSrc: new Contract(s.TestSeal, SEAL, sep), sealDst: new Contract(d.TestSeal, SEAL, arb),
    bindSrc: new Contract(s.AtelierEnvelopeBindingPolicy, BINDING, sep), bindDst: new Contract(d.AtelierEnvelopeBindingPolicy, BINDING, arb),
    quoter: new Contract(tr.destination.uniswapV3Canonical.QuoterV2, QUOTER, arb),
  };
  // vLEI: active only if the policy is installed on BOTH wrappers; otherwise no field is read and nothing changes
  c.vleiActif = avecVlei(c);
  if (c.vleiActif) {
    c.vleiSrc = new Contract(s.VleiAttestationPolicy, VLEI_ABI, sep);
    c.vleiDst = new Contract(d.VleiAttestationPolicy, VLEI_ABI, arb);
    c.vleiPartiePayeur = process.env.PC_VLEI_PAYER || 'fi-fr-payeur';
    c.vleiPartieBenef = process.env.PC_VLEI_BENEFICIARY || 'fi-sg1-beneficiaire';
    c.leiAttendus = {
      payer: process.env.PC_VLEI_LEI_PAYER || partieVlei('fi-fr-payeur').lei,
      beneficiary: process.env.PC_VLEI_LEI_BENEFICIARY || partieVlei('fi-sg1-beneficiaire').lei,
    };
    c.vleiCache = new Map();
    c.vleiDerniers = {};
  }
  if (MODE !== 'fonds') {
    if (c.walletPayeur.address.toLowerCase() !== c.payer.toLowerCase()) throw new Error('BANK_FR_PRIVATE_KEY does not derive the payer of the tracker: refusal');
    if (c.walletBenef.address.toLowerCase() !== c.benef.toLowerCase()) throw new Error('BANK_SG1_PRIVATE_KEY does not derive the beneficiary of the tracker: refusal');
  }
  return c;
}

/** An attestation item signed by the node's key, on the digest the seal READS itself (the contract is the source of truth). */
async function item(sealContrat, signataire, { uetr, code, cdh, ref, ts }) {
  const sig = [uetr, code, true, cdh, ref, ts];
  const digest = await sealContrat.digest(sig);
  const s = new SigningKey(signataire.privateKey).sign(digest);
  return [0, ORG, sig, s.r, s.s, zeroPadValue(signataire.address, 32), zeroPadValue(toBeHex(s.v), 32)];
}
export const enc = (items) => AbiCoder.defaultAbiCoder().encode([ITEMS], [items]);
/** The extended context: the SAME items array, followed by the vLEI proof (policies already installed read the array alone). */
export const encVlei = (items, proof) => AbiCoder.defaultAbiCoder().encode([ITEMS, PROOF_ABI], [items, proof]);

/** Attestation of the SOURCE leg (exact): payer to adapter, EUR amount. With `proof` (vLEI), the extended context. */
async function attSource(c, uetr, de, vers, montant, ts, extra = [], proof = null) {
  const items = [];
  for (const code of CODES) {
    const cdh = await c.bindSrc.commitment(uetr, de, vers, montant, c.wSrc.target, code);
    items.push(await item(c.sealSrc, c.noeud, { uetr, code, cdh, ref: '0x' + '00'.repeat(32), ts }));
  }
  const tous = [...items, ...extra]; // the ZK items (kind 2) follow the signed items, in the SAME array
  return proof ? encVlei(tous, proof) : enc(tous);
}
/** Attestation of the ARRIVAL leg (range): composer to beneficiary, wSGDX. With `proof` (vLEI), the extended context. */
async function attArrivee(c, uetr, vers, minOut, maxOut, ts, extra = [], proof = null) {
  const ref = await c.bindDst.rangeRef(minOut, maxOut);
  const items = [];
  for (const code of CODES) {
    const cdh = await c.bindDst.rangeCommitment(uetr, c.composer.target, vers, ref, c.wSgd.target, code);
    items.push(await item(c.sealDst, c.noeud, { uetr, code, cdh, ref, ts }));
  }
  const tous = [...items, ...extra];
  return proof ? encVlei(tous, proof) : enc(tous);
}

async function soldes(c) {
  const r = async (f) => avecEssais(f, { label: 'balance read' });
  return {
    time: new Date().toISOString(),
    payer_wEURX: await r(() => c.wSrc.balanceOf(c.payer)), payer_EURX: await r(() => c.eurxSep.balanceOf(c.payer)),
    adapter_lock_EURX: await r(() => c.eurxSep.balanceOf(c.adapter.target)), supply_wEURX_source: await r(() => c.wSrc.totalSupply()),
    arrival_reserve_EURX: await r(() => c.eurxArb.balanceOf(c.d.RECV_ADAPTER_EUR)),
    pool_EURX: await r(() => c.eurxArb.balanceOf(c.d.pool_EURX_SGDX)), pool_SGDX: await r(() => c.sgdx.balanceOf(c.d.pool_EURX_SGDX)),
    beneficiary_wSGDX: await r(() => c.wSgd.balanceOf(c.benef)), beneficiary_SGDX: await r(() => c.sgdx.balanceOf(c.benef)),
    composer_wEURX: await r(() => c.wEurArb.balanceOf(c.composer.target)),
  };
}
const lisible = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? fmt(v) : v]));

async function cotation(c, tokenIn, tokenOut, fee, montant) {
  const [out] = await c.quoter.quoteExactInputSingle.staticCall([tokenIn, tokenOut, montant, fee, 0]);
  return out;
}

/** The two quotes (direct and pivot) and the route chosen by the rule: highest output, tie goes to direct. */
async function choisirRoute(c, montant) {
  const d = c.d;
  const direct = await cotation(c, d.EURX_reception_TokenRep, d.SGDX_delivery_TokenRep, 100, montant);
  const usd = await cotation(c, d.EURX_reception_TokenRep, d.USDX_pivot_TokenRep, 100, montant);
  const pivot = await cotation(c, d.USDX_pivot_TokenRep, d.SGDX_delivery_TokenRep, 100, usd);
  const route = pivot > direct ? 1 : 0;
  return { direct, pivot, route, output: route === 1 ? pivot : direct };
}

// Gas of the conditioned `send`: 9,000,000 was no longer enough with the vLEI policy (measurement of 2026-10-22: 9,871,350 estimated,
// hard failure at 8,874,788 out of 9,000,000, tx 0x91e75b21... block 11966123). Sepolia per-transaction ceiling: 16,777,216.
const GAZ_SEND = BigInt(process.env.PC_SEND_GAS || 13_000_000);
const FEES = { dstEid: null };
function param(c, composeMsg, montant, oftCmd = '0x') {
  return {
    dstEid: c.tr.destination.eid, to: zeroPadValue(c.composer.target, 32), amountLD: montant, minAmountLD: montant,
    extraOptions: '0x', composeMsg, oftCmd,
  };
}

// ── sanctions proofs (lot 6): produced OFF-CHAIN and BEFORE the transfer, one per screened party ────────────
// The Policy Wrapper concentrates all screening (AtelierZkSanctionsWrapperPolicy, a universal policy): it screens the
// `from` and the `to` of the gated transfer, excluding the rail's "conduits" (adapter, composer, return receiver). A leg entering
// the rail therefore has only one screenable party on the source wrapper side (the payer), and the arrival leg has only one (the
// beneficiary). The proofs are kind 2 items, code `sanctions-zkp-public`, in the SAME array as the attestation.
const ZK_DIR = join(toolkit, 'zk', 'sanctions');
const PROUVEUR = join(tmpdir(), 'prove-sanctions-corridor');
const ZK_CODE = 'sanctions-zkp-public';
function construireProuveur() {
  mkdirSync(dirname(PROUVEUR), { recursive: true });
  execFileSync('go', ['build', '-o', PROUVEUR, './cmd/prove-sanctions'], { cwd: ZK_DIR, stdio: 'pipe' });
}
/** One proof for the `id` party of the transfer (from, to) on `wrapper`. Exact amount (`montant`) or range (`min`, `max`).
 *  Returns { code: 3, message } if the party is in the list (NO proof exists), otherwise { code: 0, item }. */
function prouverPartie(c, { wrapper, chainid, uetr, from, to, id, party: partie, montant, min, max }) {
  construireProuveur();
  const pk = process.env.SANCTIONS_PK || join(homedir(), '.aiko-ceremonies', 'sanctions-v1', 'pk', 'pk.bin');
  if (!existsSync(pk)) throw new Error('proof key not found (SANCTIONS_PK or ~/.aiko-ceremonies/sanctions-v1/pk/pk.bin)');
  const sortie = join(tmpdir(), `preuve-${partie}-${Date.now()}.json`);
  const montantArgs = min !== undefined ? ['--min', String(min), '--max', String(max)] : ['--amount', String(montant)];
  const r = spawnSync(PROUVEUR, ['prove', '--snapshot', 'lists/demo-sanctions-v1.json', '--wrapper', wrapper, '--uetr', uetr,
    '--payer', from, '--beneficiary', to, ...montantArgs, '--chainid', String(chainid),
    '--pk', pk, '--circuit', 'ceremony-output/circuit.json', '--vk', 'ceremony-output/vk.bin', '--party', partie, '--type', 'address', '--id', id, '--output', sortie],
  { cwd: ZK_DIR, encoding: 'utf8' });
  if (r.status === 3) return { code: 3, message: (r.stderr || '').trim() };
  if (r.status !== 0) throw new Error(`prove-sanctions (${partie}) : ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  const w = JSON.parse(readFileSync(sortie, 'utf8')).preuve;
  return { code: 0, item: [2, w[0], [uetr, ZK_CODE, true, w[1], w[2], BigInt(w[3])], w[4], w[5], w[6], w[7]] };
}
const avecSanctions = (c) => !!(c.s.AtelierZkSanctionsWrapperPolicy && c.d.AtelierZkSanctionsWrapperPolicy);
const POLICY_ZK = ['function runFor(address subject,address from,address to,uint256 amount,bytes context) view returns (uint8)'];
/** Client pre-check: eth_call of `runFor` on the leg's chain, same verdict as the transaction (returns the reason). */
async function precontroleZk(c, chaine, { subject, from, to, montant, contexte }) {
  const adr = chaine === 'sepolia' ? c.s.AtelierZkSanctionsWrapperPolicy : c.d.AtelierZkSanctionsWrapperPolicy;
  const pol = new Contract(adr, POLICY_ZK, chaine === 'sepolia' ? c.sep : c.arb);
  try { await pol.runFor.staticCall(subject, from, to, montant, contexte, { gasLimit: 30_000_000n }); return { ok: true }; } catch (e) { return { ok: false, reason: raison(e.data) }; }
}


// ── vLEI: KYC_CP, knowledge of the counterparty (2026-10-22) ─────────────────────────────────────────────────
// Three questions before value moves: is the institution on the other side the one I believe it is (expected LEI), does the person or
// the agent acting for it have the right to (OOR, or a mandate under an OOR), is this wallet the one linked to it (linkage signed in both
// senses). The attester answers with the KERI/ACDC verifier, then signs an EIP-712 proof bound to THIS transfer; the wrapper's
// `VleiAttestationPolicy` verifies it at the gated transfer and emits `VleiReliedUpon`.
/** True if the vLEI policy is installed on both wrappers; installing it on a single chain is an incoherent state: refusal. */
function avecVlei(c) {
  const src = !!c.s.VleiAttestationPolicy, dst = !!c.d.VleiAttestationPolicy;
  if (src !== dst) throw new Error(`vLEI policy set on a single chain (source ${src}, arrival ${dst}): inconsistent state, nothing is sent`);
  return src;
}
const CTL_SG1_SUR_FR = 'FI SG1 node, before signing its arrival attestation : payer\'s vLEI presentation (OOR, or mandate and granter\'s OOR), wallet linkage, expected LEI';
const CTL_FR_SUR_SG1 = 'FI FR, before sending : beneficiary\'s vLEI presentation, wallet linkage, expected LEI, then runFor of the arrival policy (Arbitrum)';
/** One attestation per (party, wallet, uetr, amount, expected LEI) and per pass: both FIs read the same report. */
async function attesterEnCache(c, cleCache, args) {
  if (!c.vleiCache.has(cleCache)) c.vleiCache.set(cleCache, await attesterVlei({ ...args, cleAttesteur: cle('VLEI_ATTESTER_PRIVATE_KEY') }));
  return c.vleiCache.get(cleCache);
}
/** The payer (controlled party of the source wrapper): its presentation, its linkage, its LEI against the LEI expected by FI SG1. */
async function vleiPayeur(c, uetr, { party: partie = c.vleiPartiePayeur, montant = MONTANT, wallet = c.payer, expectedLei: leiAttendu = c.leiAttendus.payer } = {}) {
  const r = await attesterEnCache(c, `payeur|${partie}|${wallet}|${uetr}|${montant}|${leiAttendu}`, {
    name: partie, chainId: c.tr.source.chainId, wallet, asset: c.wSrc.target, policy: c.vleiSrc, uetr, montant, decimales: 18, assetSymbol: 'EURX', expectedLei: leiAttendu,
  });
  c.vleiDerniers.payer = r;
  return r;
}
/** The beneficiary (controlled party of the arrival wrapper): its presentation, its linkage, its LEI against the LEI expected by FI FR. */
async function vleiBeneficiaire(c, uetr, { party: partie = c.vleiPartieBenef, wallet = c.benef, expectedLei: leiAttendu = c.leiAttendus.beneficiary } = {}) {
  const r = await attesterEnCache(c, `beneficiaire|${partie}|${wallet}|${uetr}|${leiAttendu}`, {
    name: partie, chainId: c.tr.destination.chainId, wallet, asset: c.wSgd.target, policy: c.vleiDst, uetr, assetSymbol: 'SGDX', expectedLei: leiAttendu,
  });
  c.vleiDerniers.beneficiary = r;
  return r;
}
const entreeKyc = (r, controle) => ({
  check: controle, party: r.rapport.party, presented_lei: r.rapport.lei, expected_lei: r.rapport.expectedLei, role: r.rapport.role,
  roleTitle: r.rapport.roleTitle, verdict: r.signed, reasons: r.rapport.reasons, telStatus: r.rapport.telStatus, checkedAt: r.rapport.checkedAt,
});
/** Client pre-check: eth_call of the chain's vLEI policy `runFor`, same verdict as the gated transfer. */
async function precontroleVlei(c, chaine, { subject, from, to, montant, contexte }) {
  const pol = chaine === 'sepolia' ? c.vleiSrc : c.vleiDst;
  try {
    const r = await pol.runFor.staticCall(subject, from, to, montant, contexte, { gasLimit: 30_000_000n });
    return Number(r) === 2 ? { ok: true } : { ok: false, reason: `result ${r} (Continue = 2 expected)` };
  } catch (e) { return { ok: false, reason: raison(e.data) }; }
}
const etatPre = (x) => (x.ok ? 'Continue' : x.reason);
/** The source with the payer's proof when vLEI is active (an attester refusal stops everything: nothing is sent). */
async function preuvePayeurSiVlei(c, uetr, montant = MONTANT) {
  if (!c.vleiActif) return null;
  const p = await vleiPayeur(c, uetr, { montant });
  if (!p.signed) throw Object.assign(new Error(`payer vLEI refused (${p.rapport.party}): ${p.rapport.reasons.join(' ; ')}; nothing is sent`), { refusVlei: p.rapport });
  return p.proof;
}
async function attSourceControlee(c, uetr, montant, ts, extra = []) {
  return attSource(c, uetr, c.payer, c.adapter.target, montant, ts, extra, await preuvePayeurSiVlei(c, uetr, montant));
}

/**
 * The two KYC_CP controls, BEFORE any transaction, and in this order:
 *  (b) the FI SG1 node checks FI FR (payer's vLEI presentation, linkage, expected LEI): if it refuses, it does not sign;
 *  (a) FI FR checks FI SG1 (beneficiary's vLEI presentation, linkage, expected LEI), then replays the arrival policy
 *      (runFor on Arbitrum) on the beneficiary's attestation; FI FR also replays the source policy (runFor on Sepolia).
 * The runFor contexts carry only the signed items (no sanctions proof): the vLEI policy reads only the first item's
 * uetr and the proof. Returns { ok, raison, payeur, beneficiaire, kyc_cp, precontrole }.
 */
async function kycCp(c, { uetr, minOut, maxOut, montant = MONTANT, partiePayeur = c.vleiPartiePayeur }) {
  const out = { ok: false, kyc_cp: { by_fi_sg1_on_fi_fr: null, by_fi_fr_on_fi_sg1: null }, precontrole: { source: 'not played', arrival: 'not played' } };
  const p = await vleiPayeur(c, uetr, { party: partiePayeur, montant });
  out.payer = p;
  out.kyc_cp.by_fi_sg1_on_fi_fr = entreeKyc(p, CTL_SG1_SUR_FR);
  if (!p.signed) { out.reason = `KYC_CP of FI SG1 on FI FR refused: ${p.rapport.reasons.join(' ; ')}; the FI SG1 node does not sign its arrival attestation`; return out; }
  const b = await vleiBeneficiaire(c, uetr);
  out.beneficiary = b;
  const kFr = entreeKyc(b, CTL_FR_SUR_SG1);
  out.kyc_cp.by_fi_fr_on_fi_sg1 = kFr;
  if (!b.signed) { kFr.runFor_arbitrum = 'not played : no signed attestation'; out.reason = `KYC_CP of FI FR on FI SG1 refused: ${b.rapport.reasons.join(' ; ')}`; return out; }
  const ts = Math.floor(Date.now() / 1000) - 5;
  const dst = await attArrivee(c, uetr, c.benef, minOut, maxOut, ts, [], b.proof);
  const src = await attSource(c, uetr, c.payer, c.adapter.target, montant, ts, [], p.proof);
  const [arr, dep] = await Promise.all([
    precontroleVlei(c, 'arbitrum', { subject: c.wSgd.target, from: c.composer.target, to: c.benef, montant: maxOut, contexte: dst }),
    precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant, contexte: src }),
  ]);
  kFr.runFor_arbitrum = etatPre(arr);
  out.precontrole = { source: etatPre(dep), arrival: etatPre(arr) };
  if (!arr.ok) { kFr.verdict = false; out.reason = `KYC_CP of FI FR on FI SG1: the arrival policy refuses the beneficiary's attestation (${arr.reason})`; return out; }
  if (!dep.ok) { out.reason = `the source policy refuses the payer's attestation (${dep.reason})`; return out; }
  out.ok = true;
  return out;
}
function afficherKyc(k) {
  const l = (x) => (x ? `${x.verdict ? 'OK' : 'REFUS'} (${x.party}, LEI ${x.presented_lei} / expected ${x.expected_lei}, ${x.role} ${x.roleTitle || ''}, TEL ${x.telStatus})${x.reasons.length ? ' : ' + x.reasons.join(' ; ') : ''}` : 'not played');
  log(`KYC_CP by FI SG1 on FI FR : ${l(k.kyc_cp.by_fi_sg1_on_fi_fr)}`);
  log(`KYC_CP by FI FR on FI SG1 : ${l(k.kyc_cp.by_fi_fr_on_fi_sg1)}`);
  log(`vLEI precheck (runFor): source ${k.precontrole.source} ; arrival ${k.precontrole.arrival}`);
}
const VLEI_IFACE = new Interface(VLEI_ABI);
/** The VleiReliedUpon events of a receipt, decoded, and cross-checked against the attester's report (condensed, role, wallet, signer). */
export function relianceVlei(recu, politique, chaine, rapport) {
  const out = [];
  for (const l of recu.logs) {
    if (l.address.toLowerCase() !== politique.toLowerCase()) continue;
    let ev;
    try { ev = VLEI_IFACE.parseLog(l); } catch { continue; }
    if (!ev || ev.name !== 'VleiReliedUpon') continue;
    const a = ev.args;
    const e = {
      chain: chaine, tx: recu.hash, block: recu.blockNumber, policy: politique, subject: a.subject, uetr: a.uetr, wallet: a.wallet, lei: toUtf8String(getBytes(a.lei)),
      role: Number(a.role), credentialSaid: a.credentialSaid, holderAid: a.holderAid, rootAid: a.rootAid, mandateSaid: a.mandateSaid,
      verifiedAt: new Date(Number(a.verifiedAt) * 1000).toISOString(), verifier: a.verifier,
      terms: { termsHash: a.terms.termsHash, allocation: Number(a.terms.allocation), disputeRef: a.terms.disputeRef, sourceRef: a.terms.sourceRef },
    };
    if (rapport && rapport.digests) {
      const k = rapport.digests;
      e.matches_the_attester = e.lei === rapport.lei && e.role === rapport.roleAttestation && e.credentialSaid === k.credentialSaid
        && e.holderAid === k.holderAid && e.rootAid === k.rootAid && e.mandateSaid === k.mandateSaid && e.verifiedAt === rapport.verifiedAt
        && e.verifier.toLowerCase() === rapport.attester.toLowerCase() && e.wallet.toLowerCase() === rapport.wallet.toLowerCase()
        && (!rapport.terms || (e.terms.termsHash === rapport.terms.termsHash && e.terms.allocation === rapport.terms.allocation
          && e.terms.disputeRef === rapport.terms.disputeRef && e.terms.sourceRef === rapport.terms.sourceRef));
    }
    out.push(e);
  }
  return out;
}
/** The `vlei` entry of a result: policies, attester, both parties' reports, KYC_CP and whatever the caller adds. */
function vleiResume(c, kyc, extra = {}) {
  const p = kyc ? kyc.payer : c.vleiDerniers.payer, b = kyc ? kyc.beneficiary : c.vleiDerniers.beneficiary;
  const un = p || b;
  return {
    warning: 'pinned TEST root (not GLEIF), fictional LEIs prefixed DEMO',
    source_policy: c.s.VleiAttestationPolicy, arrival_policy: c.d.VleiAttestationPolicy,
    attester: (p && p.rapport.attester) || (b && b.rapport.attester) || new Wallet(cle('VLEI_ATTESTER_PRIVATE_KEY')).address,
    pinned_root: un ? un.rapport.pinnedRoot : null,
    payer: p ? p.rapport : null, beneficiary: b ? b.rapport : null,
    kyc_cp: kyc ? kyc.kyc_cp : { by_fi_sg1_on_fi_fr: p ? entreeKyc(p, CTL_SG1_SUR_FR) : null, by_fi_fr_on_fi_sg1: b ? entreeKyc(b, CTL_FR_SUR_SG1) : null },
    ...extra,
  };
}

// ── OFF-CHAIN control by the beneficiary's FI node (institution-node model) ──────────────────────────────────────
// Before any transaction, the beneficiary's node verifies its client with its own data and signs the arrival attestation
// only if the control passes. Here the node reads the identity registry of the arrival chain (its "data"); without
// a valid credential it REFUSES TO SIGN: no attestation, therefore no transaction. Without vLEI, the wrappers carry no
// identity policy (institution-node model): they check the list of required proofs, nothing else.
// vLEI active: the node's control BECOMES the vLEI verification. It first checks the counterparty (KYC_CP on the payer), then
// its client (vLEI presentation, linkage of wallet `adresse`, expected LEI); a refusal by the attester = no signature.
async function controleNoeudBeneficiaire(c, adresse, uetr) {
  if (c.vleiActif) {
    const p = await vleiPayeur(c, uetr);
    if (!p.signed) return { ok: false, reason: `beneficiary node: KYC_CP on the payer refused (${p.rapport.reasons.join(' ; ')}), attestation not signed`, vlei: p };
    const r = await vleiBeneficiaire(c, uetr, { wallet: adresse });
    if (!r.signed) return { ok: false, reason: `beneficiary node: vLEI verification refused for ${adresse} (${r.rapport.reasons.join(' ; ')}), attestation not signed`, vlei: r };
    return { ok: true, vlei: r };
  }
  const ids = new Contract(c.d.AtelierIds, IDS, c.arb); // the beneficiary FI's data (demo registry)
  const creds = new Contract(c.d.AtelierCreds, CREDS, c.arb);
  const ccid = await ids.getIdentity(adresse);
  if (ccid === '0x' + '00'.repeat(32)) return { ok: false, reason: `beneficiary node: ${adresse} is unknown to its FI (no identity), attestation not signed` };
  if (!(await creds.isValid(ccid, idOf('KYB')))) return { ok: false, reason: `beneficiary node: ${adresse} has no valid KYB credential, attestation not signed` };
  return { ok: true, ccid };
}
async function attArriveeControlee(c, uetr, vers, minOut, maxOut, ts, extra = []) {
  const ctl = await controleNoeudBeneficiaire(c, vers, uetr);
  if (!ctl.ok) throw Object.assign(new Error(ctl.reason), { refusNoeud: ctl.reason });
  return attArrivee(c, uetr, vers, minOut, maxOut, ts, extra, ctl.vlei ? ctl.vlei.proof : null);
}

function nouveauUetr() { return keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'string'], [Date.now(), 'corridor-fx'])).slice(0, 34); }

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function modeFonds(c) {
  const avant = await soldes(c);
  log(JSON.stringify(lisible(avant), null, 2));
  const besoinReserve = MONTANT * 2n; // one compliant pass (consumed) and one return pass (given back)
  const manque = besoinReserve > avant.arrival_reserve_EURX ? besoinReserve - avant.arrival_reserve_EURX : 0n;
  log(`arrival reserve at ${fmt(avant.arrival_reserve_EURX)} EURX, target ${fmt(besoinReserve)} : mint de ${fmt(manque)}`);
  log(`payer holdings: ${fmt(avant.payer_EURX)} plain EURX and ${fmt(avant.payer_wEURX)} wEURX; the pass wraps ${fmt(MONTANT)} itself`);
  const nuNecessaire = MONTANT * 2n;
  const manqueNu = nuNecessaire > avant.payer_EURX + avant.payer_wEURX ? nuNecessaire - avant.payer_EURX - avant.payer_wEURX : 0n;
  log(`plain EURX to mint for the payer (two passes): ${fmt(manqueNu)}`);
  if (!EXECUTE) return log('--dry : nothing is written');
  if (manque > 0n) await envoyer(c.deployerArb, 'arbitrum', { to: c.eurxArb.target, data: c.eurxArb.interface.encodeFunctionData('mint', [c.d.RECV_ADAPTER_EUR, manque]) }, { label: 'mint of the arrival reserve' });
  if (manqueNu > 0n) await envoyer(c.deployerSep, 'sepolia', { to: c.eurxSep.target, data: c.eurxSep.interface.encodeFunctionData('mint', [c.payer, manqueNu]) }, { label: 'mint of the payer EURX' });
  log(JSON.stringify(lisible(await soldes(c)), null, 2));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function attendre(fn, quoi, delaiMs = 25 * 60_000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    const r = await fn().catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 15_000));
  }
  throw new Error(`TIMEOUT EXCEEDED: ${quoi}`);
}

/** Searches the composer for the Delivered or Refused event of the guid, starting from a block. */
async function issueArrivee(c, guid, depuis) {
  const tete = await c.arb.getBlockNumber();
  const dl = await c.composer.queryFilter(c.composer.filters.Delivered(guid), depuis, tete);
  if (dl.length) return { issue: 'delivered', log: dl[0] };
  const rf = await c.composer.queryFilter(c.composer.filters.Refused(guid), depuis, tete);
  if (rf.length) return { issue: 'refused', log: rf[0] };
  return null;
}

/** Events of the arrival receipt, decoded with the known ABIs: the two steps of the atomic one. */
async function jambesArrivee(c, hash) {
  const recu = await c.arb.getTransactionReceipt(hash);
  const ifaces = [new Interface(WRAP), new Interface(POOL), new Interface(COMPOSER)];
  const evs = [];
  for (const l of recu.logs) {
    for (const i of ifaces) {
      try { const p = i.parseLog(l); if (p) { evs.push({ address: l.address, name: p.name, args: p.args.toArray().map((a) => (typeof a === 'bigint' ? a.toString() : a)) }); break; } } catch { /* autre ABI */ }
    }
  }
  return { hash, block: recu.blockNumber, status: recu.status, events: evs };
}

/** Wraps whatever is missing so the payer holds `montant` in wEURX: a refusal must be explained by the guard, never by an empty balance. */
async function assurerWrap(c, montant) {
  const wP = c.wSrc.connect(c.walletPayeur), eP = c.eurxSep.connect(c.walletPayeur);
  const a = await c.wSrc.balanceOf(c.payer);
  if (a >= montant) return null;
  const manque = montant - a;
  await envoyer(c.walletPayeur, 'sepolia', { to: eP.target, data: eP.interface.encodeFunctionData('approve', [c.wSrc.target, manque]) }, { label: 'approve du wrap' });
  return envoyer(c.walletPayeur, 'sepolia', { to: wP.target, data: wP.interface.encodeFunctionData('depositFor', [c.payer, manque]) }, { label: 'depositFor (wrap)', gasLimit: 1_500_000n });
}

/** The compliant pass. `partiePayeur`: the payer's vLEI record (the agent under mandate for mode `agent`); `fichier`: the result. */
async function modeConforme(c, { partiePayeur = c.vleiPartiePayeur, fichier = 'live-result.json', pass: passe = 'compliant' } = {}) {
  const { route, output: sortie, direct, pivot } = await choisirRoute(c, MONTANT);
  const ref = c.tr.reference_fx.sgd_per_eur;
  const taux = Number(sortie) / Number(MONTANT);
  const ecartBps = (taux / ref - 1) * 1e4;
  const minOut = sortie - sortie / 100n, maxOut = sortie; // floor -1 %, ceiling = quote
  log(`route ${route} (direct ${fmt(direct)}, pivot ${fmt(pivot)}) ; expected output ${fmt(sortie)} SGDX ; rate ${taux.toFixed(6)} ; gap to the reference ${ecartBps.toFixed(2)} bps ; plancher ${fmt(minOut)}`);
  // vLEI: the two KYC_CP controls BEFORE the wrap; a refusal moves nothing, not even the payer's EURX (read-only in --dry too)
  let kyc = null, uetrVlei = null;
  if (c.vleiActif) {
    uetrVlei = nouveauUetr();
    kyc = await kycCp(c, { uetr: uetrVlei, minOut, maxOut, partiePayeur });
    afficherKyc(kyc);
    if (!kyc.ok) throw new Error(`${kyc.reason} ; no transaction`);
  }
  const avant = await soldes(c);
  log(JSON.stringify(lisible(avant), null, 2));
  if (!EXECUTE) return log('--dry : nothing is written');

  const res = { schema: 2, pass: passe, amount_eur: fmt(MONTANT), route, direct_quote: fmt(direct), pivot_quote: fmt(pivot), expected_applied_rate: taux, reference_sgd_per_eur: ref, gap_to_reference_bps: Number(ecartBps.toFixed(2)), min_out: fmt(minOut), balances_before: lisible(avant), legs: [] };
  const jambe = (nom, chaine, recu, extra = {}) => res.legs.push({ leg: nom, chain: chaine, tx: recu.hash, block: recu.blockNumber, status: recu.status === 1 ? 'ok' : 'echec', ...extra });

  // 1. wrap: payer's approve then depositFor (a leg of the pass, no more hidden wrap)
  const eurxP = c.eurxSep.connect(c.walletPayeur), wP = c.wSrc.connect(c.walletPayeur);
  const wrapAvant = await c.wSrc.balanceOf(c.payer);
  if (process.env.PC_SKIP_WRAP) log('PC_SKIP_WRAP: wrap skipped (diagnostic only)');
  else await envoyer(c.walletPayeur, 'sepolia', { to: eurxP.target, data: eurxP.interface.encodeFunctionData('approve', [c.wSrc.target, MONTANT]) }, { label: 'approve du wrap' });
  const rWrap = process.env.PC_SKIP_WRAP ? { hash: '0x', blockNumber: 0, status: 1 } : await envoyer(c.walletPayeur, 'sepolia', { to: wP.target, data: wP.interface.encodeFunctionData('depositFor', [c.payer, MONTANT]) }, { label: 'depositFor (wrap)', gasLimit: 1_500_000n });
  jambe('wrap', 'sepolia', rWrap, { wEURX_before: fmt(wrapAvant), wEURX_after: fmt(await c.wSrc.balanceOf(c.payer)) });

  // 2. attestations and payload (with vLEI, the uetr is the one of the already-signed KYC_CP attestations)
  const uetr = uetrVlei || nouveauUetr();
  const ts = Math.floor(Date.now() / 1000) - 5;
  // Sanctions proofs: ONE per screenable party of each leg, produced before the send. Source: the payer (the `to` is
  // the adapter, a conduit). Arrival: the beneficiary (the `from` is the composer, a conduit).
  let zkSrc = [], zkDst = [];
  if (avecSanctions(c)) {
    const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
    const pD = prouverPartie(c, { wrapper: c.wSgd.target, chainid: c.tr.destination.chainId, uetr, from: c.composer.target, to: c.benef, id: c.benef, party: 'to', min: minOut, max: maxOut });
    const listee = [pS, pD].find((x) => x.code === 3);
    if (listee) throw new Error(`sanctions: a party is on the list, no proof exists: ${listee.message}`);
    zkSrc = [pS.item]; zkDst = [pD.item];
  }
  const srcAtt = await attSource(c, uetr, c.payer, c.adapter.target, MONTANT, ts, zkSrc, kyc ? kyc.payer.proof : null);
  // vLEI: the FI SG1 node already checked the counterparty and its client (kycCp); it now signs its arrival attestation
  const dstAtt = kyc
    ? await attArrivee(c, uetr, c.benef, minOut, maxOut, ts, zkDst, kyc.beneficiary.proof)
    : await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts, zkDst);
  const composeMsg = route === 0
    ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt)
    : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);

  // 3. client pre-check (eth_call of runFor on each chain), then conditioned send: lock's approve, deposit of the
  // context, send (gated transfer, lock)
  if (avecSanctions(c)) {
    const aSrc = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
    const aDst = await precontroleZk(c, 'arbitrum', { subject: c.wSgd.target, from: c.composer.target, to: c.benef, montant: maxOut, contexte: dstAtt });
    log(`sanctions precheck: source ${aSrc.ok ? 'Continue' : aSrc.reason} ; arrival ${aDst.ok ? 'Continue' : aDst.reason}`);
    if (!aSrc.ok || !aDst.ok) throw new Error(`sanctions precheck refused: ${aSrc.reason || ''} ${aDst.reason || ''}`);
    res.sanctions = {
      source_policy: c.s.AtelierZkSanctionsWrapperPolicy, arrival_policy: c.d.AtelierZkSanctionsWrapperPolicy, circuit: 'sanctions-non-membership-v1',
      list: 'SAN01 demo-sanctions-v1 (public demonstration list)', setup: 'demonstration ceremony',
      screened_parties: { source: ['payeur'], arrival: ['beneficiaire'] }, conduits: 'source adapter, return receiver, composer',
      client_precheck: { source: 'Continue', arrival: 'Continue' }, verified_by: 'each chain\'s Policy Wrapper, at its gated transfer',
    };
  }
  if (kyc) {
    // pre-check vLEI on the REAL contexts (sanctions proofs included), just before the send
    const [vS, vD] = await Promise.all([
      precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt }),
      precontroleVlei(c, 'arbitrum', { subject: c.wSgd.target, from: c.composer.target, to: c.benef, montant: maxOut, contexte: dstAtt }),
    ]);
    log(`vLEI precheck (real contexts): source ${etatPre(vS)} ; arrival ${etatPre(vD)}`);
    if (!vS.ok || !vD.ok) throw new Error(`vLEI precheck refused: source ${etatPre(vS)} ; arrival ${etatPre(vD)}`);
    res.vlei = vleiResume(c, kyc, {
      client_precheck: { kyc_cp: kyc.precontrole, real_contexts: { source: etatPre(vS), arrival: etatPre(vD) } },
      reliance: { source: [], arrival: [] }, verified_by: 'VleiAttestationPolicy, at the end of each chain\'s Policy Wrapper list, at its gated transfer',
    });
  }
  const p = param(c, composeMsg, MONTANT);
  const optionsGaz = process.env.PC_LZ_OPTIONS || '0x';
  p.extraOptions = optionsGaz;
  let frais;
  try {
    frais = await c.adapter.connect(c.walletPayeur).quoteSend.staticCall(p, false, { gasLimit: 30_000_000n }); // called by the payer: the guard reads msg.sender
  } catch (e) {
    if (process.env.PC_DEBUG_CALLDATA && e.transaction) writeFileSync(process.env.PC_DEBUG_CALLDATA, JSON.stringify({ from: c.payer, to: c.adapter.target, data: e.transaction.data }));
    throw e;
  }
  log(`native LayerZero fees: ${fmt(frais.nativeFee)} ETH`);
  await envoyer(c.walletPayeur, 'sepolia', { to: c.wSrc.target, data: c.wSrc.interface.encodeFunctionData('approve', [c.adapter.target, MONTANT]) }, { label: 'adapter approve' });
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', [srcAtt]), gasLimit: 9_000_000n }, { label: 'depot de l\'attestation source', gasLimit: 9_000_000n });
  const rSend = await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('send', [p, [frais.nativeFee, 0n], c.payer]), value: frais.nativeFee, gasLimit: GAZ_SEND }, { label: 'conditional send', gasLimit: GAZ_SEND });
  const sent = rSend.logs.map((l) => { try { return c.adapter.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'OFTSent');
  const guid = sent.args.guid;
  const wSrcI = new Interface(WRAP);
  const evSrc = rSend.logs.map((l) => { try { const x = wSrcI.parseLog(l); return x && { name: x.name, args: x.args.toArray().map(String) }; } catch { return null; } }).filter(Boolean);
  jambe('transfer-source', 'sepolia', rSend, { note: 'transferFrom payer to adapter, gated by the source leg\'s Policy Manager (identity, attestation, linkage)', events: evSrc.filter((e) => e.name === 'Transfer') });
  jambe('lock', 'sepolia', rSend, { note: 'adapter\'s withdrawTo : the wEURX is burned, the EURX stays locked with the adapter', events: evSrc.filter((e) => e.name === 'TokenUnwrap'), lock_after: fmt(await c.eurxSep.balanceOf(c.adapter.target)) });
  res.guid = guid; res.uetr = uetr;
  if (kyc) res.vlei.reliance.source = relianceVlei(rSend, c.s.VleiAttestationPolicy, 'sepolia', kyc.payer.rapport);
  const blocDepart = await c.arb.getBlockNumber();
  log(`sent, guid ${guid}. Waiting for the LayerZero delivery to Arbitrum...`);

  // 4. arrival: the composer exchanges then delivers, in a single atomic transaction
  const arrivee = await attendre(() => issueArrivee(c, guid, blocDepart - 200), `delivery of the guid ${guid}`);
  const tx = arrivee.log.transactionHash;
  const ja = await jambesArrivee(c, tx);
  res.issue = arrivee.issue;
  if (kyc) res.vlei.reliance.arrival = relianceVlei(await c.arb.getTransactionReceipt(tx), c.d.VleiAttestationPolicy, 'arbitrum-sepolia', kyc.beneficiary.rapport);
  const nomme = (noms) => ja.events.filter((e) => noms.includes(e.name));
  res.legs.push({ leg: 'swap', stage: 1, chain: 'arbitrum-sepolia', tx, block: ja.block, status: 'ok', note: 'first step : unwrapping the wEURX, EURX to the pool, SGDX returned to the composer (market, no control)', events: ja.events.filter((e) => ['Transfer', 'TokenUnwrap', 'Swap'].includes(e.name) && !(e.name === 'Transfer' && e.address.toLowerCase() === c.wSgd.target.toLowerCase())) });
  res.legs.push({ leg: 'deliver', stage: 2, chain: 'arbitrum-sepolia', tx, block: ja.block, status: arrivee.issue === 'delivered' ? 'ok' : 'refused', note: 'second step : wrapping the SGDX then transferring the wSGDX to the beneficiary under the controls ; same transaction, therefore atomic', events: [...nomme(['TokenWrap']), ...ja.events.filter((e) => e.name === 'Transfer' && e.address.toLowerCase() === c.wSgd.target.toLowerCase())] });
  res.arrival = ja;
  if (arrivee.issue !== 'delivered') { res.raison_refus = raison(await c.composer.lastRefusal()); log(`ARRIVAL REFUSED: ${res.raison_refus}`); }

  // 5. unwrap: the beneficiary returns the wSGDX for SGDX
  if (arrivee.issue === 'delivered') {
    const livre = await c.wSgd.balanceOf(c.benef);
    res.delivered_wSGDX = fmt(livre);
    const sgdAvant = await c.sgdx.balanceOf(c.benef);
    const wB = c.wSgd.connect(c.walletBenef);
    const rUn = await envoyer(c.walletBenef, 'arbitrum', { to: wB.target, data: wB.interface.encodeFunctionData('withdrawTo', [c.benef, livre]) }, { label: 'withdrawTo (unwrap)', gasLimit: 1_500_000n });
    jambe('unwrap', 'arbitrum-sepolia', rUn, { wSGDX_before: fmt(livre), wSGDX_after: fmt(await c.wSgd.balanceOf(c.benef)), SGDX_before: fmt(sgdAvant), SGDX_after: fmt(await c.sgdx.balanceOf(c.benef)) });
    res.measured_applied_rate = Number(livre) / Number(MONTANT);
    res.measured_gap_to_reference_bps = Number(((res.measured_applied_rate / ref - 1) * 1e4).toFixed(2));
  }
  res.balances_after = lisible(await soldes(c));
  res.measured_at = new Date().toISOString();
  writeFileSync(join(here, fichier), JSON.stringify(res, null, 2) + '\n');
  log(`written ${fichier} (issue : ${res.issue})`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function modeRefus(c) {
  // Beneficiary without credential: BANK_SG2, never registered. Two trials, no funds must move:
  // (1) its node refuses to SIGN the attestation: no attestation exists, therefore no transaction;
  // (2) a third party tries to send using ANOTHER beneficiary's (valid) attestation: the pre-transaction guard refuses it.
  // vLEI active: trial (1) is the node's vLEI verification (BANK_SG2 is linked to no credential); trial (2)
  // carries the payer's VALID vLEI proof and BANK_SG1's valid one: only the diversion to `inconnu` can cause a refusal.
  const inconnu = process.env.BANK_SG2_ADDRESS;
  if (!inconnu) throw new Error('BANK_SG2_ADDRESS not found (read by name)');
  const uetr = nouveauUetr();
  const noeud = await controleNoeudBeneficiaire(c, inconnu, uetr);
  log(`off-chain check by the beneficiary node: ${noeud.ok ? 'passes (unexpected)' : noeud.reason}`);
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const ts = Math.floor(Date.now() / 1000) - 5;
  // The PAYEUR's sanctions proof is valid: the debit passes the source wrapper's policy, only the missing attestation of the
  // beneficiary can then make the send fail (the pre-transaction guard refuses it). Without that, the refusal would be that of a missing
  // sanctions proof, not the one being tested.
  let zkSrc = [];
  if (avecSanctions(c)) {
    const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
    if (pS.code === 3) throw new Error('sanctions: the payer is on the list');
    zkSrc = [pS.item];
  }
  const srcAtt = await attSourceControlee(c, uetr, MONTANT, ts, zkSrc);
  const vleiSg1 = c.vleiActif ? await vleiBeneficiaire(c, uetr) : null;
  if (vleiSg1 && !vleiSg1.signed) throw new Error(`vLEI of BANK_SG1 refused: ${vleiSg1.rapport.reasons.join(' ; ')}; test 2 would no longer be the guard's`);
  const dstAtt = await attArrivee(c, uetr, c.benef, minOut, maxOut, ts, [], vleiSg1 ? vleiSg1.proof : null); // signed for BANK_SG1, presented for `inconnu`
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(inconnu, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(inconnu, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`prior wrap ${rw.hash}: the payer holds ${fmt(MONTANT)} wEURX, so a refusal cannot be explained by an empty balance`); }
  const avant = await soldes(c);
  log(JSON.stringify(lisible(avant), null, 2));
  let raisonQuote;
  try { await c.adapter.connect(c.walletPayeur).quoteSend.staticCall(p, false, { gasLimit: 30_000_000n }); raisonQuote = 'NO REFUSAL (unexpected)'; } catch (e) { raisonQuote = raison(e.data); }
  log(`quoteSend : ${raisonQuote}`);
  if (!EXECUTE) return log('--dry : nothing is written');

  // Forced send: explicit gas, so the transaction is sent and reverts; the receipt is the evidence.
  const res = { schema: 2, pass: 'refusal-at-source', amount_eur: fmt(MONTANT), beneficiary_without_credential: inconnu,
    beneficiary_node: { signed: noeud.ok, reason: noeud.ok ? null : noeud.reason, submitted_transaction: false },
    test_2_attestation_of_another_beneficiary: { quoteSend_reason: raisonQuote }, balances_before: lisible(avant), legs: [] };
  if (c.vleiActif) {
    res.vlei = vleiResume(c, null, { refus_du_noeud_pour_l_inconnu: noeud.vlei ? noeud.vlei.rapport : null });
    res.vlei.kyc_cp.by_fi_fr_on_fi_sg1 = vleiSg1 ? entreeKyc(vleiSg1, `${CTL_FR_SUR_SG1} ; attestation de BANK_SG1, presentee pour ${inconnu}`) : null;
  }
  await envoyer(c.walletPayeur, 'sepolia', { to: c.wSrc.target, data: c.wSrc.interface.encodeFunctionData('approve', [c.adapter.target, MONTANT]) }, { label: 'adapter approve' });
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', [srcAtt]), gasLimit: 9_000_000n }, { label: 'depot de l\'attestation source', gasLimit: 9_000_000n });
  const fraisForce = 20_000_000_000_000_000n; // 0.02 ETH: the revert happens before any payment
  let tx, statut = 'inconnu';
  try {
    await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('send', [p, [fraisForce, 0n], c.payer]), value: fraisForce, gasLimit: GAZ_SEND }, { label: 'send with another beneficiary attestation', gasLimit: GAZ_SEND });
    statut = 'PASSES (unexpected)';
  } catch (e) {
    const m = String(e.message).match(/transaction (0x[0-9a-fA-F]{64}) REVERTED/);
    tx = m && m[1]; statut = m ? 'reverted' : `error: ${e.message.slice(0, 160)}`;
  }
  res.legs.push({ leg: 'send-refuse', chain: 'sepolia', tx, status: statut, note: 'another beneficiary\'s attestation : refused by the pre-transaction guard (binding to the party), before any lock' });
  // the deposited context is consumed only by a debit: removing it by redepositing an empty one
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', ['0x']), gasLimit: 9_000_000n }, { label: 'removal of the deposited context', gasLimit: 9_000_000n });
  const apres = await soldes(c);
  const memes = ['payer_wEURX', 'adapter_lock_EURX', 'supply_wEURX_source', 'arrival_reserve_EURX', 'pool_EURX', 'pool_SGDX', 'composer_wEURX'].every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-refusal.json'), JSON.stringify(res, null, 2) + '\n');
  log(`no funds moved: ${memes} ; written live-result-refusal.json`);
  if (!memes) process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function modeRetour(c) {
  // Residual case: the beneficiary's node attestation is valid, then its KEY is revoked at the arrival seal before
  // delivery. Arrival refuses, the key is RESTORED (rotation: the return is also gated by this seal), the funds are returned.
  const sealArr = new Contract(c.d.TestSeal, ['function revokeKey(bytes32,address)', 'function registerKey(bytes32,address)', 'function isKeyActive(bytes32,address) view returns (bool)'], c.arb);
  const cleNoeud = c.noeud.address;
  // PC_RETURN_CAUSE=sanctions-beneficiaire: no key revocation; the sanctions proof of the arrival leg is made for an identifier OTHER
  // than the beneficiary (a listed beneficiary obtains no proof), arrival refuses, the funds come back.
  const SANC = process.env.PC_RETURN_CAUSE === 'sanctions-beneficiaire';
  const AUTRE_ID = '0x00000000000000000000000000000000000b0b0b';
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  // vLEI: the return credit (return receiver to payer) passes the source wrapper WITHOUT a vLEI proof, which is possible only
  // if the receiver is declared a conduit of the policy (read on chain, before any action). Then the two KYC_CP checks, before the wrap.
  let kyc = null, uetrVlei = null;
  if (c.vleiActif) {
    const conduit = await c.vleiSrc.isConduit(c.wSrc.target, c.s.RETURN_RECEIVER);
    log(`return receiver ${c.s.RETURN_RECEIVER} conduit de la politique vLEI source : ${conduit}`);
    if (!conduit) throw new Error('return receiver not declared as a conduit of the source vLEI policy: the return credit would be refused, nothing is sent');
    uetrVlei = nouveauUetr();
    kyc = await kycCp(c, { uetr: uetrVlei, minOut, maxOut });
    afficherKyc(kyc);
    if (!kyc.ok) throw new Error(`${kyc.reason} ; no transaction`);
  }
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  log(JSON.stringify(lisible(avant), null, 2));
  if (!EXECUTE) return log('--dry : nothing is written');
  const res = { schema: 2, pass: 'return-residual', amount_eur: fmt(MONTANT), balances_before: lisible(avant), legs: [] };
  const revoquer = () => envoyer(c.deployerArb, 'arbitrum', { to: sealArr.target, data: sealArr.interface.encodeFunctionData('revokeKey', [ORG, cleNoeud]) }, { label: 'revocation of the node key at the arrival seal' });
  const restaurer = () => envoyer(c.deployerArb, 'arbitrum', { to: sealArr.target, data: sealArr.interface.encodeFunctionData('registerKey', [ORG, cleNoeud]) }, { label: 'restoration of the node key' });
  let cleRevoquee = false;
  try {
    const uetr = uetrVlei || nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
    let zkSrc = [], zkDst = [];
    if (avecSanctions(c)) {
      const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
      const pD = prouverPartie(c, { wrapper: c.wSgd.target, chainid: c.tr.destination.chainId, uetr, from: c.composer.target, to: c.benef, id: SANC ? AUTRE_ID : c.benef, party: 'to', min: minOut, max: maxOut });
      if (pS.code === 3 || pD.code === 3) throw new Error('sanctions: a party is on the list');
      zkSrc = [pS.item]; zkDst = [pD.item];
    }
    const srcAtt = await attSource(c, uetr, c.payer, c.adapter.target, MONTANT, ts, zkSrc, kyc ? kyc.payer.proof : null);
    // the beneficiary's node verifies its client and SIGNS (the control passes); only afterwards is the key revoked at arrival.
    // With vLEI, the arrival attestation carries the beneficiary's proof: the refusal at arrival remains the revoked key's.
    const dstAtt = kyc
      ? await attArrivee(c, uetr, c.benef, minOut, maxOut, ts, zkDst, kyc.beneficiary.proof)
      : await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts, zkDst);
    const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
    const p = param(c, composeMsg, MONTANT);
    const rRev = SANC ? null : await revoquer();
    cleRevoquee = !SANC;
    if (!SANC) res.legs.push({ leg: 'key-revocation-at-arrival', chain: 'arbitrum-sepolia', tx: rRev.hash, status: 'ok', note: 'the node key is revoked at the arrival seal AFTER signing the attestation, before delivery : the residual case (key-revocation propagation window)' });
    const frais = await c.adapter.connect(c.walletPayeur).quoteSend.staticCall(p, false, { gasLimit: 30_000_000n });
    await envoyer(c.walletPayeur, 'sepolia', { to: c.wSrc.target, data: c.wSrc.interface.encodeFunctionData('approve', [c.adapter.target, MONTANT]) }, { label: 'adapter approve' });
    await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', [srcAtt]), gasLimit: 9_000_000n }, { label: 'depot de l\'attestation source', gasLimit: 9_000_000n });
    const rSend = await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('send', [p, [frais.nativeFee, 0n], c.payer]), value: frais.nativeFee, gasLimit: GAZ_SEND }, { label: 'send', gasLimit: GAZ_SEND });
    const guid = rSend.logs.map((l) => { try { return c.adapter.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'OFTSent').args.guid;
    res.legs.push({ leg: 'lock', chain: 'sepolia', tx: rSend.hash, status: 'ok', lock_after: fmt(await c.eurxSep.balanceOf(c.adapter.target)) });
    if (kyc) {
      res.vlei = vleiResume(c, kyc, {
        client_precheck: { kyc_cp: kyc.precontrole }, conduit_recepteur_de_retour: c.s.RETURN_RECEIVER,
        reliance: { source: relianceVlei(rSend, c.s.VleiAttestationPolicy, 'sepolia', kyc.payer.rapport), arrival: [] },
        note: 'arrival refused by a policy placed before the vLEI policy: no reliance at arrival; the return credit goes through the receiver, a conduit, without vLEI proof',
      });
    }
    const depuis = (await c.arb.getBlockNumber()) - 200;
    const arrivee = await attendre(() => issueArrivee(c, guid, depuis), `arrival of the guid ${guid}`);
    if (arrivee.issue !== 'refused') throw new Error('the arrival did not refuse: the residual case is not reproduced');
    res.legs.push({ leg: 'refused', chain: 'arbitrum-sepolia', tx: arrivee.log.transactionHash, status: 'refused', reason: raison(await c.composer.lastRefusal()), wEURX_in_transit_at_the_composer: fmt(await c.wEurArb.balanceOf(c.composer.target)) });
    res.guid = guid;
    const rRest = SANC ? null : await restaurer(); // rotation: the return is also gated by the same seal
    cleRevoquee = false;
    if (!SANC) res.legs.push({ leg: 'key-restoration', chain: 'arbitrum-sepolia', tx: rRest.hash, status: 'ok' });
    // return of the funds: attestation of the debit (composer to arrival adapter, on the arrival wEURX) and of the credit (receiver to payer)
    const tsR = Math.floor(Date.now() / 1000) - 5;
    const debit = await attRetourDebit(c, uetr, tsR);
    let zkCredit = [];
    if (avecSanctions(c)) {
      // leg of the return to the source: from = receiver (conduit), to = payer: the payer is the screened party
      const pC = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.s.RETURN_RECEIVER, to: c.payer, id: c.payer, party: 'to', montant: MONTANT });
      if (pC.code === 3) throw new Error('sanctions: the payer is on the list');
      zkCredit = [pC.item];
    }
    const credit = await attRetourCredit(c, uetr, tsR, zkCredit);
    const { newOptions } = { newOptions: null };
    void newOptions;
    const options = optionsRetour();
    const args = { debitAttestation: debit, creditAttestation: credit, extraOptions: options };
    const fraisR = await c.composer.quoteReturn(guid, args);
    // callable by the original payer or the composer's operator (the deployer); the payer has no ETH on Arbitrum
    const cP = c.composer.connect(c.deployerArb);
    const rRet = await envoyer(c.deployerArb, 'arbitrum', { to: cP.target, data: cP.interface.encodeFunctionData('returnToSource', [guid, args]), value: fraisR, gasLimit: 3_000_000n }, { label: 'returnToSource', gasLimit: 3_000_000n });
    res.legs.push({ leg: 'return-start', chain: 'arbitrum-sepolia', tx: rRet.hash, status: 'ok', layerzero_fees: fmt(fraisR) });
    // The payer must get back EXACTLY its pre-send balance (`avant`, taken after the preliminary wrap). An "at least
    // MONTANT" condition would be true from the start when the payer already holds other wEURX: defect seen on 2026-10-18.
    const cible = avant.payer_wEURX;
    const retourne = await attendre(async () => { const b = await c.wSrc.balanceOf(c.payer); return b === cible ? b : null; }, 'return of the wEURX to the payer');
    const tete = await c.sep.getBlockNumber();
    const evR = await c.wSrc.queryFilter(c.wSrc.filters.Transfer(c.s.RETURN_RECEIVER, c.payer), tete - 300, tete);
    const dernier = evR[evR.length - 1];
    res.legs.push({ leg: 'return-delivered', chain: 'sepolia', tx: dernier && dernier.transactionHash, block: dernier && dernier.blockNumber, status: 'ok', payer_wEURX_after: fmt(retourne), lock_after: fmt(await c.eurxSep.balanceOf(c.adapter.target)) });
  } finally {
    if (cleRevoquee) { const rOk = await restaurer(); res.legs.push({ leg: 'key-restoration', chain: 'arbitrum-sepolia', tx: rOk.hash, status: 'ok' }); }
  }
  res.balances_after = lisible(await soldes(c)); res.measured_at = new Date().toISOString();
  writeFileSync(join(here, SANC ? 'live-result-return-sanctions-beneficiary.json' : 'live-result-return.json'), JSON.stringify(res, null, 2) + '\n');
  log(`written ${SANC ? 'live-result-return-sanctions-beneficiary.json' : 'live-result-return.json'}`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function modeRefusSanctions(c) {
  if (!avecSanctions(c)) throw new Error('wrapper sanctions policy absent from the tracker');
  const LISTE = '0x7e57000000000000000000000000000000005a11'; // demonstration list identifier (address)
  const autre = '0x00000000000000000000000000000000000b0b0b'; // clean address: valid proof, but for ANOTHER identifier
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const res = { schema: 3, pass: 'refusal-sanctions', amount_eur: fmt(MONTANT), legs: [], list: 'SAN01 demo-sanctions-v1 (public demonstration list)' };
  const base = { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, party: 'from', montant: MONTANT };
  // (1) a listed party obtains NO proof: refusal before any transaction (code 3, no file)
  const dedans = prouverPartie(c, { ...base, id: LISTE });
  res.listed_party = { id: LISTE, prover_exit_code: dedans.code, proof_produced: dedans.code === 0, message: dedans.message || null };
  log(`listed party: prover code ${dedans.code} ; ${dedans.message || ''}`);
  // (2) a VALID proof made for an identifier other than the payer is refused by the source wrapper (binding to the `from`)
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const fausse = prouverPartie(c, { ...base, id: autre });
  if (fausse.code !== 0) throw new Error('the proof for the clean identifier should exist');
  const srcAtt = await attSourceControlee(c, uetr, MONTANT, ts, [fausse.item]);
  const dstAtt = await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts);
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  const pre = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
  log(`client precheck (runFor, source): ${pre.ok ? 'Continue (unexpected)' : pre.reason}`);
  if (!EXECUTE) return log('--dry : nothing is written');
  res.balances_before = lisible(avant); res.client_precheck = pre;
  await envoyer(c.walletPayeur, 'sepolia', { to: c.wSrc.target, data: c.wSrc.interface.encodeFunctionData('approve', [c.adapter.target, MONTANT]) }, { label: 'adapter approve' });
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', [srcAtt]), gasLimit: 9_000_000n }, { label: 'depot de l\'attestation source', gasLimit: 9_000_000n });
  const fraisForce = 20_000_000_000_000_000n;
  let tx, statut = 'inconnu';
  try {
    await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('send', [p, [fraisForce, 0n], c.payer]), value: fraisForce, gasLimit: 12_000_000n }, { label: 'send with a sanctions proof bound to another identifier', gasLimit: 12_000_000n });
    statut = 'PASSES (unexpected)';
  } catch (e) { const m = String(e.message).match(/transaction (0x[0-9a-fA-F]{64}) REVERTED/); tx = m && m[1]; statut = m ? 'reverted' : `error: ${e.message.slice(0, 160)}`; }
  res.legs.push({ leg: 'send-refuse', chain: 'sepolia', tx, status: statut, note: 'non-membership proof made for an identifier other than the payer\'s : refused by the source Policy Wrapper at the gated transfer, before any lock' });
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', ['0x']), gasLimit: 9_000_000n }, { label: 'removal of the deposited context', gasLimit: 9_000_000n });
  const apres = await soldes(c);
  const memes = ['payer_wEURX', 'adapter_lock_EURX', 'supply_wEURX_source', 'arrival_reserve_EURX', 'pool_EURX', 'pool_SGDX', 'composer_wEURX'].every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-sanctions-refusal.json'), JSON.stringify(res, null, 2) + '\n');
  log(`no funds moved: ${memes} ; written live-result-sanctions-refusal.json`);
  if (!memes) process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A FORCED send (explicit gas) that must come back as an error: returns the hash, the gas consumed and the status. The balances before and after are
 *  compared by the caller. The deposited context is then removed. */
async function envoiForce(c, { srcAtt, p, label: libelle }) {
  await envoyer(c.walletPayeur, 'sepolia', { to: c.wSrc.target, data: c.wSrc.interface.encodeFunctionData('approve', [c.adapter.target, MONTANT]) }, { label: 'adapter approve' });
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', [srcAtt]), gasLimit: 9_000_000n }, { label: 'depot de l\'attestation source', gasLimit: 9_000_000n });
  const fraisForce = 20_000_000_000_000_000n;
  let tx, statut = 'inconnu', gaz = null;
  try {
    await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('send', [p, [fraisForce, 0n], c.payer]), value: fraisForce, gasLimit: 12_000_000n }, { label: libelle, gasLimit: 12_000_000n });
    statut = 'PASSES (unexpected)';
  } catch (e) {
    const m = String(e.message).match(/transaction (0x[0-9a-fA-F]{64}) REVERTED/);
    tx = m && m[1]; statut = m ? 'reverted' : `error: ${e.message.slice(0, 160)}`;
    if (tx) { const r = await c.sep.getTransactionReceipt(tx); gaz = r ? r.gasUsed.toString() : null; }
  }
  await envoyer(c.walletPayeur, 'sepolia', { to: c.adapter.target, data: c.adapter.interface.encodeFunctionData('stageContext', ['0x']), gasLimit: 9_000_000n }, { label: 'removal of the deposited context', gasLimit: 9_000_000n });
  return { tx, status: statut, gas_used: gaz };
}
const SOLDES_CLES = ['payer_wEURX', 'adapter_lock_EURX', 'supply_wEURX_source', 'arrival_reserve_EURX', 'pool_EURX', 'pool_SGDX', 'composer_wEURX'];

/** FALSIFIED BY ONE BIT proof: one word of the payer's proof (the item's r word) is altered, the send is real. */
async function modeRefusBit(c) {
  if (!avecSanctions(c)) throw new Error('wrapper sanctions policy absent from the tracker');
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const bon = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
  if (bon.code !== 0) throw new Error('the payer should have a proof');
  const faux = bon.item.slice();
  const avantMot = faux[3];
  faux[3] = toBeHex(BigInt(avantMot) ^ 1n, 32); // one bit of the r word
  const srcAtt = await attSourceControlee(c, uetr, MONTANT, ts, [faux]);
  const dstAtt = await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts);
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  const pre = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
  log(`client precheck (runFor): ${pre.ok ? 'Continue (unexpected)' : pre.reason}`);
  if (!EXECUTE) return log('--dry : nothing is written');
  const res = { schema: 3, pass: 'refusal-proof-forged-by-one-bit', amount_eur: fmt(MONTANT), uetr,
    tampering: { word: 'r of the payer\'s proof item', before: avantMot, after: faux[3], flipped_bit: 'the least significant bit' }, client_precheck: pre, balances_before: lisible(avant), legs: [] };
  const env = await envoiForce(c, { srcAtt, p, label: 'send with a proof forged by one bit' });
  res.legs.push({ leg: 'send-refuse', chain: 'sepolia', ...env, note: 'payer\'s proof altered by one bit : refused at the source wrapper\'s gated transfer, before any lock' });
  const apres = await soldes(c);
  const memes = SOLDES_CLES.every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-refusal-proof-forged.json'), JSON.stringify(res, null, 2) + '\n');
  log(`gas used by the refusal: ${env.gas_used}; no funds moved: ${memes}; written live-result-refusal-proof-forged.json`);
  if (!memes) process.exit(1);
}

/** REPLAY: same uetr, same parties, same amount as the compliant pass (live-result.json), attestations and proofs regenerated for this binding. */
async function modeRejeu(c) {
  const conforme = JSON.parse(readFileSync(join(here, 'live-result.json'), 'utf8'));
  const uetr = conforme.uetr;
  if (!uetr || conforme.issue !== 'delivered') throw new Error('live-result.json does not carry a compliant delivered pass with its uetr');
  if (fmt(MONTANT) !== conforme.amount_eur) throw new Error(`the amount (${fmt(MONTANT)}) differs from the compliant pass (${conforme.amount_eur})`);
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const ts = Math.floor(Date.now() / 1000) - 5;
  const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
  if (pS.code !== 0) throw new Error('the payer should have a proof');
  const srcAtt = await attSourceControlee(c, uetr, MONTANT, ts, [pS.item]);
  const dstAtt = await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts);
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  const pre = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
  log(`client precheck (runFor of the ZK policy): ${pre.ok ? 'Continue' : pre.reason}`);
  if (!EXECUTE) return log('--dry : nothing is written');
  const res = { schema: 3, pass: 'replay-of-the-compliant-pass', amount_eur: fmt(MONTANT), uetr, replayed_pass: { measured_at: conforme.measured_at, guid: conforme.guid, transfer_source: (conforme.legs.find((j) => j.leg === 'transfer-source') || {}).tx },
    client_zk_policy_precheck: pre, balances_before: lisible(avant), legs: [] };
  const env = await envoiForce(c, { srcAtt, p, label: 'replayed send (same uetr)' });
  res.legs.push({ leg: 'send-refuse', chain: 'sepolia', ...env, note: 'same uetr, same parties, same amount : see refuse_par for the policy that refuses, read in the trace' });
  const apres = await soldes(c);
  const memes = SOLDES_CLES.every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-replay.json'), JSON.stringify(res, null, 2) + '\n');
  log(`gas used by the refusal: ${env.gas_used}; no funds moved: ${memes}; written live-result-replay.json`);
  if (!memes) process.exit(1);
}

/** KEY REVOKED AT THE SOURCE (2026-10-20): the node's attestation is signed and valid, then its key is revoked at the SOURCE seal before
 *  the send. The source wrapper's gated transfer must refuse, before any lock. The key is ALWAYS restored (finally), because the source
 *  seal also serves the following passes. */
async function modeRefusCleSource(c) {
  if (!avecSanctions(c)) throw new Error('wrapper sanctions policy absent from the tracker');
  const sealSrcAdm = new Contract(c.s.TestSeal, ['function revokeKey(bytes32,address)', 'function registerKey(bytes32,address)', 'function isKeyActive(bytes32,address) view returns (bool)'], c.sep);
  const cleNoeud = c.noeud.address;
  if (!(await sealSrcAdm.isKeyActive(ORG, cleNoeud))) throw new Error('the node key is already inactive at the source seal: nothing to prove, abnormal starting state');
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
  if (pS.code !== 0) throw new Error('the payer should have a proof');
  const srcAtt = await attSourceControlee(c, uetr, MONTANT, ts, [pS.item]);
  const dstAtt = await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts);
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  const preAvant = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
  log(`precheck BEFORE revocation (control: must pass): ${preAvant.ok ? 'Continue' : preAvant.reason}`);
  if (!EXECUTE) return log('--dry : nothing is written');
  const res = { schema: 3, pass: 'refusal-key-revoked-at-source', amount_eur: fmt(MONTANT), uetr, precheck_before_revocation: preAvant, balances_before: lisible(avant), legs: [] };
  let restauree = false;
  try {
    const rRev = await envoyer(c.deployerSep, 'sepolia', { to: sealSrcAdm.target, data: sealSrcAdm.interface.encodeFunctionData('revokeKey', [ORG, cleNoeud]) }, { label: 'revocation of the node key at the SOURCE seal' });
    res.legs.push({ leg: 'key-revocation-at-source', chain: 'sepolia', tx: rRev.hash, block: rRev.blockNumber, status: 'ok', note: 'the node key is revoked at the source seal AFTER signing the attestation, before the send' });
    const preApres = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
    res.precheck_after_revocation = preApres;
    log(`precheck AFTER revocation: ${preApres.ok ? 'Continue (unexpected)' : preApres.reason}`);
    const env = await envoiForce(c, { srcAtt, p, label: 'send with a node key revoked at the source' });
    res.legs.push({ leg: 'send-refuse', chain: 'sepolia', ...env, note: 'attestation signed by a key revoked at the source seal : refused at the source wrapper\'s gated transfer, before any lock' });
  } finally {
    const rRest = await envoyer(c.deployerSep, 'sepolia', { to: sealSrcAdm.target, data: sealSrcAdm.interface.encodeFunctionData('registerKey', [ORG, cleNoeud]) }, { label: 'restoration of the node key at the SOURCE seal' });
    restauree = await sealSrcAdm.isKeyActive(ORG, cleNoeud);
    res.legs.push({ leg: 'key-restoration-at-source', chain: 'sepolia', tx: rRest.hash, block: rRest.blockNumber, status: restauree ? 'ok' : 'key still inactive' });
  }
  const apres = await soldes(c);
  const memes = SOLDES_CLES.every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.key_restored = restauree; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-refusal-key-source.json'), JSON.stringify(res, null, 2) + '\n');
  log(`no funds moved: ${memes} ; key restored: ${restauree} ; written live-result-refusal-key-source.json`);
  if (!memes || !restauree) process.exit(1);
}

/** INVALID SIGNATURE AT THE SOURCE (2026-10-20): one bit of the r word of the node's signature is flipped on the first attestation item
 *  of the source leg. The key stays active: only the signature is wrong. The source wrapper must refuse before any lock. */
async function modeRefusSignatureSource(c) {
  if (!avecSanctions(c)) throw new Error('wrapper sanctions policy absent from the tracker');
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
  if (pS.code !== 0) throw new Error('the payer should have a proof');
  const items = [];
  for (const code of CODES) {
    const cdh = await c.bindSrc.commitment(uetr, c.payer, c.adapter.target, MONTANT, c.wSrc.target, code);
    items.push(await item(c.sealSrc, c.noeud, { uetr, code, cdh, ref: '0x' + '00'.repeat(32), ts }));
  }
  const avantMot = items[0][3];
  items[0][3] = toBeHex(BigInt(avantMot) ^ 1n, 32); // one bit of the r word of the signature
  const pv = await preuvePayeurSiVlei(c, uetr); // vLEI active: the payer's proof, so that only the signature defect causes the refusal
  const srcAtt = pv ? encVlei([...items, pS.item], pv) : enc([...items, pS.item]);
  const dstAtt = await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts);
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  if (!EXECUTE) return log('--dry : nothing is written');
  const res = { schema: 3, pass: 'refusal-invalid-signature-at-source', amount_eur: fmt(MONTANT), uetr,
    tampering: { word: 'r of the first source attestation item\'s signature', before: avantMot, after: items[0][3], flipped_bit: 'the least significant bit' }, balances_before: lisible(avant), legs: [] };
  const env = await envoiForce(c, { srcAtt, p, label: 'send with an invalid node signature' });
  res.legs.push({ leg: 'send-refuse', chain: 'sepolia', ...env, note: 'node signature altered by one bit (key active) : refused at the source wrapper\'s gated transfer, before any lock' });
  const apres = await soldes(c);
  const memes = SOLDES_CLES.every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-refusal-signature-source.json'), JSON.stringify(res, null, 2) + '\n');
  log(`gas used by the refusal: ${env.gas_used}; no funds moved: ${memes}; written live-result-refusal-signature-source.json`);
  if (!memes) process.exit(1);
}

/** STALE SANCTIONS ROOT (2026-10-20): beneficiary attestation and payer proof VALID, but the registry's SAN01 root is older than the policy's window. The source
 *  wrapper must refuse ("sanctions root is stale") before any lock. GUARD: if the root is not stale, we STOP without sending anything
 *  (the send would succeed and move funds: it would no longer be a refusal). Nothing is republished: the pass waits for the expiry. */
async function modeRefusRacinePerimee(c) {
  if (!avecSanctions(c)) throw new Error('wrapper sanctions policy absent from the tracker');
  const zk = JSON.parse(readFileSync(join(toolkit, 'deployments', '11155111-sanctions-nonmembership.json'), 'utf8'));
  const listId = idOf('demo-sanctions-v1');
  const reg = new Contract(zk.SanctionsRootRegistry, ['function current(bytes32 listId) view returns (tuple(bytes32 root, uint64 publishedAt, uint64 listVersion))'], c.sep);
  // The window is the SAN01 list's maxRootAge in the SOURCE WRAPPER'S POLICY: the contract is the source of truth.
  const pol = new Contract(c.s.AtelierZkSanctionsWrapperPolicy, ['function listsOf(address subject) view returns (tuple(address roots, bytes32 listId, uint32 maxRootAge, string label)[])'], c.sep);
  const [r, listes, tete] = await Promise.all([reg.current(listId), pol.listsOf(c.wSrc.target), c.sep.getBlock('latest')]);
  const fenetre = Number(listes.find((l) => l.listId === listId)?.maxRootAge ?? 0);
  if (!fenetre) throw new Error('SAN01 list absent from the source wrapper policy: unknown window');
  const fin = Number(r.publishedAt) + fenetre, maintenant = tete.timestamp;
  log(`SAN01 root published at ${new Date(Number(r.publishedAt) * 1000).toISOString()}, expire a ${new Date(fin * 1000).toISOString()}, bloc de tete a ${new Date(maintenant * 1000).toISOString()}`);
  if (maintenant <= fin) { console.error(`root still valid (${fin - maintenant} s left): nothing is sent, the send would succeed`); process.exit(2); }
  const { route, output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const pS = prouverPartie(c, { wrapper: c.wSrc.target, chainid: c.tr.source.chainId, uetr, from: c.payer, to: c.adapter.target, id: c.payer, party: 'from', montant: MONTANT });
  if (pS.code !== 0) throw new Error('the payer should have a proof');
  const srcAtt = await attSourceControlee(c, uetr, MONTANT, ts, [pS.item]);
  const dstAtt = await attArriveeControlee(c, uetr, c.benef, minOut, maxOut, ts);
  const composeMsg = route === 0 ? await c.composer.composePayloadFor(c.benef, minOut, maxOut, dstAtt) : await c.composer.composePayloadForRoute(c.benef, minOut, 1, maxOut, dstAtt);
  const p = param(c, composeMsg, MONTANT);
  if (EXECUTE) { const rw = await assurerWrap(c, MONTANT); if (rw) log(`wrap prealable ${rw.hash}`); }
  const avant = await soldes(c);
  const pre = await precontroleZk(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: srcAtt });
  log(`client precheck (runFor, source): ${pre.ok ? 'Continue (unexpected)' : pre.reason}`);
  if (!EXECUTE) return log('--dry : nothing is written');
  const res = { schema: 3, pass: 'refusal-stale-sanctions-root', amount_eur: fmt(MONTANT), uetr,
    root: { published_at: Number(r.publishedAt), expires_at: fin, head_at: maintenant, list_version: String(r.listVersion) }, client_precheck: pre, balances_before: lisible(avant), legs: [] };
  const env = await envoiForce(c, { srcAtt, p, label: 'send with a stale sanctions root' });
  res.legs.push({ leg: 'send-refuse', chain: 'sepolia', ...env, note: 'attestation and proof valid, SAN01 root stale (more than 24 h) : refused by the source wrapper at the gated transfer, before any lock' });
  const apres = await soldes(c);
  const memes = SOLDES_CLES.every((k) => avant[k] === apres[k]);
  res.balances_after = lisible(apres); res.no_funds_moved = memes; res.measured_at = new Date().toISOString();
  writeFileSync(join(here, 'live-result-refusal-root-stale.json'), JSON.stringify(res, null, 2) + '\n');
  log(`gas used by the refusal: ${env.gas_used}; no funds moved: ${memes}; written live-result-refusal-root-stale.json`);
  if (!memes) process.exit(1);
}

// ── vLEI modes (2026-10-22): each refusal happens BEFORE any send; these modes broadcast NOTHING ─────────────────
function exigerVlei(c) {
  if (!c.vleiActif) throw new Error('vLEI policy absent from the tracker (source.contracts.VleiAttestationPolicy et destination.contracts.VleiAttestationPolicy)');
}
/** Writes the result of a refusal mode (with --execute; in --dry it is printed) and exits with an error if the refusal is not the expected one. */
function ecrireResultat(fichier, res, attendu) {
  res.expected_result = attendu;
  res.measured_at = new Date().toISOString();
  if (EXECUTE) { writeFileSync(join(here, fichier), JSON.stringify(res, null, 2) + '\n'); log(`written ${fichier}`); }
  else { log(JSON.stringify(res, null, 2)); log(`--dry : ${fichier} not written (this mode broadcasts nothing; --execute only writes the file)`); }
  if (!attendu) { console.error(`${fichier}: UNEXPECTED result (see above)`); process.exit(1); }
}
const memesSoldes = (avant, apres) => SOLDES_CLES.every((k) => avant[k] === apres[k]);
const contient = (x, motif) => !x.ok && String(x.reason).includes(motif);

/** REVOKED OOR: the former holder (Former Head of Operations, FI FR) presents its OOR, revoked at the QVI's TEL. The verifier
 *  sees it at the moment of the control (revocation seal re-read at the witnesses): no attestation, so nothing is sent. In read mode, a
 *  context WITHOUT a vLEI proof is refused by the source wrapper's policy; witness: the current holder, same uetr, passes. */
async function modeRefusVlei(c) {
  exigerVlei(c);
  const avant = await soldes(c);
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const r = await vleiPayeur(c, uetr, { party: 'fi-fr-ancien-revoque' });
  log(`attester, revoked OOR: ${r.signed ? 'SIGNED (unexpected)' : r.rapport.reasons.join(' ; ')}`);
  const sansPreuve = await attSource(c, uetr, c.payer, c.adapter.target, MONTANT, ts);
  const pre = await precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: sansPreuve });
  log(`source runFor, context without vLEI proof: ${etatPre(pre)}`);
  const t = await vleiPayeur(c, uetr, { party: 'fi-fr-payeur' });
  const temoin = t.signed
    ? await precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: await attSource(c, uetr, c.payer, c.adapter.target, MONTANT, ts, [], t.proof) })
    : { ok: false, reason: `attester: ${t.rapport.reasons.join(' ; ')}` };
  log(`control, holder in office (fi-fr-payeur), same uetr: ${etatPre(temoin)}`);
  const apres = await soldes(c);
  const res = {
    schema: 3, pass: 'refusal-vlei-revoked-oor', amount_eur: fmt(MONTANT), uetr, submitted_transaction: false,
    vlei: {
      warning: 'pinned TEST root (not GLEIF), fictional LEIs prefixed DEMO', source_policy: c.s.VleiAttestationPolicy,
      attester: new Wallet(cle('VLEI_ATTESTER_PRIVATE_KEY')).address, payer_revoked_oor: r.rapport,
      kyc_cp: { by_fi_sg1_on_fi_fr: entreeKyc(r, CTL_SG1_SUR_FR) },
      precheck_without_proof: { source: etatPre(pre) },
      holder_in_office_control: { party: t.rapport.party, signed: t.signed, telStatus: t.rapport.telStatus, runFor_source: etatPre(temoin) },
    },
    balances_before: lisible(avant), balances_after: lisible(apres), no_funds_moved: memesSoldes(avant, apres),
  };
  ecrireResultat('live-result-refusal-vlei.json', res, !r.signed && r.rapport.telStatus === 'revoked'
    && contient(pre, 'VleiAttestationPolicy: no vLEI attestation supplied') && temoin.ok && res.no_funds_moved);
}

/** AGENT OUT OF MANDATE: FI FR's agent requests a transfer beyond its mandate ceiling (250,000 EURX). The intent
 *  check refuses: no attestation, nothing is sent. Second trial, in read mode: an attestation obtained WITHIN the mandate
 *  (1000 EURX) then presented for the out-of-mandate amount is refused by the chain itself (ceiling signed in the attestation). */
async function modeAgentHorsMandat(c) {
  exigerVlei(c);
  const partie = 'fi-fr-agent-mandate';
  const avant = await soldes(c);
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const r = await vleiPayeur(c, uetr, { party: partie, montant: MONTANT });
  log(`attester, agent for ${fmt(MONTANT)} EURX : ${r.signed ? 'SIGNED (unexpected)' : r.rapport.reasons.join(' ; ')}`);
  const dans = parseUnits('1000', 18);
  const a = await vleiPayeur(c, uetr, { party: partie, montant: dans });
  let preHors = { ok: false, reason: `attestation within the mandate refused: ${a.rapport.reasons.join(' ; ')}` }, preDans = preHors;
  if (a.signed) {
    [preHors, preDans] = await Promise.all([
      precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: await attSource(c, uetr, c.payer, c.adapter.target, MONTANT, ts, [], a.proof) }),
      precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: dans, contexte: await attSource(c, uetr, c.payer, c.adapter.target, dans, ts, [], a.proof) }),
    ]);
  }
  log(`source runFor, attestation within the mandate presented for ${fmt(MONTANT)}: ${etatPre(preHors)}; control for ${fmt(dans)}: ${etatPre(preDans)}`);
  const apres = await soldes(c);
  const res = {
    schema: 3, pass: 'refusal-agent-out-of-mandate', amount_eur: fmt(MONTANT), uetr, submitted_transaction: false,
    vlei: {
      warning: 'pinned TEST root (not GLEIF), fictional LEIs prefixed DEMO', source_policy: c.s.VleiAttestationPolicy,
      attester: new Wallet(cle('VLEI_ATTESTER_PRIVATE_KEY')).address, agent_out_of_mandate: r.rapport,
      kyc_cp: { by_fi_sg1_on_fi_fr: entreeKyc(r, CTL_SG1_SUR_FR) },
      test_2_cap_enforced_by_the_chain: {
        attestation_obtained_for_eur: fmt(dans), signed: a.signed, maxAmount: a.signed ? fmt(BigInt(a.rapport.maxAmount)) : null,
        runFor_amount_out_of_mandate: etatPre(preHors), control_runFor_amount_within_mandate: etatPre(preDans),
      },
    },
    balances_before: lisible(avant), balances_after: lisible(apres), no_funds_moved: memesSoldes(avant, apres),
  };
  ecrireResultat('live-result-agent-out-of-mandate.json', res, !r.signed && /greater than maxAmount/.test(r.rapport.reasons.join(' '))
    && contient(preHors, 'VleiAttestationPolicy: amount above the mandate') && preDans.ok && res.no_funds_moved);
}

/** ATTESTATION THEFT: FI SG2 (BANK_SG2, no vLEI) tries to pay with FI FR's VALID attestation. The attester does not link
 *  FI FR's OOR to FI SG2's wallet; and FI FR's attestation, presented for FI SG2's wallet, is refused by runFor
 *  ("attestation is for another wallet"). Witness: the same attestation, for FI FR's wallet, passes. Nothing is sent. */
async function modeVol(c) {
  exigerVlei(c);
  const sg2 = new Wallet(cle('BANK_SG2_PRIVATE_KEY')).address;
  const avant = await soldes(c);
  const sg2Avant = await c.wSrc.balanceOf(sg2);
  const uetr = nouveauUetr(), ts = Math.floor(Date.now() / 1000) - 5;
  const directe = await vleiPayeur(c, uetr, { wallet: sg2 });
  log(`attester, FI FR's OOR for FI SG2's wallet: ${directe.signed ? 'SIGNED (unexpected)' : directe.rapport.reasons.join(' ; ')}`);
  const fr = await vleiPayeur(c, uetr);
  if (!fr.signed) throw new Error(`FI FR's attestation should exist: ${fr.rapport.reasons.join(' ; ')}`);
  const [vol, temoin] = await Promise.all([
    precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: sg2, to: c.adapter.target, montant: MONTANT, contexte: await attSource(c, uetr, sg2, c.adapter.target, MONTANT, ts, [], fr.proof) }),
    precontroleVlei(c, 'sepolia', { subject: c.wSrc.target, from: c.payer, to: c.adapter.target, montant: MONTANT, contexte: await attSource(c, uetr, c.payer, c.adapter.target, MONTANT, ts, [], fr.proof) }),
  ]);
  log(`source runFor, FI SG2 presents FI FR's attestation: ${etatPre(vol)} ; control FI FR: ${etatPre(temoin)}`);
  const apres = await soldes(c);
  const sg2Apres = await c.wSrc.balanceOf(sg2);
  const res = {
    schema: 3, pass: 'refusal-attestation-theft', amount_eur: fmt(MONTANT), uetr, thief: { fi: 'FI SG2', wallet: sg2, vlei: 'aucun' }, submitted_transaction: false,
    vlei: {
      warning: 'pinned TEST root (not GLEIF), fictional LEIs prefixed DEMO', source_policy: c.s.VleiAttestationPolicy, attester: fr.rapport.attester,
      test_1_attester_for_the_wallet_of_fi_sg2: { signed: directe.signed, reasons: directe.rapport.reasons },
      test_2_attestation_of_fi_fr_presented_by_fi_sg2: { attestation_for: fr.rapport.wallet, lei: fr.rapport.lei, runFor_source: etatPre(vol) },
      control_same_attestation_for_fi_fr: { runFor_source: etatPre(temoin) },
    },
    balances_before: { ...lisible(avant), fi_sg2_wEURX: fmt(sg2Avant) }, balances_after: { ...lisible(apres), fi_sg2_wEURX: fmt(sg2Apres) },
    no_funds_moved: memesSoldes(avant, apres) && sg2Avant === sg2Apres,
  };
  ecrireResultat('live-result-theft.json', res, !directe.signed && contient(vol, 'VleiAttestationPolicy: attestation is for another wallet') && temoin.ok && res.no_funds_moved);
}

/** UNEXPECTED COUNTERPARTY: FI FR's payment instruction names a LEI DIFFERENT from the one the beneficiary presents (a
 *  fictional but well-formed LEI, valid mod 97 check digit). FI FR's KYC_CP on the counterparty refuses before any send: nothing moves. */
const LEI_INATTENDU = cleLei('DEMO00FISG2XXXXXXX');
async function modeContrepartieInattendue(c) {
  exigerVlei(c);
  const leiReel = partieVlei(c.vleiPartieBenef).lei;
  c.leiAttendus = { ...c.leiAttendus, beneficiary: LEI_INATTENDU };
  const { output: sortie } = await choisirRoute(c, MONTANT);
  const minOut = sortie - sortie / 100n, maxOut = sortie;
  const avant = await soldes(c);
  const uetr = nouveauUetr();
  const kyc = await kycCp(c, { uetr, minOut, maxOut });
  afficherKyc(kyc);
  const apres = await soldes(c);
  const kFr = kyc.kyc_cp.by_fi_fr_on_fi_sg1;
  const res = {
    schema: 3, pass: 'refusal-unexpected-counterparty', amount_eur: fmt(MONTANT), uetr, submitted_transaction: false,
    instruction: { lei_expected_by_fi_fr: LEI_INATTENDU, presented_beneficiary_lei: leiReel, beneficiary: c.benef },
    vlei: vleiResume(c, kyc, { client_precheck: kyc.precontrole, refusal: kyc.reason || null }),
    balances_before: lisible(avant), balances_after: lisible(apres), no_funds_moved: memesSoldes(avant, apres),
  };
  ecrireResultat('live-result-counterparty-unexpected.json', res, !kyc.ok && !!kFr && kFr.verdict === false
    && kFr.reasons.includes(`KYC_CP: presented LEI ${leiReel} differs from the expected LEI ${LEI_INATTENDU}`)
    && kyc.kyc_cp.by_fi_sg1_on_fi_fr.verdict === true && res.no_funds_moved);
}

/** The AGENT UNDER MANDATE pays: the full compliant pass, the payer presenting the agent's mandate (and the granter's OOR). */
async function modeAgent(c) {
  exigerVlei(c);
  return modeConforme(c, { partiePayeur: 'fi-fr-agent-mandate', fichier: 'live-result-agent.json', pass: 'compliant-agent-under-mandate' });
}

function optionsRetour() {
  // type 3: lzReceive 1,500,000 (at least 1,380,000), lzCompose index 0 at 9,000,000 (at least 7,000,000)
  const u128 = (n) => toBeHex(n, 16).slice(2);
  const recv = '01' + '0011' + '01' + u128(1_500_000n);
  const comp = '01' + '0013' + '03' + '0000' + u128(9_000_000n);
  return '0x0003' + recv + comp;
}
async function attRetourDebit(c, uetr, ts) {
  const items = [];
  const bindDst = c.bindDst;
  for (const code of CODES) {
    const cdh = await bindDst.commitment(uetr, c.composer.target, c.d.RECV_ADAPTER_EUR, MONTANT, c.wEurArb.target, code);
    items.push(await item(c.sealDst, c.noeud, { uetr, code, cdh, ref: '0x' + '00'.repeat(32), ts }));
  }
  return enc(items);
}
async function attRetourCredit(c, uetr, ts, extra = []) {
  const rr = c.s.RETURN_RECEIVER;
  const items = [];
  for (const code of CODES) {
    const cdh = await c.bindSrc.commitment(uetr, rr, c.payer, MONTANT, c.wSrc.target, code);
    items.push(await item(c.sealSrc, c.noeud, { uetr, code, cdh, ref: '0x' + '00'.repeat(32), ts }));
  }
  return enc([...items, ...extra]);
}

if (process.argv[1] && process.argv[1].endsWith('live-pass.mjs')) {
  const modes = {
    funds: modeFonds, compliant: (c) => modeConforme(c), refusal: modeRefus, return: modeRetour, 'refusal-sanctions': modeRefusSanctions, 'refusal-bit': modeRefusBit,
    'refusal-key-source': modeRefusCleSource, 'refusal-signature-source': modeRefusSignatureSource, 'refusal-root-stale': modeRefusRacinePerimee, replay: modeRejeu,
    // vLEI (KYC_CP): require the vLEI policy in the tracer
    agent: modeAgent, 'refusal-vlei': modeRefusVlei, 'agent-out-of-mandate': modeAgentHorsMandat, theft: modeVol, 'unexpected-counterparty': modeContrepartieInattendue,
  };
  if (!modes[MODE]) { console.error('usage : funds|compliant|refusal|return|refusal-sanctions|refusal-bit|refusal-key-source|refusal-signature-source|refusal-root-stale|replay|agent|refusal-vlei|agent-out-of-mandate|theft|unexpected-counterparty [--amount N] [--execute]'); process.exit(2); }
  (async () => { const c = ctx(); void FEES; log(`mode ${MODE}, amount ${fmt(MONTANT)} EURX, ${EXECUTE ? 'EXECUTE' : 'dry'}${c.vleiActif ? ', vLEI active (KYC_CP)' : ''}, ${new Date().toISOString()}`); await modes[MODE](c); })()
    .catch((e) => { console.error(`live-pass : ${e.message}`); process.exit(1); });
}
