#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0
// examples/repo: the second use case of the demonstration, a tokenized repo settled leg by leg on two
// Policy Wrappers, played against a local or remote chain.
//
//   1. Deploy           : the pack's foundation
//   2. tokens           : a cash (ExampleToken, 18 decimals) at the lender, a tokenised money market fund (TokenisedMoneyMarketFund,
//                         NAV per share) at the borrower
//   3. DeployWrapper x2 : wCASH (checks: counterparty due diligence, holder KYC attestation) and
//                         wFUND (investor eligibility as well), same pipeline
//   4. Admit            : borrower, lender, liquidator (identity by LEI, KYB credential), engine key
//   5. SDK, opening     : one envelope, two legs (collateral borrower -> lender, cash lender -> borrower),
//                         one attestation PER LEG (the checks the leg's wrapper requires, on the leg's
//                         parties), two transfers under policy
//   6. signed price     : the collateral value at the reference price, the LTV against the threshold, isHealthy
//   7. liquidation      : the price drops, the position is no longer healthy; a liquidator unknown to the Identity
//                         Manager is refused at evaluation (nothing is submitted); the admitted liquidator pays the
//                         debt to the lender and receives the collateral, two legs under policy
//   8. records          : the evidencing records of each action, as line-delimited JSON
//
//   RPC=http://127.0.0.1:8545 node examples/repo/run.mjs   (by default: anvil, anvil accounts 0, 1 and 2;
//   `bash examples/repo/run.sh` starts anvil and chains the steps)
//
// Why leg by leg and not through a pool: a Policy Wrapper consumes the context of `msg.sender`, a pool
// that executes `transferFrom` itself never presents an attestation. That is the intended behavior.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, NonceManager, Contract, keccak256, toUtf8Bytes, formatUnits, parseUnits } from 'ethers';
import {
  buildEnvelope, hashEnvelope, enrich, readPolicyVersion, buildAttestation, InstitutionSigner,
  wrap, transferUnderPolicy, describeRefusal, RecordStore, explorerTx, WRAPPER_ABI,
} from '../../sdk/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const toolkit = join(here, '..', '..');
const RPC = process.env.RPC ?? 'http://127.0.0.1:8545';
const KEYS = [
  process.env.PRIVATE_KEY_A ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  process.env.PRIVATE_KEY_B ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  process.env.PRIVATE_KEY_C ?? '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const [borrower, lender, liquidator] = KEYS.map((k) => { const w = new Wallet(k, provider); return Object.assign(new NonceManager(w), { address: w.address }); });
const stranger = Wallet.createRandom().address; // a liquidator the Identity Manager does not know
const cid = Number((await provider.getNetwork()).chainId);
const forgeEnv = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` };
const forge = (args, env = {}) => execFileSync('forge', args, { cwd: toolkit, env: { ...forgeEnv, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const step = (t) => console.log(`\n== ${t}`);
const dep = (f) => JSON.parse(readFileSync(join(toolkit, 'deployments', f), 'utf8'));
mkdirSync(join(toolkit, 'deployments'), { recursive: true });
const records = new RecordStore(join(here, 'evidencing-records.jsonl'));

// 1. the foundation
step('1. Deploy : the pack\'s foundation');
forge(['script', 'scripts/Deploy.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q']);
const core = dep(`${cid}.json`);
console.log('PolicyManager', core.PolicyManager);

// 2. the tokens: the cash at the lender, the fund at the borrower
step('2. Tokens : cash (ExampleToken) at the lender, tokenised money market fund tMMF1 (TokenisedMoneyMarketFund) at the borrower');
forge(['script', 'scripts/DeployExampleToken.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q'], { HOLDER: lender.address, TOKEN_NAME: 'Example central bank money', TOKEN_SYMBOL: 'wSGD' });
const cash = dep(`${cid}-example-token.json`).ExampleToken;
forge(['script', 'scripts/DeployRepoAssets.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q'], { HOLDER: borrower.address, SHARES: String(1_000n * 10n ** 18n), NAV_USD_1E2: '10700' });
const fund = dep(`${cid}-tMMF1-token.json`).tMMF1;
console.log('cash', cash, ', fund', fund);

// 3. the two wrappers
step('3. DeployWrapper : wCASH and wFUND, same pipeline, their own checks');
forge(['script', 'scripts/DeployWrapper.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q'],
  { UNDERLYING: cash, WRAPPER_NAME: 'Policy Wrapper cash', WRAPPER_SYMBOL: 'wCASH', REQUIRED_CHECKS: 'counterparty-due-diligence,holder-kyc-attestation', POLICY_LABEL: '2026.09-02' });
forge(['script', 'scripts/DeployWrapper.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q'],
  { UNDERLYING: fund, WRAPPER_NAME: 'Policy Wrapper fund', WRAPPER_SYMBOL: 'wFUND', REQUIRED_CHECKS: 'investor-eligibility,counterparty-due-diligence,holder-kyc-attestation', POLICY_LABEL: '2026.09-02' });
const wCash = dep(`${cid}-wCASH.json`).PolicyWrapper, wFund = dep(`${cid}-wFUND.json`).PolicyWrapper;
console.log('wCASH', wCash, ', wFUND', wFund);

// 4. the admissions
step('4. Admit : borrower, lender, liquidator, Compliance Rules Engine key');
const engine = InstitutionSigner.random(keccak256(toUtf8Bytes('compliance-rules-engine:example')));
const admit = (account, lei) => forge(['script', 'scripts/Admit.s.sol', '--sig', 'admitParty(address,string,bytes32,bytes32,uint40)', account, lei,
  keccak256(toUtf8Bytes('schema:vLEI:LE')), keccak256(toUtf8Bytes(`cred:${lei}`)), String(Math.floor(Date.now() / 1000) + 365 * 86400),
  '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q']);
admit(borrower.address, '969500FX8K40ZDW4F377');
admit(lender.address, 'IO66REGK3RCBAMA8HR66');
admit(liquidator.address, '1VUV7VQFKUOQSJ21A208');
forge(['script', 'scripts/Admit.s.sol', '--sig', 'registerSigner(bytes32,bytes32,bytes32)', engine.orgId, engine.qx, engine.qy, '--rpc-url', RPC, '--broadcast', '--private-key', KEYS[0], '-q']);
for (const s of [borrower, lender, liquidator]) s.reset();
records.add({ actionType: 'party-admitted', transactionOrEventId: 'onboarding', affectedObject: 'Identity Manager', actor: borrower.address, outcome: 'borrower, lender, liquidator: identity and KYB credential', chainId: cid });

// 5. the opening, leg by leg
step('5. Opening : one envelope, two legs, one attestation per leg');
const wc = new Contract(wCash, WRAPPER_ABI, provider), wf = new Contract(wFund, WRAPPER_ABI, provider);
const decCash = Number(await wc.decimals()), decFund = Number(await wf.decimals());
const kyb = keccak256(toUtf8Bytes('common.kyb'));
const ids = { identityRegistry: core.IdentityRegistry, credentialRegistry: core.CredentialRegistry, credentialType: kyb };
// the reference price: 98.44 cash units per share, at the Morpho scale (1e36 + dec cash - dec fund)
const scale = 10n ** BigInt(36 + decCash - decFund);
const price36 = (v) => parseUnits(v, 6) * scale / 10n ** 6n;
let price = price36('98.44');
const collateral = parseUnits('100', decFund);
const value = (p) => collateral * p / 10n ** 36n;
const cashAmount = value(price) * 9350n / 10000n; // initial LTV 93.50 %
const LLTV = 9650n;
const env0 = buildEnvelope({
  asset: wCash, amount: cashAmount, mediationPattern: 'Entity-to-Entity',
  parties: [
    { role: 'borrower', wallet: borrower.address, jurisdiction: 'SG', offLedgerData: { name: 'Singapore Bank', lei: 'IO66REGK3RCBAMA8HR66', side: 'collateral provider' } },
    { role: 'lender', wallet: lender.address, jurisdiction: 'FR', offLedgerData: { name: 'French Bank', lei: '969500FX8K40ZDW4F377', side: 'cash provider' } },
    { role: 'liquidator', wallet: liquidator.address, jurisdiction: 'FR', offLedgerData: { name: 'FX dealer', lei: '1VUV7VQFKUOQSJ21A208', side: 'liquidator (identified CASP)' } },
  ],
});
let { envelope, evidence } = await enrich(env0, provider, ids);
records.add({ actionType: 'envelope-construction', transactionOrEventId: envelope.uetr, affectedObject: 'Repo GMRA-EXAMPLE-0001', actor: borrower.address, outcome: `3 Party Packets, ${formatUnits(cashAmount, decCash)} wCASH against ${formatUnits(collateral, decFund)} wFUND, Travel Rule data off-ledger`, chainId: cid });

// The example Compliance Rules Engine: on the parties of a leg, from what the Identity Manager returns.
const known = (w) => evidence.find((e) => e.wallet.toLowerCase() === w.toLowerCase());
const evaluate = (checks, subjects) => checks.map((check) => {
  const missing = subjects.filter((s) => !(known(s)?.credentialValid));
  const ok = missing.length === 0;
  const who = missing.map((m) => m.slice(0, 8)).join(', ');
  if (check === 'counterparty-due-diligence') return { check, outcome: ok ? 'PASS' : 'FAIL', evidence: ok ? 'vLEI credential valid on chain for each party' : `no valid KYB credential for ${who}`, trustedIssuer: 'GLEIF QVI' };
  if (check === 'holder-kyc-attestation') return { check, outcome: ok ? 'PASS' : 'FAIL', evidence: ok ? 'KYC attestation of a trusted issuer for each holder' : `no attestation by a trusted KYC issuer for ${who}`, trustedIssuer: 'KYC issuers set' };
  if (check === 'investor-eligibility') return { check, outcome: ok ? 'PASS' : 'FAIL', evidence: ok ? 'category Professional client' : `no eligibility credential for ${who}`, trustedIssuer: 'fund distributor' };
  return { check, outcome: 'FURTHER_HANDLING' };
});
async function attest(leg, wrapper, from, to, amount) {
  const w = new Contract(wrapper, WRAPPER_ABI, provider);
  const version = await readPolicyVersion(provider, core.PolicyManager, wrapper);
  const checks = (await (new Contract(core.RequiredChecksPolicy, ['function requiredChecks(address) view returns (string[])'], provider)).requiredChecks(wrapper)).map(String);
  const results = evaluate(checks, [from, to]);
  const a = buildAttestation({ envelope, envelopeHash: hashEnvelope(envelope), leg: { uetr: envelope.uetr, from, to, amount, asset: wrapper }, results, policyVersion: version, signer: engine, domain: { chainId: cid, verifyingContract: core.InstitutionSignatureVerifier } });
  console.log(`attestation ${leg}: ${a.outcome} ${results.map((r) => `${r.check}=${r.outcome}`).join(' ')}, ${formatUnits(amount, Number(await w.decimals()))} ${await w.symbol()}`);
  records.add({ actionType: 'compliance-evaluation', transactionOrEventId: envelope.uetr, affectedObject: `${leg} leg, Policy Wrapper ${wrapper}`, actor: 'Compliance Rules Engine', outcome: `${a.outcome}, ${results.map((r) => `${r.check} ${r.outcome}`).join(', ')}`, chainId: cid });
  return a;
}
async function settle(leg, signer, wrapper, underlying, to, amount, attestation) {
  const w = new Contract(wrapper, WRAPPER_ABI, provider);
  const dec = Number(await w.decimals());
  if ((await w.balanceOf(signer.address)) < amount) {
    const r = await wrap(signer, wrapper, underlying, signer.address, amount - (await w.balanceOf(signer.address)));
    records.add({ actionType: 'wrap', transactionOrEventId: envelope.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: signer.address, outcome: `${formatUnits(amount, dec)} wrapped`, tx: r.hash, chainId: cid });
  }
  const t = await transferUnderPolicy(signer, wrapper, to, amount, attestation.context);
  console.log(`${leg}: ${formatUnits(amount, dec)} ${await w.symbol()} ${signer.address.slice(0, 8)} -> ${to.slice(0, 8)}, tx ${t.transferTx.slice(0, 12)} ${explorerTx(cid, t.transferTx)}`);
  records.add({ actionType: 'transfer-under-policy', transactionOrEventId: envelope.uetr, affectedObject: `Policy Wrapper ${wrapper}`, actor: signer.address, outcome: `PASS, attestation ${attestation.id} consumed (${leg})`, tx: t.transferTx, chainId: cid });
}
const aColl = await attest('collateral', wFund, borrower.address, lender.address, collateral);
const aCash = await attest('cash', wCash, lender.address, borrower.address, cashAmount);
await settle('collateral', borrower, wFund, fund, lender.address, collateral, aColl);
await settle('cash', lender, wCash, cash, borrower.address, cashAmount, aCash);
records.add({ actionType: 'repo-opened', transactionOrEventId: envelope.uetr, affectedObject: 'Repo GMRA-EXAMPLE-0001', actor: borrower.address, outcome: `OPEN, LTV 93.50 %, threshold ${Number(LLTV) / 100} %`, chainId: cid });

// 6. the signed price and health
step('6. Reference price and position health');
const oracle = Wallet.createRandom();
const signPrice = async (p) => ({ price: p, signedAt: Math.floor(Date.now() / 1000), signature: await oracle.signMessage(`price:${wFund}:${p}`) });
const health = (p) => { const v = value(p); const ltv = Number(cashAmount * 10000n / v); return { value: v, ltvBps: ltv, healthy: BigInt(ltv) <= LLTV }; };
let signed = await signPrice(price);
let h = health(price);
console.log(`price 98.44 signed by ${oracle.address.slice(0, 10)}, collateral value ${formatUnits(h.value, decCash)}, LTV ${(h.ltvBps / 100).toFixed(2)} %, isHealthy ${h.healthy}`);
records.add({ actionType: 'price-signed', transactionOrEventId: envelope.uetr, affectedObject: 'wFUND reference price', actor: oracle.address, outcome: `98.44, LTV ${(h.ltvBps / 100).toFixed(2)} %, signature ${signed.signature.slice(0, 12)}`, chainId: cid });

// 7. the liquidation
step('7. The price drops : trigger, unknown liquidator refused, admitted liquidator');
price = price36('94.60'); signed = await signPrice(price); h = health(price);
console.log(`price 94.60, LTV ${(h.ltvBps / 100).toFixed(2)} % > ${Number(LLTV) / 100} %, isHealthy ${h.healthy}`);
if (h.healthy) throw new Error('the position should not be healthy at this price');
records.add({ actionType: 'liquidation-trigger', transactionOrEventId: envelope.uetr, affectedObject: 'Repo GMRA-EXAMPLE-0001', actor: 'health from the signed price', outcome: `LTV ${(h.ltvBps / 100).toFixed(2)} % above the threshold`, chainId: cid });
// a liquidator the Identity Manager does not know: the envelope is enriched with it, the evaluation FAILs, nothing is submitted
({ envelope, evidence } = await enrich(buildEnvelope({ ...env0, uetr: envelope.uetr, parties: [...env0.parties, { role: 'liquidator', wallet: stranger, jurisdiction: 'XX', offLedgerData: { name: 'unknown' } }] }), provider, ids));
const aBad = await attest('liquidation-cash (unidentified liquidator)', wCash, stranger, lender.address, cashAmount);
if (aBad.outcome !== 'REJECT') throw new Error('an unidentified liquidator must be rejected');
console.log('liquidation leg not submitted: the unidentified liquidator fails', aBad.results.filter((r) => r.outcome === 'FAIL').map((r) => r.check).join(', '));
records.add({ actionType: 'liquidation-not-submitted', transactionOrEventId: envelope.uetr, affectedObject: 'Repo GMRA-EXAMPLE-0001', actor: stranger, outcome: `REJECT: ${aBad.results.filter((r) => r.outcome === 'FAIL').map((r) => `${r.check} ${r.evidence}`).join('; ')}`, chainId: cid });
// the admitted liquidator: it pays the debt to the lender, receives the collateral
const aLiqCash = await attest('liquidation-cash', wCash, liquidator.address, lender.address, cashAmount);
const aLiqColl = await attest('liquidation-collateral', wFund, lender.address, liquidator.address, collateral);
// the liquidator needs cash: the example issuer gives it some (on Hoodi, it holds some)
await (await (new Contract(cash, ['function transfer(address,uint256) returns (bool)'], lender)).transfer(liquidator.address, cashAmount)).wait();
await settle('liquidation-cash', liquidator, wCash, cash, lender.address, cashAmount, aLiqCash);
await settle('liquidation-collateral', lender, wFund, fund, liquidator.address, collateral, aLiqColl);
console.log('liquidated, wFUND at liquidator', formatUnits(await wf.balanceOf(liquidator.address), decFund), ', wCASH at lender', formatUnits(await wc.balanceOf(lender.address), decCash));
records.add({ actionType: 'liquidation', transactionOrEventId: envelope.uetr, affectedObject: 'Repo GMRA-EXAMPLE-0001', actor: liquidator.address, outcome: `LIQUIDATED, debt repaid to the lender, ${formatUnits(collateral, decFund)} wFUND to the liquidator`, chainId: cid });

// replaying an already consumed attestation is refused by the chain
try {
  await transferUnderPolicy(lender, wFund, liquidator.address, collateral, aLiqColl.context);
  throw new Error('a replayed attestation passed');
} catch (err) {
  lender.reset();
  const r = describeRefusal(err);
  if (!r.reason.includes('already used') && !r.reason.includes('not bound')) throw err;
  console.log('replay refused as expected :', r.reason);
}

step(`8. ${records.records.length} evidencing records in ${join(here, 'evidencing-records.jsonl')}`);
console.log(records.toCsv().split('\n').slice(0, 3).join('\n'));
console.log('\nexample repo : OK');
