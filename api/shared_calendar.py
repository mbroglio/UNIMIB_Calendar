"""
UNIMIB Calendar – Shared Calendar API
======================================
Returns the combined timetable of multiple students by fetching
each student's profile from Redis and then calling /api/calendar
for their individual timetable.

GET /api/shared_calendar?ids=ID1,ID2,ID3&date=DD-MM-YYYY
GET /api/shared_calendar?codes=CODE1,CODE2&date=DD-MM-YYYY

Returns ONLY the courses each student has marked as favourites
(config.favorites). If a student has no favourites, all their
courses are returned (full study-year timetable).

High-Performance Parallel Engine:
- Profile lookups run in parallel via ThreadPoolExecutor.
- UNIMIB grid fetches are deduplicated (multiple students in the same
  degree/year share a single request).
- Distinct UNIMIB grid requests run concurrently in parallel.
- Responses are cached in an in-memory TTL cache (300s) for instant response.
"""

import os
import json
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timedelta
import concurrent.futures

def _get_redis_creds():
    url = (
        os.environ.get("UPSTASH_REDIS_REST_URL")
        or os.environ.get("KV_REST_API_URL")
        or os.environ.get("REDIS_REST_URL")
        or ""
    ).strip().strip('"').strip("'").rstrip("/")
    token = (
        os.environ.get("UPSTASH_REDIS_REST_TOKEN")
        or os.environ.get("KV_REST_API_TOKEN")
        or os.environ.get("REDIS_REST_TOKEN")
        or ""
    ).strip().strip('"').strip("'")
    return url, token

GRID_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php'

# Distinct colors for each student in the shared view
SHARED_COLORS = [
    "#8B5CF6", "#10B981", "#F59E0B", "#EC4899",
    "#3B82F6", "#F97316", "#06B6D4", "#84CC16",
    "#EF4444", "#A78BFA"
]

MAX_PROFILES = 8  # safety cap
CACHE_TTL = 300   # 5 minutes in-memory cache for UNIMIB grids

# In-memory grid cache: (anno, corso, tuple(sorted(anni)), monday) -> (timestamp, list_of_raw_cells)
_grid_cache = {}


# ── Redis helper ────────────────────────────────────────────────────────────────

