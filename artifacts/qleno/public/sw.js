/* Qleno service worker — PWA + Web Push.
 * Scope: / (served from public/sw.js → /sw.js).
 * Handles 'push' (show the OS notification) and 'notificationclick'
 * (focus an existing tab or open the app at the notification's link).
 * No offline caching here — this is purpose-built for installability + push.
 */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: "Qleno", body: event.data ? event.data.text() : "" }; }
  const title = payload.title || "Qleno";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/images/phes-logo.jpeg",
    badge: "/images/phes-logo.jpeg",
    tag: payload.tag || undefined,        // collapse duplicates when set
    data: { link: payload.link || "/", ...(payload.data || {}) },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Focus an existing Qleno tab and navigate it to the link if possible.
    for (const client of all) {
      if ("focus" in client) {
        try { if ("navigate" in client) await client.navigate(link); } catch (e) { /* cross-origin / not allowed */ }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(link);
  })());
});
