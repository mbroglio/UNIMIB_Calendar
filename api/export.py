"""
UNIMIB Calendar – Standard Export & WebCal Subscription API
============================================================
Exports university course timetables into standard calendar formats:
- iCalendar (.ics) [RFC 5545] (Apple Calendar, Google Calendar, Outlook, Thunderbird)
- CSV (.csv) (Excel, Google Sheets, Calc)
- JSON (.json) (Structured raw data)

Supports both file download and live WebCal feed subscriptions:
- webcal://.../api/export?code=SHARE_CODE&format=ics
- GET /api/export?code=SHARE_CODE[&format=ics|csv|json][&weeks=4][&start=DD-MM-YYYY]
- GET /api/export?anno=2526&corso=F1801Q&anno2=GGG|1[&fav=CODE1,CODE2][&format=ics|csv|json]
"""

import os
import json
import csv
import io
import re
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timedelta, timezone
import concurrent.futures

GRID_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

# In-memory grid cache with 300s TTL: (anno, corso, tuple(sorted(anni)), monday) -> (time, cells)
_grid_cache = {}
CACHE_TTL = 300


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


def _redis_get(key: str):
    url, token = _get_redis_creds()
    if not url or not token:
        return None
    path = "/GET/" + urllib.parse.quote(key, safe="")
    req = urllib.request.Request(
        url + path,
        headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode())
        if "error" in body:
            return None
        raw = body.get("result")
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _get_monday(dt=None):
    if dt is None:
        dt = datetime.now()
    return dt - timedelta(days=dt.weekday())


