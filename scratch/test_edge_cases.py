import unittest
import io
import json
from datetime import datetime
from api.teachers import (
    parse_date_to_monday,
    clean_html,
    extract_emails,
    split_curricula,
    get_academic_years,
    get_teachers_list,
    handler as TeachersHandler
)


class TestTeacherHelpers(unittest.TestCase):
    def test_date_parsing_formats(self):
        # Italian format DD-MM-YYYY (Tuesday -> Monday)
        mon1 = parse_date_to_monday("06-10-2026")
        self.assertEqual(mon1.strftime("%d-%m-%Y"), "05-10-2026")

        # ISO format YYYY-MM-DD
        mon2 = parse_date_to_monday("2026-10-06")
        self.assertEqual(mon2.strftime("%d-%m-%Y"), "05-10-2026")

        # Weekend (Sunday -> Monday of same academic week)
        mon3 = parse_date_to_monday("11-10-2026")
        self.assertEqual(mon3.strftime("%d-%m-%Y"), "05-10-2026")

        # Weekend ISO (Sunday)
        mon4 = parse_date_to_monday("2026-10-11")
        self.assertEqual(mon4.strftime("%d-%m-%Y"), "05-10-2026")

        # Already Monday
        mon5 = parse_date_to_monday("05-10-2026")
        self.assertEqual(mon5.strftime("%d-%m-%Y"), "05-10-2026")

        # Invalid formats raise ValueError
        with self.assertRaises(ValueError):
            parse_date_to_monday("2026/10/06")
        with self.assertRaises(ValueError):
            parse_date_to_monday("invalid-date")

    def test_clean_html(self):
        raw = '<i class="fa fa-asterisk"></i> CHIMICA ORGANICA II&nbsp;&nbsp;'
        self.assertEqual(clean_html(raw), "CHIMICA ORGANICA II&nbsp;&nbsp;".strip())

        raw2 = '<span><strong>Prof.</strong> Rossi</span>'
        self.assertEqual(clean_html(raw2), "Prof. Rossi")

        self.assertEqual(clean_html(""), "")
        self.assertEqual(clean_html(None), "")

    def test_extract_emails(self):
        mail_str = ", alessandro.abbotto@unimib.it, , luca.zoia@unimib.it"
        link_str = '<a href="mailto:alessandro.abbotto@unimib.it">email</a>'
        emails = extract_emails(mail_str, link_str)
        self.assertEqual(emails, ["alessandro.abbotto@unimib.it", "luca.zoia@unimib.it"])
        self.assertEqual(extract_emails("", ""), [])

    def test_split_curricula(self):
        percorso = "SCIENZE CHIMICHE [E27]<hr>SCIENZE BIOLOGICHE [E28]"
        res = split_curricula(percorso)
        self.assertEqual(len(res), 2)
        self.assertEqual(res[0], "SCIENZE CHIMICHE [E27]")
        self.assertEqual(res[1], "SCIENZE BIOLOGICHE [E28]")


class MockTeachersHandler(TeachersHandler):
    def __init__(self, path):
        self.path = path
        self.response_status = None
        self.headers = {}
        self.output = io.BytesIO()
        self.wfile = self.output
        self.do_GET()

    def send_response(self, code):
        self.response_status = code

    def send_header(self, k, v):
        self.headers[k] = v

    def end_headers(self):
        pass

    def get_json(self):
        return json.loads(self.output.getvalue().decode("utf-8"))


