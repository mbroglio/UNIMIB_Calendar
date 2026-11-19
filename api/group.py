"""
UNIMIB Calendar – Multi-Group & Shared Calendar API
====================================================
Manages multiple synchronized study groups per user in Upstash Redis.

Data Model:
- group:<group_id> -> {
    "id":         "G9X2P4",
    "name":       "Gruppo Studio Analisi",
    "creator":    "K9X2P4",
    "members":    ["K9X2P4", "W3M7R2", ...],
    "created_at": 1727870000,
    "updated_at": 1727870000
  }
- user_groups:<share_code_lower> -> ["G9X2P4", "G3M1P8", ...]
  (Users initially start with 0 groups: [])

Authorization:
- Modifying actions (create_group, join_group, leave_group, rename_group, add_member, remove_member)
  require a valid session token (Authorization: Bearer <session_token>).
- Only members of a group may rename it or add/remove members.

Endpoints:
- GET  /api/group?user=<SHARE_CODE>[&group_id=<ID>]  – fetch user groups & active group details
- GET  /api/group?id=<GROUP_ID>                      – fetch group & members by group ID/code
- POST /api/group                                    – actions: create_group, join_group, leave_group,
                                                                rename_group, add_member, remove_member,
                                                                list_user_groups, sync
"""

import sys
import os
import json
import re
import secrets
import time
import tempfile
import threading
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from typing import Optional, Dict, Any, List

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

# Curated 12 distinct high-contrast colors for group members
MEMBER_COLORS = [
    "#3B82F6",  # Royal Blue
    "#F97316",  # Warm Orange
    "#8B5CF6",  # Vivid Purple
    "#10B981",  # Emerald Green
    "#EC4899",  # Hot Pink
    "#EAB308",  # Amber Gold
    "#6366F1",  # Indigo
    "#F43F5E",  # Rose Coral
    "#84CC16",  # Lime Green
    "#06B6D4",  # Electric Cyan
    "#A855F7",  # Orchid Purple
    "#D97706",  # Bronze Gold
]

SHARE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
GROUP_CODE_LEN = 6
SESSION_TTL_SECONDS = 90 * 86400


# ── Sanitization & Anti-XSS Helpers ───────────────────────────────────────────

def _sanitize_text(s: Any, max_len: int = 40) -> str:
    if not isinstance(s, str):
        return ""
    # Strip script and style blocks entirely
    clean = re.sub(r'<\s*script[^>]*>.*?<\s*/\s*script\s*>', '', s, flags=re.IGNORECASE | re.DOTALL)
    clean = re.sub(r'<\s*style[^>]*>.*?<\s*/\s*style\s*>', '', clean, flags=re.IGNORECASE | re.DOTALL)
    # Strip any other HTML / XML tags
    clean = re.sub(r'<[^>]*>', '', clean)
    for ch in ('<', '>', '"', "'", '`', '\x00'):
        clean = clean.replace(ch, '')
    clean = ''.join(ch for ch in clean if ch.isprintable())
    return clean.strip()[:max_len]


def _is_safe_code(code: str) -> bool:
    return bool(code and re.match(r'^[A-Za-z0-9_-]{3,32}$', code))


def _gen_group_id() -> str:
    return "G" + "".join(secrets.choice(SHARE_CHARS) for _ in range(GROUP_CODE_LEN - 1))


# ── Auth & Profile Helpers ───────────────────────────────────────────────────

def _get_auth_session(headers, body: dict) -> Optional[dict]:
    auth = headers.get("Authorization") or headers.get("authorization") or ""
    token = ""
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    elif "session_token" in body:
        token = str(body["session_token"]).strip()

    if not token:
        return None

    session = redis_get(f"session:{token}")
    if session and isinstance(session, dict):
        # Slide session TTL
        session["last_active"] = int(time.time())
        redis_set(f"session:{token}", session, ex=SESSION_TTL_SECONDS)
        return session
    return None


