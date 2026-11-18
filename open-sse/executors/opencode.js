import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { HTTP_STATUS, MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { FREETIER_KIND, classifyFreeTierRejection, rewriteEgressRejection } from "../utils/freeTierEgress.js";
import { getQuotaCooldown } from "../services/accountFallback.js";
import { opencodeTlsFetch } from "../services/opencodeTlsClient.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
const OPENCODE_UA = "opencode/latest/2.0.29/cli";
const OPENCODE_CLIENT = "cli";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Bounded retries for an egress-reputation block. More attempts cannot help a
// flagged address, and each one waits getQuotaCooldown(attempt) milliseconds.
const MAX_EGRESS_ATTEMPTS = 3;

// Free-lane load shedding: total attempts (first try + retries) and backoff.
// Live bursts last ~20 s (a request that kept failing for 8 s succeeded at 19 s),
// so the schedule below covers 800+1600+2400+3200+4000*3 = ~20 s.
const OPENCODE_OVERLOAD_ATTEMPTS = 8;
const OPENCODE_OVERLOAD_BASE_MS = 800;
const OPENCODE_OVERLOAD_MAX_MS = 4000;
const OPENCODE_OVERLOAD_RE = /overloaded/i;
// A 429 that names the per-IP free-usage quota. A fresh session id cannot clear
// it, so it must not rotate (upstream's fix); an unclassified 429 still does.
const OPENCODE_FREE_USAGE_RE = /FreeUsageLimitError|free usage limit/i;

async function isFreeUsageRejection(response) {
  try {
    return OPENCODE_FREE_USAGE_RE.test(await response.clone().text());
  } catch {
    return false;
  }
}

/**
 * Classify a gated free-lane rejection:
 * - "overload": transient 429 load shedding, worth retrying.
 * - "session":  any other 429 (FreeUsageLimitError) or 403, which can mean the
 *               session id itself is spent or flagged.
 * - null:       anything else.
 */
async function classifyRejection(response) {
  const status = response?.status;
  if (status !== 429 && status !== 403) return null;
  if (status === 403) return "session";
  try {
    // The body is the response stream; clone it so a non-retryable 429 is still
    // delivered intact to the caller.
    return OPENCODE_OVERLOAD_RE.test(await response.clone().text()) ? "overload" : "session";
  } catch {
    return "session";
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}
// Models served by /inference/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${unstableRandom()}`;
}

// Upstream decodes the prefix timestamp and refuses sessions whose time is in
// the future or older than the free-tier window (live probes 2026-10-26: a
// Date.now() session passed 10/10 while digest-derived ones passed 1/10). A
// digest is uniform over 2^36 ms, so most translated ids were refused even
// though their shape matched. Mint with the current time and memoize per
// conversation so a conversation keeps one stable, valid session.
const translatedOpencodeSessions = new Map();
const MAX_TRANSLATED_SESSIONS = 5000;
const translatedSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of translatedOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      translatedOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (translatedSessionCleanup.unref) translatedSessionCleanup.unref();

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const key = `${clientTool || "generic"}\0${sessionId || ""}`;
  const existing = translatedOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.sessionId;
  }
  const translated = `ses_${descendingTimeHex(Date.now(), 1)}${unstableRandom()}`;
  if (translatedOpencodeSessions.size >= MAX_TRANSLATED_SESSIONS) {
    translatedOpencodeSessions.delete(translatedOpencodeSessions.keys().next().value);
  }
  translatedOpencodeSessions.set(key, { sessionId: translated, lastUsed: Date.now() });
  return translated;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;

// Where a request's session came from. Only "stable" (self-minted, per-identity)
// sessions are safe to rotate: native and derived sessions are dictated by the
// caller and must pass through untouched.
const SESSION_SOURCE = { native: "native", derived: "derived", stable: "stable" };

