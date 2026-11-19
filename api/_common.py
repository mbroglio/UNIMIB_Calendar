"""
UNIMIB Calendar – Common Serverless Utilities & Base Handler
============================================================
Shared foundational utilities across all Vercel Python serverless endpoints:
- Timezone handling: Europe/Rome timezone resolution & Monday date calculations
- Bounded LRU/FIFO in-memory cache with strict max capacity
- Resilient HTTP requests with exponential backoff & jitter
- Unified BaseApiHandler with secure headers, payload limits, and JSON responses
- Standardized Redis driver with local /tmp fallback for tests
- Text sanitization, HTML stripping, and curricula parsers
"""

import os
import html
import json
import re
import time
import secrets
import tempfile
import threading
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timezone, timedelta
from collections import OrderedDict
from typing import Optional, Dict, Any, Tuple, List

# ── Timezone & Date Calculations ──────────────────────────────────────────────
try:
    import zoneinfo
    TZ_ROME = zoneinfo.ZoneInfo("Europe/Rome")
except Exception:
    TZ_ROME = timezone(timedelta(hours=1))

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

def get_rome_now() -> datetime:
    """Return the current localized datetime in Europe/Rome."""
    try:
        return datetime.now(TZ_ROME)
    except Exception:
        return datetime.now(timezone(timedelta(hours=1)))

def get_monday(dt: Optional[datetime] = None) -> datetime:
    """Return the Monday of the given week in Europe/Rome timezone."""
    if dt is None:
        dt = get_rome_now()
    return dt - timedelta(days=dt.weekday())

def parse_date_to_monday(date_str: str) -> datetime:
    """Given DD-MM-YYYY or YYYY-MM-DD, parse and return the Monday of that week."""
    if not date_str:
        return get_monday()
    clean = str(date_str).strip()
    m_it = re.fullmatch(r'(\d{2})-(\d{2})-(\d{4})', clean)
    if m_it:
        d, m, y = map(int, m_it.groups())
        try:
            dt = datetime(y, m, d)
        except ValueError:
            raise ValueError("Data non valida (giorno o mese non esistente)")
        return dt - timedelta(days=dt.weekday())
    m_iso = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', clean)
    if m_iso:
        y, m, d = map(int, m_iso.groups())
        try:
            dt = datetime(y, m, d)
        except ValueError:
            raise ValueError("Data non valida (giorno o mese non esistente)")
        return dt - timedelta(days=dt.weekday())
    raise ValueError("Parametro 'date' non valido (atteso GG-MM-AAAA o AAAA-MM-GG)")


# ── Bounded In-Memory Cache (Strict Capacity LRU/FIFO) ────────────────────────
class BoundedTTLCache:
    """Thread-safe bounded in-memory cache with eviction on maxsize or expiration."""
    def __init__(self, maxsize: int = 150, ttl_seconds: int = 300):
        self.maxsize = maxsize
        self.ttl = ttl_seconds
        self._data: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any, default: Any = None) -> Optional[Any]:
        with self._lock:
            if key not in self._data:
                return default
            ts, val = self._data[key]
            if time.time() - ts >= self.ttl:
                del self._data[key]
                return default
            self._data.move_to_end(key)
            return val

    def setdefault(self, key: Any, default: Any = None) -> Any:
        val = self.get(key)
        if val is not None:
            return val
        self.set(key, default)
        return default

    def set(self, key: Any, val: Any) -> None:
        with self._lock:
            now = time.time()
            if key in self._data:
                self._data.move_to_end(key)
            elif len(self._data) >= self.maxsize:
                # Evict expired entries first
                expired_keys = [k for k, (ts, _) in self._data.items() if now - ts >= self.ttl]
                if expired_keys:
                    for k in expired_keys:
                        del self._data[k]
                # If still at maxsize, pop least recently used (first item)
                if len(self._data) >= self.maxsize:
                    self._data.popitem(last=False)
            self._data[key] = (now, val)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def pop(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            item = self._data.pop(key, None)
            if item is None:
                return default
            ts, val = item
            if time.time() - ts >= self.ttl:
                return default
            return val

    def keys(self) -> list:
        with self._lock:
            now = time.time()
            return [k for k, (ts, _) in self._data.items() if now - ts < self.ttl]

    def items(self) -> list:
        with self._lock:
            now = time.time()
            return [(k, val) for k, (ts, val) in self._data.items() if now - ts < self.ttl]

    def __contains__(self, key: Any) -> bool:
        return self.get(key) is not None

    def __getitem__(self, key: Any) -> Any:
        val = self.get(key)
        if val is None:
            raise KeyError(key)
        return val

    def __setitem__(self, key: Any, val: Any) -> None:
        self.set(key, val)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


# ── Resilient Upstream HTTP Requests (Retry & Backoff) ────────────────────────
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

class UpstreamError(Exception):
    """Exception raised when an upstream university service fails."""
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code

def fetch_upstream(url: str, headers: Optional[dict] = None, timeout: int = 10, max_retries: int = 2) -> str:
    """Fetch URL with retries on transient network/5xx failures."""
    req_headers = {'User-Agent': USER_AGENT}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers)

    last_error: Optional[Exception] = None
    for attempt in range(max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='replace')
        except (urllib.error.HTTPError) as e:
            last_error = e
            # Retry only on server errors (500, 502, 503, 504)
            if e.code in (500, 502, 503, 504) and attempt < max_retries:
                time.sleep(0.3 * (2 ** attempt) + (secrets.randbelow(100) / 1000.0))
                continue
            raise UpstreamError(f"Errore server UNIMIB ({e.code}): {e.reason}", status_code=502)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = e
            if attempt < max_retries:
                time.sleep(0.3 * (2 ** attempt) + (secrets.randbelow(100) / 1000.0))
                continue
            raise UpstreamError(f"Impossibile contattare i server UNIMIB: {e}", status_code=502)

    raise UpstreamError(f"Errore connessione UNIMIB: {last_error}", status_code=502)


