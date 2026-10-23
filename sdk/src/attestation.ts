// The Compliance Attestation (figure 3 of the whitepaper): consolidate the Compliance Rules Engine results,
// bind them to the transfer, sign them in P-256, encode them for the Policy Manager.

import { AbiCoder, Contract, TypedDataEncoder, keccak256, toUtf8Bytes, getBytes, hexlify, type Provider } from 'ethers';
import { p256 } from '@noble/curves/p256';
import type {
  Hex, AttestationItem, CheckResult, ComplianceAttestation, TransactionEnvelope,
} from './types.js';

const coder = AbiCoder.defaultAbiCoder();

/** The binding domain of `EnvelopeBindingPolicy`: part of the digest, not a decoration. */
export const BINDING_DOMAIN = keccak256(toUtf8Bytes('LegBinding/v2')) as Hex;

/** A leg: what the binding policy reads on chain (from, to, amount, asset) plus the UETR. */
export interface Leg {
  uetr: Hex;
  from: Hex;
  to: Hex;
  amount: bigint;
  asset: Hex;
}

/** `EnvelopeBindingPolicy.commitment(uetr, from, to, amount, asset, code)`, computed here so it can be signed. */
export function commitment(leg: Leg, checkCode: string): Hex {
  return keccak256(
    coder.encode(
      ['bytes32', 'bytes16', 'address', 'address', 'uint256', 'address', 'string'],
      [BINDING_DOMAIN, leg.uetr, leg.from, leg.to, leg.amount, leg.asset, checkCode],
    ),
  ) as Hex;
}

