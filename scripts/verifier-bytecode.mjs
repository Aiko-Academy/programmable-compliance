#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0
// Witness of lot 1: the contracts taken over as is describe, byte for byte excluding metadata, the code in
// service on Hoodi. Compiled under the `hoodi` profile (same settings as the origin), compares the pack's
// execution bytecode, CBOR metadata removed, to the code read at the reference address.
//
//   HOODI_RPC=https://rpc.hoodi.ethpandaops.io node scripts/verifier-bytecode.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// Two public providers: the environment's first, the other as a fallback when the first returns a 502
// (measured in CI on September 14: a red unrelated to the code).
const RPCS = [process.env.HOODI_RPC, 'https://rpc.hoodi.ethpandaops.io', 'https://ethereum-hoodi-rpc.publicnode.com'].filter((x, i, a) => x && a.indexOf(x) === i);
let rpc = RPCS[0];
for (const candidat of RPCS) {
  try { await new JsonRpcProvider(candidat, undefined, { cacheTimeout: -1 }).getBlockNumber(); rpc = candidat; break; }
  catch (e) { console.warn(`${candidat} does not respond (${(e.shortMessage ?? e.message).slice(0, 60)}) : fallback`); }
}
const ref = JSON.parse(readFileSync(join(root, 'deployments', 'hoodi-reference.json'), 'utf8'));
const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });

/** Remove the trailing CBOR trace (the last two bytes give its length). */
function stripMetadata(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  if (b.length < 2) return b;
  const len = b.readUInt16BE(b.length - 2);
  if (len + 2 > b.length) return b;
  return b.subarray(0, b.length - len - 2);
}

execFileSync('forge', ['build', '--silent'], { cwd: root, env: { ...process.env, FOUNDRY_PROFILE: 'hoodi', PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` }, stdio: 'inherit' });
let ok = 0, ko = 0;
const block = await provider.getBlockNumber();
for (const [name, entry] of Object.entries(ref.contracts)) {
  const art = JSON.parse(readFileSync(join(root, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  const local = stripMetadata(art.deployedBytecode.object);
  const chain = stripMetadata(await provider.getCode(entry.address, block));
  // An immutable (the Policy Manager's address, for instance) is written into the code at deployment: mask
  // its locations on both sides, the compiler says where they are.
  for (const refs of Object.values(art.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) {
      if (start + length <= local.length) local.fill(0, start, start + length);
      if (start + length <= chain.length) chain.fill(0, start, start + length);
    }
  }
  const same = local.length === chain.length && local.equals(chain);
  same ? ok++ : ko++;
  console.log(`${same ? 'OK ' : 'KO '} ${name.padEnd(30)} ${entry.address} ${entry.origin} (${chain.length} bytes)`);
}
console.log(`block ${block} : ${ok} identical, ${ko} different`);
if (ko) process.exit(1);
