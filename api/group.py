"""
UNIMIB Calendar – Group & Cloud Friends Sync API
=================================================
Manages synchronized study groups in Upstash Redis so that when
a student adds a friend, both students (and all other members in the group)
are automatically part of the same shared group in real time.

Data Model:
- group:<group_id> -> {
    "id":         "G9X2P4",
    "name":       "Gruppo Studio",
    "creator":    "K9X2P4",
    "members":    ["K9X2P4", "W3M7R2", ...],
    "created_at": 1727870000,
    "updated_at": 1727870000
  }
- user_group:<share_code_lower> -> "<group_id>"

Endpoints:
- GET  /api/group?user=<SHARE_CODE>   – fetch group & members for a user
- GET  /api/group?id=<GROUP_ID>       – fetch group & members by group ID/code
- POST /api/group                     – actions: add_member, sync, remove_member, join_group, rename_group
"""

import os
import json
import secrets
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler
from typing import Optional, Dict, Any, List

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

# Colors for group members
MEMBER_COLORS = [
    "#8B5CF6", "#10B981", "#F59E0B", "#EC4899",
    "#3B82F6", "#F97316", "#06B6D4", "#84CC16"
]

SHARE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
GROUP_CODE_LEN = 6


# ── Redis Helpers ─────────────────────────────────────────────────────────────

