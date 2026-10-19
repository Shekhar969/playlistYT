'use strict';
// Zero-dependency Node server: serves /public and a small, rate-limited YouTube proxy.
// Needs Node 18+ (built-in fetch). Run: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- load .env (tiny parser, so no npm install is needed) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }

const KEY = process.env.YT_API_KEY;
const PORT = Number(process.env.PORT) || 3000;
const LIMIT = Number(process.env.RATE_LIMIT) || 20;
if (!KEY || KEY.startsWith('paste-your')) {
  console.error('\nMissing YouTube API key. Open .env and set YT_API_KEY=your-key, then run again.\n');
  process.exit(1);
}

const PUBLIC = path.join(__dirname, 'public');
const YT = 'https://www.googleapis.com/youtube/v3';
const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const MAX_VIDEOS = 500;
const CACHE_MS = 30 * 60 * 1000;
const WINDOW_MS = 60 * 1000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---- rate limit + cache (in memory) ----
const hits = new Map();   // ip -> { start, count }
const cached = new Map(); // playlist id -> { t, data }

function rateLimit(ip) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  let h = hits.get(ip);
  if (!h || now - h.start >= WINDOW_MS) { h = { start: now, count: 0 }; hits.set(ip, h); }
  h.count++;
  return h.count > LIMIT ? Math.ceil((h.start + WINDOW_MS - now) / 1000) : 0; // seconds to wait, 0 = allowed
}

// ---- YouTube ----
async function yt(route, params) {
  const u = new URL(YT + route);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (r.ok) return r.json();
  const e = await r.json().catch(() => ({}));
  const reason = e?.error?.errors?.[0]?.reason;
  if (reason === 'quotaExceeded') throw new HttpError(503, 'Daily limit reached. Try again tomorrow.');
  if (reason === 'keyInvalid' || reason === 'API_KEY_INVALID') throw new HttpError(500, 'The server’s YouTube API key is invalid.');
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

async function buildPlaylist(id) {
  const meta = await yt('/playlists', { part: 'snippet', id });
  if (!meta.items?.length) throw new HttpError(404, 'Playlist not found, or it is private.');
  const ids = [];
  let token, truncated = false;
  do {
    const page = await yt('/playlistItems', { part: 'contentDetails', playlistId: id, maxResults: 50, ...(token && { pageToken: token }) });
    for (const it of page.items || []) ids.push(it.contentDetails.videoId);
    token = page.nextPageToken;
    if (ids.length >= MAX_VIDEOS) { truncated = Boolean(token) || ids.length > MAX_VIDEOS; ids.length = Math.min(ids.length, MAX_VIDEOS); break; }
  } while (token);
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const res = await yt('/videos', { part: 'contentDetails,snippet', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    for (const v of res.items || []) byId.set(v.id, { id: v.id, title: v.snippet.title, seconds: seconds(v.contentDetails.duration) });
  }
  const videos = ids.map(i => byId.get(i)).filter(Boolean); // private/deleted videos are skipped
  return { title: meta.items[0].snippet.title, channel: meta.items[0].snippet.channelTitle, truncated, videos };
}

// ---- HTTP ----
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function handleApi(req, res, url) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Origin not allowed.' });
  const wait = rateLimit(req.socket.remoteAddress || 'unknown');
  if (wait) return send(res, 429, { error: `Too many requests. Try again in ${wait}s.` }, { 'Retry-After': String(wait) });
  const id = url.searchParams.get('id') || '';
  if (!ID_RE.test(id)) return send(res, 400, { error: 'Invalid playlist ID.' });
  const hit = cached.get(id);
  if (hit && Date.now() - hit.t < CACHE_MS) return send(res, 200, hit.data);
  try {
    const data = await buildPlaylist(id);
    if (cached.size >= 50) cached.delete(cached.keys().next().value);
    cached.set(id, { t: Date.now(), data });
    send(res, 200, data);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Server error.' });
  }
}

function serveStatic(res, pathname) {
  let file;
  try {
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    file = path.normalize(path.join(PUBLIC, rel));
  } catch { return send(res, 400, 'Bad request'); }
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  if (url.pathname === '/api/playlist') return handleApi(req, res, url);
  serveStatic(res, url.pathname);
}).listen(PORT, '127.0.0.1', () => console.log(`Playlist Time Finder running at http://localhost:${PORT}`));