/** Delete the stable session entry for this identity (upstream rejected it). */
export function evictStableSession(credentials) {
  stableOpencodeSessions.delete(identityKey(credentials));
}

/**
 * Wait before the next attempt. Resolves true when the caller aborted during
 * the wait, so a cancelled request never sits out the full backoff.
 */
function sleepUnlessAborted(ms, signal) {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // An abort between the guard above and the listener attach would otherwise
    // never fire; re-check so a cancelled request never waits out the backoff.
    if (signal?.aborted) onAbort();
  });
}

const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

// The memoized sessions above are never refreshed on failure, so once upstream
// spends or flags one, every later request reuses it and fails the same way
// until restart (#5559). Drop the rejected id so the next request mints a fresh
// one. Match by value, not identity key: a concurrent request may already have
// minted a replacement, which must survive.
export function forgetOpencodeSession(sessionId) {
  if (!sessionId) return false;
  let removed = false;
  for (const store of [stableOpencodeSessions, translatedOpencodeSessions]) {
    for (const [key, entry] of store) {
      if (entry.sessionId === sessionId) {
        store.delete(key);
        removed = true;
      }
    }
  }
  return removed;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return { session: native, source: SESSION_SOURCE.native };

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return { session: translateSessionId(hinted, clientTool), source: SESSION_SOURCE.derived };

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return { session: translateSessionId(viaManager, clientTool), source: SESSION_SOURCE.derived };
  }

  return { session: stableSessionId(credentials), source: SESSION_SOURCE.stable };
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  // Adaptive / budget-less thinking (Claude Code's thinking:{type:"adaptive"})
  // arrives as "auto", which upstream rejects with 400 "unknown variant `auto`".
  // Omitting effort lets upstream pick its default, which is what adaptive means.
  if (effort === "auto") delete body.reasoning.effort;
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// Chat Completions lane: the free backend validates reasoning_effort against the
// plain OpenAI enum (none|minimal|low|medium|high|xhigh|max) and answers 400
// "Invalid option" for anything else — including "auto", which adaptive thinking
// (Claude Code's thinking:{type:"adaptive"}) arrives as. Omitting the field lets
// the upstream pick its own default, which is what adaptive means; same rationale
// as the Responses path above, which rejects "unknown variant `auto`".
function dropAdaptiveReasoningEffort(body) {
  if (body?.reasoning_effort === "auto") delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const { session, source } = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
      _opencodeSessionSource: source,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Free-tier fingerprint tools are required even when an agent client
      // already supplied tools. ZCode/Claude Code requests normally have
      // non-empty tool arrays; skipping cloaking here triggers 403 FreeTierError.
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      dropAdaptiveReasoningEffort(body);
      applyFingerprintTools(body, false, { claude: isMessagesModel(model || body?.model) });
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  // The free gate keys on the TLS ClientHello, so a native Node fetch is refused
  // no matter how faithful the body is. Route through the impersonating client
  // and keep proxy handling on the existing path (proxyAwareFetch delegates to
  // `directFetch` when no proxy is configured, and passes the resolved proxy
  // URL through when one is). Fail-open: without wreq-js the request still goes
  // out on native fetch instead of erroring here.
  async execute(args) {
    const directFetch = (url, options, proxyUrl) => opencodeTlsFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    }, { signal: options.signal, proxyUrl });
    // wreq-js tunnels the proxy itself; adapters that cannot must stay on undici.
    directFetch.proxyCapable = true;

    let prepared = this.prepareRequestCredentials(args);
    let rotatedForRateLimit = false;
    let rotatedForFingerprint = false;
    let egressAttempt = 1;

    // Only a session this server minted is ours to replace; native and derived
    // ids are dictated by the caller and must pass through untouched.
    const rotateSession = () => {
      forgetOpencodeSession(prepared[SESSION_FIELD]);
      evictStableSession(prepared);
      prepared = this.prepareRequestCredentials(args);
    };

    for (let attempt = 1; ; attempt++) {
      const result = await super.execute({ ...args, credentials: prepared, directFetch });
      const response = result?.response;
      const canRotate = prepared._opencodeSessionSource === SESSION_SOURCE.stable;

      // 1. Upstream's transient overload 429 ("The inference service is overloaded").
      //    Retry with backoff; keep the same session across retries.
      const rejection = await classifyRejection(response);
      if (rejection === "overload") {
        if (attempt >= OPENCODE_OVERLOAD_ATTEMPTS || args.signal?.aborted) return result;
        response.body?.cancel?.().catch?.(() => {});
        args.log?.debug?.("RETRY", `OpenCode free lane overloaded, retry ${attempt}/${OPENCODE_OVERLOAD_ATTEMPTS - 1}`);
        const backoff = Math.min(OPENCODE_OVERLOAD_BASE_MS * attempt, OPENCODE_OVERLOAD_MAX_MS);
        await sleep(backoff + Math.random() * 250, args.signal);
        if (args.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        continue;
      }

      // 2. Free-tier gate 403 (fingerprint / egress) — only for stable sessions.
      //    The gate answers a stale/exhausted session with the same 403
      //    FreeTierError as a bad client fingerprint (live probes 2026-10-17), so
      //    that variant is ambiguous: rotate the session once, then give up. Only
      //    the egress variant is separately retryable below.
      const freeTierKind = await classifyFreeTierRejection(response);
      if (freeTierKind === FREETIER_KIND.fingerprint) {
        if (!canRotate) return result;
        if (rotatedForFingerprint) return result;
        rotatedForFingerprint = true;
        rotateSession();
        continue;
      }

      if (freeTierKind === FREETIER_KIND.egress) {
        if (!canRotate) return result;
        if (egressAttempt >= MAX_EGRESS_ATTEMPTS) {
          return {
            ...result,
            response: await rewriteEgressRejection(response, {
              provider: this.provider,
              model: args?.model,
              poolId: args?.proxyOptions?.proxyPoolId || null,
            }),
          };
        }
        rotateSession();
        if (await sleepUnlessAborted(getQuotaCooldown(egressAttempt), args?.signal)) return result;
        egressAttempt++;
        continue;
      }

      // 3. Non-gate 429 / bare 403. A quota 429 (FreeUsageLimitError) is per-IP
      //    and never cleared by a fresh session id: drop the minted id for the
      //    next request (#5559) and return upstream's answer untouched
      //    (upstream's fix). An unclassified 429 is the fork's original case —
      //    upstream blackholes exactly one stable session while fresh sessions
      //    succeed — so it rotates once. A bare 403 only drops the minted id.
      //    Native/derived sessions belong to the caller and pass through.
      if (rejection === "session") {
        if (response?.status === HTTP_STATUS.RATE_LIMITED
          && !(await isFreeUsageRejection(response))) {
          if (!canRotate) return result;
          if (rotatedForRateLimit) return result;
          rotatedForRateLimit = true;
          rotateSession();
          continue;
        }
        // A client-supplied native session is not ours to replace; this only
        // drops ids we minted, so the next request starts on a fresh one.
        if (forgetOpencodeSession(prepared[SESSION_FIELD])) {
          args.log?.debug?.("SESSION", `OpenCode ${response.status}: dropped cached session, next request re-mints`);
        }
        return result;
      }

      // 4. Anything else (200, non-gate 403, 500, etc.) — return untouched.
      return result;
    }
  }

  // Free tier moved from /zen/v1 to /inference/v1 (OpenCode v2); /zen/v1 now
  // answers every free request with 403 FreeTierError.
  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/inference/v1/responses`;
    if (isMessagesModel(model)) return `${base}/inference/v1/messages`;
    return `${base}/inference/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Mirrors the v2 CLI. Upstream needs x-opencode-session-id next to
    // x-opencode-session, and rejects any x-opencode-request (v1 only) with 403.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