def _parse_date_to_monday(date_str: str) -> datetime:
    if not date_str:
        return _get_monday()
    clean = date_str.strip().replace('/', '-')
    for fmt in ("%d-%m-%Y", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(clean, fmt)
            return _get_monday(dt)
        except ValueError:
            pass
    return _get_monday()


def _safe_ts(c):
    try:
        return int(c.get("timestamp") or 0)
    except (ValueError, TypeError):
        return 0


def _fetch_unimib_grid(anno: str, corso: str, anni_tuple: tuple, monday_str: str) -> list:
    if not anno or not corso or not anni_tuple:
        return []

    cache_key = (anno, corso, anni_tuple, monday_str)
    cached = _grid_cache.get(cache_key)
    if cached:
        cached_time, cached_cells = cached
        if time.time() - cached_time < CACHE_TTL:
            return cached_cells

    params = [
        ("view", "easycourse"),
        ("form-type", "corso"),
        ("include", "corso"),
        ("anno", anno),
        ("corso", corso),
        *[("anno2[]", a) for a in anni_tuple],
        ("date", monday_str),
        ("_lang", "it"),
    ]
    url = f"{GRID_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
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


def _escape_ical(text: str) -> str:
    if not text:
        return ""
    return str(text).replace("\\", "\\\\").replace(";", r"\;").replace(",", r"\,").replace("\n", r"\n")


def _format_ical_date(day_date: str, time_str: str) -> str:
    """Convert DD-MM-YYYY or YYYY-MM-DD to YYYYMMDDTHHMMSS"""
    clean = (day_date or "").strip().replace("/", "-")
    parts = clean.split("-")
    if len(parts) == 3:
        if len(parts[0]) == 4:
            d_clean = f"{parts[0]}{parts[1]}{parts[2]}"
        else:
            d_clean = f"{parts[2]}{parts[1]}{parts[0]}"
    else:
        d_clean = datetime.now().strftime("%Y%m%d")
    t_clean = (time_str or "09:00").replace(":", "")
    if len(t_clean) == 4:
        t_clean += "00"
    return f"{d_clean}T{t_clean}"


def _format_csv_date(day_date: str) -> str:
    """Convert DD-MM-YYYY or YYYY-MM-DD to YYYY-MM-DD for standard CSV import"""
    clean = (day_date or "").strip().replace("/", "-")
    parts = clean.split("-")
    if len(parts) == 3:
        if len(parts[2]) == 4:
            return f"{parts[2]}-{parts[1]}-{parts[0]}"
        elif len(parts[0]) == 4:
            return f"{parts[0]}-{parts[1]}-{parts[2]}"
    return clean


class handler(BaseHTTPRequestHandler):

    def _qs(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return urllib.parse.parse_qs(parsed.query)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        qs = self._qs()

        # ── 1. Resolve Profile or Query Parameters ───────────────────────────
        code = qs.get("code", [""])[0].strip().lower()
        cfg = None
        cal_name = "Orario UNIMIB"

        if code:
            prof = _redis_get(f"share:{code}") or _redis_get(f"account:{code}") or _redis_get(f"profile:{code}")
            if prof and isinstance(prof, dict):
                cfg = prof.get("config")
                nick = prof.get("nickname")
                if nick:
                    cal_name = f"Orario UNIMIB - {nick}"

        if not cfg:
            anno = qs.get("anno", [""])[0].strip()
            corso = qs.get("corso", [""])[0].strip()
            anni = [a for a in qs.get("anno2", []) if a]
            fav_str = qs.get("fav", [""])[0].strip()
            fav_codes = [f.strip() for f in fav_str.split(",") if f.strip()] if fav_str else []

            if anno and corso and anni:
                cfg = {
                    "anno": anno,
                    "corso": corso,
                    "anni": anni,
                    "favorites": [{"code": c} for c in fav_codes]
                }
                c_label = qs.get("label", [""])[0].strip()
                if c_label:
                    cal_name = f"Orario UNIMIB - {c_label}"

        if not cfg or not cfg.get("anno") or not cfg.get("corso") or not cfg.get("anni"):
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Parametri insufficienti. Specificare 'code' oppure 'anno', 'corso' e 'anno2'."}).encode())
            return

        extra_arg = qs.get("extra", [""])[0].strip()
        extra_courses = cfg.get("externalCourses") or []
        if extra_arg:
            try:
                parsed_extra = json.loads(extra_arg)
                if isinstance(parsed_extra, list):
                    extra_courses = parsed_extra
            except Exception:
                pass

        anno = cfg["anno"]
        corso = cfg["corso"]
        anni = tuple(sorted(cfg.get("anni", [])))
        favorites = cfg.get("favorites") or []
        fav_set = {f["code"].upper() for f in favorites if f.get("code")} if favorites else set()
        for ext in extra_courses:
            if ext.get("code"):
                fav_set.add(ext["code"].upper())
        if not fav_set and not favorites:
            fav_set = None

        # Filter mode: 'all' to export all courses, or default favorites if defined
        filter_mode = qs.get("filter", ["target"])[0].strip().lower()
        if filter_mode == "all":
            fav_set = None

        # Number of weeks (1 to 12, default 4)
        try:
            weeks_count = max(1, min(12, int(qs.get("weeks", ["4"])[0])))
        except ValueError:
            weeks_count = 4

        # Start date
        start_date_str = qs.get("date", qs.get("start", [""]))[0].strip()
        start_monday = _parse_date_to_monday(start_date_str)

        export_format = qs.get("format", ["ics"])[0].strip().lower()

        # ── 2. Fetch Weeks in Parallel ───────────────────────────────────────
        weeks_mondays = [(start_monday + timedelta(days=7 * w)).strftime("%d-%m-%Y") for w in range(weeks_count)]

        # Prepare external grid specs
        ext_specs = []
        ext_codes_set = set()
        for ext in extra_courses:
            if not isinstance(ext, dict):
                continue
            ext_c = ext.get("corso", "").strip()
            if not ext_c:
                continue
            ext_a = ext.get("anno") or anno
            ext_y = ext.get("anno2") or []
            if isinstance(ext_y, str):
                ext_y = [ext_y]
            ext_y_tuple = tuple(sorted([y for y in ext_y if y]))
            if not ext_y_tuple:
                continue
            ext_code = (ext.get("code") or "").upper()
            if ext_code:
                ext_codes_set.add(ext_code)
            ext_specs.append((ext_a, ext_c, ext_y_tuple, ext_code))

        week_cells = {mon: [] for mon in weeks_mondays}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(weeks_count * (1 + len(ext_specs)), 12)) as executor:
            future_to_info = {}
            for mon in weeks_mondays:
                f_main = executor.submit(_fetch_unimib_grid, anno, corso, anni, mon)
                future_to_info[f_main] = (mon, None)
                for (ea, ec, ey, ecode) in ext_specs:
                    f_ext = executor.submit(_fetch_unimib_grid, ea, ec, ey, mon)
                    future_to_info[f_ext] = (mon, ecode)

            for future in concurrent.futures.as_completed(future_to_info):
                mon, required_code = future_to_info[future]
                try:
                    cells = future.result()
                    if required_code:
                        cells = [c for c in cells if c.get("codice_insegnamento", "").upper() == required_code]
                    week_cells[mon].extend(cells)
                except Exception:
                    pass

        # ── 3. Deduplicate and Filter Events ─────────────────────────────────
        seen_events = set()
        events = []

        for mon in weeks_mondays:
            cells = week_cells.get(mon, [])
            for c in cells:
                course_code = c.get("codice_insegnamento", "")
                if fav_set and course_code.upper() not in fav_set:
                    continue

                day_date = c.get("data", "")
                start_time = c.get("ora_inizio", "")
                end_time = c.get("ora_fine", "")
                course_name = c.get("nome_insegnamento", "").strip()
                event_key = (day_date, start_time, end_time, course_name)

                if event_key in seen_events:
                    continue
                seen_events.add(event_key)

                events.append({
                    "id": c.get("id") or f"{day_date}_{start_time}_{course_code}",
                    "course": course_name,
                    "course_code": course_code,
                    "date": day_date,
                    "day_name": c.get("nome_giorno", "").capitalize(),
                    "start_time": start_time,
                    "end_time": end_time,
                    "docente": c.get("docente", "").strip(),
                    "aula": c.get("aula", "").strip(),
                    "type": c.get("tipo", "Lezione"),
                    "is_canceled": c.get("Annullato") == "1"
                })

        # Chronological sort
        def _sort_key(e):
            d = e.get("date", "")
            parts = d.split("-")
            if len(parts) == 3 and len(parts[2]) == 4:
                d = f"{parts[2]}-{parts[1]}-{parts[0]}"
            return (d, e.get("start_time", ""))

        events.sort(key=_sort_key)

        # ── 4. Format Output ─────────────────────────────────────────────────
        if export_format == "csv":
            output = io.StringIO()
            writer = csv.writer(output, lineterminator="\r\n")
            writer.writerow([
                "Subject", "Start Date", "Start Time", "End Date", "End Time",
                "All Day Event", "Description", "Location"
            ])
            for ev in events:
                iso_date = _format_csv_date(ev["date"])
                desc = f"Docente: {ev['docente']}\nInsegnamento: {ev['course_code']}\nTipo: {ev['type']}"
                if ev["is_canceled"]:
                    desc += "\n[ANNULLATO]"
                writer.writerow([
                    ev["course"],
                    iso_date,
                    ev["start_time"],
                    iso_date,
                    ev["end_time"],
                    "False",
                    desc,
                    ev["aula"] or "UNIMIB"
                ])

            data_bytes = output.getvalue().encode("utf-8-sig")  # UTF-8 BOM for Excel compatibility
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="orario_unimib.csv"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data_bytes)))
            self.end_headers()
            self.wfile.write(data_bytes)

        elif export_format == "json":
            payload = {
                "calendar_name": cal_name,
                "course": corso,
                "academic_year": anno,
                "study_years": list(anni),
                "total_events": len(events),
                "events": events
            }
            data_bytes = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="orario_unimib.json"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data_bytes)))
            self.end_headers()
            self.wfile.write(data_bytes)

        else:
            # Default: iCalendar (.ics) [RFC 5545]
            now_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            vcalendar_lines = [
                "BEGIN:VCALENDAR",
                "VERSION:2.0",
                "PRODID:-//UNIMIB Orari//IT",
                "CALSCALE:GREGORIAN",
                "METHOD:PUBLISH",
                f"X-WR-CALNAME:{_escape_ical(cal_name)}",
                "X-WR-TIMEZONE:Europe/Rome"
            ]

            for ev in events:
                dt_start = _format_ical_date(ev["date"], ev["start_time"])
                dt_end = _format_ical_date(ev["date"], ev["end_time"])
                summary = ev["course"]
                if ev["is_canceled"]:
                    summary = f"[ANNULLATO] {summary}"
                location = ev["aula"] or "UNIMIB"
                description = f"Docente: {ev['docente']}\\nInsegnamento: {ev['course_code']}\\nTipo: {ev['type']}"

                vcalendar_lines.extend([
                    "BEGIN:VEVENT",
                    f"UID:unimib-lesson-{ev['id']}@unimib.it",
                    f"DTSTAMP:{now_stamp}",
                    f"DTSTART;TZID=Europe/Rome:{dt_start}",
                    f"DTEND;TZID=Europe/Rome:{dt_end}",
                    f"SUMMARY:{_escape_ical(summary)}",
                    f"LOCATION:{_escape_ical(location)}",
                    f"DESCRIPTION:{_escape_ical(description)}",
                    "STATUS:CANCELLED" if ev["is_canceled"] else "STATUS:CONFIRMED",
                    "END:VEVENT"
                ])

            vcalendar_lines.append("END:VCALENDAR")
            ics_text = "\r\n".join(vcalendar_lines) + "\r\n"
            data_bytes = ics_text.encode("utf-8")

            self.send_response(200)
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="orario_unimib.ics"')
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data_bytes)))
            self.end_headers()
            self.wfile.write(data_bytes)

    def log_message(self, *args):
        pass
