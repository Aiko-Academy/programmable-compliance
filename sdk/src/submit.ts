// Submission: wrap, transfer under policy with its attestation in context, unwrap; and reading the
// refusal, as the Policy Manager names it.

import { Contract, Interface, type Signer, type TransactionReceipt } from 'ethers';
import type { Hex } from './types.js';

export const WRAPPER_ABI = [
  'function setContext(bytes context)',
  'function depositFor(address to, uint256 amount) returns (bool)',
  'function withdrawTo(address to, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function underlying() view returns (address)',
  'function policyManager() view returns (address)',
  'function isRestricted(address) view returns (bool)',
  'function frozenOf(address) view returns (uint256)',
  'function paused() view returns (bool)',
  'event TokenWrap(address indexed from, address indexed to, uint256 amount, address underlying)',
  'event TokenUnwrap(address indexed from, address indexed to, uint256 amount, address underlying)',
  'event ContextSet(address indexed sender, bytes32 contextHash)',
  'event AddressRestricted(address indexed account, bool restricted, string reason)',
  'event BalanceFrozen(address indexed account, uint256 amount, string reason)',
  'event ForcedTransfer(address indexed from, address indexed to, uint256 amount, string reason)',
];

export const MANAGER_ERRORS = [
  'error PolicyRunRejected(bytes4 selector, address policy, string reason)',
  'error PolicyRunError(bytes4 selector, address policy, bytes err)',
  'error PolicyPostRunError(bytes4 selector, address policy, bytes err)',
  'error ExtractorError(bytes4 selector, address extractor, bytes err)',
  'error TargetNotAttached(address target)',
  'error WrapperPaused()',
  'error AccountRestricted(address account)',
  'error InsufficientUnfrozenBalance(address account, uint256 available, uint256 needed)',
  'error PolicyManagerNotSet()',
];

const ERC20_ABI = ['function approve(address spender, uint256 value) returns (bool)', 'function allowance(address,address) view returns (uint256)'];

/**
 * Reread after write: a public provider load-balances its calls across several nodes, and the one answering
 * after a receipt may not have seen the block. Sending the next transaction at that moment yields "replacement
 * underpriced" or "nonce too low" with nothing actually wrong. Wait until the sender's nonce account, read at
 * `latest`, has passed that of the received transaction (up to thirty seconds).
 */
export async function synchronised(signer: Signer, receipt: TransactionReceipt): Promise<TransactionReceipt> {
  const p = signer.provider;
  if (!p) return receipt;
  const owner = await signer.getAddress();
  const tx = await p.getTransaction(receipt.hash);
  const nonce = tx?.nonce ?? -1;
  for (let i = 0; i < 30; i++) {
    if ((await p.getTransactionCount(owner, 'latest')) > nonce) return receipt;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return receipt;
}

export async function wrap(signer: Signer, wrapper: Hex, underlying: Hex, to: Hex, amount: bigint): Promise<TransactionReceipt> {
  const u = new Contract(underlying, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  if ((await u.allowance(owner, wrapper)) < amount) {
    await synchronised(signer, await (await u.approve(wrapper, amount)).wait());
    // THE PUBLIC RPC IS A LOAD BALANCER. The node that accepted the approval is not necessarily the one that
    // will estimate the gas of the following deposit: a lagging node reports a zero allowance and the deposit
    // reverts with ERC20InsufficientAllowance, with nothing explaining it (run of September 16, repo B).
    // Waiting for the nonce is not enough, it is local to the account; wait for the PRECONDITION itself,
    // reread on chain.
    for (let i = 0; i < 30 && (await u.allowance(owner, wrapper)) < amount; i++) await new Promise((r) => setTimeout(r, 1000));
  }
  const w = new Contract(wrapper, WRAPPER_ABI, signer);
  return synchronised(signer, (await (await w.depositFor(to, amount)).wait()) as TransactionReceipt);
}

export async function unwrap(signer: Signer, wrapper: Hex, to: Hex, amount: bigint): Promise<TransactionReceipt> {
  const w = new Contract(wrapper, WRAPPER_ABI, signer);
  return synchronised(signer, (await (await w.withdrawTo(to, amount)).wait()) as TransactionReceipt);
}

/**
 * The transfer under policy: `setContext(attestation)` then `transfer` by the same signer. Two
 * transactions; the context is read only by the transfer that follows, from the same caller.
 */
export async function transferUnderPolicy(
  signer: Signer, wrapper: Hex, to: Hex, amount: bigint, context: Hex,
): Promise<{ contextTx: Hex; transferTx: Hex; receipt: TransactionReceipt }> {
  const w = new Contract(wrapper, WRAPPER_ABI, signer);
  const c = await synchronised(signer, (await (await w.setContext(context)).wait()) as TransactionReceipt);
  // Estimating the transfer may land on a pool node that does not yet have the setContext: it then returns
  // "no compliance checks supplied" with nothing actually wrong (measured on Hoodi on September 15).
  // The context stays in storage until it is consumed: retry a few seconds later.
  let receipt: TransactionReceipt | undefined;
  for (let i = 0; i < 6; i++) {
    try { receipt = await synchronised(signer, (await (await w.transfer(to, amount)).wait()) as TransactionReceipt); break; }
    catch (e) {
      if (i === 5 || !describeRefusal(e).reason.includes('no compliance checks supplied')) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { contextTx: c.hash as Hex, transferTx: receipt!.hash as Hex, receipt: receipt! };
}

/** The name of the refusal, decoded from the provider error: the policy and its reason, or the raw error. */
export function describeRefusal(err: unknown): { policy?: Hex; reason: string } {
  const data: string | undefined = (err as { data?: string })?.data ?? (err as { info?: { error?: { data?: string } } })?.info?.error?.data;
  const iface = new Interface(MANAGER_ERRORS);
  if (data) {
    try {
      const parsed = iface.parseError(data);
      if (parsed?.name === 'PolicyRunRejected') return { policy: parsed.args[1] as Hex, reason: parsed.args[2] as string };
      if (parsed) return { reason: `${parsed.name}(${parsed.args.map(String).join(', ')})` };
    } catch { /* not an error from the pack */ }
  }
  return { reason: (err as Error)?.message ?? String(err) };
}
