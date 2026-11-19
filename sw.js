// きょうのひとネタ：オフライン用と毎日の通知の表示。更新時は VERSION を上げる
const VERSION = 'hitoneta-v4';
const ASSETS = ['./', './index.html', './pool.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
importScripts('pool.js');

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // 'hitoneta-data' は通知用の予定なので消さない
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'hitoneta-data').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 画面本体：電波があれば最新、なければ保存版
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put('./index.html', c)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  // 同じサイトのファイルとフォント：保存版を先に返し、裏で更新
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});

// ---- 毎日の通知 ----
// 送信役からは中身のない通知が届く。ここで今日のネタを選んで表示する。
const pad = n => String(n).padStart(2, '0');
async function todaysNeta() {
  const jst = new Date(Date.now() + 9 * 3600e3);
  const day = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
  const key = `${day}_${jst.getUTCHours() < 12 ? 'am' : 'pm'}`;
  let plan = {};
  try {
    const c = await caches.open('hitoneta-data');
    const r = await c.match(new URL('plan.json', self.registration.scope).href);
    if (r) plan = await r.json();
  } catch {}
  const pool = self.HITONETA_POOL, picks = plan.picks || {}, aud = plan.aud || 'adult';
  let neta = pool.find(x => x.id === picks[key]) || pool.find(x => x.id === picks[`${day}_am`]);
  let openKey = picks[key] ? key : `${day}_am`;
  if (!neta) {
    // アプリを長く開いていない場合：日付だけで決める
    const el = pool.filter(x => aud === 'kids' ? x.aud === 'kids' : aud === 'both' ? x.aud !== 'adult' : x.aud !== 'kids');
    neta = el[Math.floor(Date.parse(day) / 864e5) % el.length];
    openKey = '';
  }
  return { neta, aud, openKey };
}
self.addEventListener('push', e => {
  e.waitUntil(todaysNeta().then(({ neta, aud, openKey }) => {
    const kana = aud === 'kids';
    const g = neta.genre === 'quiz' ? (kana ? 'くいず' : 'クイズ') : 'なぞなぞ';
    return self.registration.showNotification(`【きょうの ${g}】`, {
      body: (kana ? neta.kana : neta.body) + '\nこたえは アプリで',
      tag: 'hitoneta-daily',
      renotify: true,
      icon: 'icon-192.png',
      data: { url: new URL(openKey ? './?k=' + openKey : './', self.registration.scope).href },
    });
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if (w.url.startsWith(self.registration.scope) && 'navigate' in w) return w.navigate(url).then(x => (x || w).focus()).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