def _resolve_profile(code: str) -> Optional[dict]:
    """Look up a user's public profile from Redis by share code or clean nickname."""
    clean = (code or "").strip().lower()
    if not clean:
        return None

    # 1. Check share entry
    share = redis_get(f"share:{clean}")
    if share and isinstance(share, dict):
        return {
            "id":         share.get("share_code", clean.upper()),
            "share_code": share.get("share_code", clean.upper()),
            "nickname":   share.get("nickname", clean.upper()),
            "config":     share.get("config")
        }

    # 2. Check account entry
    acc = redis_get(f"account:{clean}")
    if acc and isinstance(acc, dict):
        return {
            "id":         acc.get("share_code", clean.upper()),
            "share_code": acc.get("share_code", clean.upper()),
            "nickname":   acc.get("nickname", clean),
            "config":     acc.get("config")
        }

    # Also try normalized clean nickname
    clean_norm = re.sub(r'[^a-z0-9_-]', '', clean)
    if clean_norm and clean_norm != clean:
        acc = redis_get(f"account:{clean_norm}")
        if acc and isinstance(acc, dict):
            return {
                "id":         acc.get("share_code", clean.upper()),
                "share_code": acc.get("share_code", clean.upper()),
                "nickname":   acc.get("nickname", clean),
                "config":     acc.get("config")
            }

    # 3. Check legacy profile
    legacy = redis_get(f"profile:{clean}")
    if legacy and isinstance(legacy, dict):
        return {
            "id":         legacy.get("share_code", clean.upper()),
            "share_code": legacy.get("share_code", clean.upper()),
            "nickname":   legacy.get("nickname", clean),
            "config":     legacy.get("config")
        }

    return None


# ── Multi-Group Data Model Helpers ────────────────────────────────────────────

def _get_user_group_ids(user_code: str) -> List[str]:
    """Retrieve the list of group IDs a user belongs to."""
    if not user_code:
        return []
    clean = user_code.strip().lower()
    raw = redis_get(f"user_groups:{clean}")
    if raw is not None:
        if isinstance(raw, list):
            return [str(g).upper() for g in raw if g]
        elif isinstance(raw, str):
            return [str(raw).upper()]

    # Backward compatibility: check legacy user_group:{clean}
    legacy = redis_get(f"user_group:{clean}")
    if legacy and isinstance(legacy, str):
        gids = [legacy.upper()]
        redis_set(f"user_groups:{clean}", gids)
        return gids

    return []


def _save_user_group_ids(user_code: str, group_ids: List[str]):
    clean = user_code.strip().lower()
    # Deduplicate preserving order
    unique: List[str] = []
    for gid in group_ids:
        g = str(gid).upper()
        if g not in unique:
            unique.append(g)
    redis_set(f"user_groups:{clean}", unique)


def _get_user_groups_summary(user_code: str) -> List[dict]:
    gids = _get_user_group_ids(user_code)
    summary = []
    valid_gids = []

    for gid in gids:
        group_data = redis_get(f"group:{gid.lower()}")
        if group_data and isinstance(group_data, dict):
            # Verify user is still an active member of this group
            members_upper = [str(m).upper() for m in group_data.get("members", [])]
            if user_code.upper() in members_upper:
                valid_gids.append(gid)
                summary.append({
                    "id":            group_data.get("id", gid),
                    "name":          group_data.get("name", "Gruppo Studio"),
                    "creator":       group_data.get("creator", ""),
                    "members_count": len(group_data.get("members", [])),
                    "updated_at":    group_data.get("updated_at", 0)
                })

    # Clean up stale references if any groups were deleted or membership revoked
    if len(valid_gids) != len(gids):
        _save_user_group_ids(user_code, valid_gids)

    return summary