class TestTeachersAPI(unittest.TestCase):
    def test_get_academic_years(self):
        years = get_academic_years()
        self.assertTrue(len(years) > 0)
        self.assertIn("value", years[0])
        self.assertIn("label", years[0])

    def test_teachers_list_handler(self):
        h = MockTeachersHandler("/api/teachers?anno=2026")
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        self.assertIn("teachers", data)
        self.assertIn("total", data)
        self.assertTrue(data["total"] > 100)
        t = data["teachers"][0]
        self.assertIn("code", t)
        self.assertIn("name", t)
        self.assertIn("courses", t)

    def test_teachers_search_handler(self):
        h = MockTeachersHandler("/api/teachers?anno=2026&q=abbotto")
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        self.assertTrue(any("ABBOTTO" in t["name"] for t in data["teachers"]))

    def test_teacher_calendar_handler(self):
        # Teacher Abbotto (valore 013696)
        h = MockTeachersHandler("/api/teachers?anno=2026&docente=013696&date=06-10-2026")
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        self.assertEqual(data["docente"], "013696")
        self.assertIn("events", data)
        self.assertIn("giorni", data)
        self.assertIn("week_label", data)
        self.assertEqual(data["monday_date"], "05-10-2026")
        if data["events"]:
            ev = data["events"][0]
            self.assertIn("course", ev)
            self.assertIn("start_time", ev)
            self.assertIn("end_time", ev)
            self.assertIn("aula", ev)
            self.assertIn("is_canceled", ev)

    def test_teacher_calendar_iso_date(self):
        h = MockTeachersHandler("/api/teachers?anno=2026&docente=013696&date=2026-10-06")
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        self.assertEqual(data["monday_date"], "05-10-2026")

    def test_teacher_invalid_params(self):
        # Invalid year
        h1 = MockTeachersHandler("/api/teachers?anno=abcd")
        self.assertEqual(h1.response_status, 400)

        # Invalid docente
        h2 = MockTeachersHandler("/api/teachers?anno=2026&docente=??!!")
        self.assertEqual(h2.response_status, 400)

        # Invalid date
        h3 = MockTeachersHandler("/api/teachers?anno=2026&docente=013696&date=bad_date")
        self.assertEqual(h3.response_status, 400)


# ════════════════════════════════════════════════════════════════════════════════
# Mock In-Memory Redis & HTTP Handlers for Profile & Group APIs
# ════════════════════════════════════════════════════════════════════════════════

import hashlib
import api.profile as profile_module
import api.group as group_module
from api.profile import (
    _clean_nickname,
    _valid_nickname,
    _valid_pin,
    _hash_pin,
    _verify_pin_hash,
    _gen_recovery_code,
    _hash_recovery_code,
    _verify_recovery_code,
    handler as ProfileHandler
)
from api.group import handler as GroupHandler


class InMemoryRedis:
    def __init__(self):
        self.store = {}

    def get(self, key):
        val = self.store.get(key)
        if val is None:
            return None
        try:
            return json.loads(val)
        except Exception:
            return val

    def set(self, key, value, ex=None):
        val_str = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        self.store[key] = val_str

    def delete(self, key):
        self.store.pop(key, None)


class MockProfileHandler(ProfileHandler):
    def __init__(self, method, path, headers=None, body=None):
        self.path = path
        self.headers = headers or {}
        if body is not None:
            raw_body = json.dumps(body).encode("utf-8")
            self.rfile = io.BytesIO(raw_body)
            self.headers["Content-Length"] = str(len(raw_body))
        else:
            self.rfile = io.BytesIO(b"")
            self.headers["Content-Length"] = "0"
        self.wfile = io.BytesIO()
        self.response_status = None
        self.response_headers = {}

        if method == "GET":
            self.do_GET()
        elif method == "POST":
            self.do_POST()
        elif method == "PUT":
            self.do_PUT()
        elif method == "DELETE":
            self.do_DELETE()
        elif method == "OPTIONS":
            self.do_OPTIONS()

    def send_response(self, code, message=None):
        self.response_status = code

    def send_header(self, k, v):
        self.response_headers[k] = v

    def end_headers(self):
        pass

    def get_json(self):
        data = self.wfile.getvalue().decode("utf-8")
        return json.loads(data) if data else {}


class MockGroupHandler(GroupHandler):
    def __init__(self, method, path, headers=None, body=None):
        self.path = path
        self.headers = headers or {}
        if body is not None:
            raw_body = json.dumps(body).encode("utf-8")
            self.rfile = io.BytesIO(raw_body)
            self.headers["Content-Length"] = str(len(raw_body))
        else:
            self.rfile = io.BytesIO(b"")
            self.headers["Content-Length"] = "0"
        self.wfile = io.BytesIO()
        self.response_status = None
        self.response_headers = {}

        if method == "GET":
            self.do_GET()
        elif method == "POST":
            self.do_POST()
        elif method == "OPTIONS":
            self.do_OPTIONS()

    def send_response(self, code, message=None):
        self.response_status = code

    def send_header(self, k, v):
        self.response_headers[k] = v

    def end_headers(self):
        pass

    def get_json(self):
        data = self.wfile.getvalue().decode("utf-8")
        return json.loads(data) if data else {}


