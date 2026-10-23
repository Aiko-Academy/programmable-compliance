#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0
// Exports the pack contracts' ABIs from `out/` (forge build) to `sdk/abi/` and `abi/`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const NAMES = ['PolicyManager', 'PolicyWrapper', 'ERC20TransferExtractor', 'RequiredChecksPolicy', 'EnvelopeBindingPolicy',
  'IdentityGatedPolicy', 'AttestationValidatorPolicy', 'IdentityRegistry', 'CredentialRegistry', 'VLEICredentialDataValidator',
  'ComplianceKeyRegistry', 'InstitutionSignatureVerifier', 'TeeTrustRegistry', 'TeeAttestationVerifier', 'ZkCheckRegistry',
  'Groth16ZkAdapter', 'SanctionsGroth16Verifier', 'HolderKycGroth16Verifier', 'ExampleToken'];
for (const dir of ['sdk/abi', 'abi']) mkdirSync(join(root, dir), { recursive: true });
let n = 0;
for (const name of NAMES) {
  const p = join(root, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) { console.error('absent :', p); process.exitCode = 1; continue; }
  const art = JSON.parse(readFileSync(p, 'utf8'));
  const out = JSON.stringify({ contractName: name, abi: art.abi, bytecodeHash: art.deployedBytecode?.object ? undefined : undefined }, null, 0);
  for (const dir of ['sdk/abi', 'abi']) writeFileSync(join(root, dir, `${name}.json`), JSON.stringify({ contractName: name, abi: art.abi }, null, 1) + '\n');
  n++;
}
console.log(`${n} ABI exportees`);
