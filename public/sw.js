const CACHE="hamyar-heyat-v4";
const SHELL=["/","/manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=="GET"||url.origin!==self.location.origin||url.pathname.startsWith("/api/")||url.pathname.startsWith("/socket.io/"))return;
  if(request.mode==="navigate"){
    event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put("/",copy));}return response;}).catch(()=>caches.match("/")));
    return;
  }
  event.respondWith(caches.match(request).then(hit=>hit||fetch(request).then(response=>{
    if(response.ok&&url.pathname.startsWith("/")){const copy=response.clone();caches.open(CACHE).then(c=>c.put(request,copy));}
    return response;
  })));
});
