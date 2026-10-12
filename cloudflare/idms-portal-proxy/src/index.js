const UPSTREAM_ORIGIN = "https://idms-imis-worker.pnl0269-org.workers.dev";
const PUBLIC_ORIGIN = "https://idms-imis-portal.pnl0269-org.workers.dev";

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    const upstreamUrl = new URL(incomingUrl.pathname + incomingUrl.search, UPSTREAM_ORIGIN);
    const headers = new Headers(request.headers);
    const browserOrigin = headers.get("Origin");

    // This is a fixed reverse proxy to our IDMS Worker, never a user-selected host.
    headers.delete("host");
    headers.delete("content-length");
    if (browserOrigin === PUBLIC_ORIGIN) headers.set("Origin", UPSTREAM_ORIGIN);

    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    const upstreamResponse = await fetch(upstreamRequest);
    const responseHeaders = new Headers(upstreamResponse.headers);
    const allowedOrigin = responseHeaders.get("Access-Control-Allow-Origin");

    if (browserOrigin === PUBLIC_ORIGIN && allowedOrigin === UPSTREAM_ORIGIN) {
      responseHeaders.set("Access-Control-Allow-Origin", PUBLIC_ORIGIN);
      responseHeaders.append("Vary", "Origin");
    }

    const location = responseHeaders.get("Location");
    if (location?.startsWith(UPSTREAM_ORIGIN + "/")) {
      responseHeaders.set("Location", PUBLIC_ORIGIN + location.slice(UPSTREAM_ORIGIN.length));
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
