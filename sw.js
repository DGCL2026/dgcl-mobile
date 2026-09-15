/* Service worker : met en cache l'interface uniquement.
   Aucun document du registre n'est conservé sur le téléphone. */

const CACHE = "dgcl-mobile-v5";
const COQUILLE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./IMG/icone-192.png",
  "./IMG/icone-512.png",
  "./IMG/logo-dgcl.png",
  "./IMG/logo-dgcl-petit.png",
  "./IMG/embleme-gabon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Tout ce qui touche à Google (authentification, Drive, documents) doit
  // passer par le réseau : rien n'est mis en cache.
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copie = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copie)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