def _get_group_with_members(group_id: str) -> Optional[dict]:
    """Fetch group record and resolve all member profiles."""
    if not group_id:
        return None
    raw = redis_get(f"group:{group_id.lower()}")
    if not raw or not isinstance(raw, dict):
        return None

    members_codes = raw.get("members", [])
    resolved_members = []

    for idx, m_code in enumerate(members_codes):
        prof = _resolve_profile(m_code)
        color = MEMBER_COLORS[idx % len(MEMBER_COLORS)]
        if prof:
            resolved_members.append({
                "id":         prof["share_code"],
                "share_code": prof["share_code"],
                "nickname":   prof["nickname"],
                "config":     prof.get("config"),
                "color":      color
            })
        else:
            resolved_members.append({
                "id":         str(m_code).upper(),
                "share_code": str(m_code).upper(),
                "nickname":   str(m_code).upper(),
                "config":     None,
                "color":      color
            })

    return {
        "group": {
            "id":         raw.get("id", group_id.upper()),
            "name":       raw.get("name", "Gruppo Studio"),
            "creator":    raw.get("creator", ""),
            "updated_at": raw.get("updated_at", int(time.time()))
        },
        "members": resolved_members
    }


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
            methods="GET, POST, OPTIONS",
            headers="Content-Type, Authorization",
            allow_origin=self._get_allow_origin()
        )

    def do_GET(self):
        qs = self._qs()
        try:
            # 1. Fetch by group ID: ?id=G9X2P4
            group_id = qs.get("id", "").strip().upper()
            if group_id:
                data = _get_group_with_members(group_id)
                if not data:
                    return self._send_json(404, {"error": "Gruppo non trovato"})
                return self._send_json(200, data)

            # 2. Fetch by user share code: ?user=K9X2P4 (or via session token)
            user_code = qs.get("user", "").strip().upper()
            if not user_code:
                session = _get_auth_session(self.headers, {})
                if session:
                    user_code = str(session.get("share_code", "")).strip().upper()

            if user_code:
                groups_summary = _get_user_groups_summary(user_code)
                current_gid = qs.get("group_id", "").strip().upper()

                if current_gid and not any(g["id"] == current_gid for g in groups_summary):
                    current_gid = ""

                if not current_gid and groups_summary:
                    current_gid = groups_summary[0]["id"]

                active_group_data = _get_group_with_members(current_gid) if current_gid else None

                return self._send_json(200, {
                    "groups":  groups_summary,
                    "group":   active_group_data["group"] if active_group_data else None,
                    "members": active_group_data["members"] if active_group_data else []
                })

            return self._send_json(400, {"error": "Specificare il parametro 'user' o 'id'"})

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_POST(self):
        try:
            body = self._read_body()
            action = body.get("action", "")

            # Verify session token for modifying group actions
            session = _get_auth_session(self.headers, body)
            if not session:
                return self._send_json(401, {"error": "Autenticazione richiesta. Effettua l'accesso col tuo profilo."})

            auth_user_code = str(session.get("share_code", "")).strip().upper()
            if not auth_user_code:
                return self._send_json(401, {"error": "Sessione non valida"})

            # ── ACTION: create_group ──────────────────────────────────────────
            if action == "create_group":
                name = _sanitize_text(body.get("name", "Gruppo Studio"), 40) or "Gruppo Studio"

                # Generate unique group ID
                gid = None
                for _ in range(10):
                    candidate = _gen_group_id()
                    if not redis_get(f"group:{candidate.lower()}"):
                        gid = candidate
                        break
                if not gid:
                    gid = _gen_group_id()

                group_data = {
                    "id":         gid,
                    "name":       name,
                    "creator":    auth_user_code,
                    "members":    [auth_user_code],
                    "created_at": int(time.time()),
                    "updated_at": int(time.time())
                }
                redis_set(f"group:{gid.lower()}", group_data)

                # Add to user's groups
                user_gids = _get_user_group_ids(auth_user_code)
                if gid not in user_gids:
                    user_gids.append(gid)
                _save_user_group_ids(auth_user_code, user_gids)

                result = _get_group_with_members(gid)
                result["groups"] = _get_user_groups_summary(auth_user_code)
                return self._send_json(201, result)

            # ── ACTION: join_group ────────────────────────────────────────────
            elif action == "join_group":
                target_gid = str(body.get("group_id", "")).strip().upper()
                if not _is_safe_code(target_gid):
                    return self._send_json(400, {"error": "group_id non valido"})

                group_data = redis_get(f"group:{target_gid.lower()}")
                if not group_data or not isinstance(group_data, dict):
                    return self._send_json(404, {"error": "Codice gruppo non trovato"})

                members = list(group_data.get("members", []))
                if not any(m.upper() == auth_user_code for m in members):
                    members.append(auth_user_code)
                    group_data["members"] = members
                    group_data["updated_at"] = int(time.time())
                    redis_set(f"group:{target_gid.lower()}", group_data)

                user_gids = _get_user_group_ids(auth_user_code)
                if not any(g.upper() == target_gid for g in user_gids):
                    user_gids.append(target_gid)
                _save_user_group_ids(auth_user_code, user_gids)

                result = _get_group_with_members(target_gid)
                result["groups"] = _get_user_groups_summary(auth_user_code)
                return self._send_json(200, result)

            # ── ACTION: leave_group ───────────────────────────────────────────
            elif action == "leave_group":
                target_gid = str(body.get("group_id", "")).strip().upper()
                if not _is_safe_code(target_gid):
                    return self._send_json(400, {"error": "group_id obbligatorio"})

                group_data = redis_get(f"group:{target_gid.lower()}")
                if group_data and isinstance(group_data, dict):
                    # Only modify/delete group if user is an active member
                    if any(m.upper() == auth_user_code for m in group_data.get("members", [])):
                        members = [m for m in group_data.get("members", []) if m.upper() != auth_user_code]
                        if len(members) == 0:
                            redis_del(f"group:{target_gid.lower()}")
                        else:
                            group_data["members"] = members
                            if group_data.get("creator", "").upper() == auth_user_code:
                                group_data["creator"] = members[0]
                            group_data["updated_at"] = int(time.time())
                            redis_set(f"group:{target_gid.lower()}", group_data)

                user_gids = [g for g in _get_user_group_ids(auth_user_code) if g.upper() != target_gid]
                _save_user_group_ids(auth_user_code, user_gids)

                return self._send_json(200, {
                    "success": True,
                    "groups":  _get_user_groups_summary(auth_user_code)
                })

            # ── ACTION: rename_group ──────────────────────────────────────────
            elif action == "rename_group":
                target_gid = str(body.get("group_id", "")).strip().upper()
                new_name = _sanitize_text(body.get("name", ""), 40)
                if not _is_safe_code(target_gid) or not new_name:
                    return self._send_json(400, {"error": "Parametri non validi"})

                group_data = redis_get(f"group:{target_gid.lower()}")
                if not group_data or not isinstance(group_data, dict):
                    return self._send_json(404, {"error": "Gruppo non trovato"})

                # Authorization check: user must be member of this group
                if auth_user_code not in [m.upper() for m in group_data.get("members", [])]:
                    return self._send_json(403, {"error": "Non sei membro di questo gruppo"})

                group_data["name"] = new_name
                group_data["updated_at"] = int(time.time())
                redis_set(f"group:{target_gid.lower()}", group_data)

                result = _get_group_with_members(target_gid)
                result["groups"] = _get_user_groups_summary(auth_user_code)
                return self._send_json(200, result)

            # ── ACTION: add_member ────────────────────────────────────────────
            elif action == "add_member":
                target_gid = str(body.get("group_id", "")).strip().upper()
                friend_code = str(body.get("friend_code", "")).strip().upper()

                if not target_gid:
                    # Fallback to first group if group_id omitted
                    user_gids = _get_user_group_ids(auth_user_code)
                    if user_gids:
                        target_gid = user_gids[0]

                if not _is_safe_code(target_gid) or not _is_safe_code(friend_code) or friend_code == auth_user_code:
                    return self._send_json(400, {"error": "friend_code o group_id non valido"})

                group_data = redis_get(f"group:{target_gid.lower()}")
                if not group_data or not isinstance(group_data, dict):
                    return self._send_json(404, {"error": "Gruppo non trovato"})

                if auth_user_code not in [m.upper() for m in group_data.get("members", [])]:
                    return self._send_json(403, {"error": "Non sei membro di questo gruppo"})

                friend_prof = _resolve_profile(friend_code)
                if not friend_prof:
                    return self._send_json(404, {"error": "Codice amico non trovato"})
                friend_actual_code = friend_prof["share_code"].upper()

                if friend_actual_code == auth_user_code:
                    return self._send_json(400, {"error": "Non puoi aggiungere te stesso al gruppo"})

                members = list(group_data.get("members", []))
                if not any(m.upper() == friend_actual_code for m in members):
                    members.append(friend_actual_code)
                    group_data["members"] = members
                    group_data["updated_at"] = int(time.time())
                    redis_set(f"group:{target_gid.lower()}", group_data)

                # Link friend to this group in user_groups
                friend_gids = _get_user_group_ids(friend_actual_code)
                if not any(g.upper() == target_gid for g in friend_gids):
                    friend_gids.append(target_gid)
                _save_user_group_ids(friend_actual_code, friend_gids)

                result = _get_group_with_members(target_gid)
                result["groups"] = _get_user_groups_summary(auth_user_code)
                return self._send_json(200, result)

            # ── ACTION: remove_member ─────────────────────────────────────────
            elif action == "remove_member":
                target_gid = str(body.get("group_id", "")).strip().upper()
                remove_code = str(body.get("remove_code", "")).strip().upper()

                if not target_gid:
                    user_gids = _get_user_group_ids(auth_user_code)
                    if user_gids:
                        target_gid = user_gids[0]

                if not target_gid or not remove_code:
                    return self._send_json(400, {"error": "Parametri non validi"})

                group_data = redis_get(f"group:{target_gid.lower()}")
                if not group_data or not isinstance(group_data, dict):
                    return self._send_json(404, {"error": "Gruppo non trovato"})

                if auth_user_code not in [m.upper() for m in group_data.get("members", [])]:
                    return self._send_json(403, {"error": "Non sei membro di questo gruppo"})

                members = [m for m in group_data.get("members", []) if m.upper() != remove_code]
                if len(members) == 0:
                    redis_del(f"group:{target_gid.lower()}")
                else:
                    group_data["members"] = members
                    if group_data.get("creator", "").upper() == remove_code:
                        group_data["creator"] = members[0]
                    group_data["updated_at"] = int(time.time())
                    redis_set(f"group:{target_gid.lower()}", group_data)

                # Unlink removed member from this group
                r_gids = [g for g in _get_user_group_ids(remove_code) if g.upper() != target_gid]
                _save_user_group_ids(remove_code, r_gids)

                result = _get_group_with_members(target_gid) if len(members) > 0 else {"group": None, "members": []}
                result["groups"] = _get_user_groups_summary(auth_user_code)
                return self._send_json(200, result)

            # ── ACTION: list_user_groups ──────────────────────────────────────
            elif action == "list_user_groups":
                return self._send_json(200, {
                    "groups": _get_user_groups_summary(auth_user_code)
                })

            # ── ACTION: sync (legacy backward compatibility) ──────────────────
            elif action == "sync":
                user_gids = _get_user_group_ids(auth_user_code)
                if not user_gids:
                    # User starts without any group – do NOT auto-create a default group
                    return self._send_json(200, {
                        "groups":  [],
                        "group":   None,
                        "members": []
                    })

                target_gid = str(body.get("group_id", "")).strip().upper()
                if not target_gid or target_gid not in user_gids:
                    target_gid = user_gids[0]

                result = _get_group_with_members(target_gid)
                if result:
                    result["groups"] = _get_user_groups_summary(auth_user_code)
                    return self._send_json(200, result)
                return self._send_json(200, {"groups": _get_user_groups_summary(auth_user_code), "group": None, "members": []})

            else:
                return self._send_json(400, {"error": f"Azione '{action}' sconosciuta"})

        except ValueError as e:
            if "Payload troppo grande" in str(e):
                return self._send_json(413, {"error": "Corpo della richiesta troppo grande (massimo 64KB)"})
            return self._send_json(400, {"error": str(e)})
        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def log_message(self, *args):
        pass