# ════════════════════════════════════════════════════════════════════════════════
# Test Suite: OWASP Profile Authentication, Sessions, Recovery & Rate Limiting
# ════════════════════════════════════════════════════════════════════════════════

class TestProfileSecurityAndAuth(unittest.TestCase):
    def setUp(self):
        self.redis = InMemoryRedis()
        profile_module.redis_get = self.redis.get
        profile_module.redis_set = self.redis.set
        profile_module.redis_del = self.redis.delete
        group_module.redis_get = self.redis.get
        group_module.redis_set = self.redis.set
        group_module.redis_del = self.redis.delete

    def test_nickname_and_pin_validation(self):
        self.assertEqual(_clean_nickname("  Müller Mario 123  "), "mullermario123")
        self.assertEqual(_clean_nickname("  Müller_Mario 123  "), "muller_mario123")
        self.assertEqual(_clean_nickname("Fr@ncesco!"), "frncesco")
        self.assertTrue(_valid_nickname("Matteo"))
        self.assertFalse(_valid_nickname(""))
        self.assertFalse(_valid_nickname("a" * 31))

        self.assertTrue(_valid_pin("1234"))
        self.assertTrue(_valid_pin("12345678"))
        self.assertFalse(_valid_pin("123"))      # too short
        self.assertFalse(_valid_pin("123456789")) # too long
        self.assertFalse(_valid_pin("12ab"))     # non-digit
        self.assertFalse(_valid_pin("12 4"))     # contains space

    def test_pbkdf2_and_legacy_hashing(self):
        pin = "4321"
        nick = "studente"
        # 1. PBKDF2 hash generation
        p_hash = _hash_pin(pin, nick)
        self.assertTrue(p_hash.startswith("pbkdf2:sha256:100000$"))
        valid, needs_upgrade = _verify_pin_hash(pin, nick, p_hash)
        self.assertTrue(valid)
        self.assertFalse(needs_upgrade)

        # Wrong PIN
        valid_bad, _ = _verify_pin_hash("9999", nick, p_hash)
        self.assertFalse(valid_bad)

        # 2. Legacy SHA-256 hash backward compatibility
        legacy_hash = hashlib.sha256(f"{pin}:{nick}".encode("utf-8")).hexdigest()
        leg_valid, leg_upgrade = _verify_pin_hash(pin, nick, legacy_hash)
        self.assertTrue(leg_valid)
        self.assertTrue(leg_upgrade)  # flags for automatic upgrade to PBKDF2

        # Corrupted hash format
        corrupt_valid, _ = _verify_pin_hash(pin, nick, "invalid:format:hash")
        self.assertFalse(corrupt_valid)

    def test_recovery_key_hashing(self):
        rec_code = _gen_recovery_code()
        self.assertTrue(rec_code.startswith("REC-"))
        self.assertEqual(len(rec_code), 13)

        rec_hash = _hash_recovery_code(rec_code)
        self.assertTrue(_verify_recovery_code(rec_code, rec_hash))
        # Case & hyphen insensitive
        self.assertTrue(_verify_recovery_code(rec_code.lower().replace("-", ""), rec_hash))
        self.assertFalse(_verify_recovery_code("REC-0000-0000", rec_hash))

    def test_profile_registration_and_login_flow(self):
        # 1. Register new user
        reg_body = {
            "nickname": "Marco",
            "pin": "1234",
            "config": {"anno": 2}
        }
        h_reg = MockProfileHandler("POST", "/api/profile", body=reg_body)
        self.assertEqual(h_reg.response_status, 201)
        data_reg = h_reg.get_json()
        self.assertEqual(data_reg["nickname"], "Marco")
        self.assertTrue(data_reg["share_code"])
        self.assertTrue(data_reg["session_token"].startswith("st_"))
        self.assertTrue(data_reg["recovery_code"].startswith("REC-"))

        # Check account in redis has PBKDF2 hash
        account = self.redis.get("account:marco")
        self.assertIsNotNone(account)
        self.assertTrue(account["pin_hash"].startswith("pbkdf2:sha256:100000$"))

        # 2. Login via PUT
        login_body = {
            "nickname": "Marco",
            "pin": "1234"
        }
        h_login = MockProfileHandler("PUT", "/api/profile", body=login_body)
        self.assertEqual(h_login.response_status, 200)
        data_login = h_login.get_json()
        self.assertEqual(data_login["nickname"], "Marco")
        self.assertTrue(data_login["session_token"].startswith("st_"))

    def test_legacy_account_auto_upgrade_on_login(self):
        # Seed account with legacy SHA-256 hash
        clean_nick = "giulia"
        pin = "5678"
        legacy_hash = hashlib.sha256(f"{pin}:{clean_nick}".encode("utf-8")).hexdigest()
        self.redis.set(f"account:{clean_nick}", {
            "nickname": "Giulia",
            "clean_nick": clean_nick,
            "pin_hash": legacy_hash,
            "share_code": "GIU123",
            "config": {}
        })

        # Login with correct PIN
        h = MockProfileHandler("PUT", "/api/profile", body={"nickname": "Giulia", "pin": pin})
        self.assertEqual(h.response_status, 200)

        # Verify account in Redis was automatically upgraded to PBKDF2
        upgraded = self.redis.get(f"account:{clean_nick}")
        self.assertTrue(upgraded["pin_hash"].startswith("pbkdf2:sha256:100000$"))
        # Verify recovery code hash was also automatically generated
        self.assertTrue(upgraded["recovery_code_hash"])

    def test_rate_limiting_login_and_recovery(self):
        # Create user
        MockProfileHandler("POST", "/api/profile", body={"nickname": "Luca", "pin": "1111"})

        # 5 failed attempts -> 403
        for i in range(5):
            h_fail = MockProfileHandler("PUT", "/api/profile", body={"nickname": "Luca", "pin": "9999"})
            self.assertEqual(h_fail.response_status, 403)

        # 6th attempt is blocked -> 429 Too Many Requests
        h_limit = MockProfileHandler("PUT", "/api/profile", body={"nickname": "Luca", "pin": "9999"})
        self.assertEqual(h_limit.response_status, 429)
        self.assertIn("Troppi tentativi", h_limit.get_json()["error"])

        # Rate limit reset upon clearing or successful login (reset counter manually to test success)
        profile_module._reset_failed_attempts("luca", "login")
        h_ok = MockProfileHandler("PUT", "/api/profile", body={"nickname": "Luca", "pin": "1111"})
        self.assertEqual(h_ok.response_status, 200)

    def test_session_bearer_token_and_logout(self):
        # Register user
        h_reg = MockProfileHandler("POST", "/api/profile", body={"nickname": "Sara", "pin": "2222"})
        session_token = h_reg.get_json()["session_token"]
        share_code = h_reg.get_json()["share_code"]

        # Authenticated lookup via GET /api/profile?me=1 with Bearer token
        h_me = MockProfileHandler("GET", "/api/profile?me=1", headers={"Authorization": f"Bearer {session_token}"})
        self.assertEqual(h_me.response_status, 200)
        self.assertEqual(h_me.get_json()["nickname"], "Sara")

        # Background sync via PUT with Bearer token without requiring PIN
        h_sync = MockProfileHandler(
            "PUT",
            "/api/profile",
            headers={"Authorization": f"Bearer {session_token}"},
            body={"config": {"anno": 3, "indirizzo": "Informatica"}}
        )
        self.assertEqual(h_sync.response_status, 200)
        self.assertEqual(h_sync.get_json()["config"]["anno"], 3)

        # Logout via DELETE /api/profile
        h_del = MockProfileHandler("DELETE", "/api/profile", headers={"Authorization": f"Bearer {session_token}"})
        self.assertEqual(h_del.response_status, 200)

        # Subsequent authenticated request fails with 401
        h_me_after = MockProfileHandler("GET", "/api/profile?me=1", headers={"Authorization": f"Bearer {session_token}"})
        self.assertEqual(h_me_after.response_status, 401)

    def test_pin_reset_with_recovery_code(self):
        # Create user
        h_reg = MockProfileHandler("POST", "/api/profile", body={"nickname": "Paolo", "pin": "3333"})
        rec_code = h_reg.get_json()["recovery_code"]

        # Reset PIN using wrong recovery code -> 403
        h_bad = MockProfileHandler("POST", "/api/profile", body={
            "action": "reset_pin",
            "nickname": "Paolo",
            "recovery_code": "REC-WRONG-CODE",
            "new_pin": "7777"
        })
        self.assertEqual(h_bad.response_status, 403)

        # Reset PIN using valid recovery code -> 200
        h_reset = MockProfileHandler("POST", "/api/profile", body={
            "action": "reset_pin",
            "nickname": "Paolo",
            "recovery_code": rec_code,
            "new_pin": "7777"
        })
        self.assertEqual(h_reset.response_status, 200)
        data_reset = h_reset.get_json()
        self.assertTrue(data_reset["recovery_code"].startswith("REC-"))
        new_session = data_reset["session_token"]

        # Login with old PIN fails
        h_old = MockProfileHandler("PUT", "/api/profile", body={"nickname": "Paolo", "pin": "3333"})
        self.assertEqual(h_old.response_status, 403)

        # Login with new PIN succeeds
        h_new = MockProfileHandler("PUT", "/api/profile", body={"nickname": "Paolo", "pin": "7777"})
        self.assertEqual(h_new.response_status, 200)


