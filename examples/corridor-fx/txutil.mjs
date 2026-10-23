// Common tools for the FX corridor runners (reset, calibrate, calibrate-pivot, live passes): RPC provider
// with a fallback list, transaction sending that FAILS loudly instead of hanging.
//
// Why (measurement of 16/10):
//   - ethers on Sepolia: a first write hung without an error (no transaction sent, nonce unchanged)
//     while `cast send --legacy --gas-limit 200000` went through. So we send as type 0 (legacy) with an
//     explicit gas limit, and we bound the wait (send then receipt): an exceeded timeout raises an error that
//     NAMES the action, with the nonce read on chain to decide between "not sent" and "not yet mined".
//   - public RPCs refuse batches, return "block not found": a provider with fallback (quorum 1) tries
//     the next one instead of stopping.
//
// Data kept as spelled, not prose: the marker REVERTED (read by live-pass.mjs), the phrase
// unknown chain (read by reset-plan.test.mjs), and the values 'read', 'known', 'unreadable'.
import { JsonRpcProvider, FallbackProvider, Network, Transaction } from 'ethers';

export const CHAINES = {
  sepolia: {
    chainId: 11155111, envUrl: 'SEPOLIA_RPC_URL', envRepli: 'SEPOLIA_RPC_FALLBACKS', legacy: true,
    repli: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co'],
  },
  arbitrum: {
    chainId: 421614, envUrl: 'ARBITRUM_SEPOLIA_RPC_URL', envRepli: 'ARBITRUM_SEPOLIA_RPC_FALLBACKS', legacy: false,
    repli: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'],
  },
};

/** Ordered, duplicate-free list of a chain's URLs: the environment URL first, then the environment
 *  fallbacks (separated by commas), then the public fallbacks. Pure logic. */
export function listeRpc(chaine, env = process.env) {
  const c = CHAINES[chaine];
  if (!c) throw new Error(`unknown chain : ${chaine}`);
  const brut = [env[c.envUrl], ...String(env[c.envRepli] || '').split(','), ...c.repli];
  return [...new Set(brut.map((u) => String(u || '').trim()).filter(Boolean))];
}

/** Fallback provider (quorum 1). With a single URL, a plain JsonRpcProvider. */
export function fournisseur(chaine, env = process.env) {
  const c = CHAINES[chaine];
  const urls = listeRpc(chaine, env);
  const reseau = Network.from(c.chainId);
  const un = (u) => new JsonRpcProvider(u, reseau, { staticNetwork: reseau, cacheTimeout: -1 });
  if (urls.length === 1) return un(urls[0]);
  return new FallbackProvider(urls.map((u, i) => ({ provider: un(u), priority: i + 1, stallTimeout: 2500, weight: 1 })), reseau, { quorum: 1 });
}

/** Replays `fn` up to `essais` times (growing pause): for reads that fail with "block not found". */
export async function avecEssais(fn, { essais = 4, pauseMs = 1200, libelle = 'read' } = {}) {
  let derniere;
  for (let i = 1; i <= essais; i++) {
    try { return await fn(); } catch (e) { derniere = e; if (i < essais) await new Promise((r) => setTimeout(r, pauseMs * i)); }
  }
  throw new Error(`${libelle} : failed after ${essais} tries (${String(derniere?.shortMessage || derniere?.message || derniere).slice(0, 160)})`);
}

function borne(promesse, ms, quoi) {
  let t;
  const delai = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`TIMEOUT (${ms} ms) : ${quoi}`)), ms); });
  return Promise.race([promesse, delai]).finally(() => clearTimeout(t));
}

/** RAW broadcast: eth_sendRawTransaction to each URL in the list, the first one that accepts wins. We do not go
 *  through `signer.sendTransaction`: measurement of 17/10, after broadcasting ethers waits to reread the transaction and
 *  hangs (the transaction was mined, nonce advanced, the promise never resolved). */
async function diffuserBrut(chaine, brut, delaiMs, env = process.env) {
  const erreurs = [];
  let accepte = null;
  for (const url of listeRpc(chaine, env)) {
    try {
      const rep = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [brut] }), signal: AbortSignal.timeout(Math.min(delaiMs, 30_000)) });
      const j = await rep.json();
      if (j.result) { accepte = j.result; continue; }   // we broadcast to ALL the RPCs: one of them may accept then drop it silently
      // "already known" or "nonce too low": the transaction may have already gone out through another RPC, let the receipt tell us.
      erreurs.push(`${new URL(url).host} : ${j.error?.message ?? 'reponse vide'}`);
      if (/already known|known transaction/i.test(j.error?.message ?? '')) { accepte = accepte ?? 'known'; continue; }
    } catch (e) { erreurs.push(`${new URL(url).host} : ${e.message}`); }
  }
  if (accepte) return accepte === 'known' ? null : accepte;
  throw new Error(`no RPC accepts the broadcast (${erreurs.join(' | ')})`);
}

/** Sends a transaction and waits for its receipt, with a timeout that FAILS. `signer` is a Wallet attached to
 *  `fournisseur(chaine)`. `chaine` ('sepolia' | 'arbitrum') fixes the type: legacy on Sepolia. `req` = { to, data?, value?, gasLimit? }.
 *  `gasLimit` is EXPLICIT (default 300000): the public RPC's estimate is one of the causes of the observed hang. */
export async function envoyer(signer, chaine, req, { libelle = 'transaction', delaiMs = 180_000, gasLimit = 300_000n } = {}) {
  const c = CHAINES[chaine];
  const tx = { ...req, gasLimit: req.gasLimit ?? gasLimit, chainId: c.chainId };
  if (c.legacy) tx.type = 0;
  let nonce = 'unreadable', hash;
  try {
    nonce = await borne(signer.provider.getTransactionCount(signer.address, 'pending'), 30_000, `reading the nonce for ${libelle}: nonce`);
    const pret = await borne(signer.populateTransaction({ ...tx, nonce }), 30_000, `preparing the fees for ${libelle}: gas`);
    delete pret.from;
    // Gas price floor on Sepolia: the RPC's price falls below the nodes' admission threshold (0.0006 gwei on
    // 17/10), the transaction is accepted then dropped silently and the receipt never comes. 0.01 gwei costs
    // fractions of a microether and goes through.
    if (c.legacy) { const plancher = BigInt(process.env.PC_MIN_GAS_PRICE_WEI || '10000000'); if (!pret.gasPrice || BigInt(pret.gasPrice) < plancher) pret.gasPrice = plancher; }
    const brut = await signer.signTransaction(pret);
    hash = (await diffuserBrut(chaine, brut, delaiMs)) ?? Transaction.from(brut).hash;
  } catch (e) {
    const apres = await signer.provider.getTransactionCount(signer.address, 'latest').catch(() => 'unreadable');
    throw new Error(`${libelle} : ${e.shortMessage || e.message} [nonce ${nonce}, chain ${apres}]`);
  }
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    const recu = await signer.provider.getTransactionReceipt(hash).catch(() => null);
    if (recu) {
      if (recu.status !== 1) throw new Error(`${libelle} : transaction ${hash} REVERTED`);
      return recu;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${libelle} : TIMEOUT (${delaiMs} ms) : transaction ${hash} broadcast (nonce ${nonce}), no receipt`);
}

/** Call of a Contract's function going through `envoyer` (type and gas under control). */
export function appeler(signer, chaine, contrat, methode, args, options) {
  return envoyer(signer, chaine, { to: contrat.target, data: contrat.interface.encodeFunctionData(methode, args) }, { libelle: `${methode}`, ...options });
}
