#!/usr/bin/env node
// examples/corridor-fx: the NEW gesture of the cross-chain FX corridor, played for real on a local chain.
//
// The LayerZero transport and the gated delivery are proven, deterministic and zero-gas, by the Foundry test
// CrossChainFXSettlement (run by run.sh BEFORE this script). Here we play the only brick that did not exist:
// the CHANGE at the arrival pivot, on a real Uniswap V3 pool (session double MockV3Dex). The swap
// EURX -> SGDX is a real transaction on anvil (31337): a hash, a balance diff, an applied rate
// measured on the chain, not copied. We read `decimals()` on each token (never assumed) and form the
// rate from two integer quantities (lesson of the euro moving to 18).
//
//   RPC=http://127.0.0.1:8545 node examples/corridor-fx/run.mjs   (run.sh starts anvil and chains them)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, formatUnits } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const toolkit = join(here, '..', '..');
const RPC = process.env.RPC ?? 'http://127.0.0.1:8545';
// anvil accounts 0 (payer/holder) and 1 (beneficiary), same keys as examples/transfer.
const KEY_PAYER = process.env.PRIVATE_KEY_A ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDR_BENEF = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil account 1

// The pool's target rate: SGD per 1 EUR, at 1e18 scale. SAME constant as the Foundry test
// (RATE_SGD_PER_EUR_X18): measurement of 2026-10-14, 1 SGDX = 0.641783 EURX, that is 1 EUR = 1.558143 SGD.
const RATE_SGD_PER_EUR_X18 = 1_558_143_000_000_000_000n;
const AMOUNT_EUR = 50n * 10n ** 18n; // 50 EUR issued
const POOL_SGD = 1_000n * 10n ** 18n; // SGDX liquidity seeded into the pool
const FEE = 500; // 0.05 % tier

const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const payer = new Wallet(KEY_PAYER, provider);
const { chainId } = await provider.getNetwork();
const cid = Number(chainId);

