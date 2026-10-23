#!/usr/bin/env node
// examples/transfer: the first use case of the demonstration, played against a local or remote chain.
//
//   1. Deploy       : the pack's foundation (verifiers, registries, Policy Manager, policies)
//   2. ExampleToken : a token to wrap, with a balance at bank A (anvil only)
//   3. DeployWrapper: a Policy Wrapper on that token, the pipeline in place (presence, binding, identity, verification)
//   4. Admit        : the two banks (identity by LEI, KYB credential) and the Compliance Rules Engine key
//   5. SDK          : envelope -> enrichment -> evaluation (example CheckProvider) -> signed attestation
//                     -> wrap -> transfer under policy -> refusal of a transfer without attestation -> unwrap
//   6. records      : the evidencing records of each action, written as line-delimited JSON
//
//   RPC=http://127.0.0.1:8545 PRIVATE_KEY_A=0x... PRIVATE_KEY_B=0x... node examples/transfer/run.mjs
//   (by default: anvil, anvil accounts 0 and 1; `bash examples/transfer/run.sh` starts anvil and chains the steps)

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, NonceManager, Contract, keccak256, toUtf8Bytes, formatUnits } from 'ethers';
import {
  buildEnvelope, hashEnvelope, enrich, readPolicyVersion, buildAttestation, InstitutionSigner,
  wrap, unwrap, transferUnderPolicy, describeRefusal, RecordStore, explorerTx, WRAPPER_ABI,
} from '../../sdk/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const toolkit = join(here, '..', '..');
const RPC = process.env.RPC ?? 'http://127.0.0.1:8545';
const KEY_A = process.env.PRIVATE_KEY_A ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const KEY_B = process.env.PRIVATE_KEY_B ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// cacheTimeout -1: ethers caches "latest" reads for 250 ms, including the nonce; against an instant-block chain
// (anvil) a cached nonce is a wrong nonce.
const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const walletA = new Wallet(KEY_A, provider);
const walletB = new Wallet(KEY_B, provider);
const bankA = Object.assign(new NonceManager(walletA), { address: walletA.address });
const bankB = Object.assign(new NonceManager(walletB), { address: walletB.address });
const { chainId } = await provider.getNetwork();
const cid = Number(chainId);
const forgeEnv = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` };
const forge = (args, env = {}) => execFileSync('forge', args, { cwd: toolkit, env: { ...forgeEnv, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const step = (t) => console.log(`\n== ${t}`);

mkdirSync(join(toolkit, 'deployments'), { recursive: true });
const records = new RecordStore(join(here, 'evidencing-records.jsonl'));
const CHECKS = ['customer-due-diligence', 'sanctions-screening', 'transaction-threshold'];

// 1. the foundation
step('1. Deploy : the pack\'s foundation');
forge(['script', 'scripts/Deploy.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEY_A, '-q']);
const core = JSON.parse(readFileSync(join(toolkit, 'deployments', `${cid}.json`), 'utf8'));
console.log('PolicyManager', core.PolicyManager, ', IdentityRegistry', core.IdentityRegistry);

// 2. the example token
step('2. ExampleToken : a token to wrap');
forge(['script', 'scripts/DeployExampleToken.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEY_A, '-q'], { HOLDER: bankA.address });
const underlying = JSON.parse(readFileSync(join(toolkit, 'deployments', `${cid}-example-token.json`), 'utf8')).ExampleToken;
console.log('underlying', underlying);

// 3. the wrapper and its pipeline
step('3. DeployWrapper : the Policy Wrapper and its four policies');
forge(['script', 'scripts/DeployWrapper.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEY_A, '-q'], {
  UNDERLYING: underlying, WRAPPER_NAME: 'Policy Wrapper wEUR', WRAPPER_SYMBOL: 'wCBDC-EUR', REQUIRED_CHECKS: CHECKS.join(','), POLICY_LABEL: '2026.09-01',
});
const wrapperJson = JSON.parse(readFileSync(join(toolkit, 'deployments', `${cid}-wCBDC-EUR.json`), 'utf8'));
const wrapper = wrapperJson.PolicyWrapper;
console.log('wrapper', wrapper, ', policy version', wrapperJson.policyVersion, ', descriptor', wrapperJson.policyDescriptor.slice(0, 18));
records.add({ actionType: 'policy-version-set', transactionOrEventId: `wrapper:${wrapper}`, affectedObject: 'Policy Manager', actor: bankA.address, outcome: `version ${wrapperJson.policyVersion} (2026.09-01)`, chainId: cid });

// 4. the admissions
step('4. Admit : two banks, one Compliance Rules Engine key');
const cre = InstitutionSigner.random(keccak256(toUtf8Bytes('compliance-rules-engine:example')));
const admit = (account, lei) => forge(['script', 'scripts/Admit.s.sol', '--sig', 'admitParty(address,string,bytes32,bytes32,uint40)', account, lei,
  keccak256(toUtf8Bytes('schema:vLEI:LE')), keccak256(toUtf8Bytes(`cred:${lei}`)), String(Math.floor(Date.now() / 1000) + 365 * 86400),
  '--rpc-url', RPC, '--broadcast', '--private-key', KEY_A, '-q']);
admit(bankA.address, '969500FX8K40ZDW4F377');
admit(bankB.address, 'IO66REGK3RCBAMA8HR66');
forge(['script', 'scripts/Admit.s.sol', '--sig', 'registerSigner(bytes32,bytes32,bytes32)', cre.orgId, cre.qx, cre.qy, '--rpc-url', RPC, '--broadcast', '--private-key', KEY_A, '-q']);
console.log('bank A', bankA.address, ', bank B', bankB.address, ', signer qx', cre.qx.slice(0, 12));
records.add({ actionType: 'party-admitted', transactionOrEventId: 'onboarding', affectedObject: 'Identity Manager', actor: bankA.address, outcome: 'bank A and bank B: identity and KYB credential', chainId: cid });

bankA.reset();
bankB.reset();

// 5. the SDK
step('5. SDK : envelope, enrichment, evaluation, attestation, wrap, transfer, refusal, unwrap');
const w = new Contract(wrapper, WRAPPER_ABI, provider);
const decimals = Number(await w.decimals());
const amount = 1_000_000n * 10n ** BigInt(decimals);
const envelope0 = buildEnvelope({
  asset: wrapper, amount, mediationPattern: 'Entity-to-Entity',
  parties: [
    { role: 'originator', wallet: bankA.address, jurisdiction: 'FR', offLedgerData: { name: 'French Bank', lei: '969500FX8K40ZDW4F377' } },
    { role: 'beneficiary', wallet: bankB.address, jurisdiction: 'SG', offLedgerData: { name: 'Singapore Bank', lei: 'IO66REGK3RCBAMA8HR66' } },
  ],
});
records.add({ actionType: 'envelope-construction', transactionOrEventId: envelope0.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: bankA.address, outcome: 'envelope created, 2 Party Packets', chainId: cid });

const kyb = keccak256(toUtf8Bytes('common.kyb'));
const { envelope, evidence } = await enrich(envelope0, provider, { identityRegistry: core.IdentityRegistry, credentialRegistry: core.CredentialRegistry, credentialType: kyb });
for (const e of evidence) console.log('identity', e.wallet.slice(0, 10), 'ccid', e.ccid.slice(0, 10), 'credential', e.credentialValid ? 'valid' : 'missing', e.lei ?? '');
records.add({ actionType: 'eligibility-decision', transactionOrEventId: envelope.uetr, affectedObject: 'Identity Manager', actor: 'Identity Manager', outcome: evidence.every((e) => e.credentialValid) ? '2 KYB credentials valid' : 'a credential is missing', chainId: cid });

// The example Compliance Rules Engine: three checks, the cap at 5 million; a real engine plugs in here.
const provider3 = {
  async evaluate(env, checks) {
    return checks.map((check) => {
      if (check === 'customer-due-diligence') return { check, outcome: evidence.every((e) => e.credentialValid) ? 'PASS' : 'FAIL', evidence: 'KYB credential (vLEI) on chain', trustedIssuer: 'GLEIF QVI' };
      if (check === 'sanctions-screening') return { check, outcome: 'PASS', evidence: 'no party on the list (example provider)', trustedIssuer: 'sanctions list publisher' };
      if (check === 'transaction-threshold') return { check, outcome: env.amount <= 5_000_000n * 10n ** BigInt(decimals) ? 'PASS' : 'FAIL', evidence: 'amount under the cap' };
      return { check, outcome: 'FURTHER_HANDLING' };
    });
  },
};
const results = await provider3.evaluate(envelope, CHECKS);
const version = await readPolicyVersion(provider, core.PolicyManager, wrapper);
const attestation = buildAttestation({
  envelope, envelopeHash: hashEnvelope(envelope), leg: { uetr: envelope.uetr, from: bankA.address, to: bankB.address, amount, asset: wrapper },
  results, policyVersion: version, signer: cre, domain: { chainId: cid, verifyingContract: core.InstitutionSignatureVerifier },
});
console.log('attestation', attestation.id, attestation.outcome, results.map((r) => `${r.check}=${r.outcome}`).join(' '), ', policy', version.label, ', hash', attestation.hash.slice(0, 18));
records.add({ actionType: 'compliance-evaluation', transactionOrEventId: envelope.uetr, affectedObject: 'Compliance Rules Engine', actor: 'Compliance Rules Engine', outcome: `${attestation.outcome}, ${results.length} checks, attestation ${attestation.id}`, chainId: cid });

const wrapRcpt = await wrap(bankA, wrapper, underlying, bankA.address, amount);
console.log('wrap', wrapRcpt.hash, explorerTx(cid, wrapRcpt.hash));
records.add({ actionType: 'wrap', transactionOrEventId: envelope.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: bankA.address, outcome: `${formatUnits(amount, decimals)} wrapped`, tx: wrapRcpt.hash, chainId: cid });

const t = await transferUnderPolicy(bankA, wrapper, bankB.address, amount, attestation.context);
console.log('transfer under policy', t.transferTx, explorerTx(cid, t.transferTx), ', balance B', formatUnits(await w.balanceOf(bankB.address), decimals));
records.add({ actionType: 'transfer-under-policy', transactionOrEventId: envelope.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: bankA.address, outcome: `PASS, attestation ${attestation.id} consumed`, tx: t.transferTx, chainId: cid });

// The refusal: the same transfer without an attestation in context.
try {
  await (new Contract(wrapper, WRAPPER_ABI, bankB)).transfer(bankA.address, 1n);
  throw new Error('a transfer without attestation passed');
} catch (err) {
  bankB.reset(); // the NonceManager incremented for a transaction that was never sent
  const r = describeRefusal(err);
  if (!r.reason.includes('no compliance checks supplied')) throw err;
  console.log('refused as expected :', r.reason, ', policy', r.policy);
  records.add({ actionType: 'transfer-refused', transactionOrEventId: envelope.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: bankB.address, outcome: r.reason, chainId: cid });
}

// The replay: the same attestation a second time.
try {
  await transferUnderPolicy(bankB, wrapper, bankA.address, amount, attestation.context);
  throw new Error('a replayed attestation passed');
} catch (err) {
  bankB.reset();
  const r = describeRefusal(err);
  if (!r.reason.includes('not bound') && !r.reason.includes('already used')) throw err;
  console.log('replay refused as expected :', r.reason);
}

const unwrapRcpt = await unwrap(bankB, wrapper, bankB.address, amount);
console.log('unwrap', unwrapRcpt.hash, ', underlying at B', formatUnits(await (new Contract(underlying, ['function balanceOf(address) view returns (uint256)'], provider)).balanceOf(bankB.address), decimals));
records.add({ actionType: 'unwrap', transactionOrEventId: envelope.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: bankB.address, outcome: `${formatUnits(amount, decimals)} unwrapped`, tx: unwrapRcpt.hash, chainId: cid });

step(`6. ${records.records.length} evidencing records in ${join(here, 'evidencing-records.jsonl')}`);
console.log(records.toCsv().split('\n').slice(0, 4).join('\n'));
console.log('\nexample transfer : OK');
