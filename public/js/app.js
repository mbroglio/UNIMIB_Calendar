/**
 * UNIMIB Magistrale Informatica - Mobile Calendar App Logic
 */

let state = {
  currentMonday: null,
  activeFilter: 'target', // 'target' (the 3 courses) or 'all'
  selectedDayDate: 'all',  // 'all' or '28-09-2026'
  calendarData: None = null,
  searchQuery: '',
  serverInfo: null
};

// Target course configurations matching backend
const COURSE_BADGES = {
  'architettura_software': { badge: '📐 Arch. Software', class: 'architettura_software', cardClass: 'target-architettura_software' },
  'reverse_engineering': { badge: '🔄 Evolution & Rev. Eng.', class: 'reverse_engineering', cardClass: 'target-reverse_engineering' },
  'large_scale_data': { badge: '📊 Large Scale Data', class: 'large_scale_data', cardClass: 'target-large_scale_data' }
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  setupEventListeners();
  registerServiceWorker();
  await fetchServerInfo();
  
  // Set initial Monday
  if (state.serverInfo && state.serverInfo.current_monday) {
    state.currentMonday = state.serverInfo.current_monday;
  } else {
    state.currentMonday = formatFormattedDate(getMonday(new Date()));
  }
  
  loadCalendar(state.currentMonday);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }
}

async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    if (res.ok) {
      state.serverInfo = await res.json();
      document.getElementById('mobileUrlText').textContent = state.serverInfo.mobile_url;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(state.serverInfo.mobile_url)}`;
      document.getElementById('qrImage').src = qrUrl;
    }
  } catch (err) {
    console.warn('Could not fetch server info', err);
  }
}

function setupEventListeners() {
  // Filter Toggle
  document.getElementById('btnFilterTarget').addEventListener('click', () => {
    setFilter('target');
  });
  
  document.getElementById('btnFilterAll').addEventListener('click', () => {
    setFilter('all');
  });

  // Week Navigation
  document.getElementById('btnPrevWeek').addEventListener('click', () => {
    changeWeek(-7);
  });
  
  document.getElementById('btnNextWeek').addEventListener('click', () => {
    changeWeek(7);
  });
  
  document.getElementById('btnToday').addEventListener('click', () => {
    if (state.serverInfo) {
      state.currentMonday = state.serverInfo.current_monday;
      loadCalendar(state.currentMonday);
    }
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    loadCalendar(state.currentMonday, true);
  });

  // Search Bar
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      renderEvents();
    });
  }

  // Modals
  document.getElementById('btnMobileInfo').addEventListener('click', () => {
    document.getElementById('qrModal').classList.add('active');
  });

  document.getElementById('btnCloseQrModal').addEventListener('click', () => {
    document.getElementById('qrModal').classList.remove('active');
  });

  // Swipe support for mobile
  let touchStartX = 0;
  let touchEndX = 0;
  const mainEl = document.querySelector('main');

  mainEl.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  mainEl.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });

  function handleSwipe() {
    const diff = touchEndX - touchStartX;
    if (Math.abs(diff) > 75) {
      if (diff < 0) {
        // Swipe Left -> Next Week
        changeWeek(7);
      } else {
        // Swipe Right -> Prev Week
        changeWeek(-7);
      }
    }
  }
}

function setFilter(filterType) {
  state.activeFilter = filterType;
  document.getElementById('btnFilterTarget').classList.toggle('active', filterType === 'target');
  document.getElementById('btnFilterAll').classList.toggle('active', filterType === 'all');
  renderEvents();
}

function changeWeek(dayOffset) {
  if (!state.currentMonday) return;
  const parts = state.currentMonday.split('-');
  const dt = new Date(parts[2], parts[1] - 1, parts[0]);
  dt.setDate(dt.getDate() + dayOffset);
  
  // Ensure it's Monday
  const monday = getMonday(dt);
  state.currentMonday = formatFormattedDate(monday);
  state.selectedDayDate = 'all';
  loadCalendar(state.currentMonday);
}

async function loadCalendar(mondayDateStr, forceRefresh = false) {
  showLoading(true);
  
  // Check LocalStorage cache for instant load
  const cacheKey = `unimib_cal_${mondayDateStr}`;
  if (!forceRefresh) {
    const localCache = localStorage.getItem(cacheKey);
    if (localCache) {
      try {
        state.calendarData = JSON.parse(localCache);
        renderCalendar();
        showLoading(false);
      } catch (e) {
        console.warn('Cache parse error', e);
      }
    }
  }

  try {
    const url = `/api/calendar?date=${mondayDateStr}${forceRefresh ? '&refresh=1' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Errore durante la risposta del server');
    
    const data = await res.json();
    state.calendarData = data;
    
    // Save to LocalStorage
    localStorage.setItem(cacheKey, JSON.stringify(data));
    
    renderCalendar();
    if (forceRefresh) showToast('Calendario aggiornato da UNIMIB!');
  } catch (err) {
    console.error('Fetch error:', err);
    if (!state.calendarData) {
      showError('Impossibile caricare il calendario. Verificare la connessione.');
    } else {
      showToast('Visualizzazione offline dei dati salvati.');
    }
  } finally {
    showLoading(false);
  }
}

function renderCalendar() {
  if (!state.calendarData) return;
  
  // Update week header label
  document.getElementById('weekLabelText').textContent = state.calendarData.week_label || state.currentMonday;
  
  renderDayTabs();
  renderEvents();
}

