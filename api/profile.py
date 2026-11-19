"""
UNIMIB Calendar – Profile & Share API
======================================
Stores and retrieves user profiles in Upstash Redis.

Authentication & Security Model ("Zero-Friction OWASP Auth"):
- Personal Login (private): Soprannome + PIN (4-8 digits).
  Stored at key "account:<clean_nickname>" with salted PBKDF2-HMAC-SHA256 PIN hash
  (100,000 iterations, 16-byte random salt per user).
  Format: pbkdf2:sha256:100000$<salt_hex>$<key_hex>.
  Includes transparent backward-compatibility and auto-upgrade for legacy SHA-256 hashes.
- Session Management:
  Generates an opaque 256-bit session token (st_<urlsafe>) stored in Redis at
  "session:<token>" with a 90-day sliding TTL.
  Requests can authenticate via Authorization: Bearer <session_token> header to sync
  study plans without holding PIN in local storage.
- Rate Limiting:
  Failed login/recovery attempts are tracked in Redis (ratelimit:login:<clean_nick>).
  Limited to 5 failed attempts per 10 minutes. Returns HTTP 429 Too Many Requests.
- Constant-Time Verification:
  All cryptographic credential comparisons use hmac.compare_digest.
- One-Time Account Recovery Key:
  Each profile is issued a recovery code (REC-XXXX-XXXX). If a PIN is forgotten,
  the user can reset it using the recovery code.
- Calendar Sharing (public): Read-only unique Calendar Code (e.g. "K9X2P4")
  Stored at key "share:<share_code>".
  Friends use this code or a share link (?friend=K9X2P4) to view the schedule.
  Cannot be used to modify or access the account.

Endpoints:
- POST /api/profile                     – create account OR reset PIN with recovery code
- PUT  /api/profile                     – login or update account (via PIN or Bearer token)
- GET  /api/profile?code=<SHARE_CODE>   – resolve public friend calendar by share code
- GET  /api/profile?id=<ID>             – resolve by ID or share code (backward compatible)
- GET  /api/profile?me=1                – resolve authenticated user profile via Bearer token
- DELETE /api/profile                  – terminate session (logout)
"""

import sys
import os
import json
import re
import hashlib
import hmac
import secrets
import time
import tempfile
import threading
from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import unicodedata
from typing import Optional, Tuple, Dict, Any

_parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _parent_dir not in sys.path:
    sys.path.insert(0, _parent_dir)

from api._common import (
    get_redis_creds as _get_redis_creds,
    BaseApiHandler,
    _LOCAL_STORE_PATH,
    _local_kv_load,
    _local_kv_save,
    _local_redis,
    redis_cmd as _redis,
    redis_get,
    redis_set,
    redis_del,
)

# Unambiguous characters for share codes and recovery codes (no 0/O, 1/I)
SHARE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SHARE_CODE_LEN = 6

PBKDF2_ITERATIONS = 100000
SESSION_TTL_SECONDS = 90 * 86400  # 90 days sliding TTL
RATE_LIMIT_MAX_ATTEMPTS = 5
RATE_LIMIT_WINDOW_SECONDS = 600   # 10 minutes


# ── Security & Cryptography Helpers ────────────────────────────────────────────

def _clean_nickname(n: str) -> str:
    nfkd = unicodedata.normalize('NFKD', n.strip())
    ascii_str = ''.join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r'[^A-Za-z0-9_-]', '', ascii_str).lower()


def _gen_share_code() -> str:
    return "".join(secrets.choice(SHARE_CHARS) for _ in range(SHARE_CODE_LEN))


def _gen_recovery_code() -> str:
    p1 = "".join(secrets.choice(SHARE_CHARS) for _ in range(4))
    p2 = "".join(secrets.choice(SHARE_CHARS) for _ in range(4))
    return f"REC-{p1}-{p2}"


def _hash_recovery_code(code: str) -> str:
    clean = re.sub(r'[^A-Z0-9]', '', code.strip().upper())
    return hashlib.sha256(clean.encode("utf-8")).hexdigest()


