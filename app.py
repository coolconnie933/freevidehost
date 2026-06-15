from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict, deque
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
DEFAULT_LOCAL_PORT = 8080
REQUEST_TIMEOUT_SECONDS = 10
MAX_TMDB_ID = 1_000_000_000
MAX_SEASON_NUMBER = 1_000
MAX_SEARCH_QUERY_LENGTH = 100
MAX_JSON_BODY_BYTES = 16_384
TMDB_API_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342"
HTML_CACHE_CONTROL = "no-store"
JSON_CACHE_CONTROL = "no-store"
STATIC_CACHE_SECONDS = 3600
SEARCH_CACHE_TTL_SECONDS = 300
DETAILS_CACHE_TTL_SECONDS = 1800
MAX_CACHE_ENTRIES = 256
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 60
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "frame-src https://www.vidking.net; "
    "style-src 'self'; "
    "script-src 'self'; "
    "img-src 'self' data: https://image.tmdb.org; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "frame-ancestors 'none';"
)
STATIC_FILES = {
    "app.js",
    "styles.css",
    "tmdb-logo.svg",
}

LOGGER = logging.getLogger("vidking_render_app")


class TTLCache:
    def __init__(self, max_entries: int) -> None:
        self.max_entries = max_entries
        self._entries: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if expires_at <= now:
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return value

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        expires_at = time.monotonic() + ttl_seconds
        with self._lock:
            self._drop_expired_entries(time.monotonic())
            self._entries[key] = (expires_at, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)

    def _drop_expired_entries(self, now: float) -> None:
        expired_keys = [
            key
            for key, (expires_at, _value) in self._entries.items()
            if expires_at <= now
        ]
        for key in expired_keys:
            self._entries.pop(key, None)


class SlidingWindowRateLimiter:
    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int | None]:
        now = time.monotonic()
        with self._lock:
            events = self._events[key]
            while events and now - events[0] >= self.window_seconds:
                events.popleft()
            if len(events) >= self.max_requests:
                retry_after = max(1, int(self.window_seconds - (now - events[0])))
                return False, retry_after
            events.append(now)
            return True, None


app = Flask(__name__)
app.config.update(
    JSON_SORT_KEYS=False,
    MAX_CONTENT_LENGTH=MAX_JSON_BODY_BYTES,
)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

tmdb_cache = TTLCache(max_entries=MAX_CACHE_ENTRIES)
tmdb_rate_limiter = SlidingWindowRateLimiter(
    max_requests=RATE_LIMIT_MAX_REQUESTS,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
)


def configure_logging() -> None:
    if LOGGER.handlers:
        return
    logging.basicConfig(level=logging.INFO, format="[vidking-app] %(message)s")


def load_tmdb_token() -> str:
    return os.environ.get("TMDB_READ_ACCESS_TOKEN", "").strip()


def token_status_payload() -> dict[str, Any]:
    return {"configured": bool(load_tmdb_token())}


def tmdb_headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "VidkingPublicHost/1.0",
    }


def build_tmdb_image_url(path: Any) -> str | None:
    return f"{TMDB_IMAGE_BASE}{path}" if isinstance(path, str) and path else None


def validate_search_query(raw_value: str) -> str:
    query = " ".join(raw_value.split())
    if len(query) < 2:
        raise ValueError("Enter at least two characters.")
    if len(query) > MAX_SEARCH_QUERY_LENGTH:
        raise ValueError("The search query is too long.")
    if any(ord(character) < 32 for character in query):
        raise ValueError("The search query contains unsupported characters.")
    return query


def parse_bounded_int(raw_value: str, *, label: str, minimum: int, maximum: int) -> int:
    if not raw_value.isdigit():
        raise ValueError(f"{label} must be a whole number.")

    value = int(raw_value, 10)
    if value < minimum or value > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}.")

    return value


