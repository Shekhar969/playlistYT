import { extractPlaylistId, fmt, sumRange, computeStats, clampInt } from './utils.js';

// The Node server (server.js) serves this page and the API from the same origin,
// and keeps the YouTube API key in .env. No key ever lives in the browser.
const API_BASE = '';
const COOLDOWN_MS = 3000;       // client-side courtesy limit; the server enforces the real limit
const CACHE_MS = 10 * 60 * 1000;
const PAGE = 10;                // videos shown per click in the list
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const $ = id => document.getElementById(id);
const els = ['form','url','go','status','result','plTitle','plMeta','total','note','sCount','sAvg','sMax','sMin',
  'strip','from','to','rangeOut','leftOut','list','listInfo','more','reset'].reduce((o, id) => (o[id] = $(id), o), {});

let videos = [];
let segs = [];
let rows = [];          // list items by video index (only the ones shown so far)
let watched = new Set();
let playlistId = '';
let listed = 0;
let controller = null;
let lastCall = 0;

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

// ---- watched videos are remembered in this browser, per playlist ----
const storeKey = () => `watched:${playlistId}`;
const keyOf = i => videos[i].id || `#${i}`;
function loadWatched() {
  try {
    const a = JSON.parse(localStorage.getItem(storeKey()) || '[]');
    return new Set(Array.isArray(a) ? a.filter(x => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function saveWatched() {
  try { localStorage.setItem(storeKey(), JSON.stringify([...watched])); } catch { /* storage blocked */ }
}
function mark(i, on) {
  on ? watched.add(keyOf(i)) : watched.delete(keyOf(i));
  saveWatched();
  update();
}

async function loadPlaylist(id, signal) {
  const key = `pl2:${id}`;
  try {
    const hit = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
  } catch { /* ignore bad cache */ }

  let res;
  try {
    res = await fetch(`${API_BASE}/api/playlist?id=${encodeURIComponent(id)}`, { signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const wait = res.headers.get('Retry-After');
    throw new Error(`Too many requests. Try again in ${wait || 'a minute'}${wait ? 's' : ''}.`);
  }
  if (!res.ok) throw new Error(body.error || 'Something went wrong loading that playlist.');

  // Never trust the response shape: rebuild it with plain strings and numbers.
  if (!Array.isArray(body.videos)) throw new Error('Unexpected response from the server.');
  const data = {
    title: String(body.title ?? 'Untitled playlist'),
    channel: String(body.channel ?? ''),
    truncated: Boolean(body.truncated),
    videos: body.videos.map(v => ({
      id: VIDEO_ID_RE.test(String(v.id)) ? String(v.id) : '',
      title: String(v.title ?? ''),
      seconds: Math.max(0, Number(v.seconds) || 0)
    }))
  };
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch { /* storage full or blocked */ }
  return data;
}

function label(i) {
  return `${i + 1}. ${videos[i].title} (${fmt(videos[i].seconds)})`;
}

function sub(text) { const s = document.createElement('small'); s.textContent = text; return s; }

function showMore() {
  const end = Math.min(listed + PAGE, videos.length);
  for (let i = listed; i < end; i++) {
    const v = videos[i];
    const li = document.createElement('li');
    li.dataset.i = i;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'chk';
    cb.setAttribute('aria-label', `Mark video ${i + 1} as watched`);

    let title;
    if (v.id) {
      title = document.createElement('a');
      title.href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}&list=${encodeURIComponent(playlistId)}`;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    } else {
      title = document.createElement('span');
    }
    title.textContent = v.title;

    const dur = document.createElement('span');
    dur.textContent = ` ${fmt(v.seconds)}`;

    li.append(cb, title, dur);
    els.list.append(li);
    rows[i] = li;
  }
  listed = end;
  els.listInfo.textContent = `Showing ${listed} of ${videos.length}`;
  els.more.hidden = listed >= videos.length;
  els.more.textContent = `Show next ${Math.min(PAGE, videos.length - listed)}`;
  update();
}

function render(data, id) {
  videos = data.videos;
  playlistId = id;
  watched = loadWatched();
  const n = videos.length;
  if (!n) { els.result.hidden = true; return setStatus('That playlist has no public videos.', true); }

  els.plTitle.textContent = data.title;
  els.plMeta.textContent = data.channel ? `by ${data.channel}` : '';
  const st = computeStats(videos);
  els.total.textContent = fmt(st.total);
  els.note.hidden = !data.truncated;
  els.note.textContent = data.truncated ? `Only the first ${n} videos are counted.` : '';

  els.sCount.textContent = n;
  els.sAvg.textContent = fmt(st.avg);
  for (const [el, i] of [[els.sMax, st.max], [els.sMin, st.min]]) {
    el.textContent = i === null ? '–' : fmt(videos[i].seconds);
    if (i !== null) el.append(sub(`#${i + 1} ${videos[i].title}`));
  }

  // Duration chart: one bar per video, width proportional to its length.
  els.strip.replaceChildren();
  segs = videos.map((v, i) => {
    const d = document.createElement('div');
    d.className = 'seg';
    d.dataset.i = i;
    d.title = label(i);
    d.style.flexGrow = String(v.seconds || 1);
    return d;
  });
  els.strip.append(...segs);

  els.list.replaceChildren();
  rows = [];
  listed = 0;

  for (const el of [els.from, els.to]) el.max = n;
  els.from.value = 1; els.to.value = n;
  els.result.hidden = false;
  showMore();
}

function update() {
  const n = videos.length;
  let a = clampInt(els.from.value, n, 1), b = clampInt(els.to.value, n, n);
  if (a > b) [a, b] = [b, a];

  els.rangeOut.textContent = fmt(sumRange(videos, a - 1, b));
  els.rangeOut.append(sub(`${b - a + 1} video${b - a ? 's' : ''}, #${a} to #${b}`));

  let leftSec = 0, left = 0;
  videos.forEach((v, i) => { if (!watched.has(keyOf(i))) { leftSec += v.seconds; left++; } });
  const total = sumRange(videos);
  const pct = total ? Math.round(((total - leftSec) / total) * 100) : 0;
  els.leftOut.textContent = `${fmt(leftSec)} left`;
  els.leftOut.append(sub(`${left} of ${n} video${n === 1 ? '' : 's'} not watched, ${pct}% done`));

  segs.forEach((s, i) => {
    const w = watched.has(keyOf(i));
    s.classList.toggle('watched', w);
    s.classList.toggle('in', !w && i >= a - 1 && i < b);
  });
  rows.forEach((li, i) => {
    const w = watched.has(keyOf(i));
    li.classList.toggle('seen', w);
    li.querySelector('input').checked = w;
  });
}

els.form.addEventListener('submit', async e => {
  e.preventDefault();
  const id = extractPlaylistId(els.url.value);
  if (!id) return setStatus('That isn’t a playlist link. Copy the full address of a playlist page; it contains “list=”.', true);

  const wait = COOLDOWN_MS - (Date.now() - lastCall);
  if (wait > 0) return setStatus(`Wait ${Math.ceil(wait / 1000)}s before searching again.`, true);
  lastCall = Date.now();

  controller?.abort();
  controller = new AbortController();
  els.go.disabled = true;
  setStatus('Loading playlist…');
  try {
    render(await loadPlaylist(id, controller.signal), id);
    if (!els.result.hidden) setStatus('');
  } catch (err) {
    if (err.name !== 'AbortError') { els.result.hidden = true; setStatus(err.message, true); }
  } finally {
    els.go.disabled = false;
  }
});

for (const el of [els.from, els.to]) el.addEventListener('input', update);
els.more.addEventListener('click', showMore);
els.reset.addEventListener('click', () => {
  if (watched.size && confirm('Clear all watched marks for this playlist?')) { watched.clear(); saveWatched(); update(); }
});
// Clicking a chart bar toggles that video's watched state.
els.strip.addEventListener('click', e => {
  const i = e.target.dataset?.i;
  if (i !== undefined) mark(Number(i), !watched.has(keyOf(Number(i))));
});
// Checkbox toggles watched; opening a video's link marks it watched.
els.list.addEventListener('change', e => {
  if (e.target.matches('input.chk')) mark(Number(e.target.closest('li').dataset.i), e.target.checked);
});
els.list.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (a) mark(Number(a.closest('li').dataset.i), true);
});