# Playlist Time Finder

Find the total watch time of a YouTube playlist, with stats, a duration chart and a range calculator.

## Run locally
1. Install Node.js 18 or newer (https://nodejs.org).
2. Get a YouTube Data API v3 key (Google Cloud Console → enable "YouTube Data API v3" → Credentials → API key).
3. Open `.env` and set `YT_API_KEY=your-key`.
4. In this folder run `npm start`, then open http://localhost:3000

## Files
- `server.js` serves `public/` and a rate-limited `/api/playlist` proxy; reads `.env`
- `public/` the website (index.html, style.css, script.js, utils.js)
- `cloudflare/worker.js` optional, for hosting on Cloudflare later
# playlistYT
