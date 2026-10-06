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


if __name__ == "__main__":
    unittest.main()
