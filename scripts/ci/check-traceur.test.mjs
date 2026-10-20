// Chaque regle du garde se prouve sur une entree FAUSSE : node --test scripts/ci/check-traceur.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlerPasses, adressesInconnues } from './check-traceur.mjs';

const H = '0x' + 'a'.repeat(64);
const refusee = () => ({
  outcome: 'refused',
  legs: [{ chainId: 11155111, phase: 'expect_revert', tx: H, expected_revert: { error: 'E', selector: 's', policy: 'p', contains: 'c' } }],
});
const traceur = (p) => ({ demonstration_passes: { note: 'x', not_played: ['y'], p } });

test('une passe conforme ne donne aucun refus', () => {
  assert.deepEqual(controlerPasses(traceur(refusee())), []);
  assert.deepEqual(controlerPasses(traceur({ outcome: 'settled', legs: [{ chainId: 421614, phase: 'lock', tx: H }] })), []);
});
test('issue inconnue', () => {
  const p = refusee(); p.outcome = 'maybe';
  assert.match(controlerPasses(traceur(p))[0], /issue inconnue/);
});
test('hash trop court, majuscules, chaine etrangere', () => {
  for (const [champ, v, motif] of [['tx', '0x' + 'a'.repeat(63), /hash/], ['tx', '0x' + 'A'.repeat(64), /hash/], ['chainId', 1, /hors du corridor/]]) {
    const p = refusee(); p.legs[0][champ] = v;
    assert.match(controlerPasses(traceur(p)).join('|'), motif);
  }
});
test('expect_revert sans expected_revert, ou champ vide', () => {
  let p = refusee(); delete p.legs[0].expected_revert;
  assert.match(controlerPasses(traceur(p)).join('|'), /expected_revert absent/);
  p = refusee(); p.legs[0].expected_revert.contains = '';
  assert.match(controlerPasses(traceur(p)).join('|'), /contains absent ou vide/);
});
test('selector present mais vide', () => {
  const p = refusee(); p.legs[0].expected_revert.selector = '';
  assert.match(controlerPasses(traceur(p)).join('|'), /selector present mais vide/);
});
test('refus sans jambe expect_revert', () => {
  const p = refusee(); p.legs[0].phase = 'lock';
  assert.match(controlerPasses(traceur(p)).join('|'), /sans jambe expect_revert/);
});
test('passe sans jambe', () => {
  assert.match(controlerPasses(traceur({ outcome: 'settled', legs: [] }))[0], /aucune jambe/);
});
test('adresse du RUNBOOK absente du traceur', () => {
  const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
  assert.deepEqual(adressesInconnues({ 'RUNBOOK.md': `voir ${a}` }, [`{"x":"${a.toUpperCase().replace('0X', '0x')}"}`]), []);
  assert.match(adressesInconnues({ 'RUNBOOK.md': `voir ${b}` }, [`{"x":"${a}"}`])[0], /RUNBOOK.md/);
});
