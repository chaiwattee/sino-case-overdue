// Service worker: lets the site install as an app, open when the network is poor, and show push notifications.
// Data (/api/…) is never cached: cases always come fresh from the server.
const CACHE = "case-sla-v10";
const SHELL = ["/", "/style.css", "/app.js", "/i18n.js", "/i18n-en.json", "/icons/icon-192.png", "/sinostech-logo.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first; the cached copy is used only when the network fails (offline / weak signal at a customer site).
self.addEventListener("fetch", (e) => {
  const r = e.request;
  const u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/csat/") || /^\/(u|r)\//.test(u.pathname)) return;
  e.respondWith(
    fetch(r)
      .then((res) => {
        // Only keep real pages and files (not the login redirect).
        if (res.ok && !res.redirected && (r.mode === "navigate" || SHELL.some((p) => u.pathname === p))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(r.mode === "navigate" ? "/" : u.pathname, copy));
        }
        return res;
      })
      .catch(() => caches.match(r.mode === "navigate" ? "/" : u.pathname).then((m) => m || Response.error()))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (err) {
    d = { title: "Sino Case SLA", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Sino Case SLA", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === location.origin && "focus" in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
