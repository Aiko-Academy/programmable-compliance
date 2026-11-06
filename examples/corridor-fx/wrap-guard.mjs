// FX corridor guard: THE PAYER CAN FUND THE WRAP OF ITS PASS (2026-11-06).
// A pass wraps plain EURX into wEURX on Sepolia before it sends. A compliant pass (`compliant`, `agent`) wraps the
// whole amount every time; the other passes (`assurerWrap`) wrap only what the payer's wEURX does not already cover.
// Without enough plain EURX the depositFor reverts on Sepolia and the pass stops with nothing to show: seen on
// 2026-11-06, 0 EURX beside 1000 wEURX, a reverted wrap the dry read had not announced. The guard is read in --dry
// as in --execute, so the dry read refuses what the broadcast would revert.
// DATA KEPT AS SPELLED: the refusal message below is matched by wrap-guard.test.mjs.

/** Pure logic, testable without network; amounts in wei (bigint).
 *  `toutEnvelopper`: true for a compliant pass, which wraps `montant` whatever wEURX the payer holds.
 *  Returns the plain EURX the wrap needs and what is missing (0n when the payer can fund it). */
export function eurxDuWrap({ montant, eurx, weurx, toutEnvelopper }) {
  const besoin = toutEnvelopper ? montant : (weurx >= montant ? 0n : montant - weurx);
  return { besoin, manque: eurx >= besoin ? 0n : besoin - eurx };
}

/** Plain EURX `funds` mints so that ONE compliant pass and then ONE return pass both fund their wrap: the compliant
 *  pass wraps the whole amount and sends it, leaving the payer's wEURX as it was, which then covers the return. */
export function eurxPourDeuxPasses({ montant, eurx, weurx }) {
  const besoin = montant + (weurx >= montant ? 0n : montant - weurx);
  return eurx >= besoin ? 0n : besoin - eurx;
}

/** The refusal of a pass the payer cannot fund, with the two amounts it names (already formatted). */
export const refusWrap = (eurx, besoin) => `the payer holds ${eurx} plain EURX and the wrap needs ${besoin}: play funds first; nothing is sent`;
