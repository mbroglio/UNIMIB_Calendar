# 📅 UNIMIB Timetable & Campus Companion

A mobile-friendly Progressive Web App (PWA) for students at the **University of Milano-Bicocca (UNIMIB)**.
View lecture timetables, check real-time classroom occupancy, track exam sessions, search professors, export to calendar apps, and coordinate study groups.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-success)
![Vercel Deployed](https://img.shields.io/badge/Vercel-Production-black?logo=vercel)

---

## ✨ Features

- **📅 Lecture Timetables**: View weekly schedules for any degree programme and year of study. Highlight followed courses (*"I Miei Corsi"*) and spot cancelled lectures automatically.
- **🏛️ Classroom Occupancy**: Real-time room status across all campus buildings (U1–U28). See whether an aula is free or occupied and until what time.
- **🧑‍🏫 Professor Schedules**: Directory search across UNIMIB faculty with weekly lecture schedules, semester events, and institutional contact info.
- **📝 Exam Calendar**: Track upcoming exam appeals for your degree with session filters (Winter, Summer, Autumn) and individual calendar downloads.
- **👥 Study Groups & Shared Calendars**: Create or join multiple study groups via code or link. View combined schedules, overlapping courses, and automatic common free slots to coordinate study sessions or lunch breaks.
- **📥 Calendar Export & WebCal**: Export schedules to iCalendar (`.ics`), CSV (Excel), or JSON. Subscribe via a live WebCal feed (`webcal://`) to automatically sync with Apple Calendar, Google Calendar, or Outlook.
- **👤 Cloud Profile & Multi-Device Sync**: Optional lightweight account (nickname + PIN) backed by Redis to keep your courses, exams, and group memberships in sync across devices.
- **📱 Mobile-First PWA**: Dark mode, swipe gestures, and offline support via Service Worker.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES6+), CSS3 (Mobile-First responsive dark theme), PWA Service Worker.
- **Backend**: Python serverless functions on Vercel (`api/*.py`, Python standard library only).
- **Storage**: Upstash Redis (REST API) for user profiles and shared groups.
- **Scraper Source**: Live queries to official UNIMIB EasyCourse endpoints (`grid_call.php`, `combo.php`, `bookings_call.php`).

---

## 📂 Project Structure

```
.
├── api/
│   ├── calendar.py         # Weekly lecture schedule scraper
│   ├── exams.py            # Exam appeals scraper
│   ├── export.py           # .ics, .csv, .json, and WebCal export engine
│   ├── group.py            # Study groups and membership management
│   ├── options.py          # Degree and course options dropdown data
│   ├── profile.py          # User profile sync and PIN authentication
│   ├── rooms.py            # Real-time classroom occupancy scraper
│   ├── shared_calendar.py  # Combined multi-student timetable generator
│   └── teachers.py         # Faculty directory and professor timetables
├── public/
│   ├── css/
│   │   └── style.css       # Responsive dark-theme styling
│   ├── js/
│   │   ├── app.js          # SPA logic, state management, and export helpers
│   │   └── sw.js           # PWA Service Worker (offline asset cache)
│   ├── icons/              # App icons (PWA)
│   ├── index.html          # SPA entry point
│   └── manifest.json       # Web App Manifest
├── scratch/
│   └── test_edge_cases.py  # Backend unit tests
├── vercel.json             # Serverless routing and rewrites
└── README.md
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/options` | Academic years, departments, degree programmes, and study years |
| `GET` | `/api/calendar` | Weekly lectures for degree and study year (`date=DD-MM-YYYY`) |
| `GET` | `/api/rooms` | Classroom occupancy and day schedule for a building (`sede=U01`) |
| `GET` | `/api/exams` | Exam appeals filtered by course and session |
| `GET` | `/api/teachers` | Faculty directory search (`?anno=YYYY`) or teacher schedule (`?docente=ID`) |
| `GET` | `/api/export` | Calendar export in `.ics`, `.csv`, `.json`, or WebCal feed |
| `GET` | `/api/shared_calendar` | Merged weekly timetable for multiple student codes |
| `GET, POST` | `/api/group` | Group creation, join, leave, rename, and member listings |
| `GET, POST, PUT` | `/api/profile` | Profile creation, authentication, PIN recovery, and cloud sync |

---

## 🚀 Getting Started

### Local Development

Run the frontend and serverless API locally using the [Vercel CLI](https://vercel.com/docs/cli):

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Start local development server
vercel dev
```

The app will be available at `http://localhost:3000`.

### Running Tests

Run the Python unit test suite:

```bash
python3 -m unittest scratch/test_edge_cases.py
```

### Environment Variables

To enable cloud profiles and study group syncing, configure your Upstash Redis credentials in `.env.local` (or in Vercel Project Settings):

| Variable | Description |
| :--- | :--- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST bearer token |

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
