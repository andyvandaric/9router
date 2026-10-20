import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { probeProxyEgress } from "../../open-sse/utils/proxyHealth.js";

const servers = new Set();
const openSockets = new Set();

const CLOSE_TIMEOUT_MS = 1000;

/**
 * Minimal SOCKS5 peer. "ok" completes the no-auth greeting and a CONNECT,
 * "hang" accepts and then never answers (the VLESS-upstream-dead mode).
 */
function startSocksServer(mode = "ok") {
  const state = { connections: 0 };
  const server = net.createServer(socket => {
    state.connections += 1;
    // Tracked so teardown can destroy it: a peer that never answers keeps its
    // socket open, and server.close() waits for open connections to drain.
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
    socket.on("error", () => {});
    if (mode === "hang") return;

    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        buffer = buffer.subarray(2);
        socket.write(Buffer.from([5, 0]));
        stage = "connect";
      }
      if (stage === "connect") {
        // ver(1) cmd(1) rsv(1) atyp(1) then address + port — we only need the head.
        if (buffer.length < 5) return;
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        stage = "done";
      }
    });
  });
  servers.add(server);
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `socks5://127.0.0.1:${port}`, state, server });
    });
  });
}

async function closedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/**
 * Close a server without waiting indefinitely. server.close() only invokes its
 * callback once every open connection has drained, so the timeout is the
 * backstop that keeps teardown deterministic.
 */
function closeServer(server) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  try {
    // A peer that accepted but never answered keeps its socket open forever,
    // and server.close() waits for those to drain. Destroying the tracked
    // sockets first makes the drain deterministic instead of a 10s hang.
    for (const socket of openSockets) {
      try {
        socket.destroy();
      } catch {
        // A socket that refuses to die must not block the rest of teardown.
      }
    }
    openSockets.clear();

    for (const server of servers) {
      try {
        await closeServer(server);
      } catch {
        // One uncooperative server must not stop the others from closing.
      }
    }
  } finally {
    openSockets.clear();
    servers.clear();
  }
});

describe("proxyHealth", () => {
  it("proxyHealth: resolves ok on a successful SOCKS5 CONNECT handshake", async () => {
    const { url } = await startSocksServer("ok");
    const result = await probeProxyEgress(url, { timeoutMs: 1000, targetHost: "example.test" });
    expect(result).toEqual({ ok: true });
  });

  it("proxyHealth: rejects with reason timeout without waiting for the upstream", async () => {
    const { url } = await startSocksServer("hang");
    const startedAt = Date.now();
    const result = await probeProxyEgress(url, { timeoutMs: 150, targetHost: "example.test" });
    const elapsed = Date.now() - startedAt;
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(elapsed).toBeLessThan(600);
  });

  it("proxyHealth: returns reason refused on ECONNREFUSED", async () => {
    const port = await closedPort();
    const result = await probeProxyEgress(`socks5://127.0.0.1:${port}`, {
      timeoutMs: 1000,
      targetHost: "example.test",
    });
    expect(result).toEqual({ ok: false, reason: "refused" });
  });

  it("proxyHealth: returns reason malformed for a non-socks5 url without throwing synchronously", async () => {
    const pending = probeProxyEgress("http://127.0.0.1:9999", { timeoutMs: 1000 });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("proxyHealth: caches a result for the TTL and collapses concurrent probes into one dial", async () => {
    const { url, state } = await startSocksServer("ok");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => probeProxyEgress(url, { timeoutMs: 1000, targetHost: "example.test" })),
    );
    expect(results.every(result => result.ok)).toBe(true);
    expect(state.connections).toBe(1);

    await probeProxyEgress(url, { timeoutMs: 1000, targetHost: "example.test" });
    expect(state.connections).toBe(1);
  });

  it("proxyHealth: never throws - always resolves a result object", async () => {
    const inputs = ["", null, undefined, "not a url", "socks5://", "socks5://127.0.0.1", { url: "x" }, 42];
    for (const input of inputs) {
      const result = await probeProxyEgress(input, { timeoutMs: 100, targetHost: "example.test" });
      expect(typeof result).toBe("object");
      expect(typeof result.ok).toBe("boolean");
    }
  });
});
