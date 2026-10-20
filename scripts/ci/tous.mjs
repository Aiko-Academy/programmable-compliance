#!/usr/bin/env node
// Enchaine les portes HORS LIGNE de la surface d'exposition. --rapide ne joint ni la chaine ni un
// depot voisin : il peut donc refuser AVANT un push, en une seconde. Les portes EN LIGNE (bytecode
// deploye contre la source) vivent dans le RUNBOOK, pas ici.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICI = dirname(fileURLToPath(import.meta.url));
const portes = [['check-handoff', 'check-handoff.mjs'], ['check-traceur', 'check-traceur.mjs']];
let echecs = 0;
for (const [nom, script] of portes) {
  console.log(`\n# ${nom}`);
  const r = spawnSync(process.execPath, [join(ICI, script)], { stdio: 'inherit' });
  if (r.status !== 0) echecs++;
}
process.exit(echecs ? 1 : 0);
