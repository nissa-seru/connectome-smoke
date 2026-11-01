
const REF = /\bimg_[0-9a-z]+_(\d+)\b/g;
const FORK = /\b(fork-[^\s"]*?-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

// Two runs of one key differ only in agent-framework's per-process image-ref nonce, in the random UUID the host's
// subagent module gives a fork's call when its own call isn't in context (subagent-module.ts), and in the stand-in's
// thinking signatures, which hash the request ahead of them.
export function maskRunVarying(value) {
  if (typeof value === 'string') return value.replace(REF, 'img_*_$1').replace(FORK, '$1UUID');
  if (Array.isArray(value)) return value.map(maskRunVarying);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === 'signature' && value.type === 'thinking' ? '(masked)' : maskRunVarying(v);
  return out;
}

