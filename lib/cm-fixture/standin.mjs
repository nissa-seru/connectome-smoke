// The model, for the context-management characterization fixture: a provider adapter that membrane's own Membrane
// wraps, so membrane's formatting is inside every request the fixture compares. Its calls are the library's
// compressions, and the agent's own requests the driver sends for a house configuration (H1, H2), as a host sends
// them, for their wire receipts and their real input totals; those carry AGENT_SENTINEL and stay out of the trace.
//
// What an answer depends on: the target its request's instruction states, and the set of canaries and recalled
// summary ids the request carries, never the request's bytes. So a prompt's rewording shows once, in that call's own
// request, and doesn't cascade into every later compile. A request carries its context (the head, recalled
// memories) as well as its sources, so the canaries an answer names are what its request carried, not exactly what
// the summary covers: coverage is read from compile provenance and the store's sourceIds, never from canaries.
//
// Two wording dependencies, each refused loudly rather than guessed past:
// - the target: "Target ~N tokens" (autobiographical's prompts) or "Aim for about N tokens" (knowledge's). A
//   request stating neither throws StandinError, so a reworded prompt can't silently measure a fallback size.
// - whether a call is a merge, read from its last message ("a single L<n> memory", or knowledge's "consolidate these
//   N L<n> summaries"). It's read only to script a merge that keeps failing (the workloads' failure marker
//   `fx:merge-refuse`): a rewording stops that one scripted failure firing, which shows as that run's divergence.
//
// Scripted failures, selected by a marker the workload writes into a message's text (outside the head window):
//   fx:refuse        every call carrying it refuses (stop reason `refusal`)
//   fx:merge-refuse  answered at L1; every merge request carrying it refuses
//   fx:empty         once: an empty answer
//   fx:thinking      once: a thinking block and no text
//   fx:max-tokens    once: text cut off at max_tokens
//   fx:overlong      once: an answer four times its target
//   fx:throw         once: the adapter throws, as a provider error does
//   fx:fail          once: the same, for a second chunk (no marker may be a substring of another: they match by text)
// rejectMerges, a switch rather than a marker, rejects every merge request for its request: the adapter throws what
// the arm's membrane makes of an HTTP 400 invalid_request_error (`reject`, below), which context-manager classes as
// request-attributable, so its ladder tries no other variant of the request.
// A refusal stays with its content, as a model refuses the same text again: a request that carries the marker
// anywhere, its context included, meets it, which is how a quarantined chunk left in later requests' context poisons
// them. The one-off kinds are met by the first call carrying their marker, and later calls are answered.
//
// Pacing (W9's): `pace(n)` lets n answers through and parks the rest until `release(n)` lets more through, so calls
// wait the same way every run with nothing timed.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** This file's digest: what a record's header names as the stand-in its answers came from. */
export const STANDIN_VERSION = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 16);

export class StandinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StandinError';
  }
}

const CANARY = /\bc\d+\.\d+\.[a-z]\b/g;
const RECALLED = /\bL\d+-\d+\b/g;
const MARKERS = ['fx:merge-refuse', 'fx:refuse', 'fx:fail', 'fx:empty', 'fx:thinking', 'fx:max-tokens', 'fx:overlong', 'fx:throw'];
/** The driver's agent requests carry it in their system prompt (driver.mjs' SYSTEM). */
export const AGENT_SENTINEL = '[cm-fixture:agent]';
const MEMORY_PREFIX = 'Memory '; // every answer this stand-in writes opens with it, then its seed's first 8 hex digits

/** Every string in a request, in order: messages' text, tool inputs and results, and the system prompt. */
function textsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) textsOf(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'data' || k === 'signature') continue; // image bytes and thinking signatures carry no words
      textsOf(v, out);
    }
  }
  return out;
}

function canaryKey(c) {
  const [, seed, turn, role] = c.match(/^c(\d+)\.(\d+)\.([a-z])$/);
  return [Number(seed), Number(turn), role];
}
function byCanary(a, b) {
  const x = canaryKey(a), y = canaryKey(b);
  return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
}