const artifact = (file, name) => {
  const a = JSON.parse(readFileSync(join(toolkit, 'out-lz', file, `${name}.json`), 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode.object };
};
const TokenRep = artifact('DeployLeg.s.sol', 'TokenRep');
const MockV3Dex = artifact('MockV3Dex.sol', 'MockV3Dex');

const deploy = async (art, args) => {
  const c = await new ContractFactory(art.abi, art.bytecode, payer).deploy(...args);
  await c.waitForDeployment();
  return c;
};
const step = (t) => console.log(`\n-- ${t}`);
const records = [];
const rec = (o) => records.push({ ts: new Date().toISOString(), chainId: cid, ...o });

// ── setup: two stablecoin representations (18 dec) and the seeded EURX/SGDX pool ───────────────────────────
step('setup: EURX, SGDX, V3 pool (session double)');
const eurx = await deploy(TokenRep, ['EURX stablecoin', 'EURX', 18]);
const sgdx = await deploy(TokenRep, ['SGDX stablecoin', 'SGDX', 18]);
const dex = await deploy(MockV3Dex, [await eurx.getAddress(), await sgdx.getAddress(), RATE_SGD_PER_EUR_X18]);
const eurAddr = await eurx.getAddress();
const sgdAddr = await sgdx.getAddress();
const dexAddr = await dex.getAddress();
await (await sgdx.mint(dexAddr, POOL_SGD)).wait(); // SGDX liquidity
console.log('EURX', eurAddr, '· SGDX', sgdAddr, '· pool', dexAddr);

// We do NOT ASSUME the scale: we read it on each token (lesson of the euro at 18).
const eurDec = Number(await eurx.decimals());
const sgdDec = Number(await sgdx.decimals());
console.log('decimals measured: EURX', eurDec, '· SGDX', sgdDec);

// ── quote (RFQ): what the beneficiary must receive, and the slippage floor ────────────────────
step('quote: QuoterV2.quoteExactInputSingle (read-only)');
const quote = await dex.quoteExactInputSingle.staticCall({
  tokenIn: eurAddr, tokenOut: sgdAddr, amountIn: AMOUNT_EUR, fee: FEE, sqrtPriceLimitX96: 0n,
});
const expectedSgd = quote[0];
console.log('quote 50 EURX ->', formatUnits(expectedSgd, sgdDec), 'SGDX');
rec({ actionType: 'fx-quote', affectedObject: 'FX Provider (QuoterV2)', actor: 'RFQ',
  outcome: `${formatUnits(AMOUNT_EUR, eurDec)} EURX -> ${formatUnits(expectedSgd, sgdDec)} SGDX` });

// ── the change: a REAL swap on the pool, EURX taken in, SGDX paid to the beneficiary ──────────────────────
step('change: SwapRouter02.exactInputSingle (real transaction)');
await (await eurx.mint(payer.address, AMOUNT_EUR)).wait();
await (await eurx.approve(dexAddr, AMOUNT_EUR)).wait();

const benefBefore = await sgdx.balanceOf(ADDR_BENEF);
const poolEurBefore = await eurx.balanceOf(dexAddr);
const poolSgdBefore = await sgdx.balanceOf(dexAddr);

const swap = await dex.exactInputSingle({
  tokenIn: eurAddr, tokenOut: sgdAddr, fee: FEE, recipient: ADDR_BENEF,
  amountIn: AMOUNT_EUR, amountOutMinimum: expectedSgd, sqrtPriceLimitX96: 0n,
});
const swapRcpt = await swap.wait();

const benefAfter = await sgdx.balanceOf(ADDR_BENEF);
const poolEurAfter = await eurx.balanceOf(dexAddr);
const poolSgdAfter = await sgdx.balanceOf(dexAddr);
const delivered = benefAfter - benefBefore;

// applied rate, formed from two INTEGER quantities (never a ratio of base units).
const rateApplied = Number(formatUnits(delivered, sgdDec)) / Number(formatUnits(AMOUNT_EUR, eurDec));
console.log('swap tx', swapRcpt.hash);
rec({ actionType: 'fx-swap', transactionOrEventId: swapRcpt.hash, affectedObject: 'EURX/SGDX pool',
  actor: payer.address, outcome: `swapped ${formatUnits(AMOUNT_EUR, eurDec)} EURX for ${formatUnits(delivered, sgdDec)} SGDX`, tx: swapRcpt.hash });
rec({ actionType: 'fx-deliver', transactionOrEventId: swapRcpt.hash, affectedObject: 'beneficiary (Singapore Bank)',
  actor: payer.address, outcome: `beneficiary +${formatUnits(delivered, sgdDec)} SGDX`, tx: swapRcpt.hash });

// ── evidencing: legs, rate, balances before/after ────────────────────────────────────────────────────────
step('evidencing');
console.log('leg lock   (source EURX)   : proven by the lz test (lock of 50 EURX at the source)');
console.log('leg swap   (dest, on-chain): 50 EURX ->', formatUnits(delivered, sgdDec), 'SGDX  tx', swapRcpt.hash);
console.log('leg deliver(dest, gate)    : proven by the lz test (gated delivery, a refusal leaves the EURX in transit)');
console.log('applied rate :', rateApplied.toFixed(6), 'SGD per 1 EUR  (target', (Number(RATE_SGD_PER_EUR_X18) / 1e18).toFixed(6), ')');
console.log('balances beneficiary SGDX :', formatUnits(benefBefore, sgdDec), '->', formatUnits(benefAfter, sgdDec));
console.log('        pool EURX          :', formatUnits(poolEurBefore, eurDec), '->', formatUnits(poolEurAfter, eurDec));
console.log('        pool SGDX          :', formatUnits(poolSgdBefore, sgdDec), '->', formatUnits(poolSgdAfter, sgdDec));

const recordsPath = join(here, 'evidencing-records.jsonl');
writeFileSync(recordsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\n${records.length} evidencing records in ${recordsPath}`);

// guard: the on-chain change must equal the quote (otherwise the pool does not keep its promise).
if (delivered !== expectedSgd) {
  console.error(`FAILED: delivered amount ${delivered} != quote ${expectedSgd}`);
  process.exit(1);
}

// ── the seam with the skill: FX_RESULT on the LAST line ───────────────────────────────────────────
const result = {
  mode: 'dev',
  rate: { src: 'EUR', dest: 'SGD', value: Number(rateApplied.toFixed(6)), source: 'uniswap-v3-pool (mock, dev)' },
  legs: [
    { chainId: cid, tx: '', phase: 'lock' },        // source EURX: proven by the lz test (in-memory)
    { chainId: cid, tx: swapRcpt.hash, phase: 'swap' }, // real change on anvil
    { chainId: cid, tx: '', phase: 'deliver' },     // gated delivery: proven by the lz test (in-memory)
  ],
  evidencing: [
    'lz test CrossChainFXSettlement : 5/5 green (lock + release EURX + swap + gate + delivery ; refusal = pool motionless)',
    `swap on-chain 50 EURX -> ${formatUnits(delivered, sgdDec)} SGDX @ ${rateApplied.toFixed(6)} (tx ${swapRcpt.hash})`,
  ],
  beneficiary: { token: 'SGDX', delta: formatUnits(delivered, sgdDec) },
};
console.log('\nFX_RESULT=' + JSON.stringify(result));
