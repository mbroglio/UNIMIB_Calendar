import sys
import os
import json
import re
import urllib.parse
from datetime import datetime, timedelta

_parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _parent_dir not in sys.path:
    sys.path.insert(0, _parent_dir)

from api._common import (
    BaseApiHandler,
    BoundedTTLCache,
    get_rome_now,
    get_monday,
    parse_date_to_monday,
    safe_ts,
    clean_html,
    split_curricula,
    fetch_upstream,
    UpstreamError,
)

COMBO_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/combo.php'
GRID_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php'

CACHE_TEACHERS_TTL = 3600  # 1 hour
CACHE_GRID_TTL = 300       # 5 minutes

_cache = BoundedTTLCache(maxsize=150, ttl_seconds=CACHE_GRID_TTL)
get_italy_now = get_rome_now
_safe_ts = safe_ts


def extract_emails(mail_str, link_str=''):
    combined = f"{mail_str or ''} {link_str or ''}"
    tokens = re.split(r'[^a-zA-Z0-9_.+@-]+', combined)
    emails = [
        tok for tok in tokens
        if tok.count("@") == 1 and tok.split("@")[0] and "." in tok.split("@")[1]
    ]
    seen = set()
    result = []
    for e in emails:
        low = e.lower().strip(".")
        if low and low not in seen:
            seen.add(low)
            result.append(low)
    return result


def js_var(script, name):
    m = re.search(r'var\s+' + re.escape(name) + r'\s*=\s*', script)
    if not m:
        return None
    try:
        return json.JSONDecoder().raw_decode(script, m.end())[0]
    except ValueError:
        return None


def fetch_text(url, timeout=15):
    return fetch_upstream(url, timeout=timeout)


def get_academic_years():
    url = f"{COMBO_URL}?sw=ec_&aa=1"
    cached = _cache.get(url)
    if cached is not None:
        text = cached
    else:
        text = fetch_text(url)
        _cache.set(url, text)

    data = js_var(text, 'anni_accademici_ec') or {}
    items = data.values() if isinstance(data, dict) else data
    years = [{"value": y["valore"], "label": y["label"]} for y in items if "valore" in y]
    years.sort(key=lambda y: y["value"], reverse=True)
    return years


def get_teachers_list(anno):
    url = f"{COMBO_URL}?sw=ec_&aa={anno}&page=docenti"
    cached = _cache.get(url)
    if cached is not None:
        text = cached
    else:
        text = fetch_text(url)
        _cache.set(url, text)

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


class handler(BaseApiHandler):
    def do_OPTIONS(self):
        self.handle_options(methods="GET, OPTIONS", headers="Content-Type")

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
                    now = get_rome_now()
                    anno = str(now.year)
            elif not re.fullmatch(r'\d{4}', anno):
                return self.send_json(400, {"error": "Parametro 'anno' non valido (atteso formato AAAA)"}, cache_control='no-store')

            # 2. Case A: Fetch single Teacher's Calendar / Timetable
            if docente:
                if not re.fullmatch(r'[A-Za-z0-9_-]+', docente):
                    return self.send_json(400, {"error": "Parametro 'docente' non valido"}, cache_control='no-store')
                if corso and not re.fullmatch(r'[A-Za-z0-9_-]+', corso):
                    return self.send_json(400, {"error": "Parametro 'corso' non valido"}, cache_control='no-store')

                try:
                    monday_dt = parse_date_to_monday(date_arg)
                    monday_str = monday_dt.strftime('%d-%m-%Y')
                except ValueError as ve:
                    return self.send_json(400, {"error": str(ve)}, cache_control='no-store')

                cache_key = f"teacher_grid:{anno}:{docente}:{corso}:{monday_str}:{all_events_flag}"
                cached = _cache.get(cache_key)
                if not force_refresh and cached is not None:
                    return self.send_json(200, cached, cache_control='public, s-maxage=300, stale-while-revalidate=3600')

                raw_data = fetch_teacher_grid(anno, docente, monday_str, corso=corso, all_events=all_events_flag)
                if not isinstance(raw_data, dict):
                    return self.send_json(502, {"error": "Risposta non valida dal server UNIMIB"}, cache_control='no-store')

                celle = sorted(raw_data.get("celle", []), key=safe_ts)
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

                _cache.set(cache_key, payload)
                return self.send_json(200, payload, cache_control='public, s-maxage=300, stale-while-revalidate=3600')

            # 3. Case B: Fetch List of all Teachers for the Academic Year
            teachers = get_teachers_list(anno)

            if search_query:
                filtered = []
                for t in teachers:
                    if search_query in t["name"].lower():
                        filtered.append(t)
                        continue
                    if any(search_query in c["name"].lower() or search_query in c["code"].lower() for c in t.get("courses", [])):
                        filtered.append(t)
                teachers = filtered

            payload = {
                "anno": anno,
                "total": len(teachers),
                "teachers": teachers
            }
            return self.send_json(200, payload, cache_control='public, s-maxage=300, stale-while-revalidate=3600')

        except Exception as e:
            self.send_json(502, {"error": str(e)}, cache_control='no-store')
