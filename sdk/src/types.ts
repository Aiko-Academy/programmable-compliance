// GL1 Programmable Compliance Toolkit, SDK: the whitepaper types (figures 2 and 3), as the pack builds
// them off chain and encodes them for the Policy Manager. No invented values: these types describe.

export type Hex = `0x${string}`;

/** A party to a transaction, reduced to its identifiers at construction, enriched afterwards. */
export interface PartyPacket {
  role: 'originator' | 'beneficiary' | 'liquidator' | 'intermediary' | string;
  wallet: Hex;
  /** ISO 3166-1 alpha-2. */
  jurisdiction: string;
  /** The identity resolved by the Identity Manager (CCID), held at enrichment. */
  ccid?: Hex;
  /** Off-ledger data (Travel Rule): it does not travel on chain, only its digest goes there. */
  offLedgerData?: Record<string, unknown>;
  /** keccak256 of the off-ledger data, zero if there is none. */
  dataHash?: Hex;
  /** Pre-validation proofs attached at enrichment (credential, attestation), in the clear for the audit. */
  preValidationProofs: string[];
}

export type MediationPattern = 'Entity-to-Entity' | 'Entity-to-VASP' | 'VASP-to-Entity' | 'VASP-to-VASP';

/** The structured record that travels with the transaction. */
export interface TransactionEnvelope {
  /** UETR, 16 hex bytes (0x + 32 characters). */
  uetr: Hex;
  asset: Hex;
  /** In the token's minimum units (read `decimals()` on the token, never copy it over). */
  amount: bigint;
  /** Seconds since the epoch. */
  datetime: number;
  mediationPattern: MediationPattern;
  parties: PartyPacket[];
}

export type CheckOutcome = 'PASS' | 'FAIL' | 'FURTHER_HANDLING';

/** The result of a check, as the Compliance Rules Engine returns it to the SDK. */
export interface CheckResult {
  check: string;
  outcome: CheckOutcome;
  /** A proof or reference readable by the audit (digest, proof identifier, link). */
  evidence?: string;
  /** The trusted issuer the result depends on (a QVI, a KYC issuer, a registry). */
  trustedIssuer?: string;
}

/** The Compliance Rules Engine as seen from the SDK: it returns one result per requested check, in order. */
export interface CheckProvider {
  evaluate(envelope: TransactionEnvelope, checks: string[]): Promise<CheckResult[]>;
}

/** An item of the Compliance Attestation as it is encoded for the Policy Manager. */
export interface AttestationItem {
  kind: 0 | 1;
  orgId: Hex;
  sig: {
    uetr: Hex;
    checkCode: string;
    verdict: boolean;
    canonicalDataHash: Hex;
    policyRef: Hex;
    timestamp: bigint;
  };
  r: Hex;
  s: Hex;
  qx: Hex;
  qy: Hex;
}

/** The execution record: the outcome of the evaluation, at a moment, against a policy version. */
export interface ComplianceAttestation {
  id: string;
  envelopeHash: Hex;
  uetr: Hex;
  outcome: 'PASS' | 'REJECT' | 'FURTHER_HANDLING';
  results: CheckResult[];
  /** The wrapper's policy version (number and label read on the Policy Manager). */
  policyVersion: { number: bigint; label: string; descriptor: Hex };
  trustDependencies: string[];
  evaluatedAt: number;
  /** The signed items, present only if `outcome` is PASS. */
  items: AttestationItem[];
  /** `abi.encode(AttestationItem[])`, what `setContext` receives. */
  context: Hex;
  /** keccak256 of the encoded context; empty if REJECT. */
  hash: Hex;
}

/** An evidencing record: the six fields of the whitepaper. */
export interface EvidencingRecord {
  actionType: string;
  time: string;
  transactionOrEventId: string;
  affectedObject: string;
  actor: string;
  outcome: string;
  /** The hash of the on-chain transaction when the action has one. */
  tx?: Hex;
  chainId?: number;
}