function renderDayTabs() {
  const tabsContainer = document.getElementById('daysTabBar');
  tabsContainer.innerHTML = '';
  
  const giorni = state.calendarData.giorni || [];
  
  // "Tutti" Tab
  const allTab = document.createElement('div');
  allTab.className = `day-tab ${state.selectedDayDate === 'all' ? 'active' : ''}`;
  allTab.innerHTML = `
    <div class="tab-name">TUTTI</div>
    <div class="tab-date">5GG</div>
  `;
  allTab.addEventListener('click', () => {
    state.selectedDayDate = 'all';
    renderDayTabs();
    renderEvents();
  });
  tabsContainer.appendChild(allTab);

  giorni.forEach(g => {
    const tab = document.createElement('div');
    const isSelected = state.selectedDayDate === g.data;
    tab.className = `day-tab ${isSelected ? 'active' : ''}`;
    
    // Short day name (lun, mar, mer...)
    const dayShort = g.label ? g.label.split(' ')[0].substring(0, 3).toUpperCase() : 'GG';
    const dayNum = g.data ? g.data.split('-')[0] : '';
    
    // Count target courses for this day
    const dayEvents = (state.calendarData.events || []).filter(e => e.date === g.data);
    const targetCount = dayEvents.filter(e => e.is_target).length;
    
    let dotsHtml = '';
    if (targetCount > 0) {
      dotsHtml = '<div class="tab-dots">';
      for(let i=0; i<Math.min(targetCount, 3); i++) {
        dotsHtml += '<div class="dot"></div>';
      }
      dotsHtml += '</div>';
    }

    tab.innerHTML = `
      <div class="tab-name">${dayShort}</div>
      <div class="tab-date">${dayNum}</div>
      ${dotsHtml}
    `;
    
    tab.addEventListener('click', () => {
      state.selectedDayDate = g.data;
      renderDayTabs();
      renderEvents();
    });
    
    tabsContainer.appendChild(tab);
  });
}

function renderEvents() {
  const container = document.getElementById('eventsContainer');
  container.innerHTML = '';
  
  if (!state.calendarData || !state.calendarData.events) return;
  
  let events = state.calendarData.events;

  // Filter 1: Target vs All
  if (state.activeFilter === 'target') {
    events = events.filter(e => e.is_target);
  }

  // Filter 2: Specific Day
  if (state.selectedDayDate !== 'all') {
    events = events.filter(e => e.date === state.selectedDayDate);
  }

  // Filter 3: Search Query
  if (state.searchQuery) {
    events = events.filter(e => 
      e.course.toLowerCase().includes(state.searchQuery) ||
      e.docente.toLowerCase().includes(state.searchQuery) ||
      e.aula.toLowerCase().includes(state.searchQuery)
    );
  }

  if (events.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <h3>Nessuna lezione trovata</h3>
        <p>${state.activeFilter === 'target' ? 'Nessuna lezione dei 3 corsi in questo periodo.' : 'Nessuna lezione in programma per i filtri selezionati.'}</p>
      </div>
    `;
    return;
  }

  // Group events by day if showing 'all' days
  const grouped = {};
  events.forEach(e => {
    if (!grouped[e.date]) {
      grouped[e.date] = {
        date: e.date,
        dayName: e.day_name,
        items: []
      };
    }
    grouped[e.date].items.push(e);
  });

  Object.keys(grouped).forEach(dateKey => {
    const group = grouped[dateKey];
    const section = document.createElement('div');
    section.className = 'day-section';
    
    section.innerHTML = `<div class="day-header-title">📌 ${group.dayName} ${group.date}</div>`;
    
    group.items.forEach(e => {
      const card = document.createElement('div');
      
      let targetClass = '';
      let badgeHtml = '';
      
      if (e.target_config) {
        const key = e.target_config.id;
        if (COURSE_BADGES[key]) {
          targetClass = COURSE_BADGES[key].cardClass;
          badgeHtml = `<span class="course-badge ${COURSE_BADGES[key].class}">${COURSE_BADGES[key].badge}</span>`;
        }
      }

      const isCanceled = e.is_canceled;
      if (isCanceled) card.classList.add('canceled');
      if (targetClass) card.classList.add(targetClass);
      
      card.className = `event-card ${targetClass} ${isCanceled ? 'canceled' : ''}`;
      
      card.innerHTML = `
        <div class="card-top">
          <span class="time-badge">⏰ ${e.start_time} - ${e.end_time}</span>
          ${badgeHtml}
        </div>
        ${isCanceled ? '<div class="canceled-banner">⚠️ LEZIONE ANNULLATA</div>' : ''}
        <div class="course-title ${isCanceled ? 'canceled-text' : ''}">${e.course}</div>
        <div class="card-details">
          <div class="detail-item">
            <span>📍</span> <span>Aula: <strong class="room-pill">${e.aula || 'Non specificata'}</strong></span>
          </div>
          <div class="detail-item">
            <span>👨‍🏫</span> <span>Docente: <strong>${e.docente || 'Non specificato'}</strong></span>
          </div>
        </div>
      `;

      section.appendChild(card);
    });

    container.appendChild(section);
  });
}

function showLoading(show) {
  const spinnerContainer = document.getElementById('spinnerContainer');
  const eventsContainer = document.getElementById('eventsContainer');
  if (show) {
    spinnerContainer.style.display = 'flex';
    eventsContainer.style.display = 'none';
  } else {
    spinnerContainer.style.display = 'none';
    eventsContainer.style.display = 'flex';
  }
}

function showError(msg) {
  const container = document.getElementById('eventsContainer');
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <h3>Errore</h3>
      <p>${msg}</p>
      <button class="btn-primary" style="margin-top:15px; width:auto;" onclick="loadCalendar(state.currentMonday, true)">Riprova</button>
    </div>
  `;
}

function showToast(msg) {
  const toast = document.getElementById('toastNotification');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Helpers
function getMonday(d) {
  d = new Date(d);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function formatFormattedDate(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}
