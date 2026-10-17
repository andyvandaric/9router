import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import net from "node:net";
import https from "node:https";
import { once } from "node:events";
import selfsigned from "selfsigned";
import { fetch as undiciFetch, ProxyAgent } from "undici";

// Make proxyAwareFetch use the trusted fixture CA without changing production TLS policy.
const caForFetch = vi.hoisted(() => ({ value: undefined }));
vi.mock("../../open-sse/utils/proxyDispatcher.js", async importOriginal => {
  const actual = await importOriginal();
  return {
    createProxyDispatcher: options => actual.createProxyDispatcher({
      ...options,
      ...(caForFetch.value ? { requestTls: { ...options.requestTls, ca: caForFetch.value } } : {}),
    }),
  };
});

const targetHost = "socks-dns.example.test";
const dispatchers = [];
const sockets = new Set();
const servers = [];

async function fixture(requireAuth = false) {
  const certificate = await selfsigned.generate([{ name: "commonName", value: targetHost }], {
    keySize: 2048,
    days: 1,
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: targetHost }] }],
  });
  const received = [];
  const targets = [];
  const credentials = [];
  const tlsServer = https.createServer({ key: certificate.private, cert: certificate.cert }, (req, res) => {
    received.push({ host: req.headers.host, servername: req.socket.servername, method: req.method });
    res.end("OK");
  });
  const track = socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  tlsServer.on("connection", track);
  await listen(tlsServer);
  const proxy = net.createServer(socket => {
    track(socket);
    let buffer = Buffer.alloc(0);
    let state = "greeting";
    socket.on("data", function read(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === "greeting") {
        if (buffer.length < 2 || buffer.length < buffer[1] + 2) return;
        buffer = buffer.subarray(buffer[1] + 2);
        socket.write(Buffer.from([5, requireAuth ? 2 : 0]));
        state = requireAuth ? "auth" : "connect";
      }
      if (state === "auth") {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
        const userEnd = 2 + buffer[1];
        const end = userEnd + 1 + buffer[userEnd];
        if (buffer.length < end) return;
        credentials.push({ username: buffer.subarray(2, userEnd).toString(), password: buffer.subarray(userEnd + 1, end).toString() });
        buffer = buffer.subarray(end);
        socket.write(Buffer.from([1, 0]));
        state = "connect";
      }
      if (buffer.length < 5) return;
      const type = buffer[3];
      const length = type === 1 ? 10 : type === 3 ? 7 + buffer[4] : 22;
      if (buffer.length < length) return;
      const host = type === 1 ? [...buffer.subarray(4, 8)].join(".")
        : type === 3 ? buffer.subarray(5, length - 2).toString() : "ipv6";
      targets.push({ type, host });
      socket.removeListener("data", read);
      socket.pause();
      const upstream = track(net.connect(tlsServer.address().port, "127.0.0.1"));
      upstream.once("connect", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (buffer.length > length) upstream.write(buffer.subarray(length));
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
      socket.once("close", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
    });
  });
  await listen(proxy);
  return {
    proxyUrl: `socks5://127.0.0.1:${proxy.address().port}`,
    url: `https://${targetHost}:${tlsServer.address().port}/probe`,
    ca: certificate.cert,
    targets,
    received,
    credentials,
  };
}
async function listen(server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
async function factory(options) {
  const { createProxyDispatcher } = await import("../../open-sse/utils/proxyDispatcher.js");
  const dispatcher = await createProxyDispatcher(options);
  dispatchers.push(dispatcher);
  return dispatcher;
}
afterEach(async () => {
  caForFetch.value = undefined;
  vi.restoreAllMocks();
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe("optional SOCKS DNS mode", () => {
  it("keeps proxy DNS by default and with dns=remote", async () => {
    const f = await fixture();
    const lookup = vi.spyOn(dns.promises, "lookup");
    for (const suffix of ["", "?dns=remote"]) {
      const dispatcher = await factory({ uri: f.proxyUrl + suffix, requestTls: { ca: f.ca } });
      const response = await undiciFetch(f.url, { dispatcher, signal: AbortSignal.timeout(5000) });
      expect(await response.text()).toBe("OK");
    }
    expect(f.targets).toEqual([{ type: 3, host: targetHost }, { type: 3, host: targetHost }]);
    expect(lookup.mock.calls.some(([host]) => host === targetHost)).toBe(false);
  });

  it("resolves locally only when opted in, preserving TLS verification, Host and SNI", async () => {
    const f = await fixture();
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "127.0.0.1", family: 4 });
    const dispatcher = await factory({ uri: f.proxyUrl + "?dns=local", requestTls: { ca: f.ca } });
    const response = await undiciFetch(f.url, { dispatcher, signal: AbortSignal.timeout(5000) });
    expect(await response.text()).toBe("OK");
    expect(f.targets).toEqual([{ type: 1, host: "127.0.0.1" }]);
    expect(f.received).toEqual([{ host: new URL(f.url).host, servername: targetHost, method: "GET" }]);
    const untrusted = await factory({ uri: f.proxyUrl + "?dns=local" });
    await expect(undiciFetch(f.url, { dispatcher: untrusted, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  });

  it("accepts an IPv6 result from the local resolver", async () => {
    const f = await fixture();
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "::1", family: 6 });
    const dispatcher = await factory({ uri: f.proxyUrl + "?dns=local", requestTls: { ca: f.ca } });
    const response = await undiciFetch(f.url, { dispatcher, signal: AbortSignal.timeout(5000) });
    expect(await response.text()).toBe("OK");
    expect(f.targets).toEqual([{ type: 4, host: "ipv6" }]);
  });

  it("skips local DNS when the destination is already an IP literal", async () => {
    const f = await fixture();
    const lookup = vi.spyOn(dns.promises, "lookup");
    const dispatcher = await factory({
      uri: f.proxyUrl + "?dns=local",
      requestTls: { ca: f.ca, servername: targetHost },
    });
    const target = new URL(f.url);
    target.hostname = "127.0.0.1";
    const response = await undiciFetch(target, { dispatcher, signal: AbortSignal.timeout(5000) });
    expect(await response.text()).toBe("OK");
    expect(lookup).not.toHaveBeenCalled();
    expect(f.targets).toEqual([{ type: 1, host: "127.0.0.1" }]);
  });

  it("propagates lookup failures without sending a SOCKS domain fallback", async () => {
    const f = await fixture();
    vi.spyOn(dns.promises, "lookup").mockRejectedValue(Object.assign(new Error("synthetic DNS failure"), { code: "ENOTFOUND" }));
    const dispatcher = await factory({ uri: f.proxyUrl + "?dns=local", requestTls: { ca: f.ca } });
    await expect(undiciFetch(f.url, { dispatcher, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(f.targets).toEqual([]);
  });

  it("retains percent-encoded SOCKS credentials", async () => {
    const f = await fixture(true);
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "127.0.0.1", family: 4 });
    const proxy = new URL(f.proxyUrl);
    proxy.username = "test%40user";
    proxy.password = "pass%3Aword";
    proxy.search = "dns=local";
    const dispatcher = await factory({ uri: proxy.href, requestTls: { ca: f.ca } });
    const response = await undiciFetch(f.url, { dispatcher, signal: AbortSignal.timeout(5000) });
    expect(await response.text()).toBe("OK");
    expect(f.credentials).toEqual([{ username: "test@user", password: "pass:word" }]);
  });

  it("bounds a pending local DNS lookup", async () => {
    const f = await fixture();
    vi.spyOn(dns.promises, "lookup").mockImplementation(() => new Promise(() => {}));
    const dispatcher = await factory({ uri: f.proxyUrl + "?dns=local", requestTls: { ca: f.ca } });
    await expect(undiciFetch(f.url, { dispatcher, signal: AbortSignal.timeout(6500) })).rejects.toMatchObject({
      cause: { code: "ETIMEDOUT" },
    });
    expect(f.targets).toEqual([]);
  }, 8000);

  it("preserves caller cancellation while DNS is pending", async () => {
    const f = await fixture();
    let finishLookup;
    vi.spyOn(dns.promises, "lookup").mockImplementation(() => new Promise(resolve => { finishLookup = resolve; }));
    const dispatcher = await factory({ uri: f.proxyUrl + "?dns=local", requestTls: { ca: f.ca } });
    const controller = new AbortController();
    const request = undiciFetch(f.url, { dispatcher, signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finishLookup).toBeTypeOf("function"));
    controller.abort();
    await rejected;
    finishLookup({ address: "127.0.0.1", family: 4 });
    await dispatcher.destroy();
    expect(f.received).toEqual([]);
  });

  it("rejects unknown, duplicated and non-SOCKS DNS modes", async () => {
    for (const uri of ["socks5://127.0.0.1:1?dns=invalid", "socks5://127.0.0.1:1?dns=local&dns=remote", "http://127.0.0.1:1?dns=local"]) {
      await expect(factory({ uri })).rejects.toThrow(/DNS mode/);
    }
  });

  it("uses the same DNS mode in the model transport and dashboard proxy test", async () => {
    const f = await fixture();
    caForFetch.value = f.ca;
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "127.0.0.1", family: 4 });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const { testProxyUrl } = await import("../../src/lib/network/proxyTest.js");
    const local = f.proxyUrl + "?dns=local";
    const response = await proxyAwareFetch(f.url, { signal: AbortSignal.timeout(5000) }, {
      enabled: true, url: local, strictProxy: true,
    });
    expect(await response.text()).toBe("OK");
    const remote = await proxyAwareFetch(f.url, { signal: AbortSignal.timeout(5000) }, {
      enabled: true, url: f.proxyUrl, strictProxy: true,
    });
    expect(await remote.text()).toBe("OK");
    expect(await testProxyUrl({ proxyUrl: local, testUrl: f.url })).toMatchObject({ ok: true, status: 200 });
    expect(f.targets).toEqual([
      { type: 1, host: "127.0.0.1" }, { type: 3, host: targetHost }, { type: 1, host: "127.0.0.1" },
    ]);
  });

  it("fails closed for an invalid DNS mode even when strictProxy is off", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(proxyAwareFetch("https://nonexistent.invalid/", {}, {
      enabled: true, url: "socks5://127.0.0.1:1?dns=typo", strictProxy: false,
    })).rejects.toMatchObject({ code: "ERR_PROXY_DNS_MODE" });
  });

  it("leaves HTTP proxy creation unchanged", async () => {
    const dispatcher = await factory({ uri: "http://127.0.0.1:1234" });
    expect(dispatcher).toBeInstanceOf(ProxyAgent);
  });
});
