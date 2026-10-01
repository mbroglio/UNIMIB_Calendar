"""
UNIMIB Calendar – Shared Calendar API
======================================
Returns the combined timetable of multiple students by fetching
each student's profile from Redis and then querying UNIMIB for
their individual timetable.

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

REDIS_URL   = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")

# Base URL for UNIMIB EasyCourse grid
GRID_BASE = "https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/index.php?view=easycourse&_lang=it"

# Distinct colors for each student in the shared view
SHARED_COLORS = [
    "#8B5CF6", "#10B981", "#F59E0B", "#EC4899",
    "#3B82F6", "#F97316", "#06B6D4", "#84CC16",
    "#EF4444", "#A78BFA"
]

MAX_PROFILES = 8  # safety cap


# ── Redis helper ────────────────────────────────────────────────────────────────

def _redis_get(key: str):
    if not REDIS_URL or not REDIS_TOKEN:
        raise RuntimeError("Upstash Redis env vars not configured")
    path  = "/GET/" + urllib.parse.quote(key, safe="")
    req   = urllib.request.Request(
        REDIS_URL + path,
        headers={"Authorization": f"Bearer {REDIS_TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    if "error" in body:
        raise RuntimeError(body["error"])
    raw = body.get("result")
    return json.loads(raw) if raw else None


# ── UNIMIB grid fetch ──────────────────────────────────────────────────────────

def _fetch_events(cfg: dict, date_str: str) -> list:
    """
    Fetch the weekly timetable events for a given config + week.
    Returns a list of event dicts (same structure as api/calendar.py).
    """
    anno    = cfg.get("anno", "")
    corso   = cfg.get("corso", "")
    anni    = cfg.get("anni", [])
    if not anno or not corso or not anni:
        return []

    params = {
        "form-type": "corso",
        "aa":        anno,
        "corso":     corso,
        "date":      date_str,
        "periodo_didattico": ""
    }
    for a in anni:
        params.setdefault("anno2[]", [])
        if isinstance(params["anno2[]"], list):
            params["anno2[]"].append(a)
        else:
            params["anno2[]"] = [params["anno2[]"], a]

    # Build query string manually to support repeated anno2[]
    qs_parts = []
    for k, v in params.items():
        if k == "anno2[]":
            for av in (v if isinstance(v, list) else [v]):
                qs_parts.append(f"anno2[]={urllib.parse.quote(str(av))}")
        else:
            qs_parts.append(f"{k}={urllib.parse.quote(str(v))}")
    url = f"{GRID_BASE}&{'&'.join(qs_parts)}&include=grid_call"

    try:
        req  = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
    except Exception:
        return []

    events_raw = data if isinstance(data, list) else data.get("celle", [])
    events     = []
    for e in events_raw:
        name      = e.get("titolo_lezione") or e.get("corso") or ""
        code      = e.get("codice_insegnamento") or e.get("corso_id") or ""
        aula      = e.get("aula") or ""
        docente   = e.get("docente") or ""
        date_val  = e.get("data") or ""
        start     = e.get("ora_inizio") or e.get("start") or ""
        end_val   = e.get("ora_fine") or e.get("end") or ""
        if not name or not date_val:
            continue
        events.append({
            "date":        date_val,
            "start_time":  start,
            "end_time":    end_val,
            "course":      name,
            "course_code": code,
            "aula":        aula,
            "docente":     docente
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
        qs   = self._qs()
        ids  = [i.strip().upper() for i in qs.get("ids", "").split(",") if i.strip()][:MAX_PROFILES]
        date = qs.get("date", "")  # DD-MM-YYYY

        if not ids:
            return self._send_json(400, {"error": "ids parameter required"})

        profiles_out = []
        all_events   = []

        for idx, pid in enumerate(ids):
            try:
                profile = _redis_get(f"profile:{pid}")
            except Exception as e:
                continue  # skip profiles we can't reach
            if not profile:
                continue

            color    = SHARED_COLORS[idx % len(SHARED_COLORS)]
            nickname = profile.get("nickname", pid)
            cfg      = profile.get("config") or {}

            profiles_out.append({"id": pid, "nickname": nickname, "color": color})

            # Use provided date or default to today-ish in UNIMIB format
            fetch_date = date or "today"
            events     = _fetch_events(cfg, fetch_date)
            for ev in events:
                ev["profile_id"] = pid
                ev["nickname"]   = nickname
                ev["color"]      = color
            all_events.extend(events)

        # Sort events: date, start_time
        def _sort_key(e):
            # date is DD-MM-YYYY → convert to YYYY-MM-DD for sorting
            d = e.get("date", "")
            parts = d.split("-")
            if len(parts) == 3:
                d = f"{parts[2]}-{parts[1]}-{parts[0]}"
            return (d, e.get("start_time", ""))

        all_events.sort(key=_sort_key)

        return self._send_json(200, {
            "profiles": profiles_out,
            "events":   all_events
        })

    def log_message(self, *args):
        pass
