export const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

/** Accepts a full YouTube URL or a bare playlist ID. Returns a validated ID or null. */
export function extractPlaylistId(input) {
  const s = String(input ?? '').trim();
  if (ID_RE.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
      const id = u.searchParams.get('list');
      if (id && ID_RE.test(id)) return id;
    }
  } catch { /* not a URL */ }
  return null;
}

export function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}h ${p(m)}m ${p(s)}s` : `${m}m ${p(s)}s`;
}

/** Total seconds for videos[a..b) (0-based, end exclusive). */
export function sumRange(videos, a = 0, b = videos.length) {
  let t = 0;
  for (let i = Math.max(0, a); i < Math.min(b, videos.length); i++) t += videos[i].seconds;
  return t;
}

export function computeStats(videos) {
  const total = sumRange(videos);
  const playable = videos.map((v, i) => ({ i, s: v.seconds })).filter(x => x.s > 0);
  if (!playable.length) return { total, avg: 0, max: null, min: null };
  const max = playable.reduce((a, b) => (b.s > a.s ? b : a));
  const min = playable.reduce((a, b) => (b.s < a.s ? b : a));
  return { total, avg: total / playable.length, max: max.i, min: min.i };
}

/** Clamp a user-entered number into 1..max; falls back to `fallback` if not a number. */
export function clampInt(value, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback;
}