def _redis_get(key: str):
    url, token = _get_redis_creds()
    if not url or not token:
        raise RuntimeError(f"Upstash Redis env vars not configured: URL={'OK' if url else 'MISSING'}, TOKEN={'OK' if token else 'MISSING'}")
    path = "/GET/" + urllib.parse.quote(key, safe="")
    req  = urllib.request.Request(
        url + path,
        headers={"Authorization": f"Bearer {token}"}
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    if "error" in body:
        raise RuntimeError(body["error"])
    raw = body.get("result")
    return json.loads(raw) if raw else None


def _resolve_profile(code: str):
    """Try resolving profile by public share code, account or legacy profile."""
    try:
        prof = _redis_get(f"share:{code}")
        if prof and isinstance(prof, dict):
            return code, prof
        prof = _redis_get(f"account:{code}")
        if prof and isinstance(prof, dict):
            return code, prof
        prof = _redis_get(f"profile:{code}")
        if prof and isinstance(prof, dict):
            return code, prof
    except Exception:
        pass
    return code, None


# ── UNIMIB grid fetch with caching & deduplication ────────────────────────────

def _get_monday(date_str: str) -> str:
    """Given DD-MM-YYYY or YYYY-MM-DD, return the Monday of that week in DD-MM-YYYY."""
    dt = None
    if date_str:
        clean = date_str.strip().replace('/', '-')
        for fmt in ("%d-%m-%Y", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(clean, fmt)
                break
            except ValueError:
                pass
    if not dt:
        dt = datetime.now()
    monday = dt - timedelta(days=dt.weekday())
    return monday.strftime("%d-%m-%Y")


def _safe_ts(c):
    try:
        return int(c.get("timestamp") or 0)
    except (ValueError, TypeError):
        return 0


def _fetch_raw_grid(anno: str, corso: str, anni_tuple: tuple, monday_str: str) -> list:
    """Fetch raw UNIMIB cells with memory caching."""
    if not anno or not corso or not anni_tuple:
        return []

    cache_key = (anno, corso, anni_tuple, monday_str)
    cached = _grid_cache.get(cache_key)
    if cached:
        cached_time, cached_cells = cached
        if time.time() - cached_time < CACHE_TTL:
            return cached_cells

    params = [
        ("view",      "easycourse"),
        ("form-type", "corso"),
        ("include",   "corso"),
        ("anno",      anno),
        ("corso",     corso),
        *[("anno2[]", a) for a in anni_tuple],
        ("date",      monday_str),
        ("_lang",     "it"),
    ]
    url = f"{GRID_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw_data = json.loads(resp.read().decode("utf-8"))
        if isinstance(raw_data, dict):
            cells = sorted(raw_data.get("celle", []), key=_safe_ts)
            _grid_cache[cache_key] = (time.time(), cells)
            return cells
    except Exception:
        pass
    return []


def _extract_events_from_cells(cells: list, favorite_codes: list | None) -> list:
    """Filter pre-fetched cells according to student favorites."""
    fav_set = {c.upper() for c in favorite_codes} if favorite_codes else None
    events = []
    for c in cells:
        course_code = c.get("codice_insegnamento", "")
        if fav_set and course_code.upper() not in fav_set:
            continue
        events.append({
            "date":        c.get("data", ""),
            "day_name":    c.get("nome_giorno", "").capitalize(),
            "start_time":  c.get("ora_inizio", ""),
            "end_time":    c.get("ora_fine", ""),
            "course":      c.get("nome_insegnamento", "").strip(),
            "course_code": course_code,
            "aula":        c.get("aula", "").strip(),
            "docente":     c.get("docente", "").strip(),
            "is_canceled": c.get("Annullato") == "1",
        })
    return events


# ── HTTP Handler ───────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):

    def _send_json(self, code: int, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _qs(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return dict(urllib.parse.parse_qsl(parsed.query))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        qs    = self._qs()
        codes = [i.strip().lower() for i in (qs.get("codes", "") or qs.get("ids", "")).split(",") if i.strip()][:MAX_PROFILES]
        date  = qs.get("date", "").strip()  # DD-MM-YYYY

        if not codes:
            return self._send_json(400, {"error": "codes parameter required"})

        monday = _get_monday(date)

        # ── 1. Parallel Profile Resolution via ThreadPoolExecutor ────────────
        resolved_profiles = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(codes), 8)) as executor:
            future_to_code = {executor.submit(_resolve_profile, c): c for c in codes}
            for future in concurrent.futures.as_completed(future_to_code):
                try:
                    c, prof = future.result()
                    if prof:
                        resolved_profiles[c] = prof
                except Exception:
                    pass

        # ── 2. Collect Distinct UNIMIB Grids to Fetch ─────────────────────────
        # Distinct course specifications across all students: set of (anno, corso, anni_tuple)
        needed_grids = set()
        students_plan = []

        for idx, code in enumerate(codes):
            profile = resolved_profiles.get(code)
            if not profile:
                continue

            color    = SHARED_COLORS[idx % len(SHARED_COLORS)]
            share_id = profile.get("share_code", code.upper())
            nickname = profile.get("nickname", share_id)
            cfg      = profile.get("config") or {}

            anno   = cfg.get("anno", "")
            corso  = cfg.get("corso", "")
            anni   = tuple(sorted(cfg.get("anni", [])))

            favorites      = cfg.get("favorites") or []
            favorite_codes = [f.get("code", "") for f in favorites if f.get("code")] if favorites else None

            if anno and corso and anni:
                grid_key = (anno, corso, anni)
                needed_grids.add(grid_key)
            else:
                grid_key = None

            students_plan.append({
                "share_id":       share_id,
                "nickname":       nickname,
                "color":          color,
                "grid_key":       grid_key,
                "favorite_codes": favorite_codes
            })

        # ── 3. Parallel Fetch of Distinct UNIMIB Grids ────────────────────────
        grids_data = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(max(len(needed_grids), 1), 8)) as executor:
            future_to_grid = {
                executor.submit(_fetch_raw_grid, g[0], g[1], g[2], monday): g
                for g in needed_grids
            }
            for future in concurrent.futures.as_completed(future_to_grid):
                grid_key = future_to_grid[future]
                try:
                    grids_data[grid_key] = future.result()
                except Exception:
                    grids_data[grid_key] = []

        # ── 4. Extract and Filter Events for Each Student ────────────────────
        profiles_out = []
        all_events   = []

        for sp in students_plan:
            profiles_out.append({
                "id":         sp["share_id"],
                "share_code": sp["share_id"],
                "nickname":   sp["nickname"],
                "color":      sp["color"]
            })

            grid_key = sp["grid_key"]
            if grid_key and grid_key in grids_data:
                cells = grids_data[grid_key]
                student_events = _extract_events_from_cells(cells, sp["favorite_codes"])
                for ev in student_events:
                    ev["profile_id"] = sp["share_id"]
                    ev["nickname"]   = sp["nickname"]
                    ev["color"]      = sp["color"]
                all_events.extend(student_events)

        # Sort: date (YYYY-MM-DD for lexicographic sort) then start_time then nickname
        def _sort_key(e):
            d = e.get("date", "")
            parts = d.split("-")
            if len(parts) == 3 and len(parts[2]) == 4:
                d = f"{parts[2]}-{parts[1]}-{parts[0]}"
            return (d, e.get("start_time", ""), e.get("nickname", ""))

        all_events.sort(key=_sort_key)

        return self._send_json(200, {
            "profiles": profiles_out,
            "events":   all_events,
            "week":     monday
        })

    def log_message(self, *args):
        pass