def _verify_recovery_code(code: str, stored_hash: str) -> bool:
    if not code or not stored_hash:
        return False
    clean = re.sub(r'[^A-Z0-9]', '', code.strip().upper())
    expected = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    return hmac.compare_digest(expected, stored_hash)


def _hash_pin(pin: str, clean_nick: str, salt: Optional[bytes] = None) -> str:
    """Generate PBKDF2-HMAC-SHA256 password hash."""
    if salt is None:
        salt = secrets.token_bytes(16)
    key = hashlib.pbkdf2_hmac("sha256", f"{pin}:{clean_nick}".encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2:sha256:{PBKDF2_ITERATIONS}${salt.hex()}${key.hex()}"


def _verify_pin_hash(pin: str, clean_nick: str, stored_hash: str) -> Tuple[bool, bool]:
    """
    Constant-time PIN verification.
    Returns: (is_valid, needs_upgrade_to_pbkdf2).
    """
    if not stored_hash or not isinstance(stored_hash, str):
        return False, False

    if stored_hash.startswith("pbkdf2:sha256:"):
        parts = stored_hash.split("$")
        if len(parts) == 3:
            algo_iter, salt_hex, key_hex = parts
            try:
                iters = int(algo_iter.split(":")[2])
                salt = bytes.fromhex(salt_hex)
                expected_key = hashlib.pbkdf2_hmac("sha256", f"{pin}:{clean_nick}".encode("utf-8"), salt, iters)
                return hmac.compare_digest(expected_key.hex(), key_hex), False
            except Exception:
                return False, False
        return False, False

    # Legacy SHA-256 backward compatibility: plain hashlib.sha256(f"{pin}:{clean_nick}")
    legacy_hash = hashlib.sha256(f"{pin}:{clean_nick}".encode("utf-8")).hexdigest()
    if hmac.compare_digest(legacy_hash, stored_hash):
        return True, True  # Valid credentials, flag for automatic upgrade

    return False, False


def _sanitize_text(s: Any, max_len: int = 100) -> str:
    if not isinstance(s, str):
        return ""
    # Strip script and style blocks entirely
    clean = re.sub(r'<\s*script[^>]*>.*?<\s*/\s*script\s*>', '', s, flags=re.IGNORECASE | re.DOTALL)
    clean = re.sub(r'<\s*style[^>]*>.*?<\s*/\s*style\s*>', '', clean, flags=re.IGNORECASE | re.DOTALL)
    # Strip any other HTML / XML tags
    clean = re.sub(r'<[^>]*>', '', clean)
    # Strip dangerous HTML and script characters
    for ch in ('<', '>', '"', "'", '`', '\x00'):
        clean = clean.replace(ch, '')
    # Strip non-printable control chars
    clean = ''.join(ch for ch in clean if ch.isprintable())
    return clean.strip()[:max_len]


def _sanitize_nickname(n: Any) -> str:
    return _sanitize_text(n, 30)


def _sanitize_config(cfg: Any) -> Any:
    if not isinstance(cfg, dict):
        return cfg
    clean_cfg = {}
    for k, v in cfg.items():
        if isinstance(v, str):
            clean_cfg[k] = _sanitize_text(v, 150)
        elif isinstance(v, list):
            clean_list = []
            for item in v:
                if isinstance(item, str):
                    clean_list.append(_sanitize_text(item, 150))
                elif isinstance(item, dict):
                    clean_list.append({
                        sub_k: _sanitize_text(sub_v, 150) if isinstance(sub_v, str) else sub_v
                        for sub_k, sub_v in item.items()
                    })
                else:
                    clean_list.append(item)
            clean_cfg[k] = clean_list
        else:
            clean_cfg[k] = v
    return clean_cfg


def _valid_nickname(n) -> bool:
    if not isinstance(n, str):
        return False
    stripped = n.strip()
    if not (1 <= len(stripped) <= 30):
        return False
    sanitized = _sanitize_nickname(stripped)
    return bool(sanitized) and bool(_clean_nickname(sanitized))


def _valid_pin(p) -> bool:
    return isinstance(p, str) and p.isascii() and p.isdigit() and 4 <= len(p) <= 8


# ── Session & Rate Limiting Helpers ───────────────────────────────────────────

def _create_session(clean_nick: str, share_code: str) -> str:
    """Generates an opaque 256-bit session token with 90-day sliding TTL."""
    token = f"st_{secrets.token_urlsafe(32)}"
    session_data = {
        "clean_nick": clean_nick,
        "share_code": share_code,
        "created_at": int(time.time()),
        "last_active": int(time.time())
    }
    redis_set(f"session:{token}", session_data, ex=SESSION_TTL_SECONDS)
    return token


def _get_session(token: str) -> Optional[dict]:
    """Retrieve and slide session TTL."""
    if not token or not isinstance(token, str):
        return None
    data = redis_get(f"session:{token}")
    if data and isinstance(data, dict):
        data["last_active"] = int(time.time())
        redis_set(f"session:{token}", data, ex=SESSION_TTL_SECONDS)
        return data
    return None


def _delete_session(token: str):
    if token:
        redis_del(f"session:{token}")


def _extract_bearer_token(headers) -> str:
    auth = headers.get("Authorization") or headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def _is_rate_limited(clean_nick: str, prefix: str = "login") -> bool:
    key = f"ratelimit:{prefix}:{clean_nick}"
    raw = redis_get(key)
    try:
        count = int(raw) if raw is not None else 0
        return count >= RATE_LIMIT_MAX_ATTEMPTS
    except Exception:
        return False


def _record_failed_attempt(clean_nick: str, prefix: str = "login") -> int:
    key = f"ratelimit:{prefix}:{clean_nick}"
    raw = redis_get(key)
    try:
        count = int(raw) if raw is not None else 0
    except Exception:
        count = 0
    count += 1
    redis_set(key, count, ex=RATE_LIMIT_WINDOW_SECONDS)
    return count


def _reset_failed_attempts(clean_nick: str, prefix: str = "login"):
    redis_del(f"ratelimit:{prefix}:{clean_nick}")


# ── HTTP Handler ───────────────────────────────────────────────────────────────


class handler(BaseApiHandler):

    def _get_allow_origin(self) -> str:
        headers = getattr(self, "headers", None) or {}
        origin = headers.get("Origin") or headers.get("origin") or ""
        if not origin:
            return "*"
        if re.match(r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$', origin) or \
           re.match(r'^https://[a-zA-Z0-9_.-]+(\.vercel\.app|\.unimib\.it)$', origin):
            return origin
        return "*"

    def _send_json(self, code: int, body):
        self.send_json(code, body, cache_control='no-store', allow_origin=self._get_allow_origin())

    def _read_body(self) -> dict:
        return self.read_json_body(max_bytes=65536)

    def _qs(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return dict(urllib.parse.parse_qsl(parsed.query))

    def do_OPTIONS(self):
        self.handle_options(
            methods="GET, POST, PUT, DELETE, OPTIONS",
            headers="Content-Type, Authorization",
            allow_origin=self._get_allow_origin()
        )

    def do_GET(self):
        qs = self._qs()
        try:
            # ── 1. Authenticated user lookup via Bearer token (?me=1) ──────────
            if qs.get("me") or qs.get("current"):
                token = _extract_bearer_token(self.headers)
                session = _get_session(token)
                if not session:
                    return self._send_json(401, {"error": "Sessione non valida o scaduta"})
                clean_nick = session.get("clean_nick", "")
                account = redis_get(f"account:{clean_nick}")
                if not account:
                    return self._send_json(404, {"error": "Account non trovato"})
                return self._send_json(200, {
                    "id":           account.get("share_code"),
                    "share_code":   account.get("share_code"),
                    "nickname":     account.get("nickname"),
                    "clean_nick":   clean_nick,
                    "config":       account.get("config"),
                    "exam_courses": account.get("exam_courses", [])
                })

            # ── 2. Fetch friend by share code (?code=K9X2P4) ───────────────────
            code = qs.get("code", "").strip().upper()
            if code:
                share = redis_get(f"share:{code.lower()}")
                if not share or not isinstance(share, dict):
                    return self._send_json(404, {"error": "Codice calendario non trovato"})
                return self._send_json(200, {
                    "id":         share.get("share_code", code),
                    "share_code": share.get("share_code", code),
                    "nickname":   share.get("nickname", "Amico"),
                    "config":     share.get("config")
                })

            # ── 3. Fetch by ID (backward compatibility) ────────────────────────
            pid = qs.get("id", "").strip()
            if pid:
                # Check share code first
                share = redis_get(f"share:{pid.lower()}")
                if share and isinstance(share, dict):
                    return self._send_json(200, {
                        "id":         share.get("share_code", pid),
                        "share_code": share.get("share_code", pid),
                        "nickname":   share.get("nickname", "Amico"),
                        "config":     share.get("config")
                    })
                # Check account
                acc = redis_get(f"account:{pid.lower()}")
                if acc and isinstance(acc, dict):
                    return self._send_json(200, {
                        "id":           acc.get("share_code", pid),
                        "share_code":   acc.get("share_code", pid),
                        "nickname":     acc.get("nickname", pid),
                        "config":       acc.get("config"),
                        "exam_courses": acc.get("exam_courses", [])
                    })
                # Legacy profile:<id>
                legacy = redis_get(f"profile:{pid}")
                if legacy and isinstance(legacy, dict):
                    legacy.pop("pin_hash", None)
                    return self._send_json(200, legacy)

                return self._send_json(404, {"error": "Calendario non trovato"})

            return self._send_json(400, {"error": "Specificare il parametro 'code' o 'id'"})

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_POST(self):
        """
        Create a new account OR recover/reset PIN with recovery code.
        """
        try:
            body = self._read_body()
            action = body.get("action", "")

            # ── ACTION: Reset PIN with Recovery Code ──────────────────────────
            if action in ("reset_pin", "recover"):
                nickname      = str(body.get("nickname", "")).strip()
                recovery_code = str(body.get("recovery_code", "")).strip().upper()
                new_pin       = str(body.get("new_pin", "")).strip()

                if not _valid_nickname(nickname):
                    return self._send_json(400, {"error": "Soprannome non valido"})
                if not recovery_code:
                    return self._send_json(400, {"error": "Codice di recupero obbligatorio"})
                if not _valid_pin(new_pin):
                    return self._send_json(400, {"error": "Il nuovo PIN deve essere di 4-8 cifre numeriche"})

                clean_nick = _clean_nickname(nickname)
                if _is_rate_limited(clean_nick, "recover"):
                    return self._send_json(429, {"error": "Troppi tentativi di recupero falliti. Riprova tra 10 minuti."})

                account = redis_get(f"account:{clean_nick}")
                if not account or not isinstance(account, dict):
                    _record_failed_attempt(clean_nick, "recover")
                    return self._send_json(404, {"error": f"Nessun account trovato per '{nickname}'."})

                stored_rec_hash = account.get("recovery_code_hash", "")
                if not _verify_recovery_code(recovery_code, stored_rec_hash):
                    attempts = _record_failed_attempt(clean_nick, "recover")
                    rem = max(0, RATE_LIMIT_MAX_ATTEMPTS - attempts)
                    return self._send_json(403, {"error": f"Codice di recupero non corretto. Tentativi rimasti: {rem}."})

                # Recovery successful: reset rate limits and update PIN with PBKDF2
                _reset_failed_attempts(clean_nick, "recover")
                _reset_failed_attempts(clean_nick, "login")

                new_recovery_code = _gen_recovery_code()
                account["pin_hash"] = _hash_pin(new_pin, clean_nick)
                account["recovery_code_hash"] = _hash_recovery_code(new_recovery_code)
                account["updated_at"] = int(time.time())

                share_code = account.get("share_code") or _gen_share_code()
                account["share_code"] = share_code
                redis_set(f"account:{clean_nick}", account)

                session_token = _create_session(clean_nick, share_code)

                return self._send_json(200, {
                    "nickname":      account["nickname"],
                    "share_code":    share_code,
                    "session_token": session_token,
                    "recovery_code": new_recovery_code,
                    "config":        account.get("config"),
                    "exam_courses":  account.get("exam_courses", [])
                })

            # ── Standard Account Creation ─────────────────────────────────────
            raw_nick     = str(body.get("nickname", "")).strip()
            nickname     = _sanitize_nickname(raw_nick)
            pin          = str(body.get("pin", "")).strip()
            config       = _sanitize_config(body.get("config"))
            raw_exams    = body.get("exam_courses", [])
            exam_courses = [_sanitize_text(c, 120) for c in raw_exams if isinstance(c, str)]

            if not _valid_nickname(raw_nick):
                return self._send_json(400, {"error": "Soprannome non valido (1-30 caratteri, tag o script non consentiti)"})
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

            recovery_code = _gen_recovery_code()
            session_token = _create_session(clean_nick, share_code)

            account = {
                "nickname":           nickname,
                "clean_nick":         clean_nick,
                "pin_hash":           _hash_pin(pin, clean_nick),
                "recovery_code_hash": _hash_recovery_code(recovery_code),
                "share_code":         share_code,
                "config":             config,
                "exam_courses":       exam_courses,
                "updated_at":         int(time.time())
            }
            redis_set(f"account:{clean_nick}", account)

            # Public share entry (read-only for friends, no pin_hash, no recovery hash)
            share_entry = {
                "clean_nick": clean_nick,
                "nickname":   nickname,
                "share_code": share_code,
                "config":     config,
                "updated_at": int(time.time())
            }
            redis_set(f"share:{share_code.lower()}", share_entry)

            return self._send_json(201, {
                "nickname":      nickname,
                "share_code":    share_code,
                "session_token": session_token,
                "recovery_code": recovery_code,
                "config":        config,
                "exam_courses":  exam_courses
            })

        except ValueError as e:
            if "Payload troppo grande" in str(e):
                return self._send_json(413, {"error": "Corpo della richiesta troppo grande (massimo 64KB)"})
            return self._send_json(400, {"error": str(e)})
        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_PUT(self):
        """
        Login or Update account.
        Supports two authentication modes:
        1. Bearer Token Auth (Authorization: Bearer <session_token> or session_token in body):
           Updates config/exam_courses without needing PIN.
        2. Soprannome + PIN:
           Verifies credentials with rate limiting & PBKDF2 hash upgrade. Generates session_token.
        """
        try:
            body = self._read_body()
            qs   = self._qs()

            # ── Mode 1: Bearer Session Token Update ───────────────────────────
            bearer_token = _extract_bearer_token(self.headers) or str(body.get("session_token", "")).strip()
            if bearer_token and not body.get("pin"):
                session = _get_session(bearer_token)
                if not session:
                    return self._send_json(401, {"error": "Sessione scaduta o non valida. Effettua nuovamente l'accesso con il tuo PIN."})

                clean_nick = session.get("clean_nick", "")
                account = redis_get(f"account:{clean_nick}")
                if not account or not isinstance(account, dict):
                    return self._send_json(404, {"error": "Account non trovato"})

                # Update config / exam_courses if present
                if "config" in body and body["config"] is not None:
                    account["config"] = _sanitize_config(body["config"])
                if "exam_courses" in body and body["exam_courses"] is not None:
                    raw_exams = body["exam_courses"]
                    account["exam_courses"] = [_sanitize_text(c, 120) for c in raw_exams if isinstance(c, str)]

                account["updated_at"] = int(time.time())
                share_code = account.get("share_code") or session.get("share_code")
                account["share_code"] = share_code
                redis_set(f"account:{clean_nick}", account)

                # Keep public share entry updated
                redis_set(f"share:{share_code.lower()}", {
                    "clean_nick": clean_nick,
                    "nickname":   account["nickname"],
                    "share_code": share_code,
                    "config":     account.get("config"),
                    "updated_at": int(time.time())
                })

                return self._send_json(200, {
                    "nickname":      account["nickname"],
                    "share_code":    share_code,
                    "session_token": bearer_token,
                    "config":        account.get("config"),
                    "exam_courses":  account.get("exam_courses", [])
                })

            # ── Mode 2: Soprannome + PIN Login ────────────────────────────────
            nickname = str(body.get("nickname") or qs.get("nick") or qs.get("id", "")).strip()
            pin      = str(body.get("pin", "")).strip()

            if not nickname:
                return self._send_json(400, {"error": "Inserisci il soprannome"})
            if not pin:
                return self._send_json(400, {"error": "Inserisci il PIN"})

            clean_nick = _clean_nickname(nickname)

            # Check rate limit
            if _is_rate_limited(clean_nick, "login"):
                return self._send_json(429, {
                    "error": "Troppi tentativi di accesso falliti. Riprova tra 10 minuti."
                })

            account = redis_get(f"account:{clean_nick}")

            # Backward-compatibility fallback: check if key is in legacy format
            if not account or not isinstance(account, dict):
                legacy = redis_get(f"profile:{clean_nick}") or redis_get(f"profile:{clean_nick}{pin}")
                if legacy and isinstance(legacy, dict):
                    legacy_valid, _ = _verify_pin_hash(pin, legacy.get("id", clean_nick), legacy.get("pin_hash", ""))
                    if not legacy_valid:
                        legacy_valid, _ = _verify_pin_hash(pin, clean_nick, legacy.get("pin_hash", ""))
                    if legacy_valid:
                        share_code = _gen_share_code()
                        recovery_code = _gen_recovery_code()
                        account = {
                            "nickname":           legacy.get("nickname", nickname),
                            "clean_nick":         clean_nick,
                            "pin_hash":           _hash_pin(pin, clean_nick),
                            "recovery_code_hash": _hash_recovery_code(recovery_code),
                            "share_code":         share_code,
                            "config":             legacy.get("config"),
                            "exam_courses":       legacy.get("exam_courses", []),
                            "updated_at":         int(time.time())
                        }
                        redis_set(f"account:{clean_nick}", account)
                        redis_set(f"share:{share_code.lower()}", {
                            "clean_nick": clean_nick,
                            "nickname":   account["nickname"],
                            "share_code": share_code,
                            "config":     account["config"],
                            "updated_at": int(time.time())
                        })

            if not account or not isinstance(account, dict):
                _record_failed_attempt(clean_nick, "login")
                return self._send_json(404, {"error": f"Nessun account trovato per '{nickname}'. Verifica il soprannome o crea un nuovo profilo."})

            is_valid, needs_upgrade = _verify_pin_hash(pin, clean_nick, account.get("pin_hash", ""))
            if not is_valid:
                attempts = _record_failed_attempt(clean_nick, "login")
                rem = max(0, RATE_LIMIT_MAX_ATTEMPTS - attempts)
                return self._send_json(403, {"error": f"PIN non corretto. Tentativi rimasti: {rem}."})

            # Login successful: reset rate limit
            _reset_failed_attempts(clean_nick, "login")

            # Transparent upgrade of legacy SHA-256 hash to PBKDF2
            if needs_upgrade:
                account["pin_hash"] = _hash_pin(pin, clean_nick)

            # Ensure recovery code hash exists for legacy users
            assigned_recovery_code = None
            if not account.get("recovery_code_hash"):
                assigned_recovery_code = _gen_recovery_code()
                account["recovery_code_hash"] = _hash_recovery_code(assigned_recovery_code)

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

            # Generate session token with 90-day sliding TTL
            session_token = _create_session(clean_nick, share_code)

            # Keep public share entry in sync with updated schedule
            redis_set(f"share:{share_code.lower()}", {
                "clean_nick": clean_nick,
                "nickname":   account["nickname"],
                "share_code": share_code,
                "config":     account.get("config"),
                "updated_at": int(time.time())
            })

            resp_payload = {
                "nickname":      account["nickname"],
                "share_code":    share_code,
                "session_token": session_token,
                "config":        account.get("config"),
                "exam_courses":  account.get("exam_courses", [])
            }
            if assigned_recovery_code:
                resp_payload["recovery_code"] = assigned_recovery_code

            return self._send_json(200, resp_payload)

        except ValueError as e:
            if "Payload troppo grande" in str(e):
                return self._send_json(413, {"error": "Corpo della richiesta troppo grande (massimo 64KB)"})
            return self._send_json(400, {"error": str(e)})
        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_DELETE(self):
        """Logout: invalidate session token."""
        try:
            token = _extract_bearer_token(self.headers)
            if token:
                _delete_session(token)
            return self._send_json(200, {"message": "Sessione terminata"})
        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def log_message(self, *args):
        pass
