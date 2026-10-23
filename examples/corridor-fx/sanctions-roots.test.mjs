// Witness of the roots drift guard: green on two identical and fresh roots, RED on each defect.
// Run: node --test examples/corridor-fx/sanctions-roots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparer, FENETRE_PAR_DEFAUT_S } from './sanctions-roots.mjs';

const R1 = '0x' + '11'.repeat(32), R2 = '0x' + '22'.repeat(32);
const now = 1_789_000_000;
const sep = { chain: 'sepolia', root: R1, publishedAt: now - 100, listVersion: 3n };
const arb = { chain: 'arbitrum-sepolia', root: R1, publishedAt: now - 120, listVersion: 3n };

test('two identical and fresh roots: no discrepancy', () => assert.deepEqual(comparer(sep, arb, { now }), []));
test('different roots: refuses and names both chains', () => {
  const e = comparer(sep, { ...arb, root: R2 }, { now });
  assert.match(e.join('|'), /different roots: sepolia .* against arbitrum-sepolia/);
});
test('different list versions: refuses', () => assert.match(comparer(sep, { ...arb, listVersion: 4n }, { now }).join('|'), /different list versions/));
test('stale root on one chain: refuses and names the chain', () => {
  const e = comparer({ ...sep, publishedAt: now - 90000 }, { ...arb, publishedAt: now - 90000 }, { now, toleranceS: 10, maxAgeS: 86400 });
  assert.match(e.join('|'), /sepolia: stale root/);
});
test('publication gap beyond the tolerance: refuses', () => {
  const e = comparer(sep, { ...arb, publishedAt: now - 1500 }, { now, toleranceS: 600 });
  assert.match(e.join('|'), /publication gap 1400 s/);
});
test('no root published: refuses (an absence is not a green)', () => {
  const e = comparer({ ...sep, root: '0x' + '00'.repeat(32) }, arb, { now });
  assert.match(e.join('|'), /sepolia: no root published/);
});
test('default 7-day window: a root of 90000 s is valid, one of 700000 s is stale', () => {
  assert.equal(FENETRE_PAR_DEFAUT_S, 604800);
  assert.deepEqual(comparer({ ...sep, publishedAt: now - 90000 }, { ...arb, publishedAt: now - 90000 }, { now, toleranceS: 10 }), []);
  assert.match(comparer({ ...sep, publishedAt: now - 700000 }, { ...arb, publishedAt: now - 700000 }, { now, toleranceS: 10 }).join('|'), /stale root/);
});