def request_tmdb_json(api_path: str, token: str) -> dict[str, Any]:
    request_object = urllib.request.Request(
        f"{TMDB_API_BASE}{api_path}",
        headers=tmdb_headers(token),
        method="GET",
    )
    with urllib.request.urlopen(request_object, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if not isinstance(payload, dict):
        raise ValueError("TMDB returned an unexpected payload.")

    return payload


def normalise_result(item: dict[str, Any]) -> dict[str, Any] | None:
    media_type = item.get("media_type")
    if media_type not in {"movie", "tv"}:
        return None

    title = item.get("title") if media_type == "movie" else item.get("name")
    date = item.get("release_date") if media_type == "movie" else item.get("first_air_date")
    if not isinstance(title, str) or not title.strip():
        return None

    identifier = item.get("id")
    if not isinstance(identifier, int):
        return None

    rating = item.get("vote_average")
    return {
        "id": identifier,
        "mediaType": media_type,
        "title": title.strip(),
        "originalTitle": item.get("original_title") or item.get("original_name") or title,
        "date": date or "",
        "year": date[:4] if isinstance(date, str) and len(date) >= 4 else "",
        "overview": item.get("overview") or "",
        "posterUrl": build_tmdb_image_url(item.get("poster_path")),
        "rating": float(rating) if isinstance(rating, (int, float)) else 0.0,
    }


def normalise_tv_details(payload: dict[str, Any]) -> dict[str, Any]:
    seasons: list[dict[str, Any]] = []
    raw_seasons = payload.get("seasons")
    if isinstance(raw_seasons, list):
        for season in raw_seasons:
            if not isinstance(season, dict):
                continue
            season_number = season.get("season_number")
            episode_count = season.get("episode_count")
            if not isinstance(season_number, int) or season_number < 0 or season_number > MAX_SEASON_NUMBER:
                continue
            seasons.append(
                {
                    "seasonNumber": season_number,
                    "name": str(season.get("name") or "").strip(),
                    "episodeCount": episode_count if isinstance(episode_count, int) and episode_count >= 0 else 0,
                    "airDate": str(season.get("air_date") or ""),
                    "posterUrl": build_tmdb_image_url(season.get("poster_path")),
                }
            )

    seasons.sort(key=lambda season: season["seasonNumber"])
    number_of_seasons = payload.get("number_of_seasons")
    return {
        "id": payload.get("id"),
        "name": str(payload.get("name") or "").strip(),
        "numberOfSeasons": number_of_seasons if isinstance(number_of_seasons, int) else len(seasons),
        "seasons": seasons,
    }


def normalise_season_details(payload: dict[str, Any]) -> dict[str, Any]:
    episodes: list[dict[str, Any]] = []
    raw_episodes = payload.get("episodes")
    if isinstance(raw_episodes, list):
        for episode in raw_episodes:
            if not isinstance(episode, dict):
                continue
            episode_number = episode.get("episode_number")
            if not isinstance(episode_number, int) or episode_number < 0:
                continue
            runtime = episode.get("runtime")
            vote_average = episode.get("vote_average")
            episodes.append(
                {
                    "episodeNumber": episode_number,
                    "name": str(episode.get("name") or "").strip(),
                    "overview": str(episode.get("overview") or ""),
                    "airDate": str(episode.get("air_date") or ""),
                    "runtime": runtime if isinstance(runtime, int) and runtime >= 0 else None,
                    "stillUrl": build_tmdb_image_url(episode.get("still_path")),
                    "voteAverage": float(vote_average) if isinstance(vote_average, (int, float)) else 0.0,
                }
            )

    episodes.sort(key=lambda episode: episode["episodeNumber"])
    return {
        "id": payload.get("id"),
        "name": str(payload.get("name") or "").strip(),
        "seasonNumber": payload.get("season_number") if isinstance(payload.get("season_number"), int) else None,
        "episodes": episodes,
    }


def json_error(status: int, message: str, *, retry_after: int | None = None) -> Response:
    response = jsonify({"error": message})
    response.status_code = status
    response.headers["Cache-Control"] = JSON_CACHE_CONTROL
    if retry_after is not None:
        response.headers["Retry-After"] = str(retry_after)
    return response


def get_client_key() -> str:
    return request.remote_addr or "unknown"


def enforce_tmdb_rate_limit() -> Response | None:
    allowed, retry_after = tmdb_rate_limiter.check(get_client_key())
    if allowed:
        return None
    return json_error(429, "Rate limit reached. Try again shortly.", retry_after=retry_after)


def require_tmdb_token() -> str | Response:
    token = load_tmdb_token()
    if token:
        return token
    return json_error(503, "TMDB title search is unavailable on this deployment.")


def tmdb_cache_key(prefix: str, suffix: str) -> str:
    return f"{prefix}:{suffix}"


def send_tmdb_http_error(
    error: urllib.error.HTTPError,
    *,
    action_label: str,
    not_found_message: str,
    unavailable_message: str,
) -> Response:
    LOGGER.warning("TMDB returned HTTP %s for %s.", error.code, action_label)
    if error.code == 404:
        return json_error(404, not_found_message)
    if error.code == 429:
        return json_error(429, "TMDB rate limit reached. Try again shortly.")
    if error.code in {401, 403}:
        return json_error(error.code, unavailable_message)
    status = error.code if 400 <= error.code < 600 else 502
    return json_error(status, f"TMDB rejected the {action_label} request.")


def html_response(filename: str) -> Response:
    response = send_from_directory(ROOT, filename, conditional=True, max_age=0)
    response.headers["Cache-Control"] = HTML_CACHE_CONTROL
    return response


def static_response(filename: str) -> Response:
    response = send_from_directory(ROOT, filename, conditional=True, max_age=STATIC_CACHE_SECONDS)
    response.headers.setdefault("Cache-Control", f"public, max-age={STATIC_CACHE_SECONDS}")
    return response


@app.after_request
def apply_security_headers(response: Response) -> Response:
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
    )
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["X-Permitted-Cross-Domain-Policies"] = "none"
    response.headers["Origin-Agent-Cluster"] = "?1"
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    path = request.path
    if path in {"/", "/index.html"}:
        response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
        response.headers["Cache-Control"] = HTML_CACHE_CONTROL
    elif path.startswith("/api/") or path == "/health":
        response.headers["Cache-Control"] = JSON_CACHE_CONTROL

    return response


