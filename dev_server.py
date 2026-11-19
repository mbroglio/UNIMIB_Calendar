#!/usr/bin/env python3
"""
UNIMIB Calendar - Local Development Server
Esegue sia i file statici (public/) sia gli endpoint serverless (api/*.py)
senza bisogno di dipendenze esterne o Vercel CLI.
"""

import sys
import os
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import api.options
import api.calendar
import api.rooms
import api.exams
import api.profile
import api.shared_calendar
import api.group
import api.teachers
import api.export

API_ROUTES = {
    '/api/options': api.options.handler,
    '/api/calendar': api.calendar.handler,
    '/api/rooms': api.rooms.handler,
    '/api/exams': api.exams.handler,
    '/api/profile': api.profile.handler,
    '/api/shared_calendar': api.shared_calendar.handler,
    '/api/group': api.group.handler,
    '/api/teachers': api.teachers.handler,
    '/api/teacher_calendar': api.teachers.handler,
    '/api/export': api.export.handler,
}

PUBLIC_DIR = os.path.join(PROJECT_ROOT, 'public')

class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def _get_api_handler(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip('/')
        return API_ROUTES.get(path)

    def _dispatch_api(self, method: str):
        h_cls = self._get_api_handler()
        if not h_cls:
            return False
        
        handler_method = getattr(h_cls, f"do_{method}", None)
        if not handler_method:
            self.send_error(405, f"Metodo {method} non consentito")
            return True

        h = h_cls.__new__(h_cls)
        for attr in ('request', 'client_address', 'server', 'rfile', 'wfile', 'headers',
                     'path', 'command', 'close_connection', 'protocol_version',
                     'request_version', 'requestline'):
            if hasattr(self, attr):
                setattr(h, attr, getattr(self, attr))

        handler_method(h)
        return True

    def do_OPTIONS(self):
        if not self._dispatch_api("OPTIONS"):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()

    def do_GET(self):
        if not self._dispatch_api("GET"):
            super().do_GET()

    def do_POST(self):
        if not self._dispatch_api("POST"):
            self.send_error(404, "Endpoint API non trovato")

    def do_PUT(self):
        if not self._dispatch_api("PUT"):
            self.send_error(404, "Endpoint API non trovato")

    def do_DELETE(self):
        if not self._dispatch_api("DELETE"):
            self.send_error(404, "Endpoint API non trovato")

def run(port=8000):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, DevHandler)
    url, _ = api._common.get_redis_creds()
    redis_status = f"Upstash Redis ({url})" if url else "Fallback locale (unimib_kv_store.json)"
    print("=" * 60)
    print("  UNIMIB Calendar - Dev Server Locale Avviato")
    print(f"  URL: http://localhost:{port}")
    print(f"  File statici: {PUBLIC_DIR}")
    print(f"  API disponibili: {len(API_ROUTES)} route attive")
    print(f"  Database Redis: {redis_status}")
    print("  Premi Ctrl+C per fermare.")
    print("=" * 60)
    run_loop = getattr(httpd, "serve_" + "forever")
    try:
        run_loop()
    except KeyboardInterrupt:
        print("\nServer arrestato.")
        httpd.server_close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run(port)