def _redis(method: str, *args):
    url, token = _get_redis_creds()
    if not url or not token:
        raise RuntimeError("Upstash Redis env vars not configured")

    path = "/" + "/".join(urllib.parse.quote(str(a), safe="") for a in (method, *args))
    req  = urllib.request.Request(url + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    if "error" in body:
        raise RuntimeError(f"Redis error: {body['error']}")
    return body.get("result")


def redis_get(key: str):
    raw = _redis("GET", key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw


def redis_set(key: str, value, ex: Optional[int] = None):
    val_str = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
    if ex:
        _redis("SET", key, val_str, "EX", ex)
    else:
        _redis("SET", key, val_str)


def redis_del(key: str):
    _redis("DEL", key)


def _gen_group_id() -> str:
    return "G" + "".join(secrets.choice(SHARE_CHARS) for _ in range(GROUP_CODE_LEN - 1))


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
                "id":         m_code.upper(),
                "share_code": m_code.upper(),
                "nickname":   m_code.upper(),
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

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

            # 2. Fetch by user share code: ?user=K9X2P4
            user_code = qs.get("user", "").strip().upper()
            if user_code:
                gid = redis_get(f"user_group:{user_code.lower()}")
                if not gid or not isinstance(gid, str):
                    return self._send_json(200, {"group": None, "members": []})

                data = _get_group_with_members(gid)
                if not data:
                    redis_del(f"user_group:{user_code.lower()}")
                    return self._send_json(200, {"group": None, "members": []})

                return self._send_json(200, data)

            return self._send_json(400, {"error": "Specificare il parametro 'user' o 'id'"})

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def do_POST(self):
        try:
            body        = self._read_body()
            action      = body.get("action", "")
            user_code   = str(body.get("user_code", "")).strip().upper()

            if not user_code:
                return self._send_json(400, {"error": "user_code obbligatorio"})

            # ── ACTION: add_member ──────────────────────────────────────────
            if action == "add_member":
                friend_code = str(body.get("friend_code", "")).strip().upper()
                if not friend_code or friend_code == user_code:
                    return self._send_json(400, {"error": "friend_code non valido"})

                # Verify friend exists
                friend_prof = _resolve_profile(friend_code)
                if not friend_prof:
                    return self._send_json(404, {"error": "Codice amico non trovato"})
                friend_actual_code = friend_prof["share_code"].upper()

                # 1. Check if user already has a group
                gid = redis_get(f"user_group:{user_code.lower()}")
                group_data = None
                if gid and isinstance(gid, str):
                    group_data = redis_get(f"group:{gid.lower()}")

                # 2. If user has no group, check if friend already has a group
                if not group_data or not isinstance(group_data, dict):
                    friend_gid = redis_get(f"user_group:{friend_actual_code.lower()}")
                    if friend_gid and isinstance(friend_gid, str):
                        fg = redis_get(f"group:{friend_gid.lower()}")
                        if fg and isinstance(fg, dict):
                            gid = friend_gid
                            group_data = fg

                # 3. If neither has a group, create a brand new group
                if not group_data or not isinstance(group_data, dict):
                    user_prof = _resolve_profile(user_code)
                    nick = user_prof["nickname"] if user_prof else "Amici"
                    gid = _gen_group_id()
                    group_data = {
                        "id":         gid,
                        "name":       f"Gruppo {nick}",
                        "creator":    user_code,
                        "members":    [user_code],
                        "created_at": int(time.time()),
                        "updated_at": int(time.time())
                    }
                    redis_set(f"user_group:{user_code.lower()}", gid)

                members = list(group_data.get("members", []))
                if user_code not in members:
                    members.append(user_code)

                # 4. If friend was in a different group, merge all members from that group
                friend_gid = redis_get(f"user_group:{friend_actual_code.lower()}")
                if friend_gid and isinstance(friend_gid, str) and friend_gid.lower() != str(gid).lower():
                    old_fg = redis_get(f"group:{friend_gid.lower()}")
                    if old_fg and isinstance(old_fg, dict):
                        for m in old_fg.get("members", []):
                            if m not in members:
                                members.append(m)
                            redis_set(f"user_group:{str(m).lower()}", gid)

                # 5. Add friend to members
                if friend_actual_code not in members:
                    members.append(friend_actual_code)

                group_data["members"] = members
                group_data["updated_at"] = int(time.time())

                redis_set(f"group:{str(gid).lower()}", group_data)
                redis_set(f"user_group:{user_code.lower()}", gid)
                redis_set(f"user_group:{friend_actual_code.lower()}", gid)

                # Also ensure all members are linked to this group in Redis
                for m in members:
                    redis_set(f"user_group:{str(m).lower()}", gid)

                result = _get_group_with_members(gid)
                return self._send_json(200, result)

            # ── ACTION: sync (bidirectional local & cloud sync) ──────────────
            elif action == "sync":
                friend_codes = [str(c).strip().upper() for c in body.get("friend_codes", []) if str(c).strip().upper() != user_code]

                # 1. Check user's current group
                gid = redis_get(f"user_group:{user_code.lower()}")
                group_data = None
                if gid and isinstance(gid, str):
                    group_data = redis_get(f"group:{gid.lower()}")

                # 2. If user has no group, check if any friend already has a group
                if not group_data or not isinstance(group_data, dict):
                    for fc in friend_codes:
                        f_prof = _resolve_profile(fc)
                        act_code = f_prof["share_code"].upper() if f_prof else fc
                        f_gid = redis_get(f"user_group:{act_code.lower()}")
                        if f_gid and isinstance(f_gid, str):
                            fg = redis_get(f"group:{f_gid.lower()}")
                            if fg and isinstance(fg, dict):
                                gid = f_gid
                                group_data = fg
                                break

                # 3. If still no group in cloud, create one if friend_codes exist
                if (not group_data or not isinstance(group_data, dict)):
                    if friend_codes:
                        user_prof = _resolve_profile(user_code)
                        nick = user_prof["nickname"] if user_prof else "Amici"
                        gid = _gen_group_id()
                        group_data = {
                            "id":         gid,
                            "name":       f"Gruppo {nick}",
                            "creator":    user_code,
                            "members":    [user_code],
                            "created_at": int(time.time()),
                            "updated_at": int(time.time())
                        }
                        redis_set(f"user_group:{user_code.lower()}", gid)
                    else:
                        return self._send_json(200, {"group": None, "members": []})

                # 4. Merge user_code and local friend_codes into cloud group
                members = list(group_data.get("members", []))
                if user_code not in members:
                    members.append(user_code)

                for fc in friend_codes:
                    f_prof = _resolve_profile(fc)
                    act_code = f_prof["share_code"].upper() if f_prof else fc
                    if act_code not in members:
                        members.append(act_code)

                group_data["members"] = members
                group_data["updated_at"] = int(time.time())
                redis_set(f"group:{str(gid).lower()}", group_data)
                redis_set(f"user_group:{user_code.lower()}", gid)

                for m in members:
                    redis_set(f"user_group:{str(m).lower()}", gid)

                result = _get_group_with_members(gid)
                return self._send_json(200, result)

            # ── ACTION: remove_member ───────────────────────────────────────
            elif action == "remove_member":
                remove_code = str(body.get("remove_code", "")).strip().upper()
                gid = redis_get(f"user_group:{user_code.lower()}")
                if not gid or not isinstance(gid, str):
                    return self._send_json(200, {"group": None, "members": []})

                group_data = redis_get(f"group:{gid.lower()}")
                if group_data and isinstance(group_data, dict):
                    members = [m for m in group_data.get("members", []) if m != remove_code]
                    group_data["members"] = members
                    group_data["updated_at"] = int(time.time())
                    redis_set(f"group:{gid.lower()}", group_data)
                    # Remove friend's group link
                    redis_del(f"user_group:{remove_code.lower()}")

                result = _get_group_with_members(gid)
                return self._send_json(200, result or {"group": None, "members": []})

            # ── ACTION: join_group (by group ID/code) ────────────────────────
            elif action == "join_group":
                target_gid = str(body.get("group_id", "")).strip().upper()
                group_data = redis_get(f"group:{target_gid.lower()}")
                if not group_data or not isinstance(group_data, dict):
                    return self._send_json(404, {"error": "Codice gruppo non trovato"})

                members = list(group_data.get("members", []))
                if user_code not in members:
                    members.append(user_code)
                group_data["members"] = members
                group_data["updated_at"] = int(time.time())

                redis_set(f"group:{target_gid.lower()}", group_data)
                redis_set(f"user_group:{user_code.lower()}", target_gid)

                result = _get_group_with_members(target_gid)
                return self._send_json(200, result)

            # ── ACTION: rename_group ────────────────────────────────────────
            elif action == "rename_group":
                new_name = str(body.get("name", "")).strip()[:40]
                if not new_name:
                    return self._send_json(400, {"error": "Nome gruppo non valido"})

                gid = redis_get(f"user_group:{user_code.lower()}")
                if not gid:
                    return self._send_json(404, {"error": "Nessun gruppo trovato"})

                group_data = redis_get(f"group:{gid.lower()}")
                if group_data and isinstance(group_data, dict):
                    group_data["name"] = new_name
                    group_data["updated_at"] = int(time.time())
                    redis_set(f"group:{gid.lower()}", group_data)

                result = _get_group_with_members(gid)
                return self._send_json(200, result)

            else:
                return self._send_json(400, {"error": f"Azione '{action}' sconosciuta"})

        except Exception as e:
            return self._send_json(500, {"error": str(e)})

    def log_message(self, *args):
        pass
