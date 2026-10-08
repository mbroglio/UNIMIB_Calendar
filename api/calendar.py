from http.server import BaseHTTPRequestHandler
import json
import re
import time
import urllib.request
import urllib.parse
from datetime import datetime, timedelta
import concurrent.futures

GRID_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php'
_grid_cache = {}
CACHE_TTL = 300

def get_monday(dt=None):
    if dt is None:
        dt = datetime.now()
    return dt - timedelta(days=dt.weekday())

def _safe_ts(c):
    try:
        return int(c.get("timestamp") or 0)
    except (ValueError, TypeError):
        return 0

def split_curricula(percorso):
    # Lessons shared by several years of study list each curriculum separated by an <hr> tag
    parts = re.split(r'<hr[^>]*>', percorso or '')
    return [re.sub(r'<[^>]+>', '', p).strip() for p in parts if p.strip()]

def fetch_unimib_grid(anno, corso, anni_studio, date_str):
    cache_key = (anno, corso, tuple(sorted(anni_studio)), date_str)
    if cache_key in _grid_cache:
        cached_time, cached_data = _grid_cache[cache_key]
        if time.time() - cached_time < CACHE_TTL:
            return cached_data

    params = [
        ('view', 'easycourse'),
        ('form-type', 'corso'),
        ('include', 'corso'),
        ('anno', anno),
        ('corso', corso),
        *[('anno2[]', a) for a in anni_studio],
        ('date', date_str),
        ('_lang', 'it'),
    ]
    url = f'{GRID_URL}?{urllib.parse.urlencode(params)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        if isinstance(data, dict):
            _grid_cache[cache_key] = (time.time(), data)
        return data

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        anno = qs.get('anno', [''])[0]
        corso = qs.get('corso', [''])[0]
        anni_studio = [a for a in qs.get('anno2', []) if a]
        date_arg = qs.get('date', [None])[0]
        extra_arg = qs.get('extra', [None])[0]

        if not re.fullmatch(r'\d{4}', anno) or not re.fullmatch(r'[A-Za-z0-9_-]+', corso) or not anni_studio:
            return self.send_json(400, {"error": "Specificare anno accademico, corso di studio e anno di studio"})

        if not date_arg:
            date_arg = get_monday().strftime('%d-%m-%Y')
        elif not re.fullmatch(r'\d{2}-\d{2}-\d{4}', date_arg):
            return self.send_json(400, {"error": "Parametro 'date' non valido (atteso gg-mm-aaaa)"})

        # Parse extra courses (from other degrees) if provided
        extra_courses = []
        if extra_arg:
            try:
                parsed_extra = json.loads(extra_arg)
                if isinstance(parsed_extra, list):
                    extra_courses = parsed_extra
            except Exception:
                pass

        try:
            # 1. Fetch main grid
            raw_data = fetch_unimib_grid(anno, corso, anni_studio, date_arg)
            if not isinstance(raw_data, dict):
                return self.send_json(502, {"error": "Risposta non valida dal server UNIMIB"})
            celle = sorted(raw_data.get("celle", []), key=_safe_ts)
            giorni = raw_data.get("giorni", [])

            events = []
            seen_ids = set()

            for c in celle:
                course_name = c.get("nome_insegnamento", "").strip()
                day_date = c.get("data", "")
                start_time = c.get("ora_inizio", "")
                ev_id = c.get("id") or f"{day_date}_{start_time}_{course_name}"
                seen_ids.add(ev_id)

                events.append({
                    "id": ev_id,
                    "course": course_name,
                    "course_code": c.get("codice_insegnamento", ""),
                    "curricula": split_curricula(c.get("percorso_didattico", "")),
                    "type": c.get("tipo", ""),
                    "date": day_date,
                    "day_name": c.get("nome_giorno", "").capitalize(),
                    "start_time": start_time,
                    "end_time": c.get("ora_fine", ""),
                    "docente": c.get("docente", "").strip(),
                    "aula": c.get("aula", "").strip(),
                    "is_canceled": c.get("Annullato") == "1",
                    "is_external": False
                })

            # 2. Fetch external courses concurrently if present
            if extra_courses:
                ext_groups = {}
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
                    key = (ext_a, ext_c, ext_y_tuple)
                    if key not in ext_groups:
                        ext_groups[key] = []
                    ext_groups[key].append(ext)

                if ext_groups:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(ext_groups), 4)) as executor:
                        future_to_group = {
                            executor.submit(fetch_unimib_grid, g_anno, g_corso, list(g_anni), date_arg): (g_anno, g_corso, g_anni, g_items)
                            for (g_anno, g_corso, g_anni), g_items in ext_groups.items()
                        }
                        for future in concurrent.futures.as_completed(future_to_group):
                            try:
                                g_anno, g_corso, g_anni, g_items = future_to_group[future]
                                ext_raw = future.result()
                                if not isinstance(ext_raw, dict):
                                    continue

                                # Merge any new days into giorni
                                existing_giorni_dates = {g.get("data") for g in giorni if isinstance(g, dict)}
                                for eg in ext_raw.get("giorni", []):
                                    if isinstance(eg, dict) and eg.get("data") and eg.get("data") not in existing_giorni_dates:
                                        giorni.append(eg)
                                        existing_giorni_dates.add(eg.get("data"))

                                codes_to_item = {item.get("code"): item for item in g_items if item.get("code")}

                                ext_cells = sorted(ext_raw.get("celle", []), key=_safe_ts)
                                for c in ext_cells:
                                    c_code = c.get("codice_insegnamento", "")
                                    if codes_to_item and c_code not in codes_to_item:
                                        continue

                                    matched_item = codes_to_item.get(c_code, g_items[0] if g_items else {})
                                    course_name = c.get("nome_insegnamento", "").strip()
                                    day_date = c.get("data", "")
                                    start_time = c.get("ora_inizio", "")
                                    ev_id = c.get("id") or f"{day_date}_{start_time}_{course_name}"

                                    if ev_id in seen_ids:
                                        continue
                                    seen_ids.add(ev_id)

                                    events.append({
                                        "id": ev_id,
                                        "course": course_name,
                                        "course_code": c_code,
                                        "curricula": split_curricula(c.get("percorso_didattico", "")),
                                        "type": c.get("tipo", ""),
                                        "date": day_date,
                                        "day_name": c.get("nome_giorno", "").capitalize(),
                                        "start_time": start_time,
                                        "end_time": c.get("ora_fine", ""),
                                        "docente": c.get("docente", "").strip(),
                                        "aula": c.get("aula", "").strip(),
                                        "is_canceled": c.get("Annullato") == "1",
                                        "is_external": True,
                                        "external_corso": matched_item.get("corsoLabel") or matched_item.get("corso") or g_corso
                                    })
                            except Exception:
                                pass

            # Sort all events chronologically (date, start_time)
            def _sort_key(ev):
                d_parts = ev.get("date", "").split("-")
                d_val = f"{d_parts[2]}-{d_parts[1]}-{d_parts[0]}" if len(d_parts) == 3 else ev.get("date", "")
                return (d_val, ev.get("start_time", ""))

            events.sort(key=_sort_key)

            payload = {
                "monday_date": date_arg,
                "week_label": f"{raw_data.get('first_day_label', date_arg)} - {raw_data.get('last_day_label', '')}",
                "giorni": giorni,
                "total_events": len(events),
                "events": events
            }
            self.send_json(200, payload)
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def send_json(self, status, payload):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))