@app.errorhandler(404)
def handle_not_found(error: Exception) -> Response:
    if request.path.startswith("/api/") or request.path == "/health":
        return json_error(404, "Not found.")
    return Response("Not found.", status=404)


@app.errorhandler(405)
def handle_method_not_allowed(error: Exception) -> Response:
    if request.path.startswith("/api/") or request.path == "/health":
        return json_error(405, "Method not allowed.")
    return Response("Method not allowed.", status=405)


@app.errorhandler(413)
def handle_payload_too_large(error: Exception) -> Response:
    return json_error(413, "The request body is too large.")


@app.errorhandler(429)
def handle_too_many_requests(error: Exception) -> Response:
    return json_error(429, "Rate limit reached. Try again shortly.")


@app.errorhandler(Exception)
def handle_unexpected_error(error: Exception) -> Response:
    LOGGER.exception("Unhandled application error.")
    if request.path.startswith("/api/") or request.path == "/health":
        return json_error(500, "Internal server error.")
    return Response("Internal server error.", status=500)


@app.get("/")
def index() -> Response:
    return html_response("index.html")


@app.get("/index.html")
def explicit_index() -> Response:
    return html_response("index.html")


@app.get("/health")
def health() -> Response:
    return jsonify({"ok": True})


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status=204)


@app.get("/api/tmdb/token-status")
def tmdb_token_status() -> Response:
    return jsonify(token_status_payload())


