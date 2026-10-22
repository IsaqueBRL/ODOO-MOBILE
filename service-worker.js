// Service Worker do app "Deuris Candy 2 - Mobile"
// Objetivo: permitir que o navegador ofereça "Instalar app" e evitar tela branca sem internet.
// Guarda só o "shell" (HTML, manifest e ícones). Os dados (estoque, vendas, clientes)
// vêm sempre da API /api/odoo em tempo real, então o app precisa de internet para funcionar de verdade.

const CACHE_NAME = "deuris-mobile-v2";
const TEMPO_REDE_MS = 3000;   // rede lenta: depois disso usa a cópia guardada, em vez de deixar o app travado
const SHELL = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Um por um, para que a falta de um arquivo não derrube a instalação inteira.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Nunca mexe em POST, na API do Odoo nem em requisições de outros domínios.
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Rede primeiro (sempre a versão mais nova). Se a rede falhar OU demorar mais de 3 s, usa a cópia guardada.
  event.respondWith((async () => {
    const guardada = () => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : undefined));
    const rede = fetch(req).then((response) => {
      if (response && response.status === 200 && response.type === "basic") {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return response;
    });
    try {
      return await Promise.race([
        rede,
        new Promise((_, falha) => setTimeout(() => falha(new Error("lento")), TEMPO_REDE_MS))
      ]);
    } catch (e) {
      const hit = await guardada();
      if (hit) { rede.catch(() => {}); return hit; }
      return rede;     // sem cópia guardada: espera a rede mesmo assim
    }
  })());
});
