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

// Refus sans transaction (vlei_refusals_without_transaction) et controle de contrepartie (counterparty_check).
const sansTx = () => ({
  name: 'r1', outcome: 'refused', transaction_emitted: false, reason: 'raison', read_only_evidence: ['runFor : PolicyRejected'],
});
const avecSansTx = (...r) => ({ demonstration_passes: { note: 'x', vlei_refusals_without_transaction: r } });
test('un refus sans transaction conforme ne donne aucun refus', () => {
  assert.deepEqual(controlerPasses(avecSansTx(sansTx())), []);
});
test('refus sans transaction : liste attendue, issue, transaction_emitted, jambe, hash, raison, temoin, doublon', () => {
  assert.match(controlerPasses({ demonstration_passes: { vlei_refusals_without_transaction: {} } }).join('|'), /une liste est attendue/);
  for (const [muter, motif] of [
    [(r) => { r.outcome = 'settled'; }, /seul refused/],
    [(r) => { r.transaction_emitted = true; }, /transaction_emitted/],
    [(r) => { delete r.transaction_emitted; }, /transaction_emitted/],
    [(r) => { r.legs = []; }, /ni jambe ni tx/],
    [(r) => { r.tx = H; }, /ni jambe ni tx/],
    [(r) => { r.read_only_evidence = [`voir ${H}`]; }, /hash de 32 octets/],
    [(r) => { r.reason = ''; }, /reason absent/],
    [(r) => { r.read_only_evidence = []; }, /read_only_evidence/],
    [(r) => { delete r.name; }, /name absent/],
  ]) {
    const r = sansTx(); muter(r);
    assert.match(controlerPasses(avecSansTx(r)).join('|'), motif);
  }
  assert.match(controlerPasses(avecSansTx(sansTx(), sansTx())).join('|'), /name en double/);
});
const H2 = '0x' + 'b'.repeat(64);
const reglee = () => ({
  outcome: 'settled',
  legs: [{ chainId: 11155111, phase: 'lock', tx: H }, { chainId: 421614, phase: 'swap+deliver', tx: H2 }],
  counterparty_check: {
    payer: { wallet: '0x1', lei_presented: 'L1', lei_expected: 'L1', role: 1, verifiedAt: '2026-10-22T00:59:26Z', relied_upon: { chainId: 11155111, tx: H, policy: 'p' } },
    beneficiary: { wallet: '0x2', lei_presented: 'L2', lei_expected: 'L2', role: 1, verifiedAt: '2026-10-22T00:59:27Z', relied_upon: { chainId: 421614, tx: H2, policy: 'q' } },
  },
});
test('controle de contrepartie conforme, puis chaque champ fausse', () => {
  assert.deepEqual(controlerPasses(traceur(reglee())), []);
  for (const [muter, motif] of [
    [(p) => { p.counterparty_check.payer.lei_expected = ''; }, /lei_expected absent/],
    [(p) => { p.counterparty_check.payer.role = 'OOR'; }, /role entier/],
    [(p) => { p.counterparty_check.beneficiary.verifiedAt = '22/10/2026'; }, /verifiedAt/],
    [(p) => { p.counterparty_check.beneficiary.relied_upon.tx = H; }, /aucune jambe de la passe sur la chaine 421614/],
    [(p) => { p.counterparty_check.payer.relied_upon.chainId = 1; }, /relied_upon sans chaine/],
    [(p) => { p.counterparty_check = {}; }, /sans payer ni beneficiary/],
  ]) {
    const p = reglee(); muter(p);
    assert.match(controlerPasses(traceur(p)).join('|'), motif);
  }
});
