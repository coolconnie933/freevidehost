# Vidking Player

This project serves a Vidking iframe player with a Flask backend that proxies a small, fixed set of TMDB endpoints. The browser keeps the existing player settings, recent history, and playback-progress data in `localStorage`, while the server keeps the TMDB read token out of the frontend.

## What stays the same

- Vidking movie and TV loading
- TMDB title search for movies and TV programmes
- The Episodes tab and season `0` specials support
- Player settings, recent history, and playback-progress storage in browser `localStorage`
- Automatic player loading when a TMDB search result is chosen

## Hosted behaviour

- TMDB search and TMDB-powered episode metadata are available only when `TMDB_READ_ACCESS_TOKEN` is set on the server
- Manual TMDB ID loading still works even when the environment variable is missing
- No token is stored in browser code, browser storage, or repository files
- `tmdb_token.txt` is no longer used
- `/api/tmdb/token` is disabled in the hosted app

## Local development

1. Install Python 3.11+.
2. Set `TMDB_READ_ACCESS_TOKEN` in your shell if you want TMDB search and episode metadata.
3. Install dependencies:

```powershell
pip install -r requirements.txt
```

4. Start the app:

```powershell
py -3 app.py
```

You can also use [start-server.bat](C:\Users\conno\Downloads\local_vidking_player_with_tmdb_search\local_vidking_player_tmdb\start-server.bat) on Windows or [start-server.sh](C:\Users\conno\Downloads\local_vidking_player_with_tmdb_search\local_vidking_player_tmdb\start-server.sh) on macOS/Linux.

The local development server listens on `127.0.0.1` and honours `PORT` when it is set.

## Render deployment

Create a Render Web Service using this repository and configure it with:

- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app --bind 0.0.0.0:$PORT`
- Required environment variable: `TMDB_READ_ACCESS_TOKEN`

Recommended:

- Set the health check path to `/health`
- Keep the TMDB token only in Render environment variables
- Do not commit `.env` files or any real token values

## Routes

- `GET /`
  Serves `index.html`
- `GET /health`
  Returns a simple success response
- `GET /api/tmdb/token-status`
  Returns whether TMDB search is configured on the server
- `GET /api/tmdb/search?q=...`
  Proxies TMDB multi-search for movies and TV only
- `GET /api/tmdb/tv/{tmdbId}`
  Proxies TMDB TV details for season lists
- `GET /api/tmdb/tv/{tmdbId}/season/{seasonNumber}`
  Proxies TMDB season details for episode lists

No arbitrary proxy routes are exposed.

## Security notes

- The TMDB token is read exclusively from `TMDB_READ_ACCESS_TOKEN`
- The token is never returned in API responses, rendered into HTML, or logged intentionally
- TMDB proxy routes validate search queries and numeric route parameters
- TMDB proxy requests use timeouts, in-memory caching, and per-client rate limiting
- HTML and API responses send security headers including a Content Security Policy
- Flask debug mode is disabled
- Static serving is explicit, so there is no directory listing route
- API errors return clean JSON messages without stack traces

## Browser storage

The frontend still uses the same localStorage keys and legacy fallbacks as before:

- `local_vidking_history_v1`
- `local_vidking_progress_v1_*`
- `local_vidking_settings_v1`
- legacy `v2` keys are still read for migration compatibility

## Troubleshooting

- TMDB search is unavailable:
  Set `TMDB_READ_ACCESS_TOKEN` on the server and restart the app.

- Episode browsing stays disabled for a TV show:
  The player can still load the show manually, but TMDB-powered season metadata needs the environment variable to be present.

- Render deploy succeeds but TMDB requests fail:
  Confirm that `TMDB_READ_ACCESS_TOKEN` is set in Render and that it is a TMDB Read Access Token.

## Legal and attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

Use the player only for media you are legally entitled to access. This application does not own, host, or distribute media.
