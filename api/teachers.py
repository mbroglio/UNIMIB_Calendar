from http.server import BaseHTTPRequestHandler
import json
import re
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

COMBO_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/combo.php'
GRID_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

CACHE_TEACHERS_TTL = 3600  # 1 hour
CACHE_GRID_TTL = 300       # 5 minutes

_cache = {}

try:
    import zoneinfo
    TZ_ROME = zoneinfo.ZoneInfo("Europe/Rome")
except Exception:
    TZ_ROME = timezone(timedelta(hours=1))


def get_italy_now():
    try:
        return datetime.now(TZ_ROME)
    except Exception:
        return datetime.now(timezone(timedelta(hours=1)))


def get_monday(dt=None):
    if dt is None:
        dt = get_italy_now()
    return dt - timedelta(days=dt.weekday())


def parse_date_to_monday(date_str):
    if not date_str:
        return get_monday()
    date_str = date_str.strip()
    m1 = re.fullmatch(r'(\d{2})-(\d{2})-(\d{4})', date_str)
    if m1:
        day, month, year = map(int, m1.groups())
        dt = datetime(year, month, day)
        return dt - timedelta(days=dt.weekday())
    m2 = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', date_str)
    if m2:
        year, month, day = map(int, m2.groups())
        dt = datetime(year, month, day)
        return dt - timedelta(days=dt.weekday())
    raise ValueError("Parametro 'date' non valido (atteso GG-MM-AAAA o AAAA-MM-GG)")


def _safe_ts(c):
    try:
        return int(c.get("timestamp") or 0)
    except (ValueError, TypeError):
        return 0


def clean_html(text):
    if not text:
        return ''
    cleaned = re.sub(r'<[^>]+>', '', str(text))
    return re.sub(r'\s+', ' ', cleaned).strip()


