# 📅 UNIMIB Timetable & Campus Companion

A modern, mobile-first Progressive Web App (PWA) designed for students at the **University of Milano-Bicocca (UNIMIB)**. View your weekly lecture timetable, track live classroom occupancy, inspect exam sessions, and share a synchronized schedule with friends.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-success)
![Vercel Deployed](https://img.shields.io/badge/Vercel-Production-black?logo=vercel)

---

## ✨ Features

### 1. 📅 Lecture Timetable (Orario Lezioni)
- **🎓 Any Degree Programme**: Choose academic year, didactic area, degree course, and study years (e.g. "1 - Percorso comune"). Choices are fetched live from UNIMIB's official EasyCourse system (`combo.php`), automatically supporting new curricula.
- **⭐ My Courses Filter (I Miei Corsi)**: Select the specific teachings you follow to get distinct color badges and filter the view to display only your active courses.
- **👆 Mobile Gestures & Daily View**: Swipe or toggle between full weekly overview or day-by-day timetable.
- **🔍 Real-Time Search**: Instant live filtering by subject name, professor, or classroom.
- **⚠️ Cancellation Notices**: Automatically highlights canceled lectures or last-minute changes in red.
- **🔗 Share Link & QR Code**: Generate a link or QR code containing your course configuration for instant preview and one-tap import.

### 2. 🏛️ Classroom Occupancy (Occupazione Aule)
- **🏢 All Campus Buildings**: Real-time room status for all UNIMIB buildings (U01 through U28).
- **🟢 Status at a Glance**: Instant visual badges indicating whether a room is **Libera** (Free) or **Occupata** (Occupied), including how long it remains free or occupied.
- **⏰ Time Slots & Date Picker**: Check occupancy right now or inspect specific time blocks (09:00, 11:00, 13:00, 14:30, 16:30) for any date.
- **📋 Full Daily Schedule**: Tap any classroom to view the complete chronological list of lectures held in that room for the selected day.

### 3. 📝 Exam Calendar (Calendario Esami)
- **🎓 Monitored Courses**: Automatically imports exam dates for your degree and allows adding extra courses from any didactic area.
- **⭐ Personalized Exam Filter**: Switch between **"📚 Tutti gli Appelli"** (all exams for the degree) and **"⭐ I Miei Corsi"** (only exams matching the teachings you actually attend).
- **🗓️ Session Filters**: Quick presets for Winter (*Invernale*), Summer (*Estiva*), Autumn (*Autunnale*), or Custom Date Range.
- **📅 Add to Calendar (.ics)**: Download an `.ics` file for any exam appeal to import it directly into Apple Calendar, Google Calendar, or Outlook.

### 4. 👤 Cloud Profile & Synchronisation (No Complex Passwords)
- **🔑 Memorable Auth (Nickname + PIN)**: No email or password needed. Create an account with your chosen **Soprannome** (e.g. `Mario`) and a 4-8 digit **PIN** (e.g. `1234`).
- **📱 Multi-Device Sync**: Log in on any device (iPhone, laptop, tablet) simply by entering your Soprannome and PIN. Your study plan, favorite courses, and monitored exams sync automatically.
- **⚡ First-Visit Onboarding**: First-time visitors can choose to create a profile, log in to restore an existing plan, or **Continua come ospite** (Guest mode) to start immediately without registration.
- **☁️ Serverless Storage**: Backed by **Upstash Redis REST API**, salted with SHA-256 for secure PIN verification.

### 5. 👥 Friends Shared Calendar (Calendario Amici)
- **🔒 Privacy First (Zero Leaked Credentials)**: Your PIN remains private for your own devices. The system generates a distinct, anonymous 6-character **Codice Calendario Univoco** (e.g. `K9X2P4`) used exclusively for sharing with friends.
- **🔗 Instant Link or Code Sharing**: Add friends by entering their 6-character calendar code, or send them a direct link (e.g. `/?friend=K9X2P4`) which automatically adds them to their calendar with a single tap.
- **🤝 Compare Timetables**: See your schedule and your friends' schedules combined on a single weekly calendar with distinct color-coded badges to easily spot common free hours and overlapping classes.
- **👥 One-Tap Group Links**: Click **🔗 Condividi Gruppo** to generate a link (e.g. `/?group=K9X2P4,W3M7R2`) so an entire study group can load all friends at once.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla ES6+ JavaScript, Responsive CSS3 (Glassmorphism, Mobile-First, iOS Safe Area support).
- **PWA**: Service Worker cache strategy (`sw.js`) and Web App Manifest (`manifest.json`) for native-like installation on iOS & Android.
- **Backend / Scrapers**: Python serverless functions (standard library `urllib` & `json`, zero external dependencies).
- **Database**: Upstash Redis (Serverless REST API) for profile preferences and friend indices.
- **Hosting & CI/CD**: Vercel Serverless Functions.

---

## 📂 Project Structure

```
.
├── api/
│   ├── calendar.py         # Weekly timetable scraper (grid_call.php)
│   ├── exams.py            # Exam appeals scraper (bookings_call.php)
│   ├── options.py          # Degree dropdown data (combo.php)
│   ├── profile.py          # Profile management & PIN authentication (Upstash Redis)
│   ├── rooms.py            # Live classroom occupancy scraper
│   └── shared_calendar.py  # Combined multi-student timetable generator
├── public/
│   ├── css/
│   │   └── style.css       # Responsive dark-theme & glassmorphism styles
│   ├── js/
│   │   ├── app.js          # Main SPA application logic & state management
│   │   └── sw.js           # PWA Service Worker (offline cache)
│   ├── icons/              # App icons for iOS / Android home screens
│   ├── index.html          # Single Page Application HTML template
│   └── manifest.json       # Web App Manifest
├── vercel.json             # Vercel serverless rewrites and routing
├── .gitignore
└── README.md
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/options` | Returns academic years, didactic areas, degree courses, and study years |
| `GET` | `/api/calendar` | Returns lessons for selected degree course and study years for a given week |
| `GET` | `/api/rooms` | Returns real-time room occupancy and daily schedule for a campus building |
| `GET` | `/api/exams` | Returns upcoming exam appeals filtered by degree courses, years, and date range |
| `POST` | `/api/profile` | Creates a new account (`{ nickname, pin, config, exam_courses }`) and returns generated `share_code` |
| `PUT` | `/api/profile` | Authenticates / updates account (`{ nickname, pin, config?, exam_courses? }`) and syncs cloud schedule |
| `GET` | `/api/profile?code=<CODE>` | Fetches friend's public schedule and nickname using their 6-char share code |
| `GET` | `/api/shared_calendar?codes=C1,C2` | Returns merged weekly timetable for multiple student share codes |

---

## 🚀 Environment Variables (Vercel)

To enable the cloud profile and shared friends calendar, configure the following environment variables in your Vercel project (**Settings** → **Environment Variables**):

| Variable | Description |
| :--- | :--- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST bearer token |

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
