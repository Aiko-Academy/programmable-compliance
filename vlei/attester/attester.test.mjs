// Tests of the vLEI attester against the REAL `VleiAttestationPolicy`, deployed on a local anvil (chain 11155111
// simulated, nothing goes out to a public network). The KERI verifier and the local witnesses (127.0.0.1:5642-5644) must be running
// (`toolkit/vlei/ecosystem.sh up`). The test attachments are written into a temporary folder (VLEI_LIAISONS_DIR) with
// disposable wallets: the live attachments of `sorties/liaisons/` are never touched (checked at the end).
//
//   node --test toolkit/vlei/attester/
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonRpcProvider, Wallet, ContractFactory, Contract, AbiCoder, Interface, parseUnits, ZeroHash, getAddress, recoverAddress, Signature,
  id as idOf, hexlify, randomBytes, toUtf8Bytes,
} from 'ethers';
import { termsValues } from '../../examples/corridor-fx/reliance-terms.mjs';
import { attester, lier, PROOF_ABI, POLICY_ABI, cesrHash, cleLei, leiValide, partie, VLEI, RACINE_DEPOT } from './attester.mjs';

const TOOLKIT = join(RACINE_DEPOT, 'toolkit');
const ARTEFACT = join(TOOLKIT, 'out-lz', 'VleiAttestationPolicy.sol', 'VleiAttestationPolicy.json');
const SOURCE = join(TOOLKIT, 'test-layerzero', 'VleiAttestationPolicy.sol');
const LIAISONS_VIVANTES = join(VLEI, 'sorties', 'liaisons');
const CHAIN = 11155111;
const ITEMS = 'tuple(uint8 kind,bytes32 orgId,tuple(bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp) sig,bytes32 r,bytes32 s,bytes32 qx,bytes32 qy)[]';
const ERREURS = new Interface(POLICY_ABI);
const EUR = (x) => parseUnits(String(x), 18);
const LEI_FR = 'DEMO00FIFRPAYER00119';

let TERMES, anvil, provider, pol, dossier, attK, wPayeur, wAgent, wAncien, WSRC, ADAPTER, ROOT;
const mtimesVivantes = () => Object.fromEntries(readdirSync(LIAISONS_VIVANTES).map((f) => [f, statSync(join(LIAISONS_VIVANTES, f)).mtimeMs]));
let vivantesAvant;

