# SOCKS5 DNS resolution

By default, 9router keeps the existing SOCKS5 behavior: the proxy receives the destination hostname and resolves it remotely. Some SOCKS gateways handle domain targets differently from numeric targets. If the same request works directly but fails through such a gateway, compare DNS/target addressing before changing provider headers.

## Explicit DNS mode

Add a `dns` query parameter to a **SOCKS5 proxy URL** in Proxy Pools, a connection proxy, or the global outbound proxy setting:

```text
socks5://127.0.0.1:1080                 # unchanged: proxy/remote DNS
socks5://127.0.0.1:1080?dns=remote      # explicit proxy/remote DNS
socks5://127.0.0.1:1080?dns=local       # opt in to local system DNS
socks5://user:password@proxy:1080?dns=local
```

With `dns=local`, the local system resolver chooses an IPv4 or IPv6 address, which is sent through the same SOCKS5 tunnel. IP-literal destinations do not need a DNS lookup. The request URL, HTTP Host, TLS SNI and certificate hostname verification still use the original destination. No destination IP is hardcoded, and proxy-pool rotation is unchanged. The dashboard's proxy test uses the same mode as model traffic. Different DNS-mode URLs have separate dispatcher-cache entries.

Local DNS is bounded to five seconds and lookup errors propagate. Unknown or duplicated DNS modes, or a DNS mode on a non-`socks5:` URL, are configuration errors; they do not trigger a direct fallback. Existing proxy failure handling is otherwise unchanged: enable **Strict Proxy** if failed proxy requests must never be retried directly. Existing `STRICT_SSL` policy is unchanged as well.

## Privacy and limitations

**Opting in exposes destination DNS lookups to the local/system resolver instead of the proxy resolver.** This can also change split-DNS results and which gateway route is selected. Choose the mode deliberately; remote DNS remains the default. The option applies to every destination using that proxy URL, not just one provider. If only one provider needs it, use a dedicated proxy-pool entry rather than changing a shared global proxy.

No provider identity, headers, account access, TLS fingerprint or certificate checks are changed by the DNS option. It is a transport diagnostic/workaround, not a guarantee that every provider-side 403 has a DNS cause. SOCKS5 support in the required Undici version is experimental. A caller can cancel a pending request. The five-second deadline bounds how long the dispatcher waits for DNS, not the underlying system lookup: Node's system DNS operation itself is not cancellable and may continue in the background. Cancellation prevents target HTTP delivery, but does not promise that an already-pending lookup cannot initiate a later SOCKS handshake.

Related report: [#4983](https://github.com/decolua/9router/issues/4983). In one AdGuard SOCKS setup, domain targets returned OpenCode Free `403 FreeTierError` while locally resolved numeric targets worked with identical request data. The local correction restored 16 existing pools in strict-proxy tests. The gateway's internal routing decision was not identified; this should not be generalized to all OpenCode failures.
