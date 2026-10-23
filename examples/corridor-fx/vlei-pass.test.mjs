// Deterministic witnesses of the live pass's vLEI integration (no network): the shape of the extended context, read by the
// policies already in place AND by the vLEI policy, and the decoding of the VleiReliedUpon events compared against the attester's report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, ZeroHash, hexlify, toUtf8Bytes, id as idOf, Wallet, getAddress } from 'ethers';
import { enc, encVlei, relianceVlei } from './live-pass.mjs';
import { PROOF_ABI, POLICY_ABI } from '../../vlei/attester/attester.mjs';

const ITEMS = 'tuple(uint8 kind,bytes32 orgId,tuple(bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp) sig,bytes32 r,bytes32 s,bytes32 qx,bytes32 qy)[]';
const UETR = '0x538a859d49a9960cbce077e6d61df36f';
const items = [0, 1].map((i) => [i, idOf('node'), [UETR, i ? 'transaction-threshold' : 'customer-due-diligence', true, ZeroHash, ZeroHash, 1_788_999_990n], ZeroHash, ZeroHash, ZeroHash, ZeroHash]);
const WALLET = getAddress('0x7c0984484391d6cd7bfc68d12d1fd3c48f1bbb38');
const ATT = [UETR, WALLET, hexlify(toUtf8Bytes('DEMO00FIFRPAYER00119')), 1, idOf('oor'), idOf('holder'), idOf('root'), ZeroHash, 0n, getAddress('0x738de4a03a18891e07ff001323ca4d150d4b2c84'), 11155111n, 1_792_000_000n, idOf('terms'), 1, idOf('dispute'), idOf('source')];
const PREUVE = [ATT, idOf('r'), idOf('s'), 27];

test('extended context: first word = 640 (the offset the vLEI policy requires), same array for the policies already in place', () => {
  const plat = enc(items), etendu = encVlei(items, PREUVE);
  assert.equal(BigInt(etendu.slice(0, 66)), 640n, '1 head word + 19 static words of VleiProof');
  const c = AbiCoder.defaultAbiCoder();
  assert.deepEqual(c.decode([ITEMS], etendu).toArray(true), c.decode([ITEMS], plat).toArray(true), 'a policy that decodes abi.encode(items) reads the same array');
  const [, p] = c.decode([ITEMS, PROOF_ABI], etendu);
  assert.equal(p.att.wallet, WALLET);
  assert.equal(p.att.uetr, UETR);
  assert.equal(Number(p.v), 27);
});

test('relianceVlei: decodes the policy VleiReliedUpon, LEI in clear, agreement with the attester, other addresses ignored', () => {
  const pol = getAddress('0x7f2f0e02ee528b991ff527ceacbfef767bebb237');
  const verif = Wallet.createRandom().address;
  const iface = new Interface(POLICY_ABI);
  const ev = iface.getEvent('VleiReliedUpon');
  const { data, topics } = iface.encodeEventLog(ev, [ATT[9], UETR, WALLET, ATT[2], 1, ATT[4], ATT[5], ATT[6], ZeroHash, ATT[11], [ATT[12], ATT[13], ATT[14], ATT[15]], verif]);
  const recu = { hash: '0x' + '11'.repeat(32), blockNumber: 42, logs: [{ address: pol, data, topics }, { address: getAddress('0x' + '22'.repeat(20)), data, topics }] };
  const rapport = {
    lei: 'DEMO00FIFRPAYER00119', roleAttestation: 1, attester: verif, wallet: WALLET, verifiedAt: new Date(1_792_000_000 * 1000).toISOString(),
    digests: { credentialSaid: ATT[4], holderAid: ATT[5], rootAid: ATT[6], mandateSaid: ZeroHash },
    terms: { termsHash: ATT[12], allocation: ATT[13], disputeRef: ATT[14], sourceRef: ATT[15] },
  };
  const [e, autre] = relianceVlei(recu, pol, 'sepolia', rapport);
  assert.equal(autre, undefined, 'a log from another address is not a trace of the policy');
  assert.equal(e.lei, 'DEMO00FIFRPAYER00119');
  assert.equal(e.role, 1);
  assert.equal(e.uetr, UETR);
  assert.equal(e.wallet, WALLET);
  assert.equal(e.matches_the_attester, true);
  assert.deepEqual(e.terms, { termsHash: ATT[12], allocation: 1, disputeRef: ATT[14], sourceRef: ATT[15] }, 'the terms invoked are decoded');
  const [t] = relianceVlei(recu, pol, 'sepolia', { ...rapport, terms: { ...rapport.terms, termsHash: idOf('other terms') } });
  assert.equal(t.matches_the_attester, false, 'other terms than the attester report do not match');
  const [f] = relianceVlei(recu, pol, 'sepolia', { ...rapport, attester: Wallet.createRandom().address });
  assert.equal(f.matches_the_attester, false, 'another signer does not match');
  assert.equal(e.subject, ATT[9], 'the subject is the wrapper');
});