# ════════════════════════════════════════════════════════════════════════════════
# Test Suite: Multi-Group Study Calendars & Access Control
# ════════════════════════════════════════════════════════════════════════════════

class TestMultiGroupAPI(unittest.TestCase):
    def setUp(self):
        self.redis = InMemoryRedis()
        profile_module.redis_get = self.redis.get
        profile_module.redis_set = self.redis.set
        profile_module.redis_del = self.redis.delete
        group_module.redis_get = self.redis.get
        group_module.redis_set = self.redis.set
        group_module.redis_del = self.redis.delete

        # Create two test users: Alice & Bob
        h_a = MockProfileHandler("POST", "/api/profile", body={"nickname": "Alice", "pin": "1234"})
        self.alice_token = h_a.get_json()["session_token"]
        self.alice_code = h_a.get_json()["share_code"]

        h_b = MockProfileHandler("POST", "/api/profile", body={"nickname": "Bob", "pin": "5678"})
        self.bob_token = h_b.get_json()["session_token"]
        self.bob_code = h_b.get_json()["share_code"]

    def test_zero_group_initial_state(self):
        # Alice starts with zero groups
        h = MockGroupHandler("GET", f"/api/group?user={self.alice_code}")
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        self.assertEqual(data["groups"], [])
        self.assertIsNone(data["group"])

    def test_auth_required_for_mutations(self):
        # Trying to create group without session token -> 401
        h = MockGroupHandler("POST", "/api/group", body={"action": "create_group", "name": "Studio"})
        self.assertEqual(h.response_status, 401)

    def test_create_and_join_group(self):
        # Alice creates "Gruppo Studio Analisi"
        h_create = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "create_group", "name": "Gruppo Studio Analisi"}
        )
        self.assertEqual(h_create.response_status, 201)
        data_create = h_create.get_json()
        gid = data_create["group"]["id"]
        self.assertTrue(gid.startswith("G"))
        self.assertEqual(data_create["group"]["name"], "Gruppo Studio Analisi")
        self.assertEqual(data_create["group"]["creator"], self.alice_code)
        self.assertEqual(len(data_create["groups"]), 1)

        # Bob joins Alice's group
        h_join = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.bob_token}"},
            body={"action": "join_group", "group_id": gid}
        )
        self.assertEqual(h_join.response_status, 200)
        data_join = h_join.get_json()
        members = [m["share_code"] for m in data_join["members"]]
        self.assertIn(self.alice_code, members)
        self.assertIn(self.bob_code, members)

        # Bob's user groups list now has this group
        h_b_groups = MockGroupHandler("GET", f"/api/group?user={self.bob_code}")
        self.assertEqual(len(h_b_groups.get_json()["groups"]), 1)

    def test_rename_group_permissions(self):
        # Alice creates group
        h_create = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "create_group", "name": "Vecchi Appunti"}
        )
        gid = h_create.get_json()["group"]["id"]

        # Bob (not a member yet) tries to rename -> 403 Forbidden
        h_nonmember = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.bob_token}"},
            body={"action": "rename_group", "group_id": gid, "name": "Hacked Group"}
        )
        self.assertEqual(h_nonmember.response_status, 403)

        # Alice renames group -> 200
        h_rename = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "rename_group", "group_id": gid, "name": "Nuovi Appunti 2026"}
        )
        self.assertEqual(h_rename.response_status, 200)
        self.assertEqual(h_rename.get_json()["group"]["name"], "Nuovi Appunti 2026")

    def test_add_and_remove_member(self):
        # Alice creates group
        h_create = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "create_group", "name": "Progetto Web"}
        )
        gid = h_create.get_json()["group"]["id"]

        # Alice adds Bob via share code
        h_add = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "add_member", "group_id": gid, "friend_code": self.bob_code}
        )
        self.assertEqual(h_add.response_status, 200)
        members = [m["share_code"] for m in h_add.get_json()["members"]]
        self.assertIn(self.bob_code, members)

        # Alice removes Bob
        h_rem = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "remove_member", "group_id": gid, "remove_code": self.bob_code}
        )
        self.assertEqual(h_rem.response_status, 200)
        members_after = [m["share_code"] for m in h_rem.get_json()["members"]]
        self.assertNotIn(self.bob_code, members_after)

    def test_leave_group_and_auto_cleanup(self):
        # Alice creates group
        h_create = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "create_group", "name": "Gruppo Temporaneo"}
        )
        gid = h_create.get_json()["group"]["id"]

        # Bob joins
        MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.bob_token}"},
            body={"action": "join_group", "group_id": gid}
        )

        # Bob leaves
        h_leave_b = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.bob_token}"},
            body={"action": "leave_group", "group_id": gid}
        )
        self.assertEqual(h_leave_b.response_status, 200)
        self.assertEqual(len(h_leave_b.get_json()["groups"]), 0)

        # Group still exists with Alice
        h_check = MockGroupHandler("GET", f"/api/group?id={gid}")
        self.assertEqual(h_check.response_status, 200)

        # Alice leaves -> last member, group is automatically deleted
        h_leave_a = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "leave_group", "group_id": gid}
        )
        self.assertEqual(h_leave_a.response_status, 200)

        # Group key no longer exists
        h_check_dead = MockGroupHandler("GET", f"/api/group?id={gid}")
        self.assertEqual(h_check_dead.response_status, 404)

    def test_multi_group_edge_cases(self):
        # 1. Join non-existent group -> 404
        h_bad_join = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.bob_token}"},
            body={"action": "join_group", "group_id": "G99999"}
        )
        self.assertEqual(h_bad_join.response_status, 404)

        # 2. Add self as friend in group -> 400
        h_create = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "create_group", "name": "Gruppo Alice"}
        )
        gid = h_create.get_json()["group"]["id"]

        h_add_self = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "add_member", "group_id": gid, "friend_code": self.alice_code}
        )
        self.assertEqual(h_add_self.response_status, 400)

        # 3. Add non-existent friend -> 404
        h_add_ghost = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "add_member", "group_id": gid, "friend_code": "NONEXISTENT"}
        )
        self.assertEqual(h_add_ghost.response_status, 404)

        # 4. Rename group with empty name -> 400
        h_empty_rename = MockGroupHandler(
            "POST",
            "/api/group",
            headers={"Authorization": f"Bearer {self.alice_token}"},
            body={"action": "rename_group", "group_id": gid, "name": "   "}
        )
        self.assertEqual(h_empty_rename.response_status, 400)


