from http.server import BaseHTTPRequestHandler
import json
import re
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

ROOMS_CALL_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/rooms_call.php'
COMBO_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/combo.php'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
CACHE_TTL = 300  # 5 minutes

_cache = {}

def get_italy_now():
    # Italy timezone: UTC+2 in Daylight Saving, UTC+1 in Standard
    # Compute rough timezone or UTC+2 for October
    # Use timezone with offset based on current time
    tz_it = timezone(timedelta(hours=2))
    return datetime.now(tz_it)

def fetch_json(url, timeout=12):
    cached = _cache.get(url)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode('utf-8', errors='replace')
    data = json.loads(text)
    _cache[url] = (time.time(), data)
    return data

def get_buildings():
    url = f"{COMBO_URL}?sw=rooms_"
    cached = _cache.get(url)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=12) as resp:
        text = resp.read().decode('utf-8', errors='replace')
    m = re.search(r'var\s+elenco_sedi\s*=\s*', text)
    if not m:
        return []
    sedi = json.JSONDecoder().raw_decode(text, m.end())[0]
    result = []
    for s in sedi:
        val = s.get("valore")
        label = s.get("label")
        if val and label and val != "SPAZI_MANCANTI":
            result.append({"value": val, "label": label})
    # Sort with common Bicocca buildings (U1, U2, ...) nicely
    def sort_key(item):
        v = item["value"]
        if v.startswith("U") and v[1:3].isdigit():
            return (0, int(v[1:3]), item["label"])
        return (1, 0, item["label"])
    result.sort(key=sort_key)
    _cache[url] = (time.time(), result)
    return result

def parse_time_str(t_str):
    # parses "08:30:00" or "08:30" to minutes from midnight
    if not t_str:
        return 0
    parts = t_str.split(':')
    h = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
    m = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return h * 60 + m

def format_minutes(mins):
    h = mins // 60
    m = mins % 60
    return f"{h:02d}:{m:02d}"

def get_room_occupancy(sede, date_str, time_str=None):
    now_it = get_italy_now()
    today_str = now_it.strftime('%d-%m-%Y')
    is_today = (date_str == today_str)

    if time_str:
        check_mins = parse_time_str(time_str)
    elif is_today:
        check_mins = now_it.hour * 60 + now_it.minute
    else:
        check_mins = None

    params = [
        ('form-type', 'rooms'),
        ('sede[]', sede),
        ('date', date_str),
        ('_lang', 'it')
    ]
    query_url = f"{ROOMS_CALL_URL}?{urllib.parse.urlencode(params)}"
    raw = fetch_json(query_url)

    all_rooms_dict = raw.get("all_rooms", {})
    if isinstance(all_rooms_dict, list):
        all_rooms_dict = {str(r.get("room_code", r.get("id"))): r for r in all_rooms_dict}

    raw_events = raw.get("events", [])

    # Group events by room code
    room_events_map = {}
    for ev in raw_events:
        if ev.get("Annullato") == "1":
            continue
        code = ev.get("CodiceAula") or ev.get("NomeAula")
        if not code:
            continue
        
        docenti = []
        for u in ev.get("Utenti", []):
            cognome = u.get("Cognome", "").strip()
            nome = u.get("Nome", "").strip()
            full = f"{cognome} {nome}".strip()
            if full:
                docenti.append(full)
        if not docenti and ev.get("utenti"):
            docenti = [ev.get("utenti").strip()]
        if not docenti and ev.get("Prenotante"):
            docenti = [ev.get("Prenotante").strip()]

        from_raw = ev.get("from", "")[:5]
        to_raw = ev.get("to", "")[:5]
        from_mins = parse_time_str(from_raw)
        to_mins = parse_time_str(to_raw)

        event_item = {
            "id": ev.get("id"),
            "name": ev.get("name", "").strip(),
            "type": ev.get("type") or ev.get("tipo") or "Evento",
            "from": from_raw,
            "to": to_raw,
            "from_mins": from_mins,
            "to_mins": to_mins,
            "docenti": docenti,
            "description": ev.get("description", "").strip(),
            "notes": ev.get("PublicNotes", "").strip() or ev.get("Note", "").strip()
        }
        room_events_map.setdefault(code, []).append(event_item)

    # Sort events by start time for each room
    for code in room_events_map:
        room_events_map[code].sort(key=lambda x: x["from_mins"])

    # Prepare room list
    rooms_output = []
    # If all_rooms_dict is empty, collect unique rooms from raw_events or raw['rooms']
    if not all_rooms_dict:
        rooms_meta = raw.get("rooms", {})
        for r_code, r_val in rooms_meta.items():
            all_rooms_dict[r_code] = {
                "room_code": r_code,
                "room_name": r_val.get("nome", r_code),
                "capacity": r_val.get("capacity", 0)
            }

    for code, meta in all_rooms_dict.items():
        evs = room_events_map.get(code, [])
        r_name = meta.get("room_name") or meta.get("NomeAula") or code
        capacity = meta.get("capacity") or 0
        try:
            capacity = int(capacity)
        except (ValueError, TypeError):
            capacity = 0

        # Determine if room is free
        is_free = True
        current_event = None
        next_event = None
        free_until = None

        if check_mins is not None:
            for ev in evs:
                if ev["from_mins"] <= check_mins < ev["to_mins"]:
                    is_free = False
                    current_event = ev
                    break
                elif ev["from_mins"] > check_mins and next_event is None:
                    next_event = ev

            if is_free:
                if next_event:
                    free_until = next_event["from"]
                else:
                    free_until = "fine giornata"
        else:
            # If no time comparison, indicate whether room has ANY events today
            is_free = (len(evs) == 0)

        rooms_output.append({
            "code": code,
            "name": r_name,
            "capacity": capacity,
            "is_free": is_free,
            "current_event": current_event,
            "next_event": next_event,
            "free_until": free_until,
            "events_count": len(evs),
            "events": evs
        })

    # Sort rooms: free rooms first, then by name
    rooms_output.sort(key=lambda r: (not r["is_free"], r["name"]))

    return {
        "sede": sede,
        "date": date_str,
        "is_today": is_today,
        "check_time": format_minutes(check_mins) if check_mins is not None else None,
        "total_rooms": len(rooms_output),
        "free_rooms": sum(1 for r in rooms_output if r["is_free"]),
        "occupied_rooms": sum(1 for r in rooms_output if not r["is_free"]),
        "rooms": rooms_output
    }

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        sede = qs.get('sede', [''])[0]
        date_arg = qs.get('date', [''])[0]
        time_arg = qs.get('time', [''])[0]

        try:
            if not sede:
                buildings = get_buildings()
                return self.send_json(200, {"buildings": buildings}, cache=True)

            if not re.fullmatch(r'[A-Za-z0-9_.\-]+', sede):
                return self.send_json(400, {"error": "Parametro 'sede' non valido"})

            if not date_arg:
                now_it = get_italy_now()
                date_arg = now_it.strftime('%d-%m-%Y')
            elif not re.fullmatch(r'\d{2}-\d{2}-\d{4}', date_arg):
                return self.send_json(400, {"error": "Parametro 'date' non valido (atteso GG-MM-AAAA)"})

            if time_arg and not re.fullmatch(r'\d{1,2}:\d{2}', time_arg):
                return self.send_json(400, {"error": "Parametro 'time' non valido (atteso HH:MM)"})

            payload = get_room_occupancy(sede, date_arg, time_arg)
            self.send_json(200, payload, cache=False)
        except Exception as e:
            self.send_json(502, {"error": str(e)})

    def send_json(self, status, payload, cache=False):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        if cache:
            self.send_header('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
        else:
            self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
