# 📅 UNIMIB Timetable & Campus Companion

A modern, mobile-first Progressive Web App (PWA) designed for students at the **University of Milano-Bicocca (UNIMIB)**. View your weekly lecture timetable, track live classroom occupancy, inspect exam sessions, and share a synchronized schedule with friends.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-success)
![Vercel Deployed](https://img.shields.io/badge/Vercel-Production-black?logo=vercel)

---

## ✨ Features

### 1. 📅 Lecture Timetable (Orario Lezioni)
- **🎓 Any Degree Programme**: Choose academic year, didactic area, degree course, and study years (e.g. "1 - Percorso comune"). Choices are fetched live from UNIMIB's official EasyCourse system (`combo.php`), automatically supporting new curricula and degree changes.
- **⭐ My Courses Filter (I Miei Corsi)**: Select the specific teachings you attend to get distinct color badges and filter the view to display only your active courses.
- **👆 Mobile Gestures & Daily View**: Swipe or toggle between full weekly overview or day-by-day timetable with automatic current day highlighting.
- **🔍 Real-Time Search**: Instant live filtering by subject name, professor, or classroom.
- **⚠️ Cancellation Notices**: Automatically highlights canceled lectures or last-minute room changes in red.
- **🔗 Share Link & QR Code**: Generate a link or QR code containing your course configuration for instant preview and one-tap import.

### 2. 🧑‍🏫 Teacher Timetable (Calendario Docenti)
- **🔍 1,700+ Faculty Directory**: Instant real-time autocomplete search across all professors and lecturers at the University of Milano-Bicocca.
- **📅 Weekly & Semester-Wide Views**: Inspect weekly lecture schedules or toggle **"Tutti gli Eventi"** to view all scheduled dates, labs, and exercises throughout the entire semester.
- **⭐ Saved Favorite Professors**: Save your favorite professors for one-tap switching directly from the top bar without re-typing their names.
- **🎓 Multi-Degree Filter**: For professors teaching across multiple faculties, filter by specific degree programme or view all their university teaching appointments at once.
- **✉️ Direct Teacher Contacts**: View verified institutional email addresses (`@unimib.it`) with one-tap `mailto:` compose.
- **📥 One-Tap iCalendar Export (.ics)**: Download an `.ics` file for an individual lecture or export the professor's entire week with a single click.
- **🔗 Shareable Links**: Direct URLs support (`/?tab=docenti&docente=013696`) to immediately open any lecturer's timetable.

### 3. 🏛️ Classroom Occupancy (Occupazione Aule)
- **🏢 All Campus Buildings**: Real-time room status for all 26+ UNIMIB buildings (U01 through U28).
- **🟢 Status at a Glance**: Instant visual badges indicating whether a room is **Libera** (Free) or **Occupata** (Occupied).
- **⏳ Smart Time Windows**: Computes exact availability (*"Libera fino alle 14:30"* or *"Occupata fino alle 16:30"*), automatically chaining consecutive contiguous lectures.
- **⏰ Time Slots & Italian Date Picker**: Check occupancy right now or inspect specific time blocks (09:00, 11:00, 13:00, 14:30, 16:30) for any date in Italian format (`GG/MM/AAAA`).
- **📋 Full Daily Schedule**: Tap any classroom card to open a modal displaying the complete chronological list of lectures and bookings held in that room for the selected day.

### 4. 📝 Exam Calendar (Calendario Esami)
- **🎓 Monitored Courses**: Automatically imports exam dates for your degree and allows adding extra courses from any didactic area across the university.
- **⭐ Personalized Exam Filter**: Switch between **"📚 Tutti gli Appelli"** (all exams for the degree) and **"⭐ I Miei Corsi"** (only exams matching the teachings you actually attend).
- **🗓️ Session Filters**: Quick presets for Winter (*Invernale*), Summer (*Estiva*), Autumn (*Autunnale*), or Custom Date Range.
- **📅 Add to Calendar (.ics)**: Download an `.ics` file for any exam appeal to import it directly into Apple Calendar, Google Calendar, or Outlook.

### 5. 👤 Cloud Profile & Zero-Friction OWASP Authentication
- **🔑 Zero-Friction Auth (Nickname + PIN)**: No email or password needed. Create an account with your chosen **Soprannome** (e.g. `Mario`) and a 4-8 digit **PIN** (e.g. `1234`).
- **🛡️ OWASP-Compliant Security**:
  - **PBKDF2-HMAC-SHA256**: Key stretching with 100,000 iterations and 16-byte random per-user salt (`pbkdf2:sha256:100000$<salt>$<key>`). Constant-time comparison via `hmac.compare_digest`.
  - **Automatic Legacy Upgrade**: Transparent backward-compatibility that automatically migrates legacy SHA-256 accounts to PBKDF2 on their next login.
  - **256-Bit Sliding Session Tokens**: Generates opaque tokens (`st_...`) with a 90-day sliding TTL in Redis. Transmitted via `Authorization: Bearer <token>` and preserved in `localStorage`, enabling secure background study plan synchronization across page refreshes without holding PINs in client storage.
  - **Brute-Force Rate Limiting**: Enforces a strict threshold of 5 failed attempts per 10-minute window per nickname, returning `HTTP 429 Too Many Requests` on violation.
  - **One-Time Account Recovery Key**: Issues an unguessable recovery key (`REC-XXXX-XXXX`) at profile registration. Users who forget their PIN can securely reset it via the recovery key without losing their courses or group memberships.
- **📚 Guided Study Plan Onboarding (2-Step Flow)**: When creating a profile, users are guided to select degree programme, study year, and active teachings (⭐ I miei corsi), or save an existing guest configuration in 1 tap.
- **📱 Multi-Device Sync**: Log in on any device (iPhone, laptop, tablet) simply by entering your Soprannome and PIN. Your study plan, favorite courses, and monitored exams sync automatically.

### 6. 👥 Multi-Group Shared Calendars (Gruppi di Studio & Calendari Condivisi)
- **👥 Multiple Groups per Student**: Belong to multiple distinct study groups simultaneously (e.g. *"Gruppo Studio Analisi"*, *"Gruppo Progetto Informatica"*, *"Tesi di Laurea"*).
- **✨ Clean Initial State**: New profiles start with zero groups (`[]`), presenting an empty state with two intuitive actions: **"+ Crea un gruppo"** or **"🤝 Unisciti con un codice"**.
- **🔄 Instant Group Switcher**: Switch effortlessly between active groups via the header dropdown selector. Switching groups updates member chips, merges overlapping schedules, and calculates shared free slots in real time.
- **✏️ Group Management & Access Control**:
  - **Rename Group**: Any group member can rename the group.
  - **Leave Group & Auto-Cleanup**: Members can leave a group at any time. When the last member departs, the group is automatically purged from Redis to prevent orphaned records.
  - **Permission Enforcement**: All group mutations require valid session token authentication, and non-members are prohibited from modifying or renaming groups (`HTTP 403 Forbidden`).
- **🔗 Invite Codes & Deep Links**: Groups have persistent codes (e.g. `G7K2P9`) and shareable links (e.g. `/?group=G7K2P9`). Opening a group link immediately adds the group to your active profile.
- **⭐ Favorites-Only Sharing**: Only active teachings (⭐ I miei corsi) of group members are shared, keeping group timetables focused.
- **👤 Include Yourself ("👤 Includi me")**: Overlay your own schedule alongside your peers' timetables with a distinct "Io 👤" badge and teal highlights.
- **🏷️ Merged Identical Lectures**: Overlapping courses attended by multiple students in the same room are consolidated into a single card with all attendee badges (e.g. `[Io 👤] [Mario] [Luca]`).
- **📊 Daily Timeline Grid (08:30 – 18:30)**: Visual vertical time grid with parallel lanes for simultaneous lectures and current-time indicators.
- **🟢 Free Slots Calculator**: Computes common windows (≥ 30 min) where **all** members are free between 08:30 and 18:30 for study sessions or lunch breaks.

### 7. 📱 iOS & Mobile Optimizations
- **Safe Area Inset Support**: Fully accounts for iPhone notch, Dynamic Island, and home indicator bars (`env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`).
- **Compact Header Breakpoints**: Responsive adjustments for narrower screens (e.g. iPhone SE / mini) to keep all navigation buttons accessible.
- **PWA Offline Caching**: Service Worker v15 caches core application assets for fast load times and offline readiness.

---

## 🔒 Privacy & Architecture Model

```mermaid
flowchart TD
    subgraph PrivateAccount ["Private Account (OWASP Compliant)"]
        A["Soprannome + PIN"] -->|PBKDF2-HMAC-SHA256 (100k iters)| B["Redis: account:clean_nick"]
        B --> C["256-bit Sliding Session Token (st_...)"]
        B --> D["One-Time Recovery Key (REC-XXXX-XXXX)"]
        B --> E["Rate Limiter (5 attempts / 10 min)"]
        C --> F["Bearer Token Background Sync"]
    end

    subgraph PublicShare ["Public Friend Sharing (Read-Only)"]
        B -->|Generates| G["6-Char Share Code (e.g. K9X2P4)"]
        G --> H["Redis: share:share_code"]
        H --> I["Nickname + Courses (NO PIN, NO Credentials)"]
    end

    subgraph MultiGroups ["Multi-Group Data Model"]
        C -->|Authenticated Mutations| J["Redis: user_groups:share_code"]
        J --> K["Group 1: group:G9X2P4"]
        J --> L["Group 2: group:G3M1P8"]
        K --> M["Members: [Alice, Bob, Marco]"]
        M --> N["Merged Timetable & Free Slots"]
    end
```

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla ES6+ JavaScript, Responsive CSS3 (Glassmorphism, Mobile-First, iOS Safe Area support).
- **PWA**: Service Worker cache strategy (`sw.js`) and Web App Manifest (`manifest.json`) for native-like installation on iOS & Android.
- **Backend / Scrapers**: Python serverless functions (standard library `urllib`, `json`, `zoneinfo`, zero external dependencies).
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
│   ├── shared_calendar.py  # Combined multi-student timetable generator
│   ├── teachers.py         # Teacher directory and weekly schedule scraper
│   └── group.py            # Synchronized cloud study groups & bidirectional friend linking
├── public/
│   ├── css/
│   │   └── style.css       # Responsive dark-theme & glassmorphism styles
│   ├── js/
│   │   ├── app.js          # Main SPA application logic & state management
│   │   └── sw.js           # PWA Service Worker (offline cache v14)
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
| `GET` | `/api/calendar` | Returns lessons for selected degree course and study years for a given week (`date=DD-MM-YYYY`) |
| `GET` | `/api/teachers` | Returns 1700+ UNIMIB faculty directory (`?anno=YYYY`), or lecturer timetable (`?docente=<CODE>&date=DD-MM-YYYY&all_events=1`) |
| `GET` | `/api/rooms` | Returns real-time room occupancy and daily schedule for a campus building (`sede=U01`, `date=DD-MM-YYYY` or `YYYY-MM-DD`, `time=HH:MM`) |
| `GET` | `/api/exams` | Returns upcoming exam appeals filtered by degree courses, years, and date range |
| `POST` | `/api/profile` | Creates a new account (`{ nickname, pin, config, exam_courses }`) and returns generated `share_code` |
| `PUT` | `/api/profile` | Authenticates / updates account (`{ nickname, pin, config?, exam_courses? }`) and syncs cloud schedule |
| `GET` | `/api/profile?code=<CODE>` | Fetches friend's public schedule and nickname using their 6-char share code |
| `GET` | `/api/shared_calendar?codes=C1,C2` | Returns merged weekly timetable for multiple student share codes |
| `GET` | `/api/group?user=<CODE>` or `?id=<GID>` | Fetches cloud group information and all member profiles |
| `POST` | `/api/group` | Manages cloud groups: `add_member`, `sync`, `remove_member`, `join_group`, `rename_group` |

---

## 🧪 Edge Cases & Verification

The backend includes a comprehensive edge case test suite covering:
1. **Accents and Diacritics**: Proper Unicode NFKD normalization (`Nicolò` → `nicolo`, `Élena` → `elena`) ensuring account identifiers are consistent while preserving displayed nicknames.
2. **PIN Validation**: Enforces strictly 4-8 ASCII digits, safely handling leading zeros (`0123`), rejecting non-ASCII digits (`①②③④`), and preventing string/number type errors.
3. **Date Formats**: Accepts both Italian `DD-MM-YYYY` and ISO `YYYY-MM-DD` interchangeably, correctly normalising weekend dates (Saturday/Sunday) to the active academic week's Monday.
4. **Time & Contiguous Bookings**: Accurate Italy timezone calculation (`Europe/Rome` with DST handling) and automatic chaining of back-to-back lectures within 15 minutes.
5. **Exam Multi-Curricula Parsing**: Regex-based splitting supporting both `//` and `/` delimiters across multi-degree exam appeals.
6. **Safe Sorting**: Robust timestamp extraction preventing mixed-type comparison errors (`TypeError: '<' not supported between instances of 'int' and 'str'`).

Run the test suite locally:
```bash
python3 -m unittest scratch/test_edge_cases.py
```

---

## 🚀 Environment Variables (Vercel)

To enable cloud profiles and shared friend calendars, configure the following environment variables in your Vercel project (**Settings** → **Environment Variables**):

| Variable | Description |
| :--- | :--- |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST bearer token |

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
