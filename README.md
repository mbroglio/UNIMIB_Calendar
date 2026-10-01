# 📅 UNIMIB Timetable App

A modern, mobile-first Web Application and Progressive Web App (PWA) designed to scrape and display the weekly course timetable of **any degree programme and year of study** at the **University of Milano-Bicocca (UNIMIB)**.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-success)

---

## ✨ Features

- **🎓 Any Course of Study**: On first launch (and anytime via ⚙️) pick *academic year*, *didactic area*, *course of study* and one or more *years of study* (e.g. "2 - PERCORSO COMUNE", "2 - T1 - Monza e Teledidattica"). All choices are loaded live from the same data that feeds the dropdowns of the [official "By degree" form](https://gestioneorari.didattica.unimib.it/PortaleStudentiUnimib/index.php?view=easycourse&_lang=en&include=corso) (`combo.php`), so new years and courses appear automatically.
- **⭐ My Courses Highlight**: Choose your own courses (teachings) from the selected years to get color-coded cards and a dedicated "I Miei Corsi" filter.
- **🔗 Share Link**: Tap 🔗 to get a readable link (plus QR code) to your configuration, e.g. `/?anno=2026&corso=F1801Q&anno2=GGG%7C2&fav=EC523651,EC523669`. Whoever opens it sees that timetable in preview mode, without saving anything, and can then **import** it or **exit** back to their own. `anno2` is repeatable and `fav` lists the teaching codes; labels are looked up again, so no server-side storage is needed.
- **🔄 Live Dynamic Scraping**: Interrogates the official UNIMIB EasyCourse API (`grid_call.php`) on demand for any selected week.
- **📱 Mobile-First Glassmorphism UI**: Beautiful, dark-themed responsive interface optimized for smartphone screens with PWA support ("Add to Home Screen" on iOS & Android).
- **👆 Touch Gestures**: Swipe left or right on mobile devices to easily navigate between weeks or days.
- **🔍 Instant Live Search**: Filter classes in real-time by course title, professor, or room location.
- **⚠️ Class Cancellation Alerts**: Visually flags canceled or modified lectures in red.
- **⚡ Offline Caching**: Caches schedule data locally in the browser (LocalStorage & Service Worker) for instant loading even with slow internet connections.
- **☁️ Serverless & Cloud Ready**: Out-of-the-box configuration for instant 1-click deployment on **Vercel**, **Render**, or **PythonAnywhere**.

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, Modern CSS3 (Glassmorphism, Flexbox/Grid), ES6 JavaScript.
- **Backend / Scraper**: Python (Scraping engine using `urllib` & standard library `json`).
- **PWA**: Service Worker (`sw.js`) and Web App Manifest (`manifest.json`).
- **Deployment**: Vercel Serverless Functions configuration (`vercel.json`).

---

## 📂 Project Structure

```
.
├── api/
│   ├── calendar.py         # Weekly timetable scraper (grid_call.php)
│   └── options.py          # Dropdown data: academic years, areas, courses, years of study (combo.php)
├── public/
│   ├── css/
│   │   └── style.css       # Glassmorphism UI styles
│   ├── js/
│   │   ├── app.js          # App logic, state management & touch handlers
│   │   └── sw.js           # PWA Service Worker
│   ├── icons/              # App icons (192x192, 512x512)
│   ├── index.html          # Main SPA template
│   └── manifest.json       # PWA Web App Manifest
├── vercel.json             # Vercel routing configuration
├── .gitignore
└── README.md
```

---

## 🔌 API

| Endpoint | Returns |
| --- | --- |
| `GET /api/options` | Academic years |
| `GET /api/options?anno=2026` | Didactic areas and courses of study, each with its years of study |
| `GET /api/options?anno=2026&corso=F1802Q` | Label, type and area of a course, plus its years of study with their teachings |
| `GET /api/calendar?anno=2026&corso=F1802Q&anno2=GGG\|1&anno2=GGG\|2&date=29-09-2026` | Lessons of the week containing `date` for the selected years of study (`anno2` is repeatable) |

---

## 🚀 Deployment Instructions

### Option 1: Deploy to Vercel (Recommended)

1. Sign in to [Vercel](https://vercel.com).
2. Click **Add New Project** and select this repository (`UNIMIB_Calendar`).
3. Click **Deploy**.
4. Open the generated live URL (e.g., `https://your-app.vercel.app`) on your smartphone and select **Add to Home Screen**!

### Option 2: Local Development (Python Flask)

1. Clone the repository:
   ```bash
   git clone https://github.com/mbroglio/UNIMIB_Calendar.git
   cd UNIMIB_Calendar
   ```
2. Install dependencies:
   ```bash
   pip install flask
   ```
3. Run the application:
   ```bash
   python app.py
   ```
4. Access the app in your browser at `http://localhost:5000` or on your mobile device on the local network (`http://<YOUR_LOCAL_IP>:5000`).

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