/** What a call's answer is a function of, and what a reader of the trace sees it carried. */
export function readRequest(request) {
  const messages = request.messages ?? [];
  const all = textsOf([request.system ?? '', messages]).join('\n');
  const target = all.match(/Target ~(\d+) tokens/) ?? all.match(/Aim for about (\d+) tokens/);
  if (!target) {
    throw new StandinError('the stand-in found no target in a compression request: neither "Target ~N tokens" nor "Aim for about N tokens"');
  }
  const merge = mergeLevel(messages);
  const canaries = [...new Set(all.match(CANARY) ?? [])].sort(byCanary);
  const recalled = [...new Set(all.match(RECALLED) ?? [])].sort();
  const markers = MARKERS.filter((m) => all.includes(m));
  // A marker in a message the workload wrote, rather than inside one of this stand-in's own memories.
  const raw = textsOf(messages).filter((t) => !t.includes(MEMORY_PREFIX)).join('\n');
  const rawMarkers = MARKERS.filter((m) => raw.includes(m));
  return {
    target: Number(target[1]),
    merge,
    canaries,
    recalled,
    markers,
    rawMarkers,
  };
}

/**
 * The level a merge request writes, read from its last message's wording, or null for an L1's request. Also read by
 * the driver's admission (it counts the merges a provider wait held back), on membrane's own request form.
 */
export function mergeLevel(messages) {
  const last = textsOf(messages.at(-1) ?? '').join('\n');
  const merge = last.match(/a single L(\d+) memory/) ?? last.match(/consolidate these \d+ L(\d+) summaries/);
  return merge ? (/consolidate/.test(merge[0]) ? Number(merge[1]) + 1 : Number(merge[1])) : null;
}

function digest(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * A seeded generator of numbers in [0, 1): mulberry32, in 32-bit integer arithmetic throughout. (A 31-bit LCG computed
 * in doubles loses its low bits past 2^53 and falls into a 10,466-state cycle, so its prose repeated itself.)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Filler of a deterministic length from a seed: words, not bytes of the request. */
function filler(seed, chars) {
  const rng = mulberry32(Number.parseInt(seed.slice(0, 8), 16));
  let s = '';
  while (s.length < chars) {
    const n = 2 + Math.floor(rng() * 7);
    for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(rng() * 26));
    s += ' ';
  }
  return s.slice(0, chars).trimEnd();
}

/**
 * The agent request's "real" input total, as a provider's tokenizer would report it: a count of the request's
 * characters at 3.3 a token, unlike context-manager's own estimate, as a real tokenizer differs from it.
 */
export function realInputTokens(request) {
  return Math.ceil(JSON.stringify([request.system ?? null, request.tools ?? null, request.messages ?? []]).length / 3.3);
}

/** About 3.5 characters a token, as the estimators context-manager uses count prose. */
const CHARS_PER_TOKEN = 3.5;

export class StandinAdapter {
  name = 'cm-fixture-standin';
  reportsContentAlterations = true;
  usageCacheConvention = 'cache-excluded';

  /**
   * @param {{ onCall?: (call: object) => void, reject?: (request: object) => Error }} [options] onCall gets each call
   * in the trace's terms (events.mjs' `call`): { request, target, carried, answer: { kind, text? } }, once when it's
   * parked (kind 'held') and once when it's answered. reject makes the error a provider's rejection of a request is
   * (the driver builds it with the arm's membrane, as membrane's own adapters do); a rejection met without it is a
   * fixture defect.
   */
  constructor(options = {}) {
    this.onCall = options.onCall ?? null;
    this.reject = options.reject ?? null;
    /** The first StandinError, a fixture defect the driver ends the run on: the library only ever sees a throw. */
    this.fatal = null;
    this.calls = 0;
    this.inFlight = 0;
    this.parked = [];
    this.allowance = Infinity;
    /** The one-off markers already met. */
    this.spent = new Set();
    /** When true, every merge request refuses (W7's merges-refused: merges starving, #412's failure mode). */
    this.refuseMerges = false;
    /** When true, every merge request is rejected for its request (W7's merges-rejected). */
    this.rejectMerges = false;
  }

  supportsModel() {
    return true;
  }

  /** Let n answers through from now on, parking the rest; Infinity lifts pacing. */
  pace(n) {
    this.allowance = n;
  }

  /** Let n answers through in all from now: parked ones first, oldest first, and then later calls up to n in all. */
  release(n) {
    this.allowance = n;
    while (this.allowance > 0 && this.parked.length > 0) {
      this.allowance--;
      this.parked.shift().resolve();
    }
  }

  /** Calls entered and not yet answered, and how many of those are parked. */
  state() {
    return { calls: this.calls, inFlight: this.inFlight, parked: this.parked.length };
  }

