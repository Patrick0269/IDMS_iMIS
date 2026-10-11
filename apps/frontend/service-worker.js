const CACHE_NAME = "idmc-shell-v14-fullscreen-workspaces-20261011";
const MAX_CACHED_FILES = 180;
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith("idmc-shell-") && name !== CACHE_NAME).map(name => caches.delete(name)));
  await self.clients.claim();
})()));
function cacheable(request, url) {
  return request.method === "GET" && url.origin === self.location.origin && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/auth/") && (request.destination === "document" || ["script", "style", "image", "font"].includes(request.destination));
}
async function store(cache, request, response) {
  if (!response?.ok || response.type === "opaque") return;
  await cache.put(request, response.clone());
  const keys = await cache.keys();
  if (keys.length > MAX_CACHED_FILES) await Promise.all(keys.slice(0, keys.length - MAX_CACHED_FILES).map(key => cache.delete(key)));
}
self.addEventListener("fetch", event => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!cacheable(request, url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const authAsset = /\/(?:login\.html|forgot-password\.html|set-password\.html|student-first-password\.html|applicant-access\.html|assets\/js\/(?:auth|api|config|student-first-password|forgot-password|applicant-access)\.js)$/.test(url.pathname);
    if (authAsset) {
      try { const fresh = await fetch(request, { cache: "no-store" }); await store(cache, request, fresh); return fresh; }
      catch { if (cached) return cached; throw new Error("Authentication asset unavailable."); }
    }
    const update = fetch(request).then(async response => { await store(cache, request, response); return response; });
    if (cached) {
      event.waitUntil(update.catch(() => undefined));
      return cached;
    }
    try { return await update; }
    catch {
      if (request.destination === "document") return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>IDMC iMIS</title><main style='font:16px system-ui;max-width:38rem;margin:12vh auto;padding:1rem'><h1>Uko nje ya mtandao</h1><p>Ukurasa huu haujafunguliwa awali kwenye kifaa hiki. Unganisha intaneti kisha ujaribu tena.</p><button onclick='location.reload()'>Jaribu tena</button></main>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
      return Response.error();
    }
  })());
});
