// The vLEI attester: the bridge between off-chain KERI/ACDC verification and the `VleiAttestationPolicy` of the wrappers.
//
// It signs ONLY if the checks pass, all of them replayed on every call (nothing is kept in cache):
//   1. the holder's presentation is valid for the vLEI verifier (`toolkit/vlei/vlei-verifier`): signatures and key states
//      re-read from the witnesses, credential chain up to the PINNED root, authorized schemas, TEL status at the moment of
//      the check; for an agent, the mandate is verified and the intent (amount, asset, maturity) is checked;
//   2. the wallet is attached to the holder IN BOTH DIRECTIONS: the attachment statement is signed by the holder's current
//      KERI key (verified against its key state) AND by the wallet's EVM key (EIP-191);
//   3. KYC_CP (counterparty know-your-customer): if the caller names the LEI it expects (`leiAttendu`), the LEI carried by the
//      verified credential must be that one;
//   4. the attestation is valid only for THIS transfer: uetr, wallet, asset (the wrapper), chain.
// Then it signs the `VleiAttestation` EIP-712 over the digest the policy COMPUTES itself (the contract is the authority).
// The signed fields (LEI, role, SAID, AID, root, mandate ceiling) come from the VERIFIER's output, not from the record:
// the record only serves to find the presentation and to refuse an inconsistency between what it announces and what is verified.
//
// Command-line usage (from the repository root):
//   node toolkit/vlei/attester/attester.mjs bind     --party fi-fr-payeur --chain 11155111 --evm-key BANK_FR_PRIVATE_KEY
//   node toolkit/vlei/attester/attester.mjs verify --party fi-fr-payeur --chain 11155111 --address 0x... [--amount 1000.00]
//                                                      [--asset EURX] [--expected-lei DEMO...]
// The attester's key is sourced by NAME (VLEI_ATTESTER_PRIVATE_KEY); no key is ever printed.
// Attachments live in `sorties/liaisons/`; VLEI_LIAISONS_DIR moves them (the tests never overwrite the live ones).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Wallet, SigningKey, keccak256, toUtf8Bytes, hexlify, parseUnits, formatUnits, verifyMessage, getAddress, ZeroHash } from 'ethers';

const ICI = dirname(fileURLToPath(import.meta.url));
export const VLEI = resolve(ICI, '..');
export const RACINE_DEPOT = resolve(VLEI, '..', '..');
const VERIFICATEUR = join(VLEI, 'vlei-verifier');
const CONFIG = join(VLEI, 'sorties', 'config-verificateur.json');
/** Read on each call: a test can point elsewhere without touching the live attachments. */
export const dossierLiaisons = () => (process.env.VLEI_LIAISONS_DIR ? resolve(process.env.VLEI_LIAISONS_DIR) : join(VLEI, 'sorties', 'liaisons'));

export const ROLES = { OOR: 1, ECR: 2, MANDAT: 3 };
/** The ABI tuple of the proof, in the order of `VleiAttestationPolicy.VleiProof`. */
export const PROOF_ABI =
  'tuple(tuple(bytes16 uetr,address wallet,bytes20 lei,uint8 role,bytes32 credentialSaid,bytes32 holderAid,bytes32 rootAid,bytes32 mandateSaid,uint256 maxAmount,address asset,uint256 chainId,uint64 verifiedAt,bytes32 termsHash,uint8 allocation,bytes32 disputeRef,bytes32 sourceRef) att,bytes32 r,bytes32 s,uint8 v)';
export const POLICY_ABI = [
  `function digest(${PROOF_ABI.slice(6, PROOF_ABI.indexOf(') att') + 1)} a) view returns (bytes32)`,
  'function runFor(address subject,address from,address to,uint256 amount,bytes context) view returns (uint8)',
  'function isVerifier(address) view returns (bool)',
  'function isConduit(address,address) view returns (bool)',
  'function configOf(address) view returns (tuple(bool enabled,uint8 side,uint32 maxAge,uint8 roleMask,bytes32 rootAid,bytes32 termsHash,uint8 allocation,bytes32 disputeRef))',
  'event VleiReliedUpon(address indexed subject, bytes16 indexed uetr, address indexed wallet, bytes20 lei, uint8 role, bytes32 credentialSaid, bytes32 holderAid, bytes32 rootAid, bytes32 mandateSaid, uint64 verifiedAt, tuple(bytes32 termsHash, uint8 allocation, bytes32 disputeRef, bytes32 sourceRef) terms, address verifier)',
  'error PolicyRejected(string reason)',
];
/** The exact reason the verifier returns when the attachment concerns a mandate (see `verifierLiaison`). */
const RAISON_LIAISON_NON_OOR = 'the credential to bind must be an OOR, not MANDAT';

