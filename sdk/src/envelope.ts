// Construction and enrichment of the Transaction Envelope (figure 2 of the whitepaper).

import { AbiCoder, Contract, keccak256, randomBytes, hexlify, toUtf8Bytes, type Provider } from 'ethers';
import type { Hex, PartyPacket, TransactionEnvelope, MediationPattern } from './types.js';

const coder = AbiCoder.defaultAbiCoder();

export function newUetr(): Hex {
  return hexlify(randomBytes(16)) as Hex;
}

/** The stable digest of a JSON object (keys sorted): what goes on chain in place of the data. */
export function hashOffLedger(data: Record<string, unknown>): Hex {
  const canon = JSON.stringify(data, Object.keys(data).sort());
  return keccak256(toUtf8Bytes(canon)) as Hex;
}

export interface EnvelopeInput {
  uetr?: Hex;
  asset: Hex;
  amount: bigint;
  datetime?: number;
  mediationPattern: MediationPattern;
  parties: Array<Omit<PartyPacket, 'preValidationProofs' | 'dataHash'> & { preValidationProofs?: string[] }>;
}

/** Construction: the Party Packets are reduced to their identifiers, the off-ledger data to a digest. */
export function buildEnvelope(input: EnvelopeInput): TransactionEnvelope {
  return {
    uetr: input.uetr ?? newUetr(),
    asset: input.asset,
    amount: input.amount,
    datetime: input.datetime ?? Math.floor(Date.now() / 1000),
    mediationPattern: input.mediationPattern,
    parties: input.parties.map((p) => ({
      ...p,
      preValidationProofs: p.preValidationProofs ?? [],
      dataHash: p.offLedgerData ? hashOffLedger(p.offLedgerData) : ('0x' + '00'.repeat(32)) as Hex,
    })),
  };
}

const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

/** The digest of the envelope, identical to `ComplianceTypes.hashEnvelope` of the pack. */
export function hashEnvelope(e: TransactionEnvelope): Hex {
  const parties = e.parties.map((p) => [
    keccak256(toUtf8Bytes(p.role)),
    p.wallet,
    hexlify(toUtf8Bytes(p.jurisdiction.padEnd(2).slice(0, 2))),
    p.ccid ?? ZERO32,
    p.dataHash ?? ZERO32,
  ]);
  return keccak256(
    coder.encode(
      ['bytes16', 'address', 'uint256', 'uint64', 'bytes32', 'tuple(bytes32,address,bytes2,bytes32,bytes32)[]'],
      [e.uetr, e.asset, e.amount, e.datetime, keccak256(toUtf8Bytes(e.mediationPattern)), parties],
    ),
  ) as Hex;
}

const IDENTITY_ABI = ['function getIdentity(address) view returns (bytes32)'];
const CREDENTIAL_ABI = [
  'function validate(bytes32 ccid, bytes32 credentialTypeId) view returns (bool)',
  'function credentialData(bytes32 ccid, bytes32 credentialTypeId) view returns (bytes)',
];

export interface IdentityManagerAddresses {
  identityRegistry: Hex;
  credentialRegistry: Hex;
  /** keccak256(abi.encodePacked("common.kyb")) for KYB by vLEI. */
  credentialType: Hex;
}

export interface EnrichmentEvidence {
  wallet: Hex;
  ccid: Hex;
  credentialValid: boolean;
  /** The LEI carried by the vLEI credential (first 20 bytes of the payload), if a credential exists. */
  lei?: string;
}

/**
 * Enrichment: the Identity Manager resolves each wallet to an identity (CCID) and says whether the
 * credential of the requested type is valid. What the registry returns is written into the Party Packet;
 * nothing is assumed.
 */
export async function enrich(
  envelope: TransactionEnvelope,
  provider: Provider,
  a: IdentityManagerAddresses,
): Promise<{ envelope: TransactionEnvelope; evidence: EnrichmentEvidence[] }> {
  const ids = new Contract(a.identityRegistry, IDENTITY_ABI, provider);
  const creds = new Contract(a.credentialRegistry, CREDENTIAL_ABI, provider);
  const evidence: EnrichmentEvidence[] = [];
  const parties: PartyPacket[] = [];
  for (const p of envelope.parties) {
    const ccid = (await ids.getIdentity(p.wallet)) as Hex;
    let credentialValid = false;
    let lei: string | undefined;
    if (ccid !== ZERO32) {
      credentialValid = (await creds.validate(ccid, a.credentialType)) as boolean;
      const data = (await creds.credentialData(ccid, a.credentialType)) as string;
      if (data && data.length >= 42) lei = Buffer.from(data.slice(2, 42), 'hex').toString('latin1');
    }
    evidence.push({ wallet: p.wallet, ccid, credentialValid, lei });
    parties.push({
      ...p,
      ccid,
      preValidationProofs: [
        ...p.preValidationProofs,
        ...(credentialValid ? [`credential:${a.credentialType}:valid:${ccid}`] : []),
      ],
    });
  }
  return { envelope: { ...envelope, parties }, evidence };
}