# ── Upstash Redis Client with Local Fallback ──────────────────────────────────
_LOCAL_STORE_PATH = os.path.join(tempfile.gettempdir(), "unimib_kv_store.json")
_LOCAL_LOCK = threading.Lock()
_LOCAL_MEM_STORE: Dict[str, Any] = {}

def _load_env_files() -> None:
    """Carica variabili d'ambiente da .env o .env.local se presenti nella root."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for fname in ('.env.local', '.env'):
        p = os.path.join(root, fname)
        if os.path.isfile(p):
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith('#') or '=' not in line:
                            continue
                        k, v = line.split('=', 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k and k not in os.environ:
                            os.environ[k] = v
            except Exception:
                pass

_load_env_files()

def get_redis_creds() -> Tuple[str, str]:
    _load_env_files()
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

def _local_kv_load() -> dict:
    if not os.path.exists(_LOCAL_STORE_PATH):
        _LOCAL_MEM_STORE.clear()
    return _LOCAL_MEM_STORE

def _local_kv_save(store: dict) -> None:
    try:
        with open(_LOCAL_STORE_PATH, "w", encoding="utf-8") as f:
            f.write("{}")
    except Exception:
        pass

def _local_redis(method: str, *args) -> Any:
    with _LOCAL_LOCK:
        store = _local_kv_load()
        now = time.time()
        m = method.upper()

        if m == "GET":
            key = str(args[0])
            item = store.get(key)
            if item is None:
                return None
            if isinstance(item, dict) and "v" in item:
                exp = item.get("e")
                if exp and now > exp:
                    store.pop(key, None)
                    _local_kv_save(store)
                    return None
                return item["v"]
            return item

        elif m == "SET":
            key = str(args[0])
            val = str(args[1])
            exp = None
            if len(args) >= 4 and str(args[2]).upper() == "EX":
                try:
                    exp = now + float(args[3])
                except Exception:
                    exp = None
            store[key] = {"v": val, "e": exp}
            _local_kv_save(store)
            return "OK"

        elif m == "DEL":
            key = str(args[0])
            if key in store:
                store.pop(key, None)
                _local_kv_save(store)
                return 1
            return 0

        return None

def redis_cmd(method: str, *args) -> Any:
    url, token = get_redis_creds()
    if not url or not token:
        return _local_redis(method, *args)

    path = "/" + "/".join(urllib.parse.quote(str(a), safe="") for a in (method, *args))
    req = urllib.request.Request(url + path, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
        if "error" in body:
            raise RuntimeError(f"Redis error: {body['error']}")
        return body.get("result")
    except Exception:
        return _local_redis(method, *args)

def redis_get(key: str) -> Any:
    raw = redis_cmd("GET", key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw

def redis_set(key: str, value: Any, ex: Optional[int] = None) -> None:
    val_str = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
    if ex:
        redis_cmd("SET", key, val_str, "EX", ex)
    else:
        redis_cmd("SET", key, val_str)

def redis_del(key: str) -> None:
    redis_cmd("DEL", key)


# ── Text & String Sanitization ────────────────────────────────────────────────
def clean_html(text: Any) -> str:
    """Strip HTML tags and normalize whitespace."""
    if not text:
        return ''
    cleaned = re.sub(r'<[^>]+>', '', str(text))
    return re.sub(r'\s+', ' ', cleaned).strip()

def split_curricula(percorso: Any) -> List[str]:
    """Split curriculum descriptions by <hr> tags and clean HTML."""
    parts = re.split(r'<hr[^>]*>', str(percorso or ''))
    return [clean_html(p) for p in parts if clean_html(p)]

def safe_ts(c: dict) -> int:
    """Extract integer timestamp safely."""
    try:
        return int(c.get("timestamp") or 0)
    except (ValueError, TypeError):
        return 0

def sanitize_text(s: Any, max_len: int = 100) -> str:
    """Strictly sanitize untrusted text against XSS and control characters."""
    if not isinstance(s, str):
        return ""
    clean = re.sub(r'<\s*script[^>]*>.*?<\s*/\s*script\s*>', '', s, flags=re.IGNORECASE | re.DOTALL)
    clean = re.sub(r'<\s*style[^>]*>.*?<\s*/\s*style\s*>', '', clean, flags=re.IGNORECASE | re.DOTALL)
    clean = re.sub(r'<[^>]*>', '', clean)
    for ch in ('<', '>', '"', "'", '`', '\x00'):
        clean = clean.replace(ch, '')
    clean = ''.join(ch for ch in clean if ch.isprintable())
    return clean.strip()[:max_len]


# ── Base HTTP Handler Class ───────────────────────────────────────────────────
class BaseApiHandler(BaseHTTPRequestHandler):
    """Base handler implementing OWASP secure headers, CORS, and response helpers."""

    def send_json(self, status: int, payload: Any, cache_control: Optional[str] = None, allow_origin: Optional[str] = "*"):
        def _escape_obj(val: Any) -> Any:
            if isinstance(val, str):
                return html.escape(val, quote=False)
            if isinstance(val, dict):
                return {str(k): _escape_obj(v) for k, v in val.items()}
            if isinstance(val, list):
                return [_escape_obj(item) for item in val]
            return val

        raw_json = json.dumps(_escape_obj(payload), ensure_ascii=False)
        safe_json = raw_json.replace("<", r"\u003c").replace(">", r"\u003e").replace("&", r"\u0026")
        data = safe_json.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        if allow_origin:
            self.send_header('Access-Control-Allow-Origin', allow_origin)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Permissions-Policy', 'geolocation=(), camera=(), microphone=()')
        self.send_header('Content-Length', str(len(data)))

        if cache_control:
            self.send_header('Cache-Control', cache_control)
        elif status == 200:
            self.send_header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
        else:
            self.send_header('Cache-Control', 'no-store')

        self.end_headers()
        self.wfile.write(data)

    def read_json_body(self, max_bytes: int = 65536) -> dict:
        """Safely read and parse JSON body with strict Content-Length validation."""
        headers = getattr(self, "headers", None) or {}
        length_header = headers.get("Content-Length", "0") if hasattr(headers, "get") else "0"
        try:
            length = int(length_header)
        except ValueError:
            raise ValueError("Valore 'Content-Length' non valido")

        if length < 0:
            raise ValueError("Valore 'Content-Length' non valido")
        if length == 0:
            return {}
        if length > max_bytes:
            raise ValueError(f"Corpo della richiesta troppo grande (massimo {max_bytes // 1024}KB)")

        rfile = getattr(self, "rfile", None)
        if not rfile:
            return {}
        raw = rfile.read(length).decode('utf-8', errors='replace')
        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("Il corpo della richiesta deve essere un oggetto JSON valido")
            return parsed
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON non valido: {e}")

    def parse_query(self) -> Dict[str, List[str]]:
        """Parse query string into standard dict of lists."""
        parsed = urllib.parse.urlparse(self.path)
        return urllib.parse.parse_qs(parsed.query)

    def get_query_param(self, name: str, default: str = "") -> str:
        """Get single query parameter value trimmed."""
        qs = self.parse_query()
        vals = qs.get(name, [])
        return vals[0].strip() if vals else default

    def handle_options(self, methods: str = "GET, OPTIONS", headers: str = "Content-Type", allow_origin: str = "*"):
        """Handle CORS preflight requests."""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", allow_origin)
        self.send_header("Access-Control-Allow-Methods", methods)
        self.send_header("Access-Control-Allow-Headers", headers)
        self.end_headers()

    def log_message(self, format, *args):
        # Silence routine request logging in serverless stdout
        pass
