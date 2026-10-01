"""
UNIMIB Calendar – Shared Calendar API
======================================
Returns the combined timetable of multiple students by fetching
each student's profile from Redis and then calling /api/calendar
for their individual timetable.

GET /api/shared_calendar?ids=ID1,ID2,ID3&date=DD-MM-YYYY

Returns:
{
  "profiles": [
    { "id": "...", "nickname": "...", "color": "#..." }
  ],
  "events": [
    {
      "profile_id":   "...",
      "nickname":     "...",
      "color":        "#...",
      "date":         "DD-MM-YYYY",
      "day_name":     "Lunedì",
      "start_time":   "09:00",
      "end_time":     "11:00",
      "course":       "...",
      "course_code":  "...",
      "aula":         "...",
      "docente":      "..."
    }
  ]
}
"""

import os
import json
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timedelta

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


# ── UNIMIB grid fetch (same logic as calendar.py) ─────────────────────────────

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


def _fetch_events(cfg: dict, date_str: str) -> list:
    """
    Fetch the weekly timetable events for a given config + week.
    Mirrors the logic in api/calendar.py exactly.
    """
    anno   = cfg.get("anno", "")
    corso  = cfg.get("corso", "")
    anni   = cfg.get("anni", [])
    if not anno or not corso or not anni:
        return []

    params = [
        ("view",      "easycourse"),
        ("form-type", "corso"),
        ("include",   "corso"),
        ("anno",      anno),
        ("corso",     corso),
        *[("anno2[]", a) for a in anni],
        ("date",      date_str),
        ("_lang",     "it"),
    ]
    url = f"{GRID_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw_data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []

    if not isinstance(raw_data, dict):
        return []

    def _safe_ts(c):
        try:
            return int(c.get("timestamp") or 0)
        except (ValueError, TypeError):
            return 0

    celle  = sorted(raw_data.get("celle", []), key=_safe_ts)
    events = []
    for c in celle:
        events.append({
            "date":        c.get("data", ""),
            "day_name":    c.get("nome_giorno", "").capitalize(),
            "start_time":  c.get("ora_inizio", ""),
            "end_time":    c.get("ora_fine", ""),
            "course":      c.get("nome_insegnamento", "").strip(),
            "course_code": c.get("codice_insegnamento", ""),
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

        # Normalise date to the Monday of the requested week
        if not date:
            date = datetime.now().strftime("%d-%m-%Y")
        monday = _get_monday(date)

        profiles_out = []
        all_events   = []

        for idx, code in enumerate(codes):
            try:
                # 1) Try public share entry
                profile = _redis_get(f"share:{code}")
                # 2) Try account entry
                if not profile:
                    profile = _redis_get(f"account:{code}")
                # 3) Legacy profile entry
                if not profile:
                    profile = _redis_get(f"profile:{code}")
            except Exception:
                continue
            if not profile:
                continue

            color    = SHARED_COLORS[idx % len(SHARED_COLORS)]
            share_id = profile.get("share_code", code.upper())
            nickname = profile.get("nickname", share_id)
            cfg      = profile.get("config") or {}

            profiles_out.append({"id": share_id, "share_code": share_id, "nickname": nickname, "color": color})

            events = _fetch_events(cfg, monday)
            for ev in events:
                ev["profile_id"] = share_id
                ev["nickname"]   = nickname
                ev["color"]      = color
            all_events.extend(events)

        # Sort: date (DD-MM-YYYY → YYYY-MM-DD for lexicographic sort) then time
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
