// FX corridor guard: THE POOL IS IN BASE TOKENS (owner's decision, 2026-10-16).
// The Uniswap V3 pool holds EURX and SGDX (the TokenRep), never wEURX nor wSGDX: the composer unpacks before the
// deposit and packs on exit, compliance applies to the wrap's transfer, not to the deposit into the pool.
//
// Everything is READ on the chain: a token is a wrap if it answers `underlying()` (OZ ERC20Wrapper), with no
// copied list of addresses. The tracer's wrap addresses serve as a second barrier, not as the source.
// DATA KEPT AS SPELLED, not prose: the two REFUSAL MESSAGES below are matched by pool-base-guard.test.mjs;
// renaming them means editing both files in one pass.
import { Contract } from 'ethers';

const TOKEN_ABI = [
  'function symbol() view returns (string)',
  'function underlying() view returns (address)',
];
const POOL_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)'];

/** Pure logic, testable without network. `lire(adresse)` returns { symbol, underlying } (underlying null if the token is not a wrap).
 *  Raises an Error that NAMES the offending token. */
export function verifierJetonsDeBase({ token0, token1, wrapsConnus = [], lire }) {
  const norm = (a) => String(a).toLowerCase();
  const connus = new Set(wrapsConnus.map(norm));
  return Promise.all([token0, token1].map(async (adresse, i) => {
    const { symbol, underlying } = await lire(adresse);
    const role = i === 0 ? 'token0' : 'token1';
    if (underlying) {
      throw new Error(`REFUSAL: ${role} of the pool = ${symbol} (${adresse}) is a WRAP (underlying() = ${underlying}). The pool must hold base tokens (EURX, SGDX), never wEURX or wSGDX.`);
    }
    if (connus.has(norm(adresse))) {
      throw new Error(`REFUSAL: ${role} of the pool = ${symbol} (${adresse}) is a wrapper from the tracker. The pool must hold base tokens (EURX, SGDX).`);
    }
    return { role, symbol, adresse };
  }));
}

/** Chain read: `lire` for a given provider. */
export function lireJeton(provider) {
  return async (adresse) => {
    const c = new Contract(adresse, TOKEN_ABI, provider);
    const symbol = await c.symbol();
    // An `underlying()` failure = base token. Only the call revert is masked (CALL_EXCEPTION): a
    // network outage must make the guard fail, never pass as "not a wrap".
    let underlying = null;
    try { underlying = await c.underlying(); } catch (e) { if (e.code !== 'CALL_EXCEPTION' && e.code !== 'BAD_DATA') throw e; }
    return { symbol, underlying };
  };
}

/** Guard on an EXISTING pool: reads token0/token1 on the chain and refuses if either is a wrap. */
export async function garantirPoolEnJetonsDeBase({ provider, pool, wrapsConnus = [] }) {
  const p = new Contract(pool, POOL_ABI, provider);
  const [token0, token1] = await Promise.all([p.token0(), p.token1()]);
  return verifierJetonsDeBase({ token0, token1, wrapsConnus, lire: lireJeton(provider) });
}

/** Guard on a PAIR before pool creation: the two addresses destined for the pool are not wraps. */
export async function garantirPaireEnJetonsDeBase({ provider, tokenA, tokenB, wrapsConnus = [] }) {
  return verifierJetonsDeBase({ token0: tokenA, token1: tokenB, wrapsConnus, lire: lireJeton(provider) });
}