const portLibre = () => new Promise((ok, ko) => {
  const s = createServer();
  s.once('error', ko);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const uetr = () => hexlify(randomBytes(16));
/** A minimal array of items: the vLEI policy only reads the uetr of the first one (the other policies are not in play here). */
const items = (u) => [[0, idOf('node'), [u, 'customer-due-diligence', true, ZeroHash, ZeroHash, 1n], ZeroHash, ZeroHash, ZeroHash, ZeroHash]];
const contexte = (u, proof) => AbiCoder.defaultAbiCoder().encode([ITEMS, PROOF_ABI], [items(u), proof]);
/** The refusal of the policy, decoded by its ABI: the exact reason, or the failure if the call goes through. */
async function raisonRefus(appel) {
  try { await appel(); } catch (e) {
    const data = e.data || e.info?.error?.data;
    const err = ERREURS.parseError(data);
    return `${err.name}: ${err.args[0]}`;
  }
  return 'NO REFUSAL';
}
const base = (extra) => ({ chainId: CHAIN, asset: WSRC, policy: pol, cleAttesteur: attK.privateKey, ...extra });

before(async () => {
  // 1. the policy artifact, recompiled if missing or older than its source
  if (!existsSync(ARTEFACT) || statSync(ARTEFACT).mtimeMs < statSync(SOURCE).mtimeMs) {
    const b = spawnSync('forge', ['build'], { cwd: TOOLKIT, env: { ...process.env, FOUNDRY_PROFILE: 'lz' }, encoding: 'utf8' });
    assert.equal(b.status, 0, `forge build (profile lz) failed: ${(b.stderr || '').slice(-400)}`);
  }
  vivantesAvant = mtimesVivantes();
  // 2. anvil on a free port, chain 11155111 simulated
  const port = await portLibre();
  anvil = spawn('anvil', ['--port', String(port), '--chain-id', String(CHAIN), '--silent'], { stdio: 'ignore' });
  provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, CHAIN, { staticNetwork: true, polling: false });
  for (let i = 0; ; i++) {
    try { await provider.getBlockNumber(); break; } catch (e) { if (i > 100) throw e; await new Promise((r) => setTimeout(r, 100)); }
  }
  // 3. the policy: owner = anvil account 0, manager = a local EOA (account 1), verifier = a disposable key
  const proprio = await provider.getSigner(0);
  const gestionnaire = await provider.getSigner(1);
  const art = JSON.parse(readFileSync(ARTEFACT, 'utf8'));
  const deploye = await new ContractFactory(art.abi, art.bytecode.object, proprio).deploy(await gestionnaire.getAddress(), await proprio.getAddress());
  await deploye.waitForDeployment();
  pol = new Contract(await deploye.getAddress(), POLICY_ABI, provider);
  const admin = new Contract(pol.target, art.abi, proprio);
  attK = Wallet.createRandom();
  WSRC = getAddress(hexlify(randomBytes(20))); // the simulated source wrapper: subject of the configuration
  ADAPTER = getAddress(hexlify(randomBytes(20)));
  ROOT = cesrHash(JSON.parse(readFileSync(join(VLEI, 'sorties', 'config-verificateur.json'), 'utf8')).rootAid);
  await (await admin.setVerifier(attK.address, true)).wait();
  TERMES = termsValues(JSON.parse(readFileSync(join(TOOLKIT, 'examples', 'corridor-fx', 'reliance-terms', 'demo-terms.json'), 'utf8')));
  await (await admin.setConfig(WSRC, 0, 3600, (1 << 1) | (1 << 3), ROOT, TERMES.termsHash, TERMES.allocation, TERMES.disputeRef)).wait(); // from side, OOR or agent
  // 4. test attachments, in a temporary folder, with disposable wallets
  dossier = mkdtempSync(join(tmpdir(), 'vlei-attesteur-'));
  process.env.VLEI_LIAISONS_DIR = join(dossier, 'liaisons');
  wPayeur = Wallet.createRandom(); wAgent = Wallet.createRandom(); wAncien = Wallet.createRandom();
  lier('fi-fr-payeur', CHAIN, wPayeur.privateKey);
  lier('fi-fr-agent-mandate', CHAIN, wAgent.privateKey);
  lier('fi-fr-ancien-revoque', CHAIN, wAncien.privateKey);
});

after(() => {
  if (anvil) anvil.kill();
  if (provider) provider.destroy();
  delete process.env.VLEI_LIAISONS_DIR;
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

let preuvePayeur, uetrPayeur;

test('LEI: ISO 7064 MOD 97-10 key identical to tools/lei.py, demo LEIs valid', () => {
  assert.equal(cleLei('DEMO00FISG2XXXXXXX'), 'DEMO00FISG2XXXXXXX81'); // value produced by `tools/lei.py calculer DEMO00FISG2XXXXXXX`
  assert.ok(leiValide(LEI_FR));
  assert.ok(leiValide(partie('fi-sg1-beneficiaire').lei));
  assert.ok(!leiValide('DEMO00FIFRPAYER00118'), 'a wrong check digit is refused');
});

test('payer OOR: attestation signed, bound to the transfer, accepted by runFor (Continue = 2)', async () => {
  uetrPayeur = uetr();
  const r = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetrPayeur, montant: EUR(1000), expectedLei: LEI_FR }));
  assert.equal(r.signed, true, JSON.stringify(r.rapport.reasons));
  const p = partie('fi-fr-payeur');
  assert.equal(r.att.role, 1);
  assert.equal(r.att.wallet, wPayeur.address);
  assert.equal(r.att.lei, hexlify(toUtf8Bytes(LEI_FR)));
  assert.equal(r.att.credentialSaid, cesrHash(p.credentialSaid));
  assert.equal(r.att.holderAid, cesrHash(p.holderAid));
  assert.equal(r.att.rootAid, ROOT);
  assert.equal(r.att.mandateSaid, ZeroHash);
  assert.equal(r.att.maxAmount, 0n);
  assert.equal(r.rapport.telStatus, 'issued');
  assert.equal(r.rapport.attester, attK.address);
  const [, rr, ss, v] = r.proof;
  assert.equal(recoverAddress(r.rapport.digest, Signature.from({ r: rr, s: ss, v })), attK.address, 'signature over the digest READ in the contract');
  assert.equal(await pol.runFor(WSRC, wPayeur.address, ADAPTER, EUR(1000), contexte(uetrPayeur, r.proof)), 2n);
  preuvePayeur = r.proof;
});

