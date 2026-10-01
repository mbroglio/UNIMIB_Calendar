"""
UNIMIB Calendar – Profile & Share API
======================================
Stores and retrieves user profiles in Upstash Redis.

Authentication & Privacy Model:
- Personal Login (private): Soprannome + PIN (4-8 digits)
  Stored at key "account:<clean_nickname>" with salted SHA-256 PIN hash.
  Never shared with friends.
- Calendar Sharing (public): Read-only unique Calendar Code (e.g. "K9X2P4")
  Stored at key "share:<share_code>".
  Friends use this code or a share link (?friend=K9X2P4) to view the schedule.
  Cannot be used to modify or access the account.

Endpoints:
- POST /api/profile                     – create account {nickname, pin, config, exam_courses}
- PUT  /api/profile                     – login or update {nickname, pin, config, exam_courses}
- GET  /api/profile?code=<SHARE_CODE>   – resolve public friend calendar by share code
- GET  /api/profile?id=<ID>             – resolve by ID or share code (backward compatible)
"""

import os
import json
import re
import hashlib
import secrets
import time
from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse

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

# Unambiguous characters for share codes (no 0/O, 1/I)
SHARE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SHARE_CODE_LEN = 6


# ── Redis helpers ──────────────────────────────────────────────────────────────

def _redis(method: str, *args):
    url, token = _get_redis_creds()
    if not url or not token:
        raise RuntimeError(f"Upstash Redis env vars not configured: URL={'OK' if url else 'MISSING'}, TOKEN={'OK' if token else 'MISSING'}")

    path = "/" + "/".join(urllib.parse.quote(str(a), safe="") for a in (method, *args))
    req  = urllib.request.Request(url + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    if "error" in body:
        raise RuntimeError(f"Redis error: {body['error']}")
    return body.get("result")


def redis_get(key: str):
    raw = _redis("GET", key)
    return json.loads(raw) if raw else None


def redis_set(key: str, value, ex: int | None = None):
    val_str = json.dumps(value, ensure_ascii=False)
    if ex:
        _redis("SET", key, val_str, "EX", ex)
    else:
        _redis("SET", key, val_str)


def redis_del(key: str):
    _redis("DEL", key)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _clean_nickname(n: str) -> str:
    return re.sub(r'[^A-Za-z0-9_-]', '', n.strip()).lower()


def _gen_share_code() -> str:
    return "".join(secrets.choice(SHARE_CHARS) for _ in range(SHARE_CODE_LEN))


def _hash_pin(pin: str, clean_nick: str) -> str:
    raw = f"{pin}:{clean_nick}".encode()
    return hashlib.sha256(raw).hexdigest()


def _verify_pin(pin: str, clean_nick: str, stored_hash: str) -> bool:
    return _hash_pin(pin, clean_nick) == stored_hash


def _valid_nickname(n) -> bool:
    return isinstance(n, str) and 1 <= len(n.strip()) <= 30


def _valid_pin(p) -> bool:
    return isinstance(p, str) and p.isdigit() and 4 <= len(p) <= 8


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

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def _qs(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return dict(urllib.parse.parse_qsl(parsed.query))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        qs = self._qs()
        try:
            # ── 1. Fetch friend by share code (?code=K9X2P4) ───────────────────
            code = qs.get("code", "").strip().upper()
            if code:
                share = redis_get(f"share:{code.lower()}")
                if not share:
                    return self._send_json(404, {"error": "Codice calendario non trovato"})
                return self._send_json(200, {
                    "id":         share.get("share_code", code),
                    "share_code": share.get("share_code", code),
                    "nickname":   share.get("nickname", "Amico"),
                    "config":     share.get("config")
                })

            # ── 2. Fetch by ID (backward compatibility) ────────────────────────
            pid = qs.get("id", "").strip()
            if pid:
                # Check share code first
                share = redis_get(f"share:{pid.lower()}")
                if share:
                    return self._send_json(200, {
                        "id":         share.get("share_code", pid),
                        "share_code": share.get("share_code", pid),
                        "nickname":   share.get("nickname", "Amico"),
                        "config":     share.get("config")
                    })
                # Check account
                acc = redis_get(f"account:{pid.lower()}")
                if acc:
                    return self._send_json(200, {
                        "id":           acc.get("share_code", pid),
                        "share_code":   acc.get("share_code", pid),
                        "nickname":     acc.get("nickname", pid),
                        "config":       acc.get("config"),
                        "exam_courses": acc.get("exam_courses", [])
                    })
                # Legacy profile:<id>
                legacy = redis_get(f"profile:{pid}")
                if legacy:
                    legacy.pop("pin_hash", None)
                    return self._send_json(200, legacy)

                return self._send_json(404, {"error": "Calendario non trovato"})

            return self._send_json(400, {"error": "Specificare il parametro 'code' o 'id'"})

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_POST(self):
        """Create a new account (Soprannome + PIN). Generates a public share_code."""
        try:
            body        = self._read_body()
            nickname    = str(body.get("nickname", "")).strip()
            pin         = str(body.get("pin", "")).strip()
            config      = body.get("config")
            exam_courses = body.get("exam_courses", [])

            if not _valid_nickname(nickname):
                return self._send_json(400, {"error": "Soprannome non valido (1-30 caratteri)"})
            if not _valid_pin(pin):
                return self._send_json(400, {"error": "Il PIN deve essere di 4-8 cifre numeriche"})

            clean_nick = _clean_nickname(nickname)
            if not clean_nick:
                return self._send_json(400, {"error": "Il soprannome deve contenere caratteri alfanumerici"})

            # Check if this account already exists
            existing = redis_get(f"account:{clean_nick}")
            if existing:
                return self._send_json(409, {
                    "error": f"Il soprannome '{nickname}' è già registrato. Vai su 'Accedi' per entrare col tuo PIN, oppure scegli un altro soprannome."
                })

            # Generate unique 6-character public share code
            share_code = None
            for _ in range(10):
                candidate = _gen_share_code()
                if not redis_get(f"share:{candidate.lower()}"):
                    share_code = candidate
                    break

            if not share_code:
                share_code = _gen_share_code()

            account = {
                "nickname":     nickname,
                "clean_nick":   clean_nick,
                "pin_hash":     _hash_pin(pin, clean_nick),
                "share_code":   share_code,
                "config":       config,
                "exam_courses": exam_courses,
                "updated_at":   int(time.time())
            }
            redis_set(f"account:{clean_nick}", account)

            # Public share entry (read-only for friends, no pin_hash)
            share_entry = {
                "clean_nick": clean_nick,
                "nickname":   nickname,
                "share_code": share_code,
                "config":     config,
                "updated_at": int(time.time())
            }
            redis_set(f"share:{share_code.lower()}", share_entry)

            return self._send_json(201, {
                "nickname":     nickname,
                "share_code":   share_code,
                "config":       config,
                "exam_courses": exam_courses
            })

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_PUT(self):
        """
        Login or Update account.
        Requires { nickname, pin } in body.
        Verifies PIN, updates config if provided, returns public share_code.
        """
        try:
            body     = self._read_body()
            qs       = self._qs()
            nickname = str(body.get("nickname") or qs.get("nick") or qs.get("id", "")).strip()
            pin      = str(body.get("pin", "")).strip()

            if not nickname:
                return self._send_json(400, {"error": "Inserisci il soprannome"})
            if not pin:
                return self._send_json(400, {"error": "Inserisci il PIN"})

            clean_nick = _clean_nickname(nickname)
            account = redis_get(f"account:{clean_nick}")

            # Backward-compatibility fallback: check if key is in legacy format
            if not account:
                legacy = redis_get(f"profile:{clean_nick}") or redis_get(f"profile:{clean_nick}{pin}")
                if legacy and _verify_pin(pin, legacy.get("id", clean_nick), legacy.get("pin_hash", "")):
                    # Migrate to account:
                    share_code = _gen_share_code()
                    account = {
                        "nickname":     legacy.get("nickname", nickname),
                        "clean_nick":   clean_nick,
                        "pin_hash":     _hash_pin(pin, clean_nick),
                        "share_code":   share_code,
                        "config":       legacy.get("config"),
                        "exam_courses": legacy.get("exam_courses", []),
                        "updated_at":   int(time.time())
                    }
                    redis_set(f"account:{clean_nick}", account)
                    redis_set(f"share:{share_code.lower()}", {
                        "clean_nick": clean_nick,
                        "nickname":   account["nickname"],
                        "share_code": share_code,
                        "config":     account["config"]
                    })

            if not account:
                return self._send_json(404, {"error": f"Nessun account trovato per '{nickname}'. Verifica il soprannome o crea un nuovo profilo."})

            if not _verify_pin(pin, clean_nick, account.get("pin_hash", "")):
                return self._send_json(403, {"error": "PIN non corretto"})

            share_code = account.get("share_code")
            if not share_code:
                share_code = _gen_share_code()
                account["share_code"] = share_code

            # Update data if sent
            if "config" in body and body["config"] is not None:
                account["config"] = body["config"]
            if "exam_courses" in body and body["exam_courses"] is not None:
                account["exam_courses"] = body["exam_courses"]

            account["updated_at"] = int(time.time())
            redis_set(f"account:{clean_nick}", account)

            # Keep public share entry in sync with updated schedule
            redis_set(f"share:{share_code.lower()}", {
                "clean_nick": clean_nick,
                "nickname":   account["nickname"],
                "share_code": share_code,
                "config":     account.get("config"),
                "updated_at": int(time.time())
            })

            return self._send_json(200, {
                "nickname":     account["nickname"],
                "share_code":   share_code,
                "config":       account.get("config"),
                "exam_courses": account.get("exam_courses", [])
            })

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def log_message(self, *args):
        pass