@app.route("/api/tmdb/token", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def disabled_tmdb_token_management() -> Response:
    return json_error(405, "TMDB token management is not available in the hosted application.")


@app.get("/api/tmdb/search")
def tmdb_search() -> Response:
    try:
        query = validate_search_query(request.args.get("q", "", type=str))
    except ValueError as error:
        return json_error(400, str(error))

    rate_limited = enforce_tmdb_rate_limit()
    if rate_limited is not None:
        return rate_limited

    token = require_tmdb_token()
    if isinstance(token, Response):
        return token

    cache_key = tmdb_cache_key("search", query.casefold())
    cached = tmdb_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    query_string = urllib.parse.urlencode(
        {
            "query": query,
            "include_adult": "false",
            "language": "en-GB",
            "page": "1",
        }
    )

    try:
        payload = request_tmdb_json(f"/search/multi?{query_string}", token)
    except urllib.error.HTTPError as error:
        return send_tmdb_http_error(
            error,
            action_label="TMDB search",
            not_found_message="TMDB search returned no result.",
            unavailable_message="TMDB title search is currently unavailable.",
        )
    except urllib.error.URLError:
        LOGGER.warning("TMDB search failed because the upstream service could not be reached.")
        return json_error(502, "Could not connect to TMDB.")
    except ValueError:
        LOGGER.warning("TMDB search failed because the upstream response was invalid.")
        return json_error(502, "TMDB returned an invalid response.")

    results: list[dict[str, Any]] = []
    raw_results = payload.get("results", [])
    if isinstance(raw_results, list):
        for item in raw_results:
            if not isinstance(item, dict):
                continue
            normalised = normalise_result(item)
            if normalised is not None:
                results.append(normalised)
            if len(results) >= 20:
                break

    response_payload = {"query": query, "results": results}
    tmdb_cache.set(cache_key, response_payload, SEARCH_CACHE_TTL_SECONDS)
    return jsonify(response_payload)


@app.get("/api/tmdb/tv/<tmdb_id_raw>")
def tmdb_tv_details(tmdb_id_raw: str) -> Response:
    try:
        tmdb_id = parse_bounded_int(
            tmdb_id_raw,
            label="TMDB ID",
            minimum=1,
            maximum=MAX_TMDB_ID,
        )
    except ValueError as error:
        return json_error(400, str(error))

    rate_limited = enforce_tmdb_rate_limit()
    if rate_limited is not None:
        return rate_limited

    token = require_tmdb_token()
    if isinstance(token, Response):
        return token

    cache_key = tmdb_cache_key("tv", str(tmdb_id))
    cached = tmdb_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        payload = request_tmdb_json(f"/tv/{tmdb_id}", token)
        normalised = normalise_tv_details(payload)
    except urllib.error.HTTPError as error:
        return send_tmdb_http_error(
            error,
            action_label="TV details lookup",
            not_found_message="That TV programme could not be found in TMDB.",
            unavailable_message="TMDB TV metadata is currently unavailable.",
        )
    except urllib.error.URLError:
        LOGGER.warning("TV details lookup failed because TMDB could not be reached.")
        return json_error(502, "Could not connect to TMDB.")
    except ValueError:
        LOGGER.warning("TV details lookup failed because the upstream response was invalid.")
        return json_error(502, "TMDB returned an invalid TV details response.")

    if not isinstance(normalised.get("id"), int):
        return json_error(502, "TMDB returned invalid TV details.")

    tmdb_cache.set(cache_key, normalised, DETAILS_CACHE_TTL_SECONDS)
    return jsonify(normalised)


@app.get("/api/tmdb/tv/<tmdb_id_raw>/season/<season_raw>")
def tmdb_tv_season_details(tmdb_id_raw: str, season_raw: str) -> Response:
    try:
        tmdb_id = parse_bounded_int(
            tmdb_id_raw,
            label="TMDB ID",
            minimum=1,
            maximum=MAX_TMDB_ID,
        )
        season_number = parse_bounded_int(
            season_raw,
            label="Season number",
            minimum=0,
            maximum=MAX_SEASON_NUMBER,
        )
    except ValueError as error:
        return json_error(400, str(error))

    rate_limited = enforce_tmdb_rate_limit()
    if rate_limited is not None:
        return rate_limited

    token = require_tmdb_token()
    if isinstance(token, Response):
        return token

    cache_key = tmdb_cache_key("season", f"{tmdb_id}:{season_number}")
    cached = tmdb_cache.get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        payload = request_tmdb_json(f"/tv/{tmdb_id}/season/{season_number}", token)
        normalised = normalise_season_details(payload)
    except urllib.error.HTTPError as error:
        return send_tmdb_http_error(
            error,
            action_label="season details lookup",
            not_found_message="That season could not be found in TMDB.",
            unavailable_message="TMDB season metadata is currently unavailable.",
        )
    except urllib.error.URLError:
        LOGGER.warning("Season details lookup failed because TMDB could not be reached.")
        return json_error(502, "Could not connect to TMDB.")
    except ValueError:
        LOGGER.warning("Season details lookup failed because the upstream response was invalid.")
        return json_error(502, "TMDB returned an invalid season details response.")

    if not isinstance(normalised.get("seasonNumber"), int):
        return json_error(502, "TMDB returned invalid season details.")

    tmdb_cache.set(cache_key, normalised, DETAILS_CACHE_TTL_SECONDS)
    return jsonify(normalised)


@app.get("/<path:filename>")
def static_files(filename: str) -> Response:
    if filename in STATIC_FILES:
        return static_response(filename)
    return handle_not_found(Exception())


def main() -> None:
    configure_logging()
    port = int(os.environ.get("PORT", str(DEFAULT_LOCAL_PORT)))
    if load_tmdb_token():
        LOGGER.info("TMDB title search is configured through TMDB_READ_ACCESS_TOKEN.")
    else:
        LOGGER.info("TMDB title search is unavailable because TMDB_READ_ACCESS_TOKEN is not set.")
    LOGGER.info("Starting Flask app on http://%s:%s", HOST, port)
    app.run(host=HOST, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