/** The EIP-712 digest of `InstitutionSignatureVerifier.digest(sig)`, computed off chain. */
export function institutionDigest(
  sig: AttestationItem['sig'],
  domain: { chainId: number; verifyingContract: Hex },
): Hex {
  return TypedDataEncoder.hash(
    { name: 'InstitutionSig', version: '1', chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    {
      InstitutionSignature: [
        { name: 'uetr', type: 'bytes16' },
        { name: 'checkCode', type: 'string' },
        { name: 'verdict', type: 'bool' },
        { name: 'canonicalDataHash', type: 'bytes32' },
        { name: 'policyRef', type: 'bytes32' },
        { name: 'timestamp', type: 'uint256' },
      ],
    },
    sig,
  ) as Hex;
}

/** An institution's P-256 key: that of the Compliance Rules Engine that signs its results. */
export class InstitutionSigner {
  readonly qx: Hex;
  readonly qy: Hex;
  private readonly key: Uint8Array;

  constructor(privateKey: Hex | Uint8Array, readonly orgId: Hex) {
    this.key = typeof privateKey === 'string' ? getBytes(privateKey) : privateKey;
    const pub = p256.ProjectivePoint.fromPrivateKey(this.key).toAffine();
    this.qx = ('0x' + pub.x.toString(16).padStart(64, '0')) as Hex;
    this.qy = ('0x' + pub.y.toString(16).padStart(64, '0')) as Hex;
  }

  /** A key is born on the machine that uses it. */
  static random(orgId: Hex): InstitutionSigner {
    return new InstitutionSigner(p256.utils.randomPrivateKey(), orgId);
  }

  /** Signature of the digest (no second hashing), s normalized to the lower half of the curve as the verifier requires. */
  sign(digest: Hex): { r: Hex; s: Hex } {
    const sig = p256.sign(getBytes(digest), this.key, { prehash: false, lowS: true });
    return {
      r: ('0x' + sig.r.toString(16).padStart(64, '0')) as Hex,
      s: ('0x' + sig.s.toString(16).padStart(64, '0')) as Hex,
    };
  }
}

const MANAGER_ABI = [
  'function policyVersion(address) view returns (uint64)',
  'function policyVersionLabel(address) view returns (string)',
  'function policyDescriptor(address target, bytes4 selector) view returns (bytes32)',
  'function getPolicies(address target, bytes4 selector) view returns (address[])',
  'function isActive(address target, bytes4 selector) view returns (bool)',
];
export const TRANSFER_SELECTOR = '0xa9059cbb' as Hex;
export const TRANSFER_FROM_SELECTOR = '0x23b872dd' as Hex;

/** A wrapper's policy version, read on the Policy Manager: what the attestation references. */
export async function readPolicyVersion(provider: Provider, manager: Hex, wrapper: Hex, selector: Hex = TRANSFER_SELECTOR) {
  const m = new Contract(manager, MANAGER_ABI, provider);
  const [number, label, descriptor, policies, active] = await Promise.all([
    m.policyVersion(wrapper), m.policyVersionLabel(wrapper), m.policyDescriptor(wrapper, selector),
    m.getPolicies(wrapper, selector), m.isActive(wrapper, selector),
  ]);
  return { number: BigInt(number), label: label as string, descriptor: descriptor as Hex, policies: policies as Hex[], active: active as boolean };
}

export function encodeContext(items: AttestationItem[]): Hex {
  return coder.encode(
    ['tuple(uint8 kind,bytes32 orgId,tuple(bytes16 uetr,string checkCode,bool verdict,bytes32 canonicalDataHash,bytes32 policyRef,uint256 timestamp) sig,bytes32 r,bytes32 s,bytes32 qx,bytes32 qy)[]'],
    [items.map((i) => [i.kind, i.orgId, [i.sig.uetr, i.sig.checkCode, i.sig.verdict, i.sig.canonicalDataHash, i.sig.policyRef, i.sig.timestamp], i.r, i.s, i.qx, i.qy])],
  ) as Hex;
}

export interface AttestationInput {
  envelope: TransactionEnvelope;
  envelopeHash: Hex;
  leg: Leg;
  results: CheckResult[];
  policyVersion: { number: bigint; label: string; descriptor: Hex };
  signer: InstitutionSigner;
  domain: { chainId: number; verifyingContract: Hex };
  timestamp?: number;
}

/**
 * Consolidation, THREE OUTCOMES and not two. A PASS requires every result to be PASS; each result
 * becomes a signed item, bound to the leg by its digest and to the policy version by `policyRef`.
 *
 * A FAIL gives a REJECT: the answer is no, definitively, and nothing is signed.
 *
 * A FURTHER_HANDLING, in the absence of any FAIL, gives a FURTHER_HANDLING: no control answered
 * no, but one of them cannot answer alone and requires human follow-up. The automatic chain
 * STOPS, it does not refuse, and nothing is presented to the Policy Wrapper in either case. Conflating
 * the two, as the previous version did, erases the difference between "the rule says no" and "the
 * rule cannot say, have a human look", which have neither the same handling nor the same delay.
 */
export function buildAttestation(input: AttestationInput): ComplianceAttestation {
  const evaluatedAt = input.timestamp ?? Math.floor(Date.now() / 1000);
  const echec = input.results.some((r) => r.outcome === 'FAIL');
  const reprise = !echec && input.results.some((r) => r.outcome === 'FURTHER_HANDLING');
  const pass = input.results.every((r) => r.outcome === 'PASS');
  const trust = [...new Set(input.results.map((r) => r.trustedIssuer).filter((x): x is string => !!x))];
  const id = `CA-${new Date(evaluatedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '')}-${input.leg.uetr.slice(-6)}`;
  if (!pass) {
    return {
      id, envelopeHash: input.envelopeHash, uetr: input.leg.uetr, outcome: reprise ? 'FURTHER_HANDLING' : 'REJECT', results: input.results,
      policyVersion: input.policyVersion, trustDependencies: trust, evaluatedAt, items: [], context: '0x', hash: '0x',
    };
  }
  const items: AttestationItem[] = input.results.map((r) => {
    const sig = {
      uetr: input.leg.uetr, checkCode: r.check, verdict: true,
      canonicalDataHash: commitment(input.leg, r.check), policyRef: input.policyVersion.descriptor,
      timestamp: BigInt(evaluatedAt),
    };
    const { r: R, s: S } = input.signer.sign(institutionDigest(sig, input.domain));
    return { kind: 0, orgId: input.signer.orgId, sig, r: R, s: S, qx: input.signer.qx, qy: input.signer.qy };
  });
  const context = encodeContext(items);
  return {
    id, envelopeHash: input.envelopeHash, uetr: input.leg.uetr, outcome: 'PASS', results: input.results,
    policyVersion: input.policyVersion, trustDependencies: trust, evaluatedAt, items, context,
    hash: keccak256(context) as Hex,
  };
}

/** For the audit: the readable form of an item, without its signature. */
export function describeItem(i: AttestationItem): string {
  return `${i.sig.checkCode}: ${i.sig.verdict ? 'PASS' : 'FAIL'} at ${new Date(Number(i.sig.timestamp) * 1000).toISOString()} bound ${hexlify(i.sig.canonicalDataHash).slice(0, 10)} policy ${i.sig.policyRef.slice(0, 10)}`;
}