test('reliance terms: the attester signs the terms PINNED in the policy, and refuses an asset with none', async () => {
  const r = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), montant: EUR(1000), expectedLei: LEI_FR }));
  assert.equal(r.att.termsHash, TERMES.termsHash);
  assert.equal(r.att.allocation, TERMES.allocation);
  assert.equal(r.att.disputeRef, TERMES.disputeRef);
  assert.match(r.att.sourceRef, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(r.rapport.terms, { termsHash: TERMES.termsHash, allocation: TERMES.allocation, disputeRef: TERMES.disputeRef, sourceRef: r.att.sourceRef });
  const sans = getAddress(hexlify(randomBytes(20)));
  const n = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), montant: EUR(1000), expectedLei: LEI_FR, asset: sans }));
  assert.equal(n.signed, false);
  assert.equal(n.proof, undefined);
  assert.deepEqual(n.rapport.reasons, ['no reliance terms pinned for this asset in the policy configuration']);
});

test('KYC_CP: an expected LEI different from the credential one is refused, without attestation', async () => {
  const autre = cleLei('DEMO00FISG2XXXXXXX');
  const r = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), montant: EUR(1000), expectedLei: autre }));
  assert.equal(r.signed, false);
  assert.equal(r.proof, undefined);
  assert.ok(r.rapport.reasons.includes(`KYC_CP: presented LEI ${LEI_FR} differs from the expected LEI ${autre}`), JSON.stringify(r.rapport.reasons));
  assert.equal(r.rapport.presentation.verdict, true, 'the presentation itself is valid: only the LEI comparison refuses');
  const mal = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), expectedLei: 'DEMO00FIFRPAYER00118' }));
  assert.equal(mal.signed, false);
  assert.match(mal.rapport.reasons.join(' | '), /expected LEI DEMO00FIFRPAYER00118 is malformed/);
});

test('revoked OOR: presentation replaced by the former holder one, no attestation', async () => {
  const r = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), montant: EUR(1000), presentation: 'toolkit/vlei/sorties/presentations/oor-pers-fifr-ancien.cesr' }));
  assert.equal(r.signed, false);
  assert.equal(r.proof, undefined);
  assert.equal(r.rapport.telStatus, 'revoked');
  assert.match(r.rapport.reasons.join(' | '), /revoked/);
});

test('revoked OOR: the former holder sheet, with its own attachment, is refused', async () => {
  const r = await attester(base({ name: 'fi-fr-ancien-revoque', wallet: wAncien.address, uetr: uetr(), montant: EUR(1000), expectedLei: LEI_FR }));
  assert.equal(r.signed, false);
  assert.equal(r.proof, undefined);
  assert.equal(r.rapport.telStatus, 'revoked');
  assert.equal(r.rapport.presentation.verdict, false);
  assert.match(r.rapport.reasons.join(' | '), /revoked/);
});

test('agent under a mandate within the ceiling: role 3, ceiling and mandate signed, the chain applies the ceiling', async () => {
  const u = uetr();
  const p = partie('fi-fr-agent-mandate');
  const r = await attester(base({ name: 'fi-fr-agent-mandate', wallet: wAgent.address, uetr: u, montant: EUR(1000), expectedLei: LEI_FR }));
  assert.equal(r.signed, true, JSON.stringify(r.rapport.reasons));
  assert.equal(r.att.role, 3);
  assert.equal(r.att.maxAmount, EUR('250000.00'));
  assert.equal(r.att.mandateSaid, cesrHash(p.credentialSaid));
  assert.equal(r.att.credentialSaid, cesrHash(p.mandate.oorSaid), 'the role credential is the principal OOR');
  assert.equal(r.att.holderAid, cesrHash(p.holderAid), 'the holder is the agent');
  assert.equal(r.rapport.role, 'MANDAT');
  const ctx = contexte(u, r.proof);
  assert.equal(await pol.runFor(WSRC, wAgent.address, ADAPTER, EUR(1000), ctx), 2n);
  assert.equal(await pol.runFor(WSRC, wAgent.address, ADAPTER, EUR(250000), ctx), 2n, 'upper bound included');
  assert.equal(await raisonRefus(() => pol.runFor(WSRC, wAgent.address, ADAPTER, EUR(250000) + 1n, ctx)), 'PolicyRejected: VleiAttestationPolicy: amount above the mandate');
});

