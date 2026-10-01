from http.server import BaseHTTPRequestHandler
import json
import re
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

GRID_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php'

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
        return json.loads(resp.read().decode('utf-8'))

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        anno = qs.get('anno', [''])[0]
        corso = qs.get('corso', [''])[0]
        anni_studio = [a for a in qs.get('anno2', []) if a]
        date_arg = qs.get('date', [None])[0]

        if not re.fullmatch(r'\d{4}', anno) or not re.fullmatch(r'[A-Za-z0-9_-]+', corso) or not anni_studio:
            return self.send_json(400, {"error": "Specificare anno accademico, corso di studio e anno di studio"})

        if not date_arg:
            date_arg = get_monday().strftime('%d-%m-%Y')
        elif not re.fullmatch(r'\d{2}-\d{2}-\d{4}', date_arg):
            return self.send_json(400, {"error": "Parametro 'date' non valido (atteso gg-mm-aaaa)"})

        try:
            raw_data = fetch_unimib_grid(anno, corso, anni_studio, date_arg)
            if not isinstance(raw_data, dict):
                return self.send_json(502, {"error": "Risposta non valida dal server UNIMIB"})
            celle = sorted(raw_data.get("celle", []), key=_safe_ts)
            giorni = raw_data.get("giorni", [])

            events = []
            for c in celle:
                course_name = c.get("nome_insegnamento", "").strip()
                day_date = c.get("data", "")
                start_time = c.get("ora_inizio", "")

                events.append({
                    "id": c.get("id") or f"{day_date}_{start_time}_{course_name}",
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
                    "is_canceled": c.get("Annullato") == "1"
                })

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