class TestProfileEdgeCases(unittest.TestCase):
    def setUp(self):
        self.redis = InMemoryRedis()
        profile_module.redis_get = self.redis.get
        profile_module.redis_set = self.redis.set
        profile_module.redis_del = self.redis.delete

    def test_invalid_inputs_registration(self):
        # Empty nickname -> 400
        h1 = MockProfileHandler("POST", "/api/profile", body={"nickname": "", "pin": "1234"})
        self.assertEqual(h1.response_status, 400)

        # Too long nickname -> 400
        h2 = MockProfileHandler("POST", "/api/profile", body={"nickname": "A" * 31, "pin": "1234"})
        self.assertEqual(h2.response_status, 400)

        # Invalid PIN (letters) -> 400
        h3 = MockProfileHandler("POST", "/api/profile", body={"nickname": "Mario", "pin": "abcd"})
        self.assertEqual(h3.response_status, 400)

        # Invalid PIN (too short) -> 400
        h4 = MockProfileHandler("POST", "/api/profile", body={"nickname": "Mario", "pin": "12"})
        self.assertEqual(h4.response_status, 400)

        # Successful registration
        h5 = MockProfileHandler("POST", "/api/profile", body={"nickname": "Mario", "pin": "1234"})
        self.assertEqual(h5.response_status, 201)

        # Duplicate nickname -> 409 Conflict
        h6 = MockProfileHandler("POST", "/api/profile", body={"nickname": "Mario", "pin": "5678"})
        self.assertEqual(h6.response_status, 409)

    def test_public_share_endpoint(self):
        # Register user
        h_reg = MockProfileHandler("POST", "/api/profile", body={"nickname": "Elena", "pin": "9999", "config": {"anno": 1}})
        share_code = h_reg.get_json()["share_code"]

        # Resolve public profile by code
        h_pub = MockProfileHandler("GET", f"/api/profile?code={share_code}")
        self.assertEqual(h_pub.response_status, 200)
        data = h_pub.get_json()
        self.assertEqual(data["nickname"], "Elena")
        self.assertNotIn("pin_hash", data)
        self.assertNotIn("recovery_code", data)
        self.assertNotIn("recovery_code_hash", data)

        # Non-existent share code -> 404
        h_bad = MockProfileHandler("GET", "/api/profile?code=NOTFOUND")
        self.assertEqual(h_bad.response_status, 404)

    def test_recovery_rate_limiting(self):
        # Register user
        MockProfileHandler("POST", "/api/profile", body={"nickname": "Federico", "pin": "4444"})

        # 5 wrong recovery attempts -> 403
        for _ in range(5):
            h_fail = MockProfileHandler("POST", "/api/profile", body={
                "action": "reset_pin",
                "nickname": "Federico",
                "recovery_code": "REC-WRON-GKEY",
                "new_pin": "5555"
            })
            self.assertEqual(h_fail.response_status, 403)

        # 6th attempt is blocked with 429 Too Many Requests
        h_limit = MockProfileHandler("POST", "/api/profile", body={
            "action": "reset_pin",
            "nickname": "Federico",
            "recovery_code": "REC-WRON-GKEY",
            "new_pin": "5555"
        })
        self.assertEqual(h_limit.response_status, 429)
        self.assertIn("Troppi tentativi", h_limit.get_json()["error"])


    def test_shared_calendar_helpers(self):
        from api.shared_calendar import _get_monday, _extract_events_from_cells, _safe_ts
        self.assertEqual(_get_monday("06-10-2026"), "05-10-2026")
        self.assertEqual(_safe_ts({"timestamp": "123"}), 123)
        self.assertEqual(_safe_ts({}), 0)

        cells = [
            {"data": "05-10-2026", "nome_giorno": "lunedì", "ora_inizio": "09:00", "ora_fine": "11:00",
             "nome_insegnamento": "Analisi I", "codice_insegnamento": "MAT01", "aula": "U1-01", "docente": "Rossi", "Annullato": "0"},
            {"data": "05-10-2026", "nome_giorno": "lunedì", "ora_inizio": "11:00", "ora_fine": "13:00",
             "nome_insegnamento": "Fisica I", "codice_insegnamento": "FIS01", "aula": "U1-02", "docente": "Bianchi", "Annullato": "0"}
        ]
        evs = _extract_events_from_cells(cells, ["MAT01"])
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["course_code"], "MAT01")

        evs_all = _extract_events_from_cells(cells, None)
        self.assertEqual(len(evs_all), 2)


    def test_export_helpers(self):
        from api.export import _escape_ical, _format_ical_date, _format_csv_date, _parse_date_to_monday
        self.assertEqual(_escape_ical("Hello, world; test"), r"Hello\, world\; test")
        self.assertEqual(_format_ical_date("05-10-2026", "09:00"), "20261005T090000")
        self.assertEqual(_format_ical_date("2026-10-05", "09:00"), "20261005T090000")
        self.assertEqual(_format_ical_date("05/10/2026", "09:00"), "20261005T090000")
        self.assertEqual(_format_csv_date("05-10-2026"), "2026-10-05")
        self.assertEqual(_format_csv_date("2026-10-05"), "2026-10-05")
        self.assertEqual(_format_csv_date("05/10/2026"), "2026-10-05")
        m = _parse_date_to_monday("06-10-2026")
        self.assertEqual(m.strftime("%d-%m-%Y"), "05-10-2026")
        m_slash = _parse_date_to_monday("06/10/2026")
        self.assertEqual(m_slash.strftime("%d-%m-%Y"), "05-10-2026")


if __name__ == "__main__":
    unittest.main()

