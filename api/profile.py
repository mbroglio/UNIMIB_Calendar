"""
UNIMIB Calendar – Profile API
==============================
Stores and retrieves user profiles (anonymous) in Upstash Redis.

Profile schema (stored as JSON string at key "profile:<id>"):
{
  "id":           "<8-char alphanumeric>",
  "nickname":     "Mario",           # user-chosen display name
  "pin_hash":     "<sha256 hex>",    # SHA-256 of PIN+id (never plain-text)
  "config":       { ... },           # UNIMIB config object
  "exam_courses": [ ... ],           # extra exam courses
  "updated_at":   1234567890         # unix timestamp
}

Endpoints
---------
GET  /api/profile?id=<ID>                  – fetch profile (public fields: id, nickname, config, exam_courses)
POST /api/profile                           – create new profile   body: {nickname, pin, config, exam_courses}
PUT  /api/profile?id=<ID>                  – update profile       body: {pin, config, exam_courses, [nickname]}
GET  /api/profile?lookup=<NICKNAME>        – find profile IDs by nickname (returns list of {id, nickname})
"""

import os
import json
import hashlib
import secrets
import time
import string
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler

REDIS_URL   = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
REDIS_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")

ID_CHARS   = string.ascii_uppercase + string.digits   # A-Z 0-9
ID_LENGTH  = 8
MAX_LOOKUP = 10  # max results for nickname lookup


# ── Redis helpers ──────────────────────────────────────────────────────────────

def _redis(method: str, *args):
    """
    Execute a single Redis command via the Upstash REST API.
    Returns the 'result' field of the JSON response, or raises RuntimeError.
    """
    if not REDIS_URL or not REDIS_TOKEN:
        raise RuntimeError("Upstash Redis env vars not configured")

    path  = "/" + "/".join(urllib.parse.quote(str(a), safe="") for a in (method, *args))
    url   = REDIS_URL + path
    req   = urllib.request.Request(url, headers={"Authorization": f"Bearer {REDIS_TOKEN}"})
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


# Nickname index: set "nick:<lowercase_nickname>" → {"<id>": 1, ...} (using a JSON object as a poor-man's set)
def _nick_key(nickname: str) -> str:
    return f"nick:{nickname.strip().lower()}"


def _add_to_nick_index(nickname: str, profile_id: str):
    key  = _nick_key(nickname)
    data = redis_get(key) or {}
    data[profile_id] = 1
    redis_set(key, data)


def _remove_from_nick_index(old_nickname: str, profile_id: str):
    key  = _nick_key(old_nickname)
    data = redis_get(key) or {}
    data.pop(profile_id, None)
    if data:
        redis_set(key, data)
    else:
        redis_del(key)


# ── ID / PIN helpers ───────────────────────────────────────────────────────────

def _gen_id() -> str:
    return "".join(secrets.choice(ID_CHARS) for _ in range(ID_LENGTH))


def _hash_pin(pin: str, profile_id: str) -> str:
    """SHA-256 of (pin + ":" + id) – salted with the profile id."""
    raw = f"{pin}:{profile_id}".encode()
    return hashlib.sha256(raw).hexdigest()


def _verify_pin(pin: str, profile_id: str, stored_hash: str) -> bool:
    return _hash_pin(pin, profile_id) == stored_hash


# ── Validation helpers ─────────────────────────────────────────────────────────

def _valid_nickname(n) -> bool:
    return isinstance(n, str) and 1 <= len(n.strip()) <= 30


def _valid_pin(p) -> bool:
    return isinstance(p, str) and p.isdigit() and 4 <= len(p) <= 8


def _valid_id(i) -> bool:
    return isinstance(i, str) and len(i) == ID_LENGTH and all(c in ID_CHARS for c in i.upper())


def _public_profile(profile: dict) -> dict:
    """Strip sensitive fields before returning to the client."""
    return {k: v for k, v in profile.items() if k != "pin_hash"}


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
            # ── Lookup by nickname ─────────────────────────────────────────
            if "lookup" in qs:
                nickname = qs["lookup"].strip()
                if not nickname:
                    return self._send_json(400, {"error": "Empty lookup"})
                data  = redis_get(_nick_key(nickname)) or {}
                ids   = list(data.keys())[:MAX_LOOKUP]
                # Fetch profiles to return {id, nickname} pairs
                results = []
                for pid in ids:
                    p = redis_get(f"profile:{pid}")
                    if p:
                        results.append({"id": pid, "nickname": p.get("nickname", pid)})
                return self._send_json(200, {"results": results})

            # ── Fetch profile by ID ────────────────────────────────────────
            pid = qs.get("id", "").strip().upper()
            if not pid:
                return self._send_json(400, {"error": "Missing id or lookup parameter"})
            if not _valid_id(pid):
                return self._send_json(400, {"error": "Invalid profile ID"})

            profile = redis_get(f"profile:{pid}")
            if not profile:
                return self._send_json(404, {"error": "Profile not found"})
            return self._send_json(200, _public_profile(profile))

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_POST(self):
        """Create a new profile."""
        try:
            body = self._read_body()
            nickname    = str(body.get("nickname", "")).strip()
            pin         = str(body.get("pin", ""))
            config      = body.get("config")
            exam_courses = body.get("exam_courses", [])

            if not _valid_nickname(nickname):
                return self._send_json(400, {"error": "Nickname non valido (1-30 caratteri)"})
            if not _valid_pin(pin):
                return self._send_json(400, {"error": "PIN non valido (4-8 cifre)"})

            # Generate a unique ID (retry up to 5 times on collision)
            for _ in range(5):
                pid = _gen_id()
                if not redis_get(f"profile:{pid}"):
                    break

            profile = {
                "id":           pid,
                "nickname":     nickname,
                "pin_hash":     _hash_pin(pin, pid),
                "config":       config,
                "exam_courses": exam_courses,
                "updated_at":   int(time.time())
            }
            redis_set(f"profile:{pid}", profile)
            _add_to_nick_index(nickname, pid)

            return self._send_json(201, _public_profile(profile))

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_PUT(self):
        """Update an existing profile (PIN required)."""
        try:
            qs  = self._qs()
            pid = qs.get("id", "").strip().upper()
            if not _valid_id(pid):
                return self._send_json(400, {"error": "ID profilo non valido"})

            profile = redis_get(f"profile:{pid}")
            if not profile:
                return self._send_json(404, {"error": "Profilo non trovato"})

            body = self._read_body()
            pin  = str(body.get("pin", ""))
            if not _verify_pin(pin, pid, profile.get("pin_hash", "")):
                return self._send_json(403, {"error": "PIN non corretto"})

            # Updateable fields
            if "config" in body:
                profile["config"] = body["config"]
            if "exam_courses" in body:
                profile["exam_courses"] = body["exam_courses"]
            if "nickname" in body:
                new_nick = str(body["nickname"]).strip()
                if _valid_nickname(new_nick) and new_nick != profile.get("nickname"):
                    _remove_from_nick_index(profile["nickname"], pid)
                    profile["nickname"] = new_nick
                    _add_to_nick_index(new_nick, pid)

            profile["updated_at"] = int(time.time())
            redis_set(f"profile:{pid}", profile)
            return self._send_json(200, _public_profile(profile))

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def log_message(self, *args):
        pass  # silence Vercel access logs
