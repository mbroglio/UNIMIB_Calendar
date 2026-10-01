from http.server import BaseHTTPRequestHandler
import json
import re
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

BOOKINGS_CALL_URL = 'https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/bookings_call.php'
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
CACHE_TTL = 600  # 10 minutes

_cache = {}

DAYS_IT = {
    0: 'Lunedì',
    1: 'Martedì',
    2: 'Mercoledì',
    3: 'Giovedì',
    4: 'Venerdì',
    5: 'Sabato',
    6: 'Domenica'
}

MONTHS_IT = {
    1: 'Gennaio', 2: 'Febbraio', 3: 'Marzo', 4: 'Aprile',
    5: 'Maggio', 6: 'Giugno', 7: 'Luglio', 8: 'Agosto',
    9: 'Settembre', 10: 'Ottobre', 11: 'Novembre', 12: 'Dicembre'
}

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

def fetch_json(url, timeout=15):
    cached = _cache.get(url)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode('utf-8', errors='replace')
    data = json.loads(text)
    _cache[url] = (time.time(), data)
    return data

def parse_exam_event(ev):
    desc = ev.get('description', '')
    name = ev.get('name', '').strip()
    
    parts = re.split(r'\s*//\s*|/(?=[^/\[]*\[[A-Za-z0-9_-]+\])', desc) if desc else ['']
    courses = []
    yr_fallback_m = re.search(r'(\d+)\s*anno', desc or '', re.IGNORECASE)
    yr_fallback = yr_fallback_m.group(1) if yr_fallback_m else ''

    for p in parts:
        code_m = re.search(r'\[([A-Za-z0-9_-]+)\]', p)
        yr_m = re.search(r'(\d+)\s*anno', p, re.IGNORECASE)
        title_m = re.search(r'(?:Nome corso di laurea:\s*|Corso di laurea:\s*)([^\[]+)', p)
        curr_m = re.search(r'(?:Curriculum|,)\s*([^/\-]+)$', p.strip(), re.IGNORECASE)
        
        c_code = code_m.group(1).upper() if code_m else ''
        c_year = yr_m.group(1) if yr_m else (yr_fallback if len(parts) == 1 else '')
        c_title = title_m.group(1).strip() if title_m else ''
        c_curr = curr_m.group(1).strip() if curr_m else ''
        if c_code or c_title:
            courses.append({
                'code': c_code,
                'year': c_year,
                'title': c_title,
                'curriculum': c_curr
            })
        elif yr_m and courses and not courses[-1]['year']:
            courses[-1]['year'] = yr_m.group(1)
            
    appello_m = re.search(r'Numero appello:\s*(\d+)', desc)
    appello_num = appello_m.group(1) if appello_m else ''

    docenti = []
    for u in ev.get('Utenti', []):
        cognome = u.get('Cognome', '').strip()
        nome = u.get('Nome', '').strip()
        full = f"{cognome} {nome}".strip()
        if full and full not in docenti:
            docenti.append(full)
    if not docenti and ev.get('utenti'):
        docenti = [ev.get('utenti').strip()]
    if not docenti and ev.get('Prenotante'):
        docenti = [ev.get('Prenotante').strip()]

    raw_date = ev.get('Giorno', '')
    day_name = ''
    date_formatted = ''
    date_long = ''
    if raw_date and re.fullmatch(r'\d{4}-\d{2}-\d{2}', raw_date):
        try:
            dt = datetime.strptime(raw_date, '%Y-%m-%d')
            day_name = DAYS_IT.get(dt.weekday(), '')
            date_formatted = dt.strftime('%d/%m/%Y')
            m_name = MONTHS_IT.get(dt.month, '')
            date_long = f"{day_name} {dt.day} {m_name} {dt.year}".strip()
        except ValueError:
            pass

    return {
        'id': ev.get('id'),
        'name': name,
        'description': desc,
        'courses': courses,
        'appello': appello_num,
        'date': raw_date,
        'date_formatted': date_formatted,
        'date_long': date_long,
        'day_name': day_name,
        'from': ev.get('from', '')[:5],
        'to': ev.get('to', '')[:5],
        'time_label': f"{ev.get('from', '')[:5]} - {ev.get('to', '')[:5]}",
        'aula': ev.get('NomeAula', '').strip(),
        'sede': ev.get('NomeSede', '').strip(),
        'docenti': docenti,
        'is_canceled': ev.get('Annullato') == '1'
    }