export const cesrHash = (texte) => keccak256(toUtf8Bytes(texte));

// ── LEI (ISO 17442, ISO 7064 MOD 97-10 key), the same rule as `tools/lei.py` ──────────────────────────────────
const entierLei = (s) => BigInt([...s].map((ch) => String(parseInt(ch, 36))).join(''));
/** The complete LEI: the 18-character alphanumeric base followed by its two check digits. */
export function cleLei(base18) {
  const b = String(base18).toUpperCase();
  if (!/^[0-9A-Z]{18}$/.test(b)) throw new Error(`invalid LEI base (18 alphanumeric characters): ${base18}`);
  return b + String(98n - (entierLei(b + '00') % 97n)).padStart(2, '0');
}
export const leiValide = (lei) => typeof lei === 'string' && /^[0-9A-Z]{18}[0-9]{2}$/.test(lei) && entierLei(lei) % 97n === 1n;

export function partie(nom) {
  const f = join(VLEI, 'sorties', 'parties', `${nom}.json`);
  if (!existsSync(f)) throw new Error(`unknown vLEI party: ${nom} (${f})`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** The verifier, called as its contract describes: JSON on standard output, 0 true, 1 false, 2 error. */
function verificateur(args) {
  const r = spawnSync(VERIFICATEUR, args, { cwd: RACINE_DEPOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let sortie;
  try { sortie = JSON.parse(r.stdout); } catch { throw new Error(`vLEI verifier without JSON (code ${r.status}): ${(r.stderr || '').slice(0, 300)}`); }
  return { code: r.status, ...sortie };
}
const raisonsDe = (r) => [...(r.reasons || []), ...(r.error ? [r.error] : [])];
const unique = (l) => [...new Set(l)];

/**
 * Check 1: the presentation (OOR, ECR) or, for an agent, the mandate THEN the intent (amount, asset, maturity).
 * `montant` is a decimal string; for an agent it is mandatory (a mandate is attested only for an amount).
 * `presentation` replaces the record's presentation (another CESR file presented by the same holder).
 */
export function verifierPresentation(p, { montant, assetSymbol: actif = 'EURX', presentation } = {}) {
  const cesr = presentation || p.presentation;
  const said = presentation ? [] : ['--said', p.credentialSaid];
  if (p.role === 'MANDAT') {
    const m = verificateur(['mandate', '--cesr', cesr, ...said, '--config', CONFIG]);
    if (montant === undefined) return { ...m, verdict: false, reasons: [...raisonsDe(m), 'amount missing: a mandate is only attested for a quantified transfer'] };
    const i = verificateur(['intent', '--cesr', cesr, ...said, '--config', CONFIG, '--amount', String(montant), '--asset', actif]);
    const verdict = m.code === 0 && m.verdict === true && i.code === 0 && i.authorized === true && i.mandateVerdict === true;
    return { ...m, intent: { authorized: i.authorized === true, reasons: raisonsDe(i), requested: i.requested }, verdict, reasons: unique([...raisonsDe(m), ...raisonsDe(i)]) };
  }
  const r = verificateur(['presentation', '--cesr', cesr, ...said, '--config', CONFIG]);
  return { ...r, verdict: r.code === 0 && r.verdict === true, reasons: raisonsDe(r) };
}

const fichierLiaison = (nom, chainId) => join(dossierLiaisons(), `${nom}-${chainId}.json`);

function porteurDe(p) {
  if (p.keystore) return p.keystore;
  const table = { 'fi-fr-payeur': 'pers-fifr', 'fi-sg1-beneficiaire': 'pers-fisg1', 'fi-fr-agent-mandate': 'agent-fifr', 'fi-fr-ancien-revoque': 'pers-fifr-ancien' };
  if (!table[p.party]) throw new Error(`unknown KERI holder for ${p.party} (add "keystore" to the sheet)`);
  return table[p.party];
}

/** Produces the attachment of a wallet: KERI signature of the holder (verifier), then EVM counter-signature of the wallet. */
export function lier(nom, chainId, cleEvm, { dureeJours = 30 } = {}) {
  const p = partie(nom);
  const wallet = new Wallet(cleEvm);
  const f = fichierLiaison(nom, chainId);
  mkdirSync(dirname(f), { recursive: true });
  const validUntil = Math.floor(Date.now() / 1000) + dureeJours * 86400;
  const r = verificateur(['binding', 'produce', '--holder', porteurDe(p), '--credential', p.credentialSaid, '--holder-aid', p.holderAid,
    '--chain-id', String(chainId), '--address', wallet.address, '--valid-until', String(validUntil), '--output', f]);
  if (r.code !== 0) throw new Error(`KERI binding not produced for ${nom}: ${r.error || JSON.stringify(r).slice(0, 300)}`);
  const l = JSON.parse(readFileSync(f, 'utf8'));
  l.evm = { address: wallet.address, signature: wallet.signMessageSync(l.canonical), schema: 'EIP-191 over the canonical form' };
  writeFileSync(f, JSON.stringify(l, null, 2) + '\n');
  return { fichier: f, address: wallet.address, holderAid: l.statement.holderAid, credentialSaid: l.statement.credentialSaid, validUntil };
}

/**
 * Check 2: the attachment, in both directions. The verifier only attaches an OOR: for an agent, the attachment concerns
 * its MANDATE (the agent has no OOR). All its other checks apply identically (presentation of the mandate up to the
 * root, issuer of the mandate = signing AID, signature against the current key state, maturity, chain, address); only the
 * type refusal, exact and unique, is lifted, and only if the record AND the verified credential are a mandate.
 */
export function verifierLiaison(nom, chainId, adresse, { presentation } = {}) {
  const p = partie(nom);
  const f = fichierLiaison(nom, chainId);
  if (!existsSync(f)) return { verdict: false, reasons: [`no attachment ${nom} on chain ${chainId}`] };
  const l = JSON.parse(readFileSync(f, 'utf8'));
  const raisons = [];
  const k = verificateur(['binding', 'verify', '--binding', f, '--cesr', presentation || p.presentation, '--config', CONFIG,
    '--chain-id', String(chainId), '--address', adresse]);
  let rk = raisonsDe(k);
  if (p.role === 'MANDAT' && k.role === 'MANDAT' && !k.error) rk = rk.filter((x) => x !== RAISON_LIAISON_NON_OOR);
  const keriOk = (k.code === 0 && k.verdict === true) || (p.role === 'MANDAT' && k.code === 1 && !k.error && rk.length === 0);
  if (!keriOk) raisons.push(`holder signature KERI: ${rk.join(' ; ') || 'refused'}`);
  let signataireEvm = null;
  try { signataireEvm = l.evm && l.evm.signature ? verifyMessage(l.canonical, l.evm.signature) : null; } catch (e) {
    raisons.push(`unreadable EVM counter-signature: ${String(e.shortMessage || e.message).slice(0, 120)}`);
  }
  if (!l.evm || !l.evm.signature) raisons.push('wallet EVM counter-signature missing');
  else if (signataireEvm && signataireEvm.toLowerCase() !== String(adresse).toLowerCase()) raisons.push(`EVM counter-signature from another address (${signataireEvm}) than the wallet ${adresse}`);
  if (getAddress(l.statement.address) !== getAddress(adresse)) raisons.push('the attachment targets another address');
  return {
    verdict: raisons.length === 0, reasons: raisons, keri: k, holderAid: l.statement.holderAid, credentialSaid: l.statement.credentialSaid,
    validUntil: l.statement.validUntil, address: l.statement.address, signataireEvm,
  };
}

const lei20 = (lei) => {
  if (!/^[0-9A-Z]{20}$/.test(lei)) throw new Error(`malformed LEI: ${lei}`);
  return hexlify(toUtf8Bytes(lei));
};

/** The source the verifier consulted: keccak256 of its configuration file (pinned root and TEL source). Signed, never checked on chain. */
const sourceConsultee = () => keccak256(readFileSync(CONFIG));

/**
 * The checks, then the signature. Returns { signe, proof, att, rapport }; `signe` false means NO attestation:
 * the caller must send nothing. `policy` is an ethers Contract of the policy of the chain where the attestation will be invoked.
 * `montant` is in wrapper units (bigint), `leiAttendu` the LEI the caller expects for this counterparty (KYC_CP).
 */
export async function attester({ name: nom, chainId, wallet, asset, policy, uetr, montant, decimales = 18, assetSymbol: actif = 'EURX', cleAttesteur, presentation, expectedLei: leiAttendu }) {
  const p = partie(nom);
  const montantDecimal = montant === undefined ? undefined : formatUnits(montant, decimales);
  const pres = verifierPresentation(p, { montant: montantDecimal, assetSymbol: actif, presentation });
  const liaison = verifierLiaison(nom, chainId, wallet, { presentation });
  const raisons = [];
  for (const r of pres.verdict ? [] : (pres.reasons.length ? pres.reasons : ['presentation refused'])) raisons.push(`presentation: ${r}`);
  for (const r of liaison.reasons) raisons.push(`wallet attachment: ${r}`);
  if (pres.verdict) {
    // what is verified must be what the record announces: otherwise we no longer know who the attestation designates
    if (pres.role !== p.role) raisons.push(`verified role ${pres.role} differs from the role of the sheet ${p.role}`);
    if (pres.pinnedRoot !== p.rootAid) raisons.push(`verifier pinned root ${pres.pinnedRoot} differs from the root of the sheet ${p.rootAid}`);
    if (pres.credentialSaid !== p.credentialSaid) raisons.push(`verified credential ${pres.credentialSaid} differs from the one in the sheet ${p.credentialSaid}`);
    if (liaison.verdict && (liaison.holderAid !== pres.holderAid || liaison.credentialSaid !== pres.credentialSaid)) {
      raisons.push('the attachment designates another holder or credential than the verified presentation');
    }
  }
  const lei = pres.lei || null;
  if (leiAttendu !== undefined && leiAttendu !== null) {
    if (!leiValide(leiAttendu)) raisons.push(`KYC_CP: expected LEI ${leiAttendu} is malformed (ISO 17442: 18 characters and two check digits mod 97)`);
    else if (lei !== leiAttendu) raisons.push(`KYC_CP: presented LEI ${lei || '(none)'} differs from the expected LEI ${leiAttendu}`);
  }
  const rapport = {
    party: nom, signed: false, lei, expectedLei: leiAttendu ?? null, role: pres.role || p.role, roleTitle: pres.roleTitle || null,
    credentialSaid: pres.credentialSaid || null, holderAid: pres.holderAid || null, pinnedRoot: pres.pinnedRoot || null,
    telStatus: pres.telStatus || null, checkedAt: pres.checkedAt || null,
    presentation: { verdict: pres.verdict, reasons: pres.reasons },
    binding: { verdict: liaison.verdict, reasons: liaison.reasons, address: liaison.address || null, validUntil: liaison.validUntil ?? null },
    reasons: raisons,
  };
  if (p.role === 'MANDAT') rapport.mandate = { ...(pres.mandate || p.mandate), intent: pres.intent || null };
  if (raisons.length) return { signed: false, rapport };

  // The reliance terms are PINNED by the relying party in the policy configuration: the attester reads them, never invents them.
  const cfg = await policy.configOf(asset);
  if (!cfg.enabled || cfg.termsHash === ZeroHash || cfg.disputeRef === ZeroHash || Number(cfg.allocation) === 0) {
    return { signed: false, rapport: { ...rapport, reasons: ['no reliance terms pinned for this asset in the policy configuration'] } };
  }
  const verifiedAt = Math.floor(Date.parse(pres.checkedAt) / 1000);
  if (!Number.isFinite(verifiedAt)) return { signed: false, rapport: { ...rapport, reasons: ['unreadable verification instant'] } };
  const mandat = p.role === 'MANDAT';
  const att = {
    uetr, wallet: getAddress(wallet), lei: lei20(lei), role: ROLES[pres.role],
    credentialSaid: cesrHash(mandat ? pres.mandate.oorSaid : pres.credentialSaid),
    holderAid: cesrHash(pres.holderAid), rootAid: cesrHash(pres.pinnedRoot),
    mandateSaid: mandat ? cesrHash(pres.credentialSaid) : ZeroHash,
    maxAmount: mandat ? parseUnits(pres.mandate.maxAmount, decimales) : 0n,
    asset: getAddress(asset), chainId: BigInt(chainId), verifiedAt: BigInt(verifiedAt),
    termsHash: cfg.termsHash, allocation: Number(cfg.allocation), disputeRef: cfg.disputeRef,
    sourceRef: sourceConsultee(),
  };
  const tuple = [att.uetr, att.wallet, att.lei, att.role, att.credentialSaid, att.holderAid, att.rootAid, att.mandateSaid, att.maxAmount, att.asset, att.chainId, att.verifiedAt,
    att.termsHash, att.allocation, att.disputeRef, att.sourceRef];
  const digest = await policy.digest(tuple);
  const sig = new SigningKey(cleAttesteur).sign(digest);
  Object.assign(rapport, {
    signed: true, roleAttestation: att.role, attester: new Wallet(cleAttesteur).address, digest, policy: policy.target, chainId: Number(chainId),
    verifiedAt: new Date(verifiedAt * 1000).toISOString(), wallet: att.wallet, assetSymbol: att.asset,
    digests: { credentialSaid: att.credentialSaid, holderAid: att.holderAid, rootAid: att.rootAid, mandateSaid: att.mandateSaid },
    terms: { termsHash: att.termsHash, allocation: att.allocation, disputeRef: att.disputeRef, sourceRef: att.sourceRef },
    maxAmount: att.maxAmount.toString(),
  });
  return { signed: true, att, proof: [tuple, sig.r, sig.s, sig.v], rapport };
}

// ── command line ────────────────────────────────────────────────────────────────────────────────────────────────
function arg(nom, defaut) {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 ? process.argv[i + 1] : defaut;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const nom = arg('party');
  const chain = Number(arg('chain'));
  if (cmd === 'bind') {
    const nomCle = arg('evm-key');
    const cle = process.env[nomCle];
    if (!cle) throw new Error(`EVM key ${nomCle} absent from the environment (source .env.local by name)`);
    console.log(JSON.stringify(lier(nom, chain, cle), null, 2));
  } else if (cmd === 'verify') {
    const p = partie(nom);
    const pres = verifierPresentation(p, { montant: arg('amount'), assetSymbol: arg('asset', 'EURX') });
    const l = verifierLiaison(nom, chain, arg('address'));
    const leiAttendu = arg('expected-lei');
    const kyc = leiAttendu === undefined ? null : { expectedLei: leiAttendu, leiPresente: pres.lei || null, verdict: leiValide(leiAttendu) && pres.lei === leiAttendu };
    console.log(JSON.stringify({
      presentation: { verdict: pres.verdict, lei: pres.lei, role: pres.role, roleTitle: pres.roleTitle, telStatus: pres.telStatus, reasons: pres.reasons, checkedAt: pres.checkedAt },
      binding: { verdict: l.verdict, reasons: l.reasons, address: l.address, validUntil: l.validUntil }, ...(kyc ? { kyc_cp: kyc } : {}),
    }, null, 2));
    process.exitCode = pres.verdict && l.verdict && (!kyc || kyc.verdict) ? 0 : 1;
  } else {
    console.error('usage: attester.mjs bind|verifier --party NAME --chain ID [--evm-key KEY_NAME | --address 0x.. [--amount D] [--asset A] [--expected-lei LEI]]');
    process.exitCode = 2;
  }
}
