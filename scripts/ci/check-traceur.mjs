#!/usr/bin/env node
// Garde du traceur public deployments/fx-corridor.json, HORS LIGNE. Refuse :
//
//   1. une passe sans issue connue (settled, refused, returned) ou sans jambe ;
//   2. une jambe dont la chaine n'est pas l'une des deux chaines du corridor, ou dont le hash de transaction n'est pas
//      0x suivi de 64 chiffres hexadecimaux en minuscules (66 caracteres) ;
//   3. une jambe `expect_revert` sans `expected_revert` (error et contains obligatoires ; selector et policy non vides s'ils sont la) ;
//   4. une passe `refused` sans aucune jambe `expect_revert` : un refus qui ne nomme pas sa cause n'est pas un temoin ;
//   5. une adresse ecrite dans le RUNBOOK ou le README qui n'est dans aucun traceur de deployments/ (une adresse ne se
//      complete pas de tete) ;
//   6. un refus SANS transaction (liste `vlei_refusals_without_transaction`) qui porterait une jambe, un hash de
//      transaction, une issue autre que `refused`, `transaction_emitted` autre que false, ou ni raison ni temoin en
//      lecture seule : ce qui n'a rien emis ne se presente pas comme une transaction ;
//   7. un `counterparty_check` dont une partie n'a pas son LEI presente et attendu, son role, son heure de verification,
//      ou dont la transaction `relied_upon` n'est pas une jambe de la passe sur la meme chaine.
//
// Usage : node scripts/ci/check-traceur.mjs [racine]   (racine = depot d'exposition, par defaut le dossier courant)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHAINES = new Set([11155111, 421614]);
export const ISSUES = new Set(['settled', 'refused', 'returned']);
const HASH = /^0x[0-9a-f]{64}$/;
const ADRESSE = /0x[0-9a-fA-F]{40}\b/g;
const CHAMPS_REVERT = ['error', 'contains']; // obligatoires ; `selector` et `policy` sont facultatifs pour le verificateur
const CHAMPS_REVERT_FACULTATIFS = ['selector', 'policy']; // mais jamais vides s'ils sont presents
export const REFUS_SANS_TX = 'vlei_refusals_without_transaction';
const HASH_DANS_TEXTE = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const nonVide = (v) => typeof v === 'string' && v !== '';