def extract_emails(mail_str, link_str=''):
    combined = f"{mail_str or ''} {link_str or ''}"
    emails = re.findall(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+', combined)
    # Deduplicate while preserving order
    seen = set()
    result = []
    for e in emails:
        low = e.lower()
        if low not in seen:
            seen.add(low)
            result.append(low)
    return result


def split_curricula(percorso):
    parts = re.split(r'<hr[^>]*>', percorso or '')
    return [clean_html(p) for p in parts if clean_html(p)]


def js_var(script, name):
    m = re.search(r'var\s+' + re.escape(name) + r'\s*=\s*', script)
    if not m:
        return None
    try:
        return json.JSONDecoder().raw_decode(script, m.end())[0]
    except ValueError:
        return None


def fetch_text(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def get_academic_years():
    url = f"{COMBO_URL}?sw=ec_&aa=1"
    cached = _cache.get(url)
    if cached and time.time() - cached[0] < CACHE_TEACHERS_TTL:
        text = cached[1]
    else:
        text = fetch_text(url)
        _cache[url] = (time.time(), text)

    data = js_var(text, 'anni_accademici_ec') or {}
    items = data.values() if isinstance(data, dict) else data
    years = [{"value": y["valore"], "label": y["label"]} for y in items if "valore" in y]
    years.sort(key=lambda y: y["value"], reverse=True)
    return years


def get_teachers_list(anno):
    url = f"{COMBO_URL}?sw=ec_&aa={anno}&page=docenti"
    cached = _cache.get(url)
    if cached and time.time() - cached[0] < CACHE_TEACHERS_TTL:
        text = cached[1]
    else:
        text = fetch_text(url)
        _cache[url] = (time.time(), text)

    raw_teachers = js_var(text, 'elenco_docenti') or []
    teachers = []
    for d in raw_teachers:
        val = str(d.get("valore", "")).strip()
        label = clean_html(d.get("label", ""))
        if not val or not label:
            continue

        courses = []
        for c in d.get("teacher_cdl", []):
            c_code = str(c.get("CorsoLaureaCodice", "")).strip()
            c_name = clean_html(c.get("CorsoLaureaNome", ""))
            curricula = [
                {
                    "value": str(curr.get("valore", "")),
                    "label": clean_html(curr.get("label", ""))
                }
                for curr in c.get("elencoCurriculum", [])
                if curr.get("valore")
            ]
            courses.append({
                "code": c_code,
                "name": c_name,
                "curricula": curricula
            })

        teachers.append({
            "code": val,
            "name": label,
            "courses": courses
        })

    # Sort alphabetically by teacher name
    teachers.sort(key=lambda t: t["name"].upper())
    return teachers


def fetch_teacher_grid(anno, docente, date_str, corso=None, all_events=False):
    params = [
        ('view', 'easycourse'),
        ('form-type', 'docente'),
        ('include', 'docente'),
        ('anno', anno),
        ('docente', docente),
        ('date', date_str),
        ('_lang', 'it'),
    ]
    if corso:
        params.append(('corso', corso))
    if all_events:
        params.append(('all_events', '1'))

    url = f"{GRID_URL}?{urllib.parse.urlencode(params)}"
    text = fetch_text(url, timeout=12)
    return json.loads(text)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        anno = qs.get('anno', [''])[0].strip()
        docente = qs.get('docente', [''])[0].strip()
        date_arg = qs.get('date', [''])[0].strip()
        corso = qs.get('corso', [''])[0].strip()
        all_events_flag = qs.get('all_events', ['0'])[0].strip() == '1'
        search_query = qs.get('q', [''])[0].strip().lower()
        force_refresh = qs.get('refresh', ['0'])[0].strip() == '1'

        try:
            # 1. Resolve Academic Year if not provided
            if not anno:
                years = get_academic_years()
                if years:
                    anno = years[0]["value"]
                else:
                    now = get_italy_now()
                    anno = str(now.year)
            elif not re.fullmatch(r'\d{4}', anno):
                return self.send_json(400, {"error": "Parametro 'anno' non valido (atteso formato AAAA)"})

            # 2. Case A: Fetch single Teacher's Calendar / Timetable
            if docente:
                if not re.fullmatch(r'[A-Za-z0-9_-]+', docente):
                    return self.send_json(400, {"error": "Parametro 'docente' non valido"})
                if corso and not re.fullmatch(r'[A-Za-z0-9_-]+', corso):
                    return self.send_json(400, {"error": "Parametro 'corso' non valido"})

                try:
                    monday_dt = parse_date_to_monday(date_arg)
                    monday_str = monday_dt.strftime('%d-%m-%Y')
                except ValueError as ve:
                    return self.send_json(400, {"error": str(ve)})

                cache_key = f"teacher_grid:{anno}:{docente}:{corso}:{monday_str}:{all_events_flag}"
                cached = _cache.get(cache_key)
                if not force_refresh and cached and time.time() - cached[0] < CACHE_GRID_TTL:
                    return self.send_json(200, cached[1], cache_control=True)

                raw_data = fetch_teacher_grid(anno, docente, monday_str, corso=corso, all_events=all_events_flag)
                if not isinstance(raw_data, dict):
                    return self.send_json(502, {"error": "Risposta non valida dal server UNIMIB"})

                celle = sorted(raw_data.get("celle", []), key=_safe_ts)
                giorni = raw_data.get("giorni", [])

                events = []
                teacher_name_found = ""
                for c in celle:
                    raw_name = c.get("name_original") or c.get("nome_insegnamento", "")
                    course_name = clean_html(raw_name)
                    day_date = c.get("data", "")
                    start_time = c.get("ora_inizio", "")
                    doc_val = clean_html(c.get("docente", ""))
                    if not teacher_name_found and doc_val:
                        teacher_name_found = doc_val

                    emails = extract_emails(c.get("mail_docente", ""), c.get("link_docente", ""))
                    notes = clean_html(c.get("NoteSettimanali") or c.get("notes", ""))

                    events.append({
                        "id": c.get("id") or f"{day_date}_{start_time}_{course_name}",
                        "course": course_name,
                        "course_code": c.get("codice_insegnamento", ""),
                        "curricula": split_curricula(c.get("percorso_didattico", "")),
                        "type": c.get("tipo", "Lezione"),
                        "date": day_date,
                        "day_name": c.get("nome_giorno", "").capitalize(),
                        "start_time": start_time,
                        "end_time": c.get("ora_fine", ""),
                        "docente": doc_val,
                        "emails": emails,
                        "primary_email": emails[0] if emails else "",
                        "aula": clean_html(c.get("aula", "")),
                        "codice_aula": c.get("codice_aula", ""),
                        "codice_sede": c.get("codice_sede", ""),
                        "notes": notes,
                        "is_canceled": c.get("Annullato") == "1"
                    })

                first_label = raw_data.get("first_day_label") or monday_str
                last_label = raw_data.get("last_day_label") or ""
                week_label = f"{first_label} - {last_label}".strip(" -")

                payload = {
                    "anno": anno,
                    "docente": docente,
                    "docente_name": teacher_name_found,
                    "monday_date": monday_str,
                    "week_label": week_label,
                    "giorni": giorni,
                    "all_events": all_events_flag,
                    "total_events": len(events),
                    "events": events
                }

                _cache[cache_key] = (time.time(), payload)
                return self.send_json(200, payload, cache_control=True)

            # 3. Case B: Fetch List of all Teachers for the Academic Year
            teachers = get_teachers_list(anno)

            if search_query:
                filtered = []
                for t in teachers:
                    if search_query in t["name"].lower():
                        filtered.append(t)
                        continue
                    # Check in courses
                    if any(search_query in c["name"].lower() or search_query in c["code"].lower() for c in t.get("courses", [])):
                        filtered.append(t)
                teachers = filtered

            payload = {
                "anno": anno,
                "total": len(teachers),
                "teachers": teachers
            }
            return self.send_json(200, payload, cache_control=True)

        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def send_json(self, status, payload, cache_control=False):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        if cache_control:
            self.send_header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
