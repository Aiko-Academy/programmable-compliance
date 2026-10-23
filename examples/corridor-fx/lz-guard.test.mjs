// Witness of the LayerZero guard: green on a healthy channel, RED on a stored message and on an alert.
// Run: node --test examples/corridor-fx/lz-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluer, exposer } from './lz-guard.mjs';

const sain = { canaux: [{ chain: 'arbitrum-sepolia', oapp: '0xA', srcEid: 40161, pending: 0n }], alertes: [{ chain: 'arbitrum-sepolia', oapp: '0xA', count: 0 }] };

test('healthy channel: ok, no line', () => {
  const r = evaluer(sain);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lignes, []);
});
test('one stored message: refuses and names the channel', () => {
  const r = evaluer({ ...sain, canaux: [{ ...sain.canaux[0], pending: 1n }] });
  assert.equal(r.ok, false);
  assert.match(r.lignes[0], /arbitrum-sepolia 0xA srcEid 40161 : 1 stored message\(s\)/);
});
test('one LzReceiveAlert without a stored message: refuses too (replay already done, cause to read)', () => {
  const r = evaluer({ ...sain, alertes: [{ ...sain.alertes[0], count: 2 }] });
  assert.equal(r.ok, false);
  assert.match(r.lignes[0], /2 LzReceiveAlert/);
});
test('exposure: one counter per channel and per OApp', () => {
  const t = exposer({ canaux: [{ ...sain.canaux[0], pending: 3n }], alertes: sain.alertes });
  assert.match(t, /pc_lz_pending_messages\{chain="arbitrum-sepolia",oapp="0xA",srceid="40161"\} 3/);
  assert.match(t, /pc_lz_receive_alerts\{chain="arbitrum-sepolia",oapp="0xA"\} 0/);
});