/** Refus sans transaction : faits hors chaine ou lectures seules, jamais une jambe ni un hash. */
function controlerRefusSansTx(liste, nomsDePasses) {
  const refus = [];
  if (!Array.isArray(liste)) return [`${REFUS_SANS_TX} : une liste est attendue`];
  const vus = new Set();
  liste.forEach((r, i) => {
    const ou = `${REFUS_SANS_TX}[${i}]${r && nonVide(r.name) ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { refus.push(`${ou} : objet attendu`); return; }
    if (!nonVide(r.name)) refus.push(`${ou} : name absent ou vide`);
    else if (vus.has(r.name) || nomsDePasses.has(r.name)) refus.push(`${ou} : name en double`);
    vus.add(r.name);
    if (r.outcome !== 'refused') refus.push(`${ou} : issue ${JSON.stringify(r.outcome)}, seul refused est admis`);
    if (r.transaction_emitted !== false) refus.push(`${ou} : transaction_emitted doit valoir false`);
    if ('legs' in r || 'tx' in r) refus.push(`${ou} : un refus sans transaction ne porte ni jambe ni tx`);
    if (HASH_DANS_TEXTE.test(JSON.stringify(r))) refus.push(`${ou} : porte un hash de 32 octets alors qu'aucune transaction n'a ete emise`);
    if (!nonVide(r.reason)) refus.push(`${ou} : reason absent ou vide`);
    if (!Array.isArray(r.read_only_evidence) || r.read_only_evidence.length === 0 || !r.read_only_evidence.every(nonVide))
      refus.push(`${ou} : read_only_evidence absent, vide ou non textuel`);
  });
  return refus;
}

/** Controle de contrepartie d'une passe : LEI presente et attendu, role, heure, et la transaction relied_upon est une
 *  jambe de la passe sur la meme chaine. */
function controlerContrepartie(nom, p) {
  const refus = [];
  const cc = p.counterparty_check;
  if (cc === undefined) return refus;
  if (!cc || typeof cc !== 'object') return [`${nom} : counterparty_check doit etre un objet`];
  const cotes = ['payer', 'beneficiary'].filter((c) => c in cc);
  if (cotes.length === 0) refus.push(`${nom} : counterparty_check sans payer ni beneficiary`);
  for (const c of cotes) {
    const x = cc[c], ou = `${nom} counterparty_check.${c}`;
    for (const k of ['wallet', 'lei_presented', 'lei_expected']) if (!nonVide(x?.[k])) refus.push(`${ou} : ${k} absent ou vide`);
    if (!Number.isInteger(x?.role)) refus.push(`${ou} : role entier attendu (le code du role dans l'evenement)`);
    if (!nonVide(x?.verifiedAt) || !ISO.test(x.verifiedAt)) refus.push(`${ou} : verifiedAt absent ou hors du format ISO 8601 UTC`);
    const ru = x?.relied_upon;
    if (!ru || !CHAINES.has(ru.chainId) || typeof ru.tx !== 'string' || !HASH.test(ru.tx)) refus.push(`${ou} : relied_upon sans chaine du corridor ni hash valide`);
    else if (!(p.legs || []).some((l) => l.chainId === ru.chainId && l.tx === ru.tx)) refus.push(`${ou} : relied_upon.tx n'est aucune jambe de la passe sur la chaine ${ru.chainId}`);
    if (ru && !nonVide(ru.policy)) refus.push(`${ou} : relied_upon.policy absent ou vide`);
  }
  return refus;
}

/** Logique pure : `traceur` = le JSON charge. Rend la liste des refus (vide = conforme). */
export function controlerPasses(traceur) {
  const refus = [];
  const passes = traceur.demonstration_passes;
  if (!passes || typeof passes !== 'object') return ['demonstration_passes absent'];
  if (REFUS_SANS_TX in passes) refus.push(...controlerRefusSansTx(passes[REFUS_SANS_TX], new Set(Object.keys(passes))));
  for (const [nom, p] of Object.entries(passes)) {
    if (nom === REFUS_SANS_TX) continue;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !('legs' in p || 'outcome' in p)) continue; // note, not_played
    if (!ISSUES.has(p.outcome)) refus.push(`${nom} : issue inconnue (${JSON.stringify(p.outcome)})`);
    if (!Array.isArray(p.legs) || p.legs.length === 0) { refus.push(`${nom} : aucune jambe`); continue; }
    let reverts = 0;
    p.legs.forEach((l, i) => {
      const ou = `${nom} jambe ${i} (${l.phase})`;
      if (!CHAINES.has(l.chainId)) refus.push(`${ou} : chaine ${l.chainId} hors du corridor`);
      if (typeof l.tx !== 'string' || !HASH.test(l.tx)) refus.push(`${ou} : hash de transaction invalide (${String(l.tx).slice(0, 18)})`);
      if (l.phase === 'expect_revert') {
        reverts++;
        const e = l.expected_revert;
        if (!e || typeof e !== 'object') refus.push(`${ou} : expected_revert absent`);
        else {
          for (const c of CHAMPS_REVERT) if (typeof e[c] !== 'string' || e[c] === '') refus.push(`${ou} : expected_revert.${c} absent ou vide`);
          for (const c of CHAMPS_REVERT_FACULTATIFS) if (c in e && (typeof e[c] !== 'string' || e[c] === '')) refus.push(`${ou} : expected_revert.${c} present mais vide`);
        }
      }
    });
    if (p.outcome === 'refused' && reverts === 0) refus.push(`${nom} : refus sans jambe expect_revert`);
    refus.push(...controlerContrepartie(nom, p));
  }
  return refus;
}

/** Adresses (en minuscules) lues dans un texte. */
export function adressesDuTexte(texte) {
  return new Set((texte.match(ADRESSE) || []).map((a) => a.toLowerCase()));
}

/** Adresses citees dans `textes` qui ne sont dans aucun des `traceurs` (textes JSON). */
export function adressesInconnues(textes, traceurs) {
  const connues = new Set();
  for (const t of traceurs) for (const a of adressesDuTexte(t)) connues.add(a);
  const inconnues = [];
  for (const [nom, t] of Object.entries(textes)) for (const a of adressesDuTexte(t)) if (!connues.has(a)) inconnues.push(`${nom} : ${a}`);
  return inconnues;
}

function main() {
  const racine = process.argv[2] || process.cwd();
  const traceur = JSON.parse(readFileSync(join(racine, 'deployments', 'fx-corridor.json'), 'utf8'));
  const refus = controlerPasses(traceur);
  const dossier = join(racine, 'deployments');
  const traceurs = readdirSync(dossier).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dossier, f), 'utf8'));
  const textes = {};
  for (const f of ['RUNBOOK.md', 'README.md']) if (existsSync(join(racine, f))) textes[f] = readFileSync(join(racine, f), 'utf8');
  refus.push(...adressesInconnues(textes, traceurs).map((m) => `adresse hors traceur, ${m}`));
  for (const m of refus) console.error('  REFUS: ' + m);
  const n = Object.values(traceur.demonstration_passes || {}).filter((p) => p && p.legs).length;
  const sansTx = (traceur.demonstration_passes || {})[REFUS_SANS_TX];
  const m = Array.isArray(sansTx) ? sansTx.length : 0;
  console.log(refus.length ? `check-traceur : ${refus.length} refus` : `check-traceur : ${n} passes, ${m} refus de passe sans transaction ; aucun refus`);
  process.exit(refus.length ? 1 : 0);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
