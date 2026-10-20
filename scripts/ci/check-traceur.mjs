#!/usr/bin/env node
// Garde du traceur public deployments/fx-corridor.json, HORS LIGNE. Refuse :
//
//   1. une passe sans issue connue (settled, refused, returned) ou sans jambe ;
//   2. une jambe dont la chaine n'est pas l'une des deux chaines du corridor, ou dont le hash de transaction n'est pas
//      0x suivi de 64 chiffres hexadecimaux en minuscules (66 caracteres) ;
//   3. une jambe `expect_revert` sans `expected_revert` (error et contains obligatoires ; selector et policy non vides s'ils sont la) ;
//   4. une passe `refused` sans aucune jambe `expect_revert` : un refus qui ne nomme pas sa cause n'est pas un temoin ;
//   5. une adresse ecrite dans le RUNBOOK ou le README qui n'est dans aucun traceur de deployments/ (une adresse ne se
//      complete pas de tete).
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

/** Logique pure : `traceur` = le JSON charge. Rend la liste des refus (vide = conforme). */
export function controlerPasses(traceur) {
  const refus = [];
  const passes = traceur.demonstration_passes;
  if (!passes || typeof passes !== 'object') return ['demonstration_passes absent'];
  for (const [nom, p] of Object.entries(passes)) {
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
  console.log(refus.length ? `check-traceur : ${refus.length} refus` : `check-traceur : ${n} passes, aucun refus`);
  process.exit(refus.length ? 1 : 0);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
