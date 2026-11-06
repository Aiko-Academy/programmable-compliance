// Witness of the guard: it must REFUSE a pass the payer cannot wrap (the case of 2026-11-06) and ACCEPT one it can,
// for the compliant pass (whole amount) and for the other passes (only what wEURX does not cover); and `funds` must
// mint enough for a compliant pass followed by a return pass.
// Run: node --test examples/corridor-fx/wrap-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { eurxDuWrap, eurxPourDeuxPasses, refusWrap } from './wrap-guard.mjs';

const E = 10n ** 18n;
const M = 1000n * E;

test('compliant pass, 0 EURX beside 1000 wEURX (2026-11-06): refuses, 1000 missing', () => {
  assert.deepEqual(eurxDuWrap({ montant: M, eurx: 0n, weurx: M, toutEnvelopper: true }), { besoin: M, manque: M });
});

test('compliant pass, exactly the amount in plain EURX: accepts', () => {
  assert.equal(eurxDuWrap({ montant: M, eurx: M, weurx: 0n, toutEnvelopper: true }).manque, 0n);
});

test('other pass, wEURX already covers the amount: needs no plain EURX', () => {
  assert.deepEqual(eurxDuWrap({ montant: M, eurx: 0n, weurx: M, toutEnvelopper: false }), { besoin: 0n, manque: 0n });
});

test('other pass, wEURX covers part: refuses for the rest only', () => {
  assert.deepEqual(eurxDuWrap({ montant: M, eurx: 100n * E, weurx: 600n * E, toutEnvelopper: false }), { besoin: 400n * E, manque: 300n * E });
});

test('funds: 2000 wEURX and no plain EURX still mints the compliant wrap', () => {
  assert.equal(eurxPourDeuxPasses({ montant: M, eurx: 0n, weurx: 2n * M }), M);
});

test('funds: from empty, mints two wraps; with both funded, mints nothing', () => {
  assert.equal(eurxPourDeuxPasses({ montant: M, eurx: 0n, weurx: 0n }), 2n * M);
  assert.equal(eurxPourDeuxPasses({ montant: M, eurx: M, weurx: M }), 0n);
});

test('the refusal names both amounts and the remedy', () => {
  assert.equal(refusWrap('0.0', '1000.0'), 'the payer holds 0.0 plain EURX and the wrap needs 1000.0: play funds first; nothing is sent');
});
