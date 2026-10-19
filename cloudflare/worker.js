// Cloudflare Worker (paste into the dashboard editor).
// Needs two settings in Worker > Settings > Variables and Secrets:
//   YT_API_KEY      (type: Secret)  your YouTube Data API v3 key
//   ALLOWED_ORIGIN  (type: Text)    your site's origin, e.g. https://playlist-time-finder.pages.dev

const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const YT = 'https://www.googleapis.com/youtube/v3';
const MAX_VIDEOS = 500;
const CACHE_MS = 30 * 60 * 1000;
const LIMIT = 20;            // requests per IP...
const WINDOW_MS = 60 * 1000; // ...per minute

// Best-effort, in-memory state. It lives as long as this Worker instance does.
const hits = new Map();   // ip -> { start, count }
const cached = new Map(); // playlist id -> { t, data }

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function rateLimit(ip) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  let h = hits.get(ip);
  if (!h || now - h.start >= WINDOW_MS) { h = { start: now, count: 0 }; hits.set(ip, h); }
  h.count++;
  return h.count > LIMIT ? Math.ceil((h.start + WINDOW_MS - now) / 1000) : 0; // seconds to wait, or 0 if allowed
}

async function yt(path, params, key) {
  const u = new URL(YT + path);
  for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (r.ok) return r.json();
  const e = await r.json().catch(() => ({}));
  const reason = e?.error?.errors?.[0]?.reason;
  if (reason === 'quotaExceeded') throw new HttpError(503, 'Daily limit reached. Try again tomorrow.');
  if (r.status === 404 || reason === 'playlistNotFound') throw new HttpError(404, 'Playlist not found, or it is private.');
  if (r.status === 403) throw new HttpError(403, 'That playlist can’t be read. It may be private.');
  throw new HttpError(502, 'YouTube didn’t respond. Try again soon.');
}

function seconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const [d, h, mi, s] = m.slice(1).map(x => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

async function buildPlaylist(id, key) {
  const meta = await yt('/playlists', { part: 'snippet', id }, key);
  if (!meta.items?.length) throw new HttpError(404, 'Playlist not found, or it is private.');

  const ids = [];
  let token, truncated = false;
  do {
    const page = await yt('/playlistItems', { part: 'contentDetails', playlistId: id, maxResults: 50, ...(token && { pageToken: token }) }, key);
    for (const it of page.items || []) ids.push(it.contentDetails.videoId);
    token = page.nextPageToken;
    if (ids.length >= MAX_VIDEOS) { truncated = Boolean(token) || ids.length > MAX_VIDEOS; ids.length = Math.min(ids.length, MAX_VIDEOS); break; }
  } while (token);

  const byId = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const res = await yt('/videos', { part: 'contentDetails,snippet', id: ids.slice(i, i + 50).join(','), maxResults: 50 }, key);
    for (const v of res.items || []) byId.set(v.id, { title: v.snippet.title, seconds: seconds(v.contentDetails.duration) });
  }
  // Private or deleted videos are missing from videos.list and are skipped.
  const videos = ids.map(i => byId.get(i)).filter(Boolean);
  return { title: meta.items[0].snippet.title, channel: meta.items[0].snippet.channelTitle, truncated, videos };
}

export default {
  async fetch(req, env) {
    const allowed = env.ALLOWED_ORIGIN;
    const base = { 'Access-Control-Allow-Origin': allowed || 'null', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' };
    const send = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...base, ...extra } });

    if (!env.YT_API_KEY || !allowed) return send({ error: 'Server is not configured yet.' }, 500);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...base, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });

    const url = new URL(req.url);
    if (req.method !== 'GET' || url.pathname !== '/api/playlist') return send({ error: 'Not found.' }, 404);
    if (req.headers.get('Origin') !== allowed) return send({ error: 'Origin not allowed.' }, 403);

    const wait = rateLimit(req.headers.get('CF-Connecting-IP') || 'unknown');
    if (wait) return send({ error: `Too many requests. Try again in ${wait}s.` }, 429, { 'Retry-After': String(wait) });

    const id = url.searchParams.get('id') || '';
    if (!ID_RE.test(id)) return send({ error: 'Invalid playlist ID.' }, 400);

    const hit = cached.get(id);
    if (hit && Date.now() - hit.t < CACHE_MS) return send(hit.data);

    try {
      const data = await buildPlaylist(id, env.YT_API_KEY);
      if (cached.size >= 50) cached.delete(cached.keys().next().value);
      cached.set(id, { t: Date.now(), data });
      return send(data);
    } catch (e) {
      return e instanceof HttpError ? send({ error: e.message }, e.status) : send({ error: 'Server error.' }, 500);
    }
  }
};
