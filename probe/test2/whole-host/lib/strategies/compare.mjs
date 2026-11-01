/**
 * Comparing two runs' requests or records (lane-requirements N12). Two runs of one key differ
 * by design in two places, and only those are masked:
 * - the image ledger's nonce in a tool image's ref, `img_<nonce>_<n>`: agent-framework makes
 *   it random per process, so a ref from before a restart never resolves to other bytes
 *   (`tool-image-ledger.ts`, `mintLedgerNonce`); the sequence number `<n>` is kept;
 * - the signature of every thinking block, which the stand-in mints over the request's
 *   content (standin.mjs, `bindingIdentity`), the nonce included.
 * Anything else that differs, keys' order included, is a difference.
 */

const REF = /\bimg_[0-9a-z]+_(\d+)\b/g;

/** A copy of `value` with what differs between runs by design masked. */
export function maskRunVarying(value) {
  if (typeof value === 'string') return value.replace(REF, 'img_*_$1');
  if (Array.isArray(value)) return value.map(maskRunVarying);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === 'signature' && value.type === 'thinking' ? '(masked)' : maskRunVarying(v);
  return out;
}

/** Whether two runs' requests or records are the same once maskRunVarying has masked both. */
export const sameAcrossRuns = (a, b) => JSON.stringify(maskRunVarying(a)) === JSON.stringify(maskRunVarying(b));
