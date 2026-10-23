#!/usr/bin/env node
// Prints, for `eval "$(node examples/corridor-fx/corridor-env.mjs)"`, the NON-SECRET addresses that the FX
// corridor's Foundry scripts read, taken from the tracer (single source): never from a stale
// environment variable (BENEFICIARY, COMPOSER_ARBITRUM_FX in .env have already lied). No key is printed.
//   --extra NAME=value   adds or replaces a variable (e.g. RETURN_RECEIVER=0x...)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tr = JSON.parse(readFileSync(join(here, '..', '..', 'test-layerzero', 'deployments-leg', 'fx-corridor.json'), 'utf8'));
const s = tr.source.contracts, d = tr.destination.contracts, uni = tr.destination.uniswapV3Canonical;
const v = {
  LZ_ENDPOINT_V2: tr.lzEndpointV2,
  SRC_ADAPTER_FX: s.SRC_ADAPTER_FX, RETURN_RECEIVER: s.RETURN_RECEIVER, WRAP_SRC: s.wEURX_PolicyWrapper, EURX_SEPOLIA: s.EURX_TokenRep,
  ZK_POLICY_SRC: s.AtelierZkSanctionsWrapperPolicy, SEAL_SRC: s.TestSeal,
  RECV_ADAPTER_EUR: d.RECV_ADAPTER_EUR, WRAP_EUR: d.wEURX_reception_PolicyWrapper, WRAP_SGD: d.wSGDX_delivery_PolicyWrapper,
  WRAP_DST: d.wSGDX_delivery_PolicyWrapper, EURX_ARBITRUM: d.EURX_reception_TokenRep, SGDX_ARBITRUM: d.SGDX_delivery_TokenRep,
  USDX_ARBITRUM: d.USDX_pivot_TokenRep, COMPOSER_ARBITRUM_FX: d.COMPOSER_ARBITRUM_FX,
  ZK_POLICY_DST: d.AtelierZkSanctionsWrapperPolicy, SEAL_DST: d.TestSeal,
  SWAP_ROUTER: uni.SwapRouter02 || uni.SwapRouter, PAYER: tr.parties.adresses.payeur, BENEFICIARY: tr.parties.adresses.beneficiaire,
};
const i = process.argv.indexOf('--extra');
if (i > 0) for (const kv of process.argv.slice(i + 1)) { const [k, ...r] = kv.split('='); v[k] = r.join('='); }
for (const [k, val] of Object.entries(v)) if (val) console.log(`export ${k}=${val}`);