  async complete(request, options) {
    options?.onRequest?.(request);
    // The agent's own request, which the driver sends so membrane hands it a wire receipt (H1): answered at once,
    // outside pacing and the trace's calls, since it's no compression.
    if (textsOf(request.system ?? '').join('\n').includes(AGENT_SENTINEL)) {
      return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: realInputTokens(request), outputTokens: 1 }, model: request.model, rawRequest: request, raw: { standin: true } };
    }
    this.calls++;
    const call = this.calls;
    this.inFlight++;
    try {
      let read;
      try {
        read = readRequest(request);
      } catch (err) {
        this.fatal ??= err;
        throw err;
      }
      const carried = [...read.canaries, ...read.recalled].sort();
      const report = (answer) => this.onCall?.({ request, target: read.target, carried, answer });
      if (this.allowance <= 0) {
        report({ kind: 'held' });
        await new Promise((resolve) => this.parked.push({ resolve, call }));
      } else if (this.allowance !== Infinity) {
        this.allowance--;
      }
      const answer = this.answer(read, request);
      const text = answer.response?.content.find((b) => b.type === 'text')?.text;
      report(text ? { kind: answer.kind, text } : { kind: answer.kind });
      if (answer.kind === 'throw') {
        const err = new Error(`stand-in provider error (${answer.marker})`);
        err.name = 'StandinProviderError';
        throw err;
      }
      if (answer.kind === 'rejection') {
        if (!this.reject) {
          this.fatal ??= new StandinError('the stand-in rejected a request with no reject() to make the provider\'s error');
          throw this.fatal;
        }
        throw this.reject(request);
      }
      return answer.response;
    } finally {
      this.inFlight--;
    }
  }

  async stream(request, callbacks, options) {
    const response = await this.complete(request, options);
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        options?.onProgress?.();
        callbacks?.onChunk?.(block.text);
      }
    }
    return response;
  }

  answer(read, request) {
    // fx:refuse and fx:merge-refuse stay with their content, as a model refuses the same text again. The others
    // are a provider's one-off: the first call that carries the marker meets it, and later calls are answered.
    const once = (m) => {
      if (!read.markers.includes(m) || this.spent.has(m)) return false;
      this.spent.add(m);
      return true;
    };
    const has = (m) => read.markers.includes(m);
    const seed = digest(String(read.target), read.canaries.join(','), read.recalled.join(','));
    const newest = read.canaries.at(-1) ?? 'none';
    // A memory of a slice whose own messages carry fx:merge-refuse carries it on, so the merge that reads it refuses.
    const carryOn = read.rawMarkers.includes('fx:merge-refuse') ? ' fx:merge-refuse' : '';
    const body = (chars) => `${MEMORY_PREFIX}${seed.slice(0, 8)}, carried ${read.canaries.length} canaries to ${newest}${carryOn}: ${filler(seed, chars)}`;
    const size = Math.round(read.target * CHARS_PER_TOKEN);
    const usage = (text) => ({ inputTokens: Math.ceil(JSON.stringify(request.messages ?? []).length / 4), outputTokens: Math.ceil(text.length / 4) });
    const response = (content, stopReason) => ({
      content,
      stopReason,
      usage: usage(content.map((b) => b.text ?? b.thinking ?? '').join('')),
      model: request.model,
      rawRequest: request,
      raw: { standin: true },
    });
    if (once('fx:throw')) return { kind: 'throw', marker: 'fx:throw' };
    if (once('fx:fail')) return { kind: 'throw', marker: 'fx:fail' };
    if (this.rejectMerges && read.merge !== null) return { kind: 'rejection' };
    if (has('fx:refuse') || (has('fx:merge-refuse') && read.merge !== null) || (this.refuseMerges && read.merge !== null)) {
      return { kind: 'refusal', response: response([{ type: 'text', text: 'I can\'t help with that.' }], 'refusal') };
    }
    if (once('fx:empty')) return { kind: 'empty', response: response([{ type: 'text', text: '' }], 'end_turn') };
    if (once('fx:thinking')) {
      return { kind: 'thinking-only', response: response([{ type: 'thinking', thinking: filler(seed, 200), signature: `sig-${seed.slice(0, 16)}` }], 'end_turn') };
    }
    if (once('fx:max-tokens')) return { kind: 'max-tokens', response: response([{ type: 'text', text: body(Math.round(size / 2)) }], 'max_tokens') };
    if (once('fx:overlong')) return { kind: 'over-long', response: response([{ type: 'text', text: body(size * 4) }], 'end_turn') };
    return { kind: 'text', response: response([{ type: 'text', text: body(size) }], 'end_turn') };
  }
}
