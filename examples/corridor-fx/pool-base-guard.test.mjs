// Witness of the guard: it must REFUSE a pool of wraps (naming the token) and ACCEPT a pool of base tokens.
// Run: node --test examples/corridor-fx/pool-base-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifierJetonsDeBase } from './pool-base-guard.mjs';

const EURX = '0x939731bADd5c55070f563CD0a5293e835586C91F';
const SGDX = '0x48660bd73791264d1ced1b3451e313a85d58c15b';
const WEURX = '0xA9bE00A49057a1AD5Ac16a4c610dD4434260F765';
const WSGDX = '0x50ac4aa1a067dfb22f56f61e04ac048d6ea1f2de';
const table = {
  [EURX.toLowerCase()]: { symbol: 'EURX', underlying: null },
  [SGDX.toLowerCase()]: { symbol: 'SGDX', underlying: null },
  [WEURX.toLowerCase()]: { symbol: 'wEURX', underlying: EURX },
  [WSGDX.toLowerCase()]: { symbol: 'wSGDX', underlying: SGDX },
};
const lire = async (a) => table[a.toLowerCase()];

test('pool of base tokens: accepts', async () => {
  const r = await verifierJetonsDeBase({ token0: SGDX, token1: EURX, lire });
  assert.deepEqual(r.map((x) => x.symbol), ['SGDX', 'EURX']);
});
test('token1 = wEURX: refuses and names wEURX', async () => {
  await assert.rejects(verifierJetonsDeBase({ token0: SGDX, token1: WEURX, lire }), /token1 of the pool = wEURX .* WRAP/);
});
test('token0 = wSGDX: refuses and names wSGDX', async () => {
  await assert.rejects(verifierJetonsDeBase({ token0: WSGDX, token1: EURX, lire }), /token0 of the pool = wSGDX .* WRAP/);
});
test('second barrier: a tracer token listed as a wrap is refused even when underlying() stays silent', async () => {
  const muet = async () => ({ symbol: 'wEURX', underlying: null });
  await assert.rejects(verifierJetonsDeBase({ token0: SGDX, token1: WEURX, wrapsConnus: [WEURX], lire: muet }), /wrapper from the tracker/);
});
