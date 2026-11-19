// きょうのひとネタ 通知の送信役（Cloudflare Workers）
// ・POST /subscribe   端末の通知先と届く時刻を登録する
// ・POST /unsubscribe 登録を消す
// ・POST /test        その端末へ今すぐ1通送る
// ・15分ごとの定期実行で、その時刻を登録した端末へ通知を送る
// 通知の中身は送らない（空のプッシュ）。端末側の sw.js が今日のネタを表示する。

const ALLOWED_ORIGIN = 'https://cigaretteone.github.io';
const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const AUDS = ['adult', 'kids', 'both'];

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'hitoneta-push' });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    if (req.headers.get('Origin') !== ALLOWED_ORIGIN) return json({ error: 'origin' }, 403);

    let body;
    try {
      const text = await req.text();
      if (text.length > 4096) return json({ error: 'too_large' }, 413);
      body = JSON.parse(text);
    } catch { return json({ error: 'bad_json' }, 400); }

    if (url.pathname === '/subscribe') {
      const sub = body && body.subscription;
      const endpoint = sub && sub.endpoint;
      if (!isPushEndpoint(endpoint)) return json({ error: 'bad_endpoint' }, 400);
      const times = Array.isArray(body.times) ? [...new Set(body.times)].filter(t => TIME_RE.test(t)).slice(0, 2) : [];
      if (!times.length) return json({ error: 'bad_times' }, 400);
      const aud = AUDS.includes(body.aud) ? body.aud : 'adult';
      const key = 'sub:' + await sha256(endpoint);
      await env.SUBS.put(key, JSON.stringify({ endpoint, aud, updatedAt: Date.now() }), { metadata: { times } });
      return json({ ok: true, times });
    }
    if (url.pathname === '/unsubscribe') {
      if (!isPushEndpoint(body && body.endpoint)) return json({ error: 'bad_endpoint' }, 400);
      await env.SUBS.delete('sub:' + await sha256(body.endpoint));
      return json({ ok: true });
    }
    if (url.pathname === '/test') {
      const endpoint = body && body.endpoint;
      if (!isPushEndpoint(endpoint)) return json({ error: 'bad_endpoint' }, 400);
      const key = 'sub:' + await sha256(endpoint);
      if (!(await env.SUBS.get(key))) return json({ error: 'not_registered' }, 404);
      const status = await sendPush(env, endpoint, new Map());
      if (status === 404 || status === 410) await env.SUBS.delete(key);
      return json({ ok: status >= 200 && status < 300, status });
    }
    return json({ error: 'not_found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSlot(env, new Date(event.scheduledTime)));
  },
};

// 日本時間の15分刻みの時刻（例 "07:00"）
export function jstSlot(date) {
  const t = new Date(date.getTime() + 9 * 3600e3);
  const h = String(t.getUTCHours()).padStart(2, '0');
  const m = String(Math.floor(t.getUTCMinutes() / 15) * 15).padStart(2, '0');
  return `${h}:${m}`;
}

async function runSlot(env, when) {
  const slot = jstSlot(when);
  const jwtCache = new Map();
  let cursor, sent = 0, gone = 0, failed = 0;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const times = (k.metadata && k.metadata.times) || [];
      if (!times.includes(slot)) continue;
      const rec = await env.SUBS.get(k.name, 'json');
      if (!rec) continue;
      const status = await sendPush(env, rec.endpoint, jwtCache);
      if (status >= 200 && status < 300) sent++;
      else if (status === 404 || status === 410) { gone++; await env.SUBS.delete(k.name); }
      else failed++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  console.log(JSON.stringify({ slot, sent, gone, failed }));
}

function isPushEndpoint(u) {
  if (typeof u !== 'string' || u.length > 1024) return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

async function sendPush(env, endpoint, jwtCache) {
  const aud = new URL(endpoint).origin;
  let jwt = jwtCache.get(aud);
  if (!jwt) { jwt = await vapidJwt(env, aud); jwtCache.set(aud, jwt); }
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        TTL: '10800',
        Urgency: 'high',
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
        'Content-Length': '0',
      },
    });
    return r.status;
  } catch { return 0; }
}

// VAPID（RFC 8292）の署名つきトークン。ES256、12時間有効
export async function vapidJwt(env, aud) {
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const claims = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT });
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64u(new Uint8Array(sig))}`;
}

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
