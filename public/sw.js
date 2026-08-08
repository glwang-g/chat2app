/* PWA 工坊 · 聊天界面自身的 Service Worker
   只缓存本聊天工具的壳；/apps/ 下的子应用完全放行，不缓存不拦截 */
const C = "pw-studio-chat-v1";
const SHELL = ["/", "/index.html", "/manifest.json", "/icon.svg"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith("/apps/") || u.pathname.startsWith("/api/")) return; // 子应用与接口放行
  const isNav = r.mode === "navigate";
  if (isNav) {
    e.respondWith(
      fetch(r).then((x) => { const c = x.clone(); caches.open(C).then((cc) => cc.put(r, c)); return x; })
        .catch(() => caches.match(r).then((m) => m || caches.match("/index.html")))
    );
    return;
  }
  e.respondWith(caches.match(r).then((m) => m || fetch(r).then((x) => { const c = x.clone(); caches.open(C).then((cc) => cc.put(r, c)); return x; })));
});