def get_exams(corsi=None, datefrom=None, dateto=None, anni=None, search=None):
    now_it = get_italy_now()
    if not datefrom:
        datefrom = now_it.strftime('%d-%m-%Y')
    if not dateto:
        # Default to 90 days ahead
        future_dt = now_it + timedelta(days=90)
        dateto = future_dt.strftime('%d-%m-%Y')

    params = [
        ('tipo', '2'),
        ('datefrom', datefrom),
        ('dateto', dateto)
    ]
    query_url = f"{BOOKINGS_CALL_URL}?{urllib.parse.urlencode(params)}"
    raw = fetch_json(query_url)
    raw_events = raw.get('events', [])

    filter_corsi = [c.strip().upper() for c in (corsi or []) if c.strip()]
    filter_anni = [str(a).strip() for a in (anni or []) if str(a).strip()]
    filter_search = search.strip().lower() if search else ''

    results = []
    for ev in raw_events:
        if ev.get('Annullato') == '1':
            continue

        item = parse_exam_event(ev)

        # Course filtering: if courses specified, at least one course code must match
        if filter_corsi:
            matched_code = False
            for c in item['courses']:
                if c['code'] in filter_corsi:
                    matched_code = True
                    break
            # Also check if course code is mentioned in description or name
            if not matched_code:
                desc_upper = item['description'].upper()
                name_upper = item['name'].upper()
                if any(fc in desc_upper or fc in name_upper for fc in filter_corsi):
                    matched_code = True

            if not matched_code:
                continue

        # Year filtering: if years specified, check year
        if filter_anni and item['courses']:
            matched_year = False
            for c in item['courses']:
                if not c['year'] or c['year'] in filter_anni:
                    matched_year = True
                    break
            if not matched_year:
                continue

        # Search query filtering
        if filter_search:
            content_to_search = f"{item['name']} {item['description']} {' '.join(item['docenti'])} {item['aula']} {item['sede']}".lower()
            if filter_search not in content_to_search:
                continue

        results.append(item)

    # Sort results chronologically: date, then from time
    results.sort(key=lambda x: (x['date'], x['from'], x['name']))

    return {
        'datefrom': datefrom,
        'dateto': dateto,
        'filter_corsi': filter_corsi,
        'total_exams': len(results),
        'exams': results
    }

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        corsi_arg = qs.get('corsi', [''])[0] or qs.get('corso', [''])[0] or qs.get('course', [''])[0]
        datefrom_arg = qs.get('datefrom', [''])[0]
        dateto_arg = qs.get('dateto', [''])[0]
        anni_arg = qs.get('anni', [''])[0] or qs.get('anno', [''])[0] or qs.get('year', [''])[0]
        search_arg = qs.get('q', [''])[0] or qs.get('search', [''])[0]

        try:
            corsi = [c.strip() for c in corsi_arg.split(',') if c.strip()] if corsi_arg else []
            anni = [a.strip() for a in anni_arg.split(',') if a.strip()] if anni_arg else []

            if datefrom_arg and re.fullmatch(r'\d{4}-\d{2}-\d{2}', datefrom_arg):
                y, m, d = datefrom_arg.split('-')
                datefrom_arg = f"{d}-{m}-{y}"
            elif datefrom_arg and not re.fullmatch(r'\d{2}-\d{2}-\d{4}', datefrom_arg):
                return self.send_json(400, {"error": "Parametro 'datefrom' non valido (atteso GG-MM-AAAA)"})

            if dateto_arg and re.fullmatch(r'\d{4}-\d{2}-\d{2}', dateto_arg):
                y, m, d = dateto_arg.split('-')
                dateto_arg = f"{d}-{m}-{y}"
            elif dateto_arg and not re.fullmatch(r'\d{2}-\d{2}-\d{4}', dateto_arg):
                return self.send_json(400, {"error": "Parametro 'dateto' non valido (atteso GG-MM-AAAA)"})

            payload = get_exams(
                corsi=corsi,
                datefrom=datefrom_arg,
                dateto=dateto_arg,
                anni=anni,
                search=search_arg
            )
            self.send_json(200, payload, cache=True)
        except Exception as e:
            self.send_json(502, {"error": str(e)})

    def send_json(self, status, payload, cache=False):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        if cache:
            self.send_header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
        else:
            self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
