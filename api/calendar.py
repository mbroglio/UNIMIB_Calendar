from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse
from datetime import datetime, timedelta

TARGET_COURSES = [
    {
        "id": "architettura_software",
        "name": "Architettura del Software",
        "keywords": ["architettura del software"],
        "color": "#8B5CF6",
        "badge": "📐 Arch. Software"
    },
    {
        "id": "reverse_engineering",
        "name": "Evolution of Software Systems and Reverse Engineering",
        "keywords": ["evolution of software", "reverse engineering"],
        "color": "#10B981",
        "badge": "🔄 Evolution & Rev. Eng."
    },
    {
        "id": "large_scale_data",
        "name": "Large Scale Data Management",
        "keywords": ["large scale data management", "large-scale data management"],
        "color": "#06B6D4",
        "badge": "📊 Large Scale Data"
    }
]

def get_monday(dt=None):
    if dt is None:
        dt = datetime.now()
    return dt - timedelta(days=dt.weekday())

def fetch_unimib_grid(date_str):
    url = f'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/grid_call.php?view=easycourse&form-type=corso&include=corso&txtcurr=2+-+PERCORSO+COMUNE&anno=2026&scuola=AreaScientifica-Informatica&corso=F1802Q&anno2%5B%5D=GGG%7C2&date={date_str}&_lang=it'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        date_arg = qs.get('date', [None])[0]
        
        if not date_arg:
            date_arg = get_monday().strftime('%d-%m-%Y')
            
        try:
            raw_data = fetch_unimib_grid(date_arg)
            celle = raw_data.get("celle", [])
            giorni = raw_data.get("giorni", [])
            
            events = []
            for c in celle:
                course_name = c.get("nome_insegnamento", "").strip()
                day_date = c.get("data", "")
                day_name = c.get("nome_giorno", "").capitalize()
                start_time = c.get("ora_inizio", "")
                end_time = c.get("ora_fine", "")
                docente = c.get("docente", "").strip()
                aula = c.get("aula", "").strip()
                is_canceled = c.get("Annullato") == "1"
                
                target_info = None
                course_lower = course_name.lower()
                for tc in TARGET_COURSES:
                    if any(kw in course_lower for kw in tc["keywords"]):
                        target_info = tc
                        break

                events.append({
                    "id": c.get("id") or f"{day_date}_{start_time}_{course_name}",
                    "course": course_name,
                    "date": day_date,
                    "day_name": day_name,
                    "start_time": start_time,
                    "end_time": end_time,
                    "docente": docente,
                    "aula": aula,
                    "is_canceled": is_canceled,
                    "is_target": target_info is not None,
                    "target_config": target_info
                })

            payload = {
                "monday_date": date_arg,
                "week_label": f"{raw_data.get('first_day_label', date_arg)} - {raw_data.get('last_day_label', '')}",
                "giorni": giorni,
                "total_events": len(events),
                "target_events_count": sum(1 for e in events if e["is_target"]),
                "events": events
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