test('agent above the ceiling (by one wei): refused by the intent check, no attestation', async () => {
  const r = await attester(base({ name: 'fi-fr-agent-mandate', wallet: wAgent.address, uetr: uetr(), montant: EUR(250000) + 1n }));
  assert.equal(r.signed, false);
  assert.equal(r.proof, undefined);
  assert.match(r.rapport.reasons.join(' | '), /amount 250000\.000000000000000001 greater than maxAmount 250000\.00/);
});

test('attachment of another address: refused', async () => {
  const intrus = Wallet.createRandom().address;
  const r = await attester(base({ name: 'fi-fr-payeur', wallet: intrus, uetr: uetr(), montant: EUR(1000) }));
  assert.equal(r.signed, false);
  assert.ok(r.rapport.reasons.includes('wallet attachment: the attachment targets another address'), JSON.stringify(r.rapport.reasons));
});

test('altered EVM counter-signature or from another key: refused', async () => {
  const vrai = process.env.VLEI_LIAISONS_DIR;
  const f = join(vrai, `fi-fr-payeur-${CHAIN}.json`);
  const l = JSON.parse(readFileSync(f, 'utf8'));
  try {
    // (a) one inverted byte of r: the signature no longer yields the wallet's address (or becomes unreadable)
    process.env.VLEI_LIAISONS_DIR = join(dossier, 'liaisons-alterees');
    const sig = l.evm.signature;
    const octet = (parseInt(sig.slice(10, 12), 16) ^ 0xff).toString(16).padStart(2, '0');
    const altere = { ...l, evm: { ...l.evm, signature: sig.slice(0, 10) + octet + sig.slice(12) } };
    mkdirSync(process.env.VLEI_LIAISONS_DIR, { recursive: true });
    writeFileSync(join(process.env.VLEI_LIAISONS_DIR, `fi-fr-payeur-${CHAIN}.json`), JSON.stringify(altere, null, 2));
    const a = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), montant: EUR(1000) }));
    assert.equal(a.signed, false);
    assert.match(a.rapport.reasons.join(' | '), /EVM counter-signature/);
    assert.equal(a.rapport.binding.reasons.some((x) => x.startsWith('holder signature KERI')), false, 'the KERI signature stays valid: only the EVM direction refuses');
    // (b) a valid signature, but from another key than the wallet's
    const autre = { ...l, evm: { ...l.evm, signature: Wallet.createRandom().signMessageSync(l.canonical) } };
    writeFileSync(join(process.env.VLEI_LIAISONS_DIR, `fi-fr-payeur-${CHAIN}.json`), JSON.stringify(autre, null, 2));
    const b = await attester(base({ name: 'fi-fr-payeur', wallet: wPayeur.address, uetr: uetr(), montant: EUR(1000) }));
    assert.equal(b.signed, false);
    assert.match(b.rapport.reasons.join(' | '), /EVM counter-signature from another address/);
  } finally {
    process.env.VLEI_LIAISONS_DIR = vrai;
  }
});

test('runFor: the proof of another wallet is refused with the exact reason, a context without proof too', async () => {
  assert.ok(preuvePayeur, 'payer proof produced by the previous test');
  const intrus = Wallet.createRandom().address;
  assert.equal(await raisonRefus(() => pol.runFor(WSRC, intrus, ADAPTER, EUR(1000), contexte(uetrPayeur, preuvePayeur))), 'PolicyRejected: VleiAttestationPolicy: attestation is for another wallet');
  const sansPreuve = AbiCoder.defaultAbiCoder().encode([ITEMS], [items(uetrPayeur)]);
  assert.equal(await raisonRefus(() => pol.runFor(WSRC, wPayeur.address, ADAPTER, EUR(1000), sansPreuve)), 'PolicyRejected: VleiAttestationPolicy: no vLEI attestation supplied');
  assert.equal(await raisonRefus(() => pol.runFor(WSRC, wPayeur.address, ADAPTER, EUR(1000), contexte(uetr(), preuvePayeur))), 'PolicyRejected: VleiAttestationPolicy: attestation is for another transfer');
});

test('the live attachments of sorties/liaisons/ are not touched by the tests', () => {
  assert.deepEqual(mtimesVivantes(), vivantesAvant);
});
