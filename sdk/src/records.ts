// The evidencing records: six fields per material action (whitepaper, "Evidence for Material Governance
// Actions"), written at the moment of the action, exportable as line-delimited JSON and as CSV.

import { appendFileSync } from 'node:fs';
import type { EvidencingRecord, Hex } from './types.js';

export type RecordInput = Omit<EvidencingRecord, 'time'> & { time?: string };

export function record(r: RecordInput): EvidencingRecord {
  return { ...r, time: r.time ?? new Date().toISOString() };
}

/** An in-memory store; `file` appends each record as line-delimited JSON as soon as it is written. */
export class RecordStore {
  readonly records: EvidencingRecord[] = [];
  constructor(private readonly file?: string) {}

  add(r: RecordInput): EvidencingRecord {
    const rec = record(r);
    this.records.push(rec);
    if (this.file) appendFileSync(this.file, JSON.stringify(rec) + '\n');
    return rec;
  }

  byTransaction(id: string): EvidencingRecord[] {
    return this.records.filter((r) => r.transactionOrEventId === id);
  }

  toCsv(): string {
    const head = ['actionType', 'time', 'transactionOrEventId', 'affectedObject', 'actor', 'outcome', 'tx', 'chainId'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [head.join(','), ...this.records.map((r) => head.map((h) => esc((r as unknown as Record<string, unknown>)[h])).join(','))].join('\n');
  }
}

/** The explorer link of a transaction, per chain; empty when the chain has none (anvil). */
export function explorerTx(chainId: number, tx: Hex): string {
  switch (chainId) {
    case 560048: return `https://hoodi.etherscan.io/tx/${tx}`;
    case 6565: return `https://explorer.shared-ledger.eu/tx/${tx}`;
    case 1: return `https://etherscan.io/tx/${tx}`;
    default: return '';
  }
}

export function explorerAddress(chainId: number, a: Hex): string {
  switch (chainId) {
    case 560048: return `https://hoodi.etherscan.io/address/${a}`;
    case 6565: return `https://explorer.shared-ledger.eu/address/${a}`;
    case 1: return `https://etherscan.io/address/${a}`;
    default: return '';
  }
}
