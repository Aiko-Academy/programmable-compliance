#!/usr/bin/env node
// Genere MANIFEST.json : empreinte sha256 et licence de chaque artefact publie. Le garde
// check-handoff recompute ces empreintes et refuse toute derive. Provenance par empreinte de commit
// (neutre), jamais par un chemin ou un nom de depot prive. A relancer apres toute mise a jour d'un
// artefact, depuis la racine du depot d'exposition.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const RACINE = process.cwd();
const SOURCE_COMMIT = process.env.SOURCE_COMMIT || '';
const ECRIT_LE = new Date().toISOString().slice(0, 10);

// Les deux verificateurs ZK sont auto-generes depuis les circuits (snarkjs), redistribues en GPL-3.0 ;
// nos contrats du corridor FX cross-chain restent MIT (notre code permissif) ; tout le reste de notre
// surface est AGPL-3.0. Les traceurs sont des donnees, pas du code licencie.
const GPL = new Set(['HolderKycGroth16Verifier', 'SanctionsGroth16Verifier']);
const MIT = new Set(['ComplianceOFTAdapter', 'ArrivalComposerFX', 'PolicyWrapperOZ4', 'VleiAttestationPolicy']);

function sha256(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }
function spdx(p) {
  const m = readFileSync(p, 'utf8').match(/SPDX-License-Identifier:\s*([^\s]+)/);
  return m ? m[1] : null;
}
function lister(dir) {
  try { return readdirSync(join(RACINE, dir)).filter((f) => !f.startsWith('.')).sort(); }
  catch { return []; }
}

const fichiers = {};
for (const f of lister('abi')) {
  const nom = f.replace(/\.json$/, '');
  fichiers[`abi/${f}`] = { sha256: sha256(join(RACINE, 'abi', f)), licence: GPL.has(nom) ? 'GPL-3.0' : MIT.has(nom) ? 'MIT' : 'AGPL-3.0' };
}
for (const f of lister('interfaces')) {
  fichiers[`interfaces/${f}`] = { sha256: sha256(join(RACINE, 'interfaces', f)), licence: spdx(join(RACINE, 'interfaces', f)) || 'INCONNU' };
}
for (const f of lister('deployments')) {
  fichiers[`deployments/${f}`] = { sha256: sha256(join(RACINE, 'deployments', f)), licence: 'data' };
}

const manifest = {
  source: 'Aiko Academy, Programmable Compliance toolkit',
  source_commit: SOURCE_COMMIT,
  ecrit_le: ECRIT_LE,
  note: 'Surface d exposition redistribuable. Principe : ABI et interfaces reproductibles depuis la source par empreinte ; traceurs lus sur la chaine ; licences AGPL-3.0, GPL-3.0 ou MIT seulement ; aucun artefact BUSL, LZBL ni UNLICENSED ; aucune trace d outil. ABI verifiees contre le bytecode deploye par le RUNBOOK (etape en ligne, RPC).',
  licences_autorisees: ['AGPL-3.0', 'GPL-3.0', 'MIT', 'data'],
  fichiers,
};

writeFileSync(join(RACINE, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`MANIFEST.json ecrit : ${Object.keys(fichiers).length} fichiers, commit=${SOURCE_COMMIT || '(non pose)'}`);
