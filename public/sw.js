const CACHE="hamyar-heyat-v1";
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(["/","/manifest.webmanifest"]))));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener("fetch",event=>{if(event.request.method!=="GET")return;event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).catch(()=>caches.match("/"))));});
