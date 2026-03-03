/* ═══════════════════════════════════════════════════
   kufiMaker — Service Worker v3
   Strategy:
   · Cache-first  → app shell (HTML, letters.json, icons)
   · Stale-while-revalidate → Google Fonts
   · Network-first → everything else
   · Query params (?new=1, ?view=letters) → always serve index.html
   · Background Sync → حفظ الجلسة عند عودة الاتصال
   · Periodic Background Sync → تحديث دوري للـ letters.json
   · Push Notifications → إشعارات التحديثات
═══════════════════════════════════════════════════ */

const CACHE   = 'kufimaker-v5';
const BASE    = '/kufiMaker';
const SYNC_TAG        = 'kufi-session-sync';
const PERIODIC_TAG    = 'kufi-periodic-update';

const PRECACHE = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/style.css',
  BASE + '/app.js',
  BASE + '/letters.json',
  BASE + '/manifest.json',
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-512.png',
  BASE + '/icons/icon-512-maskable.png',
  BASE + '/icons/new-192.png',
  BASE + '/icons/letters-192.png',
];

/* ══════════════════════════════════════════════════
   Install
══════════════════════════════════════════════════ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(
        PRECACHE.map(url =>
          cache.add(url).catch(() => console.warn('[SW] skip:', url))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

/* ══════════════════════════════════════════════════
   Activate
══════════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== 'kufimaker-share')
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ══════════════════════════════════════════════════
   Fetch
══════════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  /* Share Target — POST صورة أو JSON */
  if (
    req.method === 'POST' &&
    url.pathname === BASE + '/' &&
    url.searchParams.has('share-target')
  ) {
    event.respondWith((async () => {
      try {
        const formData = await req.formData();
        const cache    = await caches.open('kufimaker-share');
        const imgFile  = formData.get('image');
        if (imgFile && imgFile.type && imgFile.type.startsWith('image/')) {
          await cache.put('shared-image', new Response(imgFile));
        }
        const jsonFile = formData.get('json');
        if (jsonFile) {
          const text = await jsonFile.text();
          await cache.put('shared-json', new Response(text, {
            headers: { 'Content-Type': 'application/json' }
          }));
        }
      } catch(e) { console.warn('[SW share]', e); }
      return Response.redirect(BASE + '/?share-target', 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  /* Shortcut URLs → strip query, serve index.html */
  if (
    url.origin === self.location.origin &&
    url.pathname === BASE + '/' &&
    url.search
  ) {
    event.respondWith(
      caches.match(BASE + '/index.html')
        .then(cached => cached || fetch(BASE + '/index.html'))
    );
    return;
  }

  /* Google Fonts → stale-while-revalidate */
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  /* App shell & assets → cache-first */
  const isShell =
    url.pathname === BASE + '/' ||
    url.pathname === BASE + '/index.html' ||
    url.pathname === BASE + '/style.css' ||
    url.pathname === BASE + '/app.js' ||
    url.pathname === BASE + '/letters.json' ||
    url.pathname === BASE + '/manifest.json' ||
    url.pathname.startsWith(BASE + '/icons/');

  if (isShell) {
    event.respondWith(cacheFirst(req));
    return;
  }

  /* Everything else → network-first */
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

/* ══════════════════════════════════════════════════
   Background Sync — يُرسل بيانات الجلسة عند عودة الاتصال
══════════════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncSession());
  }
});

async function syncSession() {
  try {
    // أرسل إشعاراً للعميل بأن المزامنة نجحت
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_COMPLETE', tag: SYNC_TAG });
    });
    console.log('[SW] Background sync complete:', SYNC_TAG);
  } catch(e) {
    console.warn('[SW] Background sync failed:', e);
  }
}

/* ══════════════════════════════════════════════════
   Periodic Background Sync — تحديث letters.json دورياً
══════════════════════════════════════════════════ */
self.addEventListener('periodicsync', event => {
  if (event.tag === PERIODIC_TAG) {
    event.waitUntil(periodicUpdate());
  }
});

async function periodicUpdate() {
  try {
    const cache = await caches.open(CACHE);
    // تحديث letters.json من الشبكة
    const res = await fetch(BASE + '/letters.json');
    if (res && res.status === 200) {
      await cache.put(BASE + '/letters.json', res.clone());
      console.log('[SW] Periodic update: letters.json refreshed');
    }
    // أخبر العميل بوجود تحديث
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'PERIODIC_UPDATE_DONE' });
    });
  } catch(e) {
    console.warn('[SW] Periodic update failed:', e);
  }
}

/* ══════════════════════════════════════════════════
   Push Notifications — إشعارات التحديثات والتذكيرات
══════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  let data = { title: 'kufiMaker', body: 'يوجد تحديث جديد!' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch(e) {
    data.body = event.data ? event.data.text() : 'إشعار جديد من kufiMaker';
  }

  const options = {
    body:    data.body  || 'إشعار جديد من kufiMaker',
    icon:    BASE + '/icons/icon-192.png',
    badge:   BASE + '/icons/icon-192.png',
    dir:     'rtl',
    lang:    'ar',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || BASE + '/',
      dateOfArrival: Date.now()
    },
    actions: [
      { action: 'open',    title: 'فتح التطبيق' },
      { action: 'dismiss', title: 'إغلاق'        }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'kufiMaker', options)
  );
});

/* ── نقر على الإشعار → فتح التطبيق ── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || BASE + '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // إذا كان التطبيق مفتوحاً → ركّز عليه
        const existing = clients.find(c => c.url.includes(BASE));
        if (existing) return existing.focus();
        // وإلا → افتح نافذة جديدة
        return self.clients.openWindow(targetUrl);
      })
  );
});

/* ── إغلاق الإشعار ── */
self.addEventListener('notificationclose', event => {
  console.log('[SW] Notification closed:', event.notification.tag);
});

/* ══════════════════════════════════════════════════
   Message — تحكم من التطبيق
══════════════════════════════════════════════════ */
self.addEventListener('message', event => {
  if (!event.data) return;

  switch(event.data.type || event.data) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'REGISTER_SYNC':
      // التطبيق يطلب تسجيل Background Sync
      self.registration.sync?.register(SYNC_TAG).catch(e =>
        console.warn('[SW] sync register failed:', e)
      );
      break;
    case 'REGISTER_PERIODIC_SYNC':
      // التطبيق يطلب تسجيل Periodic Sync (يحتاج permission)
      self.registration.periodicSync?.register(PERIODIC_TAG, {
        minInterval: 24 * 60 * 60 * 1000 // مرة يومياً
      }).catch(e =>
        console.warn('[SW] periodic sync register failed:', e)
      );
      break;
  }
});

/* ══════════════════════════════════════════════════
   Helpers
══════════════════════════════════════════════════ */
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch(e) {
    return caches.match(BASE + '/index.html');
  }
}

async function staleWhileRevalidate(req) {
  const cache  = await caches.open(CACHE);
  const cached = await cache.match(req);
  const fresh  = fetch(req).then(res => {
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fresh;
}
