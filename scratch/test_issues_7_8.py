import unittest
import io
import json
import urllib.parse
from datetime import datetime, timedelta
import importlib.util

# Load api modules
def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

api_cal = load_module("api_cal", "api/calendar.py")
api_export = load_module("api_export", "api/export.py")
api_shared = load_module("api_shared", "api/shared_calendar.py")


class MockCalendarHandler(api_cal.handler):
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


class MockExportHandler(api_export.handler):
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

    def get_body(self):
        return self.output.getvalue().decode("utf-8")


class TestIssue7ExternalCoursesCalendar(unittest.TestCase):
    def test_calendar_with_extra_courses(self):
        # Academic year 2024 has reliable historical data
        # Main course: Informatica 2° anno (F1801Q, GGG|2)
        # Extra course: Fisica 1° anno (F1701Q, F1701Q-003|1, code EC498679 METODI MATEMATICI DELLA FISICA)
        extra = [
            {
                "anno": "2024",
                "corso": "F1701Q",
                "corsoLabel": "FISICA",
                "anno2": "F1701Q-003|1",
                "code": "EC498679",
                "label": "METODI MATEMATICI DELLA FISICA"
            }
        ]
        extra_json = json.dumps(extra)
        path = f"/api/calendar?anno=2024&corso=F1801Q&anno2=GGG%7C2&date=07-10-2024&extra={urllib.parse.quote(extra_json)}"
        h = MockCalendarHandler(path)
        self.assertEqual(h.response_status, 200)
        data = h.get_json()

        self.assertIn("events", data)
        self.assertGreater(len(data["events"]), 0)

        # Check that both main and external events exist
        main_events = [e for e in data["events"] if not e.get("is_external")]
        ext_events = [e for e in data["events"] if e.get("is_external")]

        self.assertGreater(len(main_events), 0, "Main course events should be present")
        self.assertGreater(len(ext_events), 0, "External course events should be present")

        # Verify external event properties
        for ev in ext_events:
            self.assertTrue(ev["is_external"])
            self.assertEqual(ev["course_code"], "EC498679")
            self.assertEqual(ev["external_corso"], "FISICA")

    def test_calendar_without_extra(self):
        path = "/api/calendar?anno=2024&corso=F1801Q&anno2=GGG%7C2&date=07-10-2024"
        h = MockCalendarHandler(path)
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        ext_events = [e for e in data["events"] if e.get("is_external")]
        self.assertEqual(len(ext_events), 0)

    def test_calendar_with_invalid_extra_gracefully_ignored(self):
        path = "/api/calendar?anno=2024&corso=F1801Q&anno2=GGG%7C2&date=07-10-2024&extra=not-valid-json"
        h = MockCalendarHandler(path)
        self.assertEqual(h.response_status, 200)
        data = h.get_json()
        self.assertIn("events", data)


class TestIssue7ExternalCoursesExport(unittest.TestCase):
    def test_export_ics_with_extra(self):
        extra = [
            {
                "anno": "2024",
                "corso": "F1701Q",
                "anno2": "F1701Q-003|1",
                "code": "EC498679",
                "label": "METODI MATEMATICI DELLA FISICA"
            }
        ]
        extra_json = json.dumps(extra)
        path = f"/api/export?anno=2024&corso=F1801Q&anno2=GGG%7C2&date=07-10-2024&format=ics&weeks=1&filter=all&extra={urllib.parse.quote(extra_json)}"
        h = MockExportHandler(path)
        self.assertEqual(h.response_status, 200)
        ics_text = h.get_body()
        self.assertIn("BEGIN:VCALENDAR", ics_text)
        self.assertIn("METODI MATEMATICI DELLA FISICA", ics_text)

    def test_export_csv_with_extra(self):
        extra = [
            {
                "anno": "2024",
                "corso": "F1701Q",
                "anno2": "F1701Q-003|1",
                "code": "EC498679"
            }
        ]
        extra_json = json.dumps(extra)
        path = f"/api/export?anno=2024&corso=F1801Q&anno2=GGG%7C2&date=07-10-2024&format=csv&weeks=1&filter=all&extra={urllib.parse.quote(extra_json)}"
        h = MockExportHandler(path)
        self.assertEqual(h.response_status, 200)
        csv_text = h.get_body()
        self.assertIn("METODI MATEMATICI DELLA FISICA", csv_text)


class TestIssue8DateHelpers(unittest.TestCase):
    def test_get_monday(self):
        dt = datetime(2026, 10, 8)  # Thursday
        monday = api_cal.get_monday(dt)
        self.assertEqual(monday.strftime("%d-%m-%Y"), "05-10-2026")

        sunday = datetime(2026, 10, 11)  # Sunday
        mon_sunday = api_cal.get_monday(sunday)
        self.assertEqual(mon_sunday.strftime("%d-%m-%Y"), "05-10-2026")


if __name__ == "__main__":
    unittest.main()
