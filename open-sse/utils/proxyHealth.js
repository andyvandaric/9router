/**
 * Liveness probe for a SOCKS5 egress proxy.
 *
 * A dead tunnel has two shapes. When the process is gone the OS answers
 * ECONNREFUSED fast; when the process is alive but its upstream is not, the
 * greeting is accepted and the CONNECT reply never arrives. The second shape
 * is why this probe carries its own hard timeout — waiting for a refusal
 * would hold the request slot indefinitely.
 *
 * The probe stops after the CONNECT reply and never sends an HTTP request, so
 * it costs no upstream quota. Fail-open by contract: every path resolves a
 * result object, nothing is thrown at the caller.
 */

import net, { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 200;

const SOCKS_VERSION = 5;
const AUTH_METHOD_NONE = 0;
const CMD_CONNECT = 1;
const REP_SUCCESS = 0;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const MAX_DOMAIN_LENGTH = 255;

// CONNECT destination only. No bytes are ever exchanged with it — the reply to
// this request is what proves the tunnel dials — so the value is inert.
const DEFAULT_TARGET_HOST = "example.com";
const TARGET_PORT = 443;

const SUPPORTED_PROTOCOLS = new Set(["socks5:", "socks5h:"]);
const REFUSED_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIMEOUT"]);

const STAGE_GREETING = "greeting";
const STAGE_CONNECT = "connect";

/** @type {Map<string, {expiresAt: number, result: Promise<object>}>} */
const resultCache = new Map();

function failure(reason) {
  return { ok: false, reason };
}

function normalizeTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

/**
 * Canonical cache key, or null when the URL cannot describe a SOCKS5 proxy.
 * The port must be explicit — a missing one is not silently defaulted.
 */
function proxyCacheKey(proxyUrl) {
  const raw = typeof proxyUrl === "string" ? proxyUrl : proxyUrl instanceof URL ? proxyUrl.href : "";
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) return null;
    if (!parsed.hostname || !parsed.port) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function encodeTarget(targetHost) {
  const requested = typeof targetHost === "string" ? targetHost.trim() : "";
  const host = requested && Buffer.byteLength(requested) <= MAX_DOMAIN_LENGTH ? requested : DEFAULT_TARGET_HOST;
  const port = Buffer.from([TARGET_PORT >> 8, TARGET_PORT & 0xff]);

  if (isIP(host) === 4) {
    const address = Buffer.from(host.split(".").map(Number));
    return Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0, ATYP_IPV4]), address, port]);
  }

  const name = Buffer.from(host, "utf8");
  return Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0, ATYP_DOMAIN, name.length]), name, port]);
}

function classifySocketError(error) {
  const code = error?.code;
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (REFUSED_CODES.has(code)) return "refused";
  return "handshake";
}

function runHandshake(socket, connectRequest, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stage = STAGE_GREETING;
    let buffer = Buffer.alloc(0);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish(failure("timeout")), timeoutMs);

    socket.on("connect", () => socket.write(Buffer.from([SOCKS_VERSION, 1, AUTH_METHOD_NONE])));
    socket.on("error", (error) => finish(failure(classifySocketError(error))));
    // A peer that accepted TCP and then closed before replying is a broken
    // handshake, not a timeout — it never held the slot.
    socket.on("close", () => finish(failure("handshake")));

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === STAGE_GREETING) {
        if (buffer.length < 2) return;
        if (buffer[0] !== SOCKS_VERSION || buffer[1] !== AUTH_METHOD_NONE) {
          finish(failure("handshake"));
          return;
        }
        buffer = buffer.subarray(2);
        stage = STAGE_CONNECT;
        socket.write(connectRequest);
      }

      if (stage === STAGE_CONNECT) {
        // Reply head: version, reply code, reserved, address type.
        if (buffer.length < 4) return;
        if (buffer[0] !== SOCKS_VERSION || buffer[1] !== REP_SUCCESS) {
          finish(failure("handshake"));
          return;
        }
        finish({ ok: true });
      }
    });
  });
}

async function dialSocks5(proxyUrl, timeoutMs, targetHost) {
  const proxy = new URL(proxyUrl);
  const host = proxy.hostname.replace(/^\[|\]$/g, "");
  const port = Number(proxy.port);
  const connectRequest = encodeTarget(targetHost);

  let socket;
  try {
    socket = net.createConnection({ host, port });
  } catch {
    return failure("refused");
  }

  try {
    return await runHandshake(socket, connectRequest, timeoutMs);
  } catch {
    return failure("handshake");
  } finally {
    socket.destroy();
  }
}

function pruneCache(now) {
  for (const [key, entry] of resultCache) {
    if (entry.expiresAt <= now) resultCache.delete(key);
  }
  while (resultCache.size > MAX_CACHE_ENTRIES) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

/**
 * Probe a SOCKS5 proxy by completing a CONNECT handshake within a hard
 * timeout. Concurrent calls for the same proxy share one dial for the TTL.
 *
 * @param {string} proxyUrl socks5:// or socks5h:// URL, port required
 * @param {{timeoutMs?: number, targetHost?: string}} [options]
 * @returns {Promise<{ok: true} | {ok: false, reason: "timeout"|"refused"|"malformed"|"handshake"}>}
 */
export async function probeProxyEgress(proxyUrl, options = {}) {
  try {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, targetHost } = options ?? {};
    const key = proxyCacheKey(proxyUrl);
    if (!key) return failure("malformed");

    const now = Date.now();
    const cached = resultCache.get(key);
    if (cached && cached.expiresAt > now) return await cached.result;

    // Store the in-flight promise, not the settled value: every probe inside
    // the window joins the same dial instead of opening another one.
    const result = dialSocks5(key, normalizeTimeout(timeoutMs), targetHost);
    resultCache.set(key, { expiresAt: now + CACHE_TTL_MS, result });
    pruneCache(now);
    return await result;
  } catch {
    return failure("handshake");
  }
}
