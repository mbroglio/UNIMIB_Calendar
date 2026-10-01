/**
 * UNIMIB Orari - Mobile Calendar App Logic
 */

const CONFIG_KEY = 'unimib_config';
const CALENDAR_CACHE_PREFIX = 'unimib_cal_';
const FAVORITE_COLORS = ['#8B5CF6', '#10B981', '#06B6D4', '#F59E0B', '#EC4899', '#3B82F6', '#F97316', '#84CC16'];

let state = {
  currentMonday: null,
  activeFilter: 'target', // 'target' (my courses) or 'all'
  selectedDayDate: 'all',  // 'all' or '28-09-2026'
  calendarData: null,
  searchQuery: '',
  config: null,           // { anno, corso, corsoLabel, anni: [...], anniLabels: [...], favorites: [{code, label}] }
  favoriteColors: {},     // course_code -> color
  preview: false,         // true while viewing a shared config that is not saved
  requestId: 0,
  activeTab: 'timetable'  // 'timetable', 'rooms', 'exams'
};

const EXAM_COURSES_KEY = 'unimib_exam_courses';

let roomsState = {
  buildings: [],
  selectedBuilding: localStorage.getItem('unimib_rooms_building') || 'U06',
  selectedDate: '', // initialized in initApp
  activeFilter: 'all', // 'all', 'free', 'occupied'
  searchQuery: '',
  data: null,
  modalRoom: null,
  modalDate: ''
};

let examsState = {
  extraCourses: [], // initialized in initApp from localStorage
  activeSession: 'upcoming', // 'upcoming', 'winter', 'summer', 'autumn', 'custom'
  yearFilter: '',
  searchQuery: '',
  exams: [],
  isLoading: false
};

// Options loaded from the UNIMIB dropdown data while the setup modal is open
let setup = {
  seq: 0,
  courses: [],
  teachings: []
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  roomsState.selectedDate = formatDateIso(new Date());
  roomsState.modalDate = roomsState.selectedDate;
  examsState.extraCourses = loadExamCourses();

  setupEventListeners();
  registerServiceWorker();

  state.currentMonday = formatFormattedDate(getMonday(new Date()));
  state.config = loadConfig();

  const shared = readSharedConfig();
  if (shared) {
    enterPreview(shared);
  } else if (state.config) {
    applyConfig();
    loadCalendar(state.currentMonday);
  } else {
    showWelcome();
    openSetup();
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/js/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }
}

function setupEventListeners() {
  // Navigation Tabs
  document.getElementById('tabTimetable').addEventListener('click', () => switchTab('timetable'));
  document.getElementById('tabRooms').addEventListener('click', () => switchTab('rooms'));
  document.getElementById('tabExams').addEventListener('click', () => switchTab('exams'));

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
    state.currentMonday = formatFormattedDate(getMonday(new Date()));
    state.selectedDayDate = 'all';
    loadCalendar(state.currentMonday);
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    if (state.activeTab === 'timetable') {
      loadCalendar(state.currentMonday, true);
    } else if (state.activeTab === 'rooms') {
      loadRoomsOccupancy(true);
    } else if (state.activeTab === 'exams') {
      loadExams(true);
    }
  });

  // Timetable Search Bar
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      renderEvents();
    });
  }

  // Rooms Occupancy Controls
  document.getElementById('roomsBuildingSelect').addEventListener('change', (e) => {
    roomsState.selectedBuilding = e.target.value;
    localStorage.setItem('unimib_rooms_building', roomsState.selectedBuilding);
    loadRoomsOccupancy();
  });

  document.getElementById('roomsDateInput').addEventListener('change', (e) => {
    if (e.target.value) {
      roomsState.selectedDate = e.target.value;
      loadRoomsOccupancy();
    }
  });

  document.getElementById('btnRoomsPrevDay').addEventListener('click', () => changeRoomsDate(-1));
  document.getElementById('btnRoomsNextDay').addEventListener('click', () => changeRoomsDate(1));
  document.getElementById('btnRoomsToday').addEventListener('click', setRoomsDateToday);
  const btnRefreshRooms = document.getElementById('btnRefreshRooms');
  if (btnRefreshRooms) {
    btnRefreshRooms.addEventListener('click', () => loadRoomsOccupancy(true));
  }

  document.getElementById('roomsSearchInput').addEventListener('input', (e) => {
    roomsState.searchQuery = e.target.value;
    renderRooms();
  });

  document.querySelectorAll('#roomsFilterBar .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#roomsFilterBar .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      roomsState.activeFilter = pill.getAttribute('data-filter') || 'all';
      renderRooms();
    });
  });

  // Room Schedule Modal
  document.getElementById('btnCloseRoomSchedule').addEventListener('click', () => {
    document.getElementById('roomScheduleModal').classList.remove('active');
  });
  document.getElementById('btnModalPrevDay').addEventListener('click', () => changeModalRoomDay(-1));
  document.getElementById('btnModalNextDay').addEventListener('click', () => changeModalRoomDay(1));

  // Exam Calendar Controls
  document.getElementById('btnOpenAddExamCourse').addEventListener('click', openAddExamCourseModal);
  document.getElementById('btnCloseAddExamCourse').addEventListener('click', closeAddExamCourseModal);
  document.getElementById('btnConfirmAddExamCourse').addEventListener('click', confirmAddExamCourse);

  document.getElementById('addExamCourseArea').addEventListener('change', onAddExamCourseAreaChange);
  document.getElementById('addExamCourseSelect').addEventListener('change', onAddExamCourseSelectChange);
  document.getElementById('addExamCourseCustomCode').addEventListener('input', onAddExamCourseCustomCodeInput);

  document.querySelectorAll('#examSessionPills .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#examSessionPills .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const session = pill.getAttribute('data-session');
      examsState.activeSession = session;
      const customRange = document.getElementById('examCustomDateRange');
      if (session === 'custom') {
        customRange.style.display = 'flex';
      } else {
        customRange.style.display = 'none';
        loadExams();
      }
    });
  });

  document.getElementById('btnApplyExamDates').addEventListener('click', () => {
    loadExams();
  });

  document.getElementById('examsSearchInput').addEventListener('input', (e) => {
    examsState.searchQuery = e.target.value;
    renderExams();
  });

  document.getElementById('examYearFilter').addEventListener('change', (e) => {
    examsState.yearFilter = e.target.value;
    loadExams();
  });

  document.getElementById('btnRefreshExams').addEventListener('click', () => {
    loadExams(true);
  });

  // Close modals when clicking on background overlay
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
      }
    });
  });

  // Share link
  document.getElementById('btnShare').addEventListener('click', openShare);
  document.getElementById('btnCloseShare').addEventListener('click', () => {
    document.getElementById('shareModal').classList.remove('active');
  });
  document.getElementById('btnCopyShare').addEventListener('click', copyShareUrl);
  document.getElementById('btnNativeShare').addEventListener('click', nativeShare);

  // Shared config preview
  document.getElementById('btnImportShared').addEventListener('click', importShared);
  document.getElementById('btnExitPreview').addEventListener('click', exitPreview);

  // Course of study setup
  document.getElementById('btnSettings').addEventListener('click', () => openSetup());
  document.getElementById('btnCloseSetup').addEventListener('click', closeSetup);
  document.getElementById('btnSaveSetup').addEventListener('click', saveSetup);
  document.getElementById('cfgYear').addEventListener('change', () => onSetupYearChange({}));
  document.getElementById('cfgArea').addEventListener('change', () => onSetupAreaChange({}));
  document.getElementById('cfgCourse').addEventListener('change', () => onSetupCourseChange({}));
  document.getElementById('cfgStudyYears').addEventListener('change', () => {
    renderFavoriteChoices(getCheckedValues('cfgFavorites'));
    updateSaveButton();
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
    if (state.activeTab !== 'timetable') return;
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

// ---------- Configuration ----------

function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY));
    if (cfg && cfg.anno && cfg.corso && Array.isArray(cfg.anni) && cfg.anni.length) return cfg;
  } catch (e) {
    console.warn('Config read error', e);
  }
  return null;
}

function saveConfig(cfg) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch (e) {
    console.warn('Config save error', e);
  }
}

function configKey() {
  const c = state.config;
  return `${c.anno}_${c.corso}_${c.anni.join(',')}`;
}

function clearCalendarCache() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CALENDAR_CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) {
    console.warn('Cache clear error', e);
  }
}

function applyConfig() {
  const cfg = state.config;
  state.favoriteColors = {};
  (cfg.favorites || []).forEach((f, i) => {
    state.favoriteColors[f.code] = FAVORITE_COLORS[i % FAVORITE_COLORS.length];
  });

  if (state.activeTab === 'timetable') {
    document.getElementById('headerSubtitle').textContent = `${cfg.corsoLabel} · ${cfg.anniLabels.join(', ')}`;
  }
  setFilter(cfg.favorites && cfg.favorites.length ? 'target' : 'all');
  renderExamCourseChips();
}

// ---------- Share link (?anno=2026&corso=F1801Q&anno2=GGG%7C2&fav=EC523651,EC523669) ----------

function shareUrl(cfg) {
  if (!cfg) return `${window.location.origin}/`;
  const params = new URLSearchParams({ anno: cfg.anno, corso: cfg.corso });
  cfg.anni.forEach(a => params.append('anno2', a));
  const favs = (cfg.favorites || []).map(f => f.code);
  if (favs.length) params.set('fav', favs.join(','));
  // Commas are valid in a query string: keep the favorites list readable
  return `${window.location.origin}/?${params.toString().replace(/%2C/gi, ',')}`;
}

function readSharedConfig() {
  const params = new URLSearchParams(window.location.search);
  const anno = params.get('anno') || '';
  const corso = params.get('corso') || '';
  const anni = params.getAll('anno2').filter(Boolean);
  if (!/^\d{4}$/.test(anno) || !/^[A-Za-z0-9_-]+$/.test(corso) || !anni.length) return null;
  const favCodes = (params.get('fav') || '').split(',').filter(code => /^[\w.-]+$/.test(code));
  return { anno, corso, anni, favCodes };
}

// The link only carries codes: labels are looked up again, falling back to the codes themselves
async function resolveSharedConfig(shared) {
  const cfg = {
    anno: shared.anno,
    area: '',
    corso: shared.corso,
    corsoLabel: shared.corso,
    anni: shared.anni,
    anniLabels: shared.anni.slice(),
    favorites: shared.favCodes.map(code => ({ code, label: code }))
  };
  try {
    const data = await fetchJson(`/api/options?anno=${encodeURIComponent(shared.anno)}&corso=${encodeURIComponent(shared.corso)}`);
    const years = data.years || [];
    const teachings = years.flatMap(y => y.teachings);
    cfg.area = data.area || '';
    cfg.corsoLabel = data.label || shared.corso;
    cfg.anniLabels = shared.anni.map(a => (years.find(y => y.value === a) || { label: a }).label);
    cfg.favorites = shared.favCodes.map(code => ({ code, label: (teachings.find(t => t.code === code) || { label: code }).label }));
  } catch (err) {
    console.warn('Shared config labels unavailable:', err);
  }
  return cfg;
}

async function enterPreview(shared) {
  const hasOwnConfig = Boolean(state.config);
  showLoading(true);
  state.config = await resolveSharedConfig(shared);
  state.preview = true;

  document.getElementById('previewLabel').textContent = `${state.config.corsoLabel} · ${state.config.anniLabels.join(', ')}`;
  document.getElementById('previewHint').textContent = hasOwnConfig ? 'Importandolo sostituirai la tua configurazione attuale.' : '';
  document.getElementById('previewBanner').classList.add('active');

  applyConfig();
  loadCalendar(state.currentMonday);
}

function endPreview() {
  state.preview = false;
  document.getElementById('previewBanner').classList.remove('active');
  history.replaceState(null, '', '/');
}

function importShared() {
  saveConfig(state.config);
  clearCalendarCache();
  endPreview();
  showToast('Orario importato!');
}

function exitPreview() {
  endPreview();
  state.requestId++;
  state.config = loadConfig();
  state.calendarData = null;
  state.selectedDayDate = 'all';

  if (state.config) {
    applyConfig();
    loadCalendar(state.currentMonday);
  } else {
    document.getElementById('headerSubtitle').textContent = 'Seleziona il tuo corso';
    document.getElementById('daysTabBar').innerHTML = '';
    showWelcome();
    openSetup();
  }
}

function openShare() {
  const cfg = state.config;
  const url = shareUrl(cfg);
  document.getElementById('shareHint').textContent = cfg
    ? 'Chi apre questo link (o inquadra il QR) vedrà questo orario e potrà importarlo.'
    : 'Scegli prima il tuo corso per condividere l\'orario. Intanto, ecco il link all\'app:';
  document.getElementById('shareUrlText').textContent = url;
  document.getElementById('qrImage').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  document.getElementById('btnNativeShare').style.display = navigator.share ? '' : 'none';
  document.getElementById('shareModal').classList.add('active');
}

async function copyShareUrl() {
  const urlBox = document.getElementById('shareUrlText');
  const url = urlBox.textContent;
  try {
    // navigator.clipboard only exists on HTTPS/localhost (not e.g. http://192.168.x.x)
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else if (!legacyCopy(url)) {
      throw new Error('Copy command rejected');
    }
    showToast('Link copiato!');
  } catch (err) {
    console.warn('Clipboard error', err);
    window.getSelection().selectAllChildren(urlBox);
    showToast('Link selezionato: premi Ctrl+C per copiarlo.');
  }
}

function legacyCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (e) {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function nativeShare() {
  const url = document.getElementById('shareUrlText').textContent;
  const text = state.config ? `Orario UNIMIB · ${state.config.corsoLabel}` : 'UNIMIB Orari';
  try {
    await navigator.share({ title: 'UNIMIB Orari', text, url });
  } catch (err) {
    if (err.name !== 'AbortError') showToast('Condivisione non riuscita.');
  }
}

// ---------- Setup modal (mirrors the UNIMIB "By degree" form dropdowns) ----------

async function openSetup() {
  document.getElementById('setupModal').classList.add('active');
  document.getElementById('btnCloseSetup').style.display = state.config ? '' : 'none';

  const preset = state.config || {};
  const seq = ++setup.seq;
  const yearSelect = document.getElementById('cfgYear');
  fillSelect(yearSelect, [], 'Caricamento...');
  resetSetupFrom('area');

  try {
    const data = await fetchJson('/api/options');
    if (seq !== setup.seq) return;
    const years = data.academic_years || [];
    fillSelect(yearSelect, years, null);
    if (preset.anno && years.some(y => y.value === preset.anno)) yearSelect.value = preset.anno;
    await onSetupYearChange(preset);
  } catch (err) {
    console.error('Options fetch error:', err);
    fillSelect(yearSelect, [], 'Errore di caricamento');
    showToast('Impossibile caricare le opzioni da UNIMIB.');
  }
}

function closeSetup() {
  setup.seq++;
  document.getElementById('setupModal').classList.remove('active');
}

async function onSetupYearChange(preset) {
  const seq = ++setup.seq;
  const areaSelect = document.getElementById('cfgArea');
  resetSetupFrom('area');
  fillSelect(areaSelect, [], 'Caricamento...');

  try {
    const data = await fetchJson(`/api/options?anno=${encodeURIComponent(document.getElementById('cfgYear').value)}`);
    if (seq !== setup.seq) return;
    setup.courses = data.courses || [];
    fillSelect(areaSelect, data.areas || [], 'Seleziona area...');
    if (preset.area && (data.areas || []).some(a => a.value === preset.area)) {
      areaSelect.value = preset.area;
      await onSetupAreaChange(preset);
    }
  } catch (err) {
    console.error('Options fetch error:', err);
    fillSelect(areaSelect, [], 'Errore di caricamento');
    showToast('Impossibile caricare i corsi da UNIMIB.');
  }
}

async function onSetupAreaChange(preset) {
  setup.seq++;
  resetSetupFrom('course');
  const area = document.getElementById('cfgArea').value;
  if (!area) return;

  const courseSelect = document.getElementById('cfgCourse');
  const courses = setup.courses
    .filter(c => c.area === area)
    .map(c => ({ value: c.value, label: `${c.value} - ${c.label}${c.type ? ` (${c.type})` : ''}` }));
  fillSelect(courseSelect, courses, 'Seleziona corso...');

  if (preset.corso && courses.some(c => c.value === preset.corso)) {
    courseSelect.value = preset.corso;
    await onSetupCourseChange(preset);
  }
}

async function onSetupCourseChange(preset) {
  const seq = ++setup.seq;
  resetSetupFrom('studyYears');
  const corso = document.getElementById('cfgCourse').value;
  const course = setup.courses.find(c => c.value === corso);
  if (!course) return;

  // Year of study choices, grouped by year like the optgroups of the original form
  const container = document.getElementById('cfgStudyYears');
  const preselected = preset.anni || (course.years.length === 1 ? [course.years[0].value] : []);
  let html = '';
  let lastYear = null;
  course.years.forEach(y => {
    if (y.year !== lastYear) {
      html += `<div class="choice-group-title">${/^\d+$/.test(y.year) ? `Anno ${escapeHtml(y.year)}` : escapeHtml(y.year)}</div>`;
      lastYear = y.year;
    }
    html += choiceItemHtml(y.value, y.label, '', preselected.includes(y.value));
  });
  container.innerHTML = html || '<p class="field-hint">Nessun anno di studio disponibile.</p>';
  updateSaveButton();

  // Teachings of each year of study, used to pick "my courses"
  document.getElementById('cfgFavorites').innerHTML = '<p class="field-hint">Caricamento...</p>';
  try {
    const anno = document.getElementById('cfgYear').value;
    const data = await fetchJson(`/api/options?anno=${encodeURIComponent(anno)}&corso=${encodeURIComponent(corso)}`);
    if (seq !== setup.seq) return;
    setup.teachings = data.years || [];
    renderFavoriteChoices((preset.favorites || []).map(f => f.code));
  } catch (err) {
    console.error('Teachings fetch error:', err);
    document.getElementById('cfgFavorites').innerHTML = '<p class="field-hint">Impossibile caricare gli insegnamenti.</p>';
  }
}

function renderFavoriteChoices(selectedCodes) {
  const container = document.getElementById('cfgFavorites');
  const anni = getCheckedValues('cfgStudyYears');
  if (!anni.length) {
    container.innerHTML = '<p class="field-hint">Seleziona prima l\'anno di studio.</p>';
    return;
  }

  const seen = new Set();
  let html = '';
  setup.teachings
    .filter(y => anni.includes(y.value))
    .forEach(y => {
      y.teachings.forEach(t => {
        if (seen.has(t.code)) return;
        seen.add(t.code);
        html += choiceItemHtml(t.code, t.label, t.docente, selectedCodes.includes(t.code));
      });
    });
  container.innerHTML = html || '<p class="field-hint">Nessun insegnamento disponibile.</p>';
}

function resetSetupFrom(level) {
  setup.teachings = [];
  if (level === 'area') fillSelect(document.getElementById('cfgArea'), [], '--');
  if (level === 'area' || level === 'course') fillSelect(document.getElementById('cfgCourse'), [], '--');
  document.getElementById('cfgStudyYears').innerHTML = '<p class="field-hint">Seleziona prima il corso di studio.</p>';
  document.getElementById('cfgFavorites').innerHTML = '<p class="field-hint">Seleziona prima l\'anno di studio.</p>';
  updateSaveButton();
}

function updateSaveButton() {
  const ready = document.getElementById('cfgCourse').value && getCheckedValues('cfgStudyYears').length > 0;
  document.getElementById('btnSaveSetup').disabled = !ready;
}

function saveSetup() {
  const corso = document.getElementById('cfgCourse').value;
  const course = setup.courses.find(c => c.value === corso);
  const anni = getCheckedValues('cfgStudyYears');
  if (!course || !anni.length) return;

  const favoriteCodes = getCheckedValues('cfgFavorites');
  const teachings = setup.teachings.flatMap(y => y.teachings);
  const favorites = favoriteCodes.map(code => {
    const t = teachings.find(x => x.code === code);
    return { code, label: t ? t.label : code };
  });

  state.config = {
    anno: document.getElementById('cfgYear').value,
    area: document.getElementById('cfgArea').value,
    corso,
    corsoLabel: course.label,
    anni,
    anniLabels: anni.map(a => (course.years.find(y => y.value === a) || { label: a }).label),
    favorites
  };
  saveConfig(state.config);
  clearCalendarCache();
  if (state.preview) endPreview();

  closeSetup();
  applyConfig();
  state.calendarData = null;
  state.selectedDayDate = 'all';
  loadCalendar(state.currentMonday);
}

function fillSelect(select, options, placeholder) {
  select.innerHTML = '';
  if (placeholder) select.appendChild(new Option(placeholder, ''));
  options.forEach(o => select.appendChild(new Option(o.label, o.value)));
  select.disabled = options.length === 0;
}

function choiceItemHtml(value, label, hint, checked) {
  return `
    <label class="choice-item">
      <input type="checkbox" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
      <span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>
    </label>
  `;
}

function getCheckedValues(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(i => i.value);
}

// ---------- Calendar ----------

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

function calendarUrl(mondayDateStr, forceRefresh) {
  const params = new URLSearchParams({ anno: state.config.anno, corso: state.config.corso, date: mondayDateStr });
  state.config.anni.forEach(a => params.append('anno2', a));
  if (forceRefresh) params.set('refresh', '1');
  return `/api/calendar?${params}`;
}

async function loadCalendar(mondayDateStr, forceRefresh = false) {
  if (!state.config) {
    openSetup();
    return;
  }

  const requestId = ++state.requestId;
  showLoading(true);

  // Check LocalStorage cache for instant load
  const cacheKey = `${CALENDAR_CACHE_PREFIX}${configKey()}_${mondayDateStr}`;
  if (!forceRefresh) {
    try {
      const localCache = localStorage.getItem(cacheKey);
      if (localCache) {
        state.calendarData = JSON.parse(localCache);
        renderCalendar();
        showLoading(false);
      }
    } catch (e) {
      console.warn('Cache read error', e);
    }
  }

  try {
    const res = await fetch(calendarUrl(mondayDateStr, forceRefresh));
    if (!res.ok) throw new Error('Errore durante la risposta del server');

    const data = await res.json();
    if (requestId !== state.requestId) return;
    state.calendarData = data;

    // Save to LocalStorage (a shared config being previewed leaves nothing behind)
    if (!state.preview) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(data));
      } catch (e) {
        console.warn('Cache save error', e);
      }
    }

    renderCalendar();
    if (forceRefresh) showToast('Calendario aggiornato da UNIMIB!');
  } catch (err) {
    if (requestId !== state.requestId) return;
    console.error('Fetch error:', err);
    if (!state.calendarData) {
      showError('Impossibile caricare il calendario. Verificare la connessione.');
    } else {
      showToast('Visualizzazione offline dei dati salvati.');
    }
  } finally {
    if (requestId === state.requestId) showLoading(false);
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

    // Count my courses for this day
    const dayEvents = (state.calendarData.events || []).filter(e => e.date === g.data);
    const targetCount = dayEvents.filter(isFavorite).length;

    let dotsHtml = '';
    if (targetCount > 0) {
      dotsHtml = '<div class="tab-dots">';
      for(let i=0; i<Math.min(targetCount, 3); i++) {
        dotsHtml += '<div class="dot"></div>';
      }
      dotsHtml += '</div>';
    }

    tab.innerHTML = `
      <div class="tab-name">${escapeHtml(dayShort)}</div>
      <div class="tab-date">${escapeHtml(dayNum)}</div>
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

function isFavorite(e) {
  return Boolean(state.favoriteColors[e.course_code]);
}

function renderEvents() {
  const container = document.getElementById('eventsContainer');
  container.innerHTML = '';

  if (!state.calendarData || !state.calendarData.events) return;

  const hasFavorites = state.config && state.config.favorites && state.config.favorites.length > 0;
  if (state.activeFilter === 'target' && !hasFavorites) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⭐</div>
        <h3>Nessun corso preferito</h3>
        <p>Scegli i tuoi corsi per vederli evidenziati e filtrati qui.</p>
        <button class="btn-primary" style="margin-top:15px; width:auto;" onclick="openSetup()">Scegli i miei corsi</button>
      </div>
    `;
    return;
  }

  let events = state.calendarData.events;

  // Filter 1: My courses vs All
  if (state.activeFilter === 'target') {
    events = events.filter(isFavorite);
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
        <p>${state.activeFilter === 'target' ? 'Nessuna lezione dei tuoi corsi in questo periodo.' : 'Nessuna lezione in programma per i filtri selezionati.'}</p>
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

  // With several years of study selected, show which one each lesson belongs to
  const showCurriculum = state.config.anni.length > 1;

  Object.keys(grouped).forEach(dateKey => {
    const group = grouped[dateKey];
    const section = document.createElement('div');
    section.className = 'day-section';

    section.innerHTML = `<div class="day-header-title">📌 ${escapeHtml(group.dayName)} ${escapeHtml(group.date)}</div>`;

    group.items.forEach(e => {
      const card = document.createElement('div');
      const color = state.favoriteColors[e.course_code];
      const isCanceled = e.is_canceled;

      card.className = `event-card ${color ? 'target' : ''} ${isCanceled ? 'canceled' : ''}`;
      if (color) card.style.setProperty('--course-color', color);

      const curriculum = state.config.anniLabels
        .filter(label => (e.curricula || []).some(c => c.endsWith(label)))
        .join(', ');

      card.innerHTML = `
        <div class="card-top">
          <span class="time-badge">⏰ ${escapeHtml(e.start_time)} - ${escapeHtml(e.end_time)}</span>
          ${color ? '<span class="course-badge">⭐ Mio corso</span>' : ''}
        </div>
        ${isCanceled ? '<div class="canceled-banner">⚠️ LEZIONE ANNULLATA</div>' : ''}
        <div class="course-title ${isCanceled ? 'canceled-text' : ''}">${escapeHtml(e.course)}</div>
        <div class="card-details">
          <div class="detail-item">
            <span>📍</span> <span>Aula: <strong class="room-pill">${escapeHtml(e.aula || 'Non specificata')}</strong></span>
          </div>
          <div class="detail-item">
            <span>👨‍🏫</span> <span>Docente: <strong>${escapeHtml(e.docente || 'Non specificato')}</strong></span>
          </div>
          ${showCurriculum && curriculum ? `
          <div class="detail-item">
            <span>🎓</span> <span>${escapeHtml(curriculum)}</span>
          </div>` : ''}
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

function showWelcome() {
  showLoading(false);
  document.getElementById('weekLabelText').textContent = '—';
  document.getElementById('eventsContainer').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🎓</div>
      <h3>Benvenuto!</h3>
      <p>Scegli anno accademico, area didattica, corso e anno di studio per vedere il tuo orario.</p>
      <button class="btn-primary" style="margin-top:15px; width:auto;" onclick="openSetup()">Scegli il corso</button>
    </div>
  `;
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
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

const DAYS_NAMES_IT = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

function formatDateIso(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoToDate(iso) {
  if (!iso) return new Date();
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoToFormatted(iso) {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

function isoToDisplayDate(iso) {
  if (!iso) return '';
  const dt = isoToDate(iso);
  const dayName = DAYS_NAMES_IT[dt.getDay()];
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dayName} ${d}/${m}/${dt.getFullYear()}`;
}

// ---------- Tab Navigation Switcher ----------

function switchTab(tabId) {
  state.activeTab = tabId;

  document.querySelectorAll('.bottom-nav .nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.id === (tabId === 'timetable' ? 'tabTimetable' : tabId === 'rooms' ? 'tabRooms' : 'tabExams'));
  });

  document.getElementById('viewTimetable').classList.toggle('hidden', tabId !== 'timetable');
  document.getElementById('viewRooms').classList.toggle('hidden', tabId !== 'rooms');
  document.getElementById('viewExams').classList.toggle('hidden', tabId !== 'exams');

  // Scroll to top on switch
  window.scrollTo({ top: 0, behavior: 'instant' });

  // Update header subtitle
  if (tabId === 'timetable') {
    document.getElementById('headerSubtitle').textContent = state.config 
      ? `${state.config.corsoLabel} · ${state.config.anniLabels.join(', ')}` 
      : 'Seleziona il tuo corso';
  } else if (tabId === 'rooms') {
    document.getElementById('headerSubtitle').textContent = 'Occupazione aule in tempo reale';
    if (!roomsState.buildings.length) {
      loadRoomsBuildings();
    } else if (!roomsState.data) {
      loadRoomsOccupancy();
    }
  } else if (tabId === 'exams') {
    document.getElementById('headerSubtitle').textContent = 'Calendario appelli d\'esame';
    initExamsView();
  }
}

// ---------- Classroom Occupancy (Occupazione Aule) ----------

async function loadRoomsBuildings() {
  try {
    const res = await fetchJson('/api/rooms');
    roomsState.buildings = res.buildings || [];
    const select = document.getElementById('roomsBuildingSelect');
    select.innerHTML = roomsState.buildings.map(b => 
      `<option value="${escapeHtml(b.value)}" ${b.value === roomsState.selectedBuilding ? 'selected' : ''}>${escapeHtml(b.label)}</option>`
    ).join('');

    if (!roomsState.buildings.some(b => b.value === roomsState.selectedBuilding) && roomsState.buildings.length > 0) {
      roomsState.selectedBuilding = roomsState.buildings[0].value;
      select.value = roomsState.selectedBuilding;
    }

    document.getElementById('roomsDateInput').value = roomsState.selectedDate;
    loadRoomsOccupancy();
  } catch (err) {
    console.error('Error loading buildings:', err);
    showToast('Errore nel caricamento degli edifici');
  }
}

async function loadRoomsOccupancy(forceRefresh = false) {
  if (!roomsState.selectedBuilding) return;

  const spinner = document.getElementById('roomsSpinnerContainer');
  const grid = document.getElementById('roomsGrid');
  spinner.style.display = 'block';
  grid.style.display = 'none';

  const apiDate = isoToFormatted(roomsState.selectedDate);
  try {
    const data = await fetchJson(`/api/rooms?sede=${encodeURIComponent(roomsState.selectedBuilding)}&date=${encodeURIComponent(apiDate)}`);
    roomsState.data = data;
    spinner.style.display = 'none';
    grid.style.display = 'grid';

    document.getElementById('roomsSummaryBanner').style.display = 'flex';
    document.getElementById('roomsFilterBar').style.display = 'flex';

    document.getElementById('badgeRoomsTotal').textContent = `${data.total_rooms} aule`;
    document.getElementById('badgeRoomsFree').textContent = `🟢 ${data.free_rooms} libere`;
    document.getElementById('badgeRoomsOccupied').textContent = `🔴 ${data.occupied_rooms} occupate`;

    const timeText = data.check_time ? ` · Ore ${data.check_time}` : '';
    document.getElementById('roomsSummaryText').textContent = data.is_today 
      ? `Stato in tempo reale${timeText}`
      : `Occupazione per il ${data.date}`;

    renderRooms();
    if (forceRefresh) showToast('Occupazione aule aggiornata!');
  } catch (err) {
    spinner.style.display = 'none';
    grid.style.display = 'grid';
    console.error('Error loading rooms occupancy:', err);
    showToast('Impossibile verificare l\'occupazione delle aule');
  }
}

function renderRooms() {
  const grid = document.getElementById('roomsGrid');
  if (!roomsState.data || !roomsState.data.rooms) {
    grid.innerHTML = '';
    return;
  }

  const q = roomsState.searchQuery.toLowerCase().trim();
  const filtered = roomsState.data.rooms.filter(r => {
    if (roomsState.activeFilter === 'free' && !r.is_free) return false;
    if (roomsState.activeFilter === 'occupied' && r.is_free) return false;
    if (q) {
      const matchName = r.name.toLowerCase().includes(q);
      const matchCode = r.code.toLowerCase().includes(q);
      const matchEvent = r.events.some(e => e.name.toLowerCase().includes(q));
      if (!matchName && !matchCode && !matchEvent) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">🔍</div>
        <h3>Nessuna aula trovata</h3>
        <p>Nessun'aula corrisponde ai filtri selezionati.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(r => `
    <div class="room-card ${r.is_free ? 'free' : 'occupied'}" data-code="${escapeHtml(r.code)}">
      <div class="room-card-top">
        <div>
          <div class="room-card-title">${escapeHtml(r.name)}</div>
          <div class="room-card-capacity">👥 ${r.capacity > 0 ? r.capacity + ' posti' : 'Capienza n/d'} · ${escapeHtml(r.code)}</div>
        </div>
        <div class="status-badge ${r.is_free ? 'free' : 'occupied'}">
          <span class="status-indicator-dot"></span>
          ${r.is_free ? 'LIBERA' : 'OCCUPATA'}
        </div>
      </div>
      <div class="room-card-body">
        ${r.is_free 
          ? `<strong>Libera adesso</strong> · ${r.free_until === 'fine giornata' ? 'Tutto il giorno' : 'Fino alle ' + escapeHtml(r.free_until)}` 
          : `<strong>Occupata fino alle ${escapeHtml(r.current_event ? r.current_event.to : '')}</strong><br><span style="color:var(--text-secondary);">${escapeHtml(r.current_event ? r.current_event.name : '')}</span>`
        }
      </div>
      <div class="room-card-footer">
        <span>${r.events_count} ${r.events_count === 1 ? 'lezione/evento oggi' : 'lezioni/eventi oggi'}</span>
        <span>Tutte le lezioni ➔</span>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => {
      const code = card.getAttribute('data-code');
      const room = roomsState.data.rooms.find(r => r.code === code);
      if (room) openRoomSchedule(room);
    });
  });
}

function setRoomsDateToday() {
  roomsState.selectedDate = formatDateIso(new Date());
  document.getElementById('roomsDateInput').value = roomsState.selectedDate;
  loadRoomsOccupancy();
}

function changeRoomsDate(deltaDays) {
  const dt = isoToDate(roomsState.selectedDate);
  dt.setDate(dt.getDate() + deltaDays);
  roomsState.selectedDate = formatDateIso(dt);
  document.getElementById('roomsDateInput').value = roomsState.selectedDate;
  loadRoomsOccupancy();
}

function openRoomSchedule(room) {
  roomsState.modalRoom = room;
  roomsState.modalDate = roomsState.selectedDate;

  document.getElementById('modalRoomTitle').textContent = room.name;
  document.getElementById('modalRoomSubtitle').textContent = `${room.capacity > 0 ? room.capacity + ' posti · ' : ''}Edificio ${roomsState.selectedBuilding}`;
  document.getElementById('modalDateLabel').textContent = isoToDisplayDate(roomsState.modalDate);

  renderModalRoomEvents(room.events);
  document.getElementById('roomScheduleModal').classList.add('active');
}

function renderModalRoomEvents(events) {
  const container = document.getElementById('modalRoomEventsList');
  if (!events || events.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 24px 10px;">
        <div class="empty-icon">🟢</div>
        <h3>Aula Libera</h3>
        <p>Nessuna lezione o evento programmato in quest'aula per questa giornata.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = events.map(e => `
    <div class="timeline-item">
      <div class="timeline-header">
        <span class="timeline-time">${escapeHtml(e.from)} - ${escapeHtml(e.to)}</span>
        <span class="badge-status" style="font-size:0.7rem;">${escapeHtml(e.type)}</span>
      </div>
      <div class="timeline-name">${escapeHtml(e.name)}</div>
      ${e.docenti && e.docenti.length ? `<div class="timeline-docente">👤 ${escapeHtml(e.docenti.join(', '))}</div>` : ''}
      ${e.description ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${escapeHtml(e.description)}</div>` : ''}
    </div>
  `).join('');
}

async function changeModalRoomDay(deltaDays) {
  const dt = isoToDate(roomsState.modalDate);
  dt.setDate(dt.getDate() + deltaDays);
  roomsState.modalDate = formatDateIso(dt);
  document.getElementById('modalDateLabel').textContent = isoToDisplayDate(roomsState.modalDate);

  const container = document.getElementById('modalRoomEventsList');
  container.innerHTML = '<div class="spinner" style="margin:20px auto;"></div>';

  try {
    const apiDate = isoToFormatted(roomsState.modalDate);
    const data = await fetchJson(`/api/rooms?sede=${encodeURIComponent(roomsState.selectedBuilding)}&date=${encodeURIComponent(apiDate)}`);
    const found = (data.rooms || []).find(r => r.code === roomsState.modalRoom.code);
    renderModalRoomEvents(found ? found.events : []);
  } catch (err) {
    container.innerHTML = '<p style="color:var(--danger); text-align:center;">Errore durante il caricamento.</p>';
  }
}

// ---------- Exam Calendar (Calendario Esami) ----------

function loadExamCourses() {
  try {
    const raw = localStorage.getItem(EXAM_COURSES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveExamCourses(courses) {
  try {
    localStorage.setItem(EXAM_COURSES_KEY, JSON.stringify(courses));
  } catch (e) {
    console.warn('Error saving exam courses', e);
  }
}

function getActiveExamCourses() {
  const courses = [];
  if (state.config && state.config.corso) {
    courses.push({
      code: state.config.corso,
      label: state.config.corsoLabel || state.config.corso,
      isPrimary: true
    });
  }
  (examsState.extraCourses || []).forEach(c => {
    if (!courses.some(existing => existing.code === c.code)) {
      courses.push({
        code: c.code,
        label: c.label || c.code,
        isPrimary: false
      });
    }
  });
  return courses;
}

function renderExamCourseChips() {
  const container = document.getElementById('examCoursesChips');
  if (!container) return;
  const courses = getActiveExamCourses();

  if (courses.length === 0) {
    container.innerHTML = `
      <span style="font-size:0.8rem; color:var(--text-muted);">Nessun corso selezionato.</span>
      <button id="btnChipAdd" class="course-chip course-chip-add">➕ Aggiungi corso</button>
    `;
    const btn = document.getElementById('btnChipAdd');
    if (btn) btn.addEventListener('click', openAddExamCourseModal);
    return;
  }

  container.innerHTML = courses.map(c => `
    <div class="course-chip ${c.isPrimary ? 'primary' : 'extra'}">
      <span>${c.isPrimary ? '⭐ ' : '🎓 '}${escapeHtml(c.label)} [${escapeHtml(c.code)}]</span>
      ${!c.isPrimary ? `<button class="btn-remove-chip" data-code="${escapeHtml(c.code)}" title="Rimuovi">✕</button>` : ''}
    </div>
  `).join('') + '<button id="btnChipAdd" class="course-chip course-chip-add">➕ Aggiungi corso</button>';

  const btnAdd = document.getElementById('btnChipAdd');
  if (btnAdd) btnAdd.addEventListener('click', openAddExamCourseModal);

  container.querySelectorAll('.btn-remove-chip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.getAttribute('data-code');
      removeExamCourse(code);
    });
  });
}

function initExamsView() {
  renderExamCourseChips();
  if (!examsState.exams.length) {
    loadExams();
  }
}

function getExamDateRange(sessionType) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (sessionType === 'winter') {
    const yr = currentMonth >= 9 ? currentYear + 1 : currentYear;
    return { from: `01-01-${yr}`, to: `28-02-${yr}` };
  } else if (sessionType === 'summer') {
    const yr = currentMonth >= 9 ? currentYear + 1 : currentYear;
    return { from: `01-06-${yr}`, to: `31-07-${yr}` };
  } else if (sessionType === 'autumn') {
    return { from: `01-09-${currentYear}`, to: `31-10-${currentYear}` };
  } else if (sessionType === 'custom') {
    const from = document.getElementById('examDateFrom').value;
    const to = document.getElementById('examDateTo').value;
    return {
      from: from ? isoToFormatted(from) : formatFormattedDate(now),
      to: to ? isoToFormatted(to) : formatFormattedDate(new Date(now.getTime() + 90 * 86400000))
    };
  } else {
    // Default: next 120 days from today
    const future = new Date(now.getTime() + 120 * 86400000);
    return { from: formatFormattedDate(now), to: formatFormattedDate(future) };
  }
}

async function loadExams(forceRefresh = false) {
  const courses = getActiveExamCourses();
  if (courses.length === 0) {
    document.getElementById('examsSummaryBanner').style.display = 'none';
    document.getElementById('examsContainer').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <h3>Nessun corso per gli esami</h3>
        <p>Configura il tuo corso di studi o aggiungi corsi con il pulsante <strong>+ Aggiungi corso</strong>.</p>
        <button class="btn-primary" style="margin-top:15px; width:auto;" onclick="openAddExamCourseModal()">➕ Aggiungi corso</button>
      </div>
    `;
    return;
  }

  const spinner = document.getElementById('examsSpinnerContainer');
  const container = document.getElementById('examsContainer');
  spinner.style.display = 'block';
  container.style.display = 'none';

  const dateRange = getExamDateRange(examsState.activeSession);
  const courseCodes = courses.map(c => c.code).join(',');

  const params = new URLSearchParams({
    corsi: courseCodes,
    datefrom: dateRange.from,
    dateto: dateRange.to
  });
  if (examsState.yearFilter) params.set('anni', examsState.yearFilter);
  if (examsState.searchQuery) params.set('q', examsState.searchQuery);

  try {
    const data = await fetchJson(`/api/exams?${params}`);
    examsState.exams = data.exams || [];

    spinner.style.display = 'none';
    container.style.display = 'block';

    document.getElementById('examsSummaryBanner').style.display = 'flex';
    document.getElementById('examsCountText').textContent = `${examsState.exams.length} ${examsState.exams.length === 1 ? 'appello trovato' : 'appelli trovati'}`;

    renderExams();
    if (forceRefresh) showToast('Appelli d\'esame aggiornati!');
  } catch (err) {
    spinner.style.display = 'none';
    container.style.display = 'block';
    console.error('Error loading exams:', err);
    showToast('Impossibile caricare gli appelli d\'esame');
  }
}

function renderExams() {
  const container = document.getElementById('examsContainer');
  if (!examsState.exams || examsState.exams.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>Nessun appello trovato</h3>
        <p>Nessun esame programmato nel periodo selezionato per i corsi monitorati. Prova a selezionare un'altra sessione o verificare i filtri.</p>
      </div>
    `;
    return;
  }

  // Group exams by date
  const groups = {};
  examsState.exams.forEach(ex => {
    const key = ex.date;
    if (!groups[key]) groups[key] = [];
    groups[key].push(ex);
  });

  container.innerHTML = Object.keys(groups).sort().map(dateKey => {
    const list = groups[dateKey];
    const first = list[0];
    const dateHeader = `📅 ${first.day_name} ${first.date_formatted}`;

    const cardsHtml = list.map(ex => {
      const courseInfo = ex.courses && ex.courses.length ? ex.courses[0] : null;
      const courseBadge = courseInfo ? `🎓 ${escapeHtml(courseInfo.title || courseInfo.code)}${courseInfo.year ? ' · ' + courseInfo.year + '° anno' : ''}` : '';

      return `
        <div class="exam-card">
          <div class="exam-top">
            <div class="exam-title">${escapeHtml(ex.name)}</div>
            <span class="exam-time-badge">${escapeHtml(ex.time_label)}</span>
          </div>

          <div class="exam-meta-grid">
            ${courseBadge ? `<span class="exam-meta-item course">${courseBadge}</span>` : ''}
            <span class="exam-meta-item">📍 ${escapeHtml(ex.aula || 'Aula da definire')} ${ex.sede ? '· ' + escapeHtml(ex.sede) : ''}</span>
            ${ex.docenti && ex.docenti.length ? `<span class="exam-meta-item">👤 Prof. ${escapeHtml(ex.docenti.join(', '))}</span>` : ''}
            ${ex.appello ? `<span class="badge-status" style="font-size:0.7rem;">Appello ${escapeHtml(ex.appello)}</span>` : ''}
          </div>

          <div class="exam-actions">
            <button class="btn-add-cal" data-id="${escapeHtml(ex.id)}">
              📅 Salva nel calendario
            </button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="exams-date-group">
        <div class="exams-date-header">${dateHeader}</div>
        ${cardsHtml}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-add-cal').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const ex = examsState.exams.find(item => item.id == id);
      if (ex) downloadExamIcs(ex);
    });
  });
}

function downloadExamIcs(exam) {
  const dateClean = (exam.date || '').replace(/-/g, '');
  const startClean = (exam.from || '09:00').replace(/:/g, '') + '00';
  const endClean = (exam.to || '12:00').replace(/:/g, '') + '00';
  const dtStart = `${dateClean}T${startClean}`;
  const dtEnd = `${dateClean}T${endClean}`;
  const summary = `Esame: ${exam.name}`;
  const location = `${exam.aula || ''} - ${exam.sede || ''}`.trim();
  const description = `Appello d'esame: ${exam.name}\nDocente: ${(exam.docenti || []).join(', ')}\n${exam.appello ? 'Appello n. ' + exam.appello : ''}`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UNIMIB Orari//IT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:exam-${exam.id || Date.now()}@unimib.it`,
    `DTSTAMP:${dateClean}T000000Z`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${summary.replace(/,/g, '\\,')}`,
    `LOCATION:${location.replace(/,/g, '\\,')}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n').replace(/,/g, '\\,')}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `esame_${exam.name.replace(/[^a-zA-Z0-9]/g, '_')}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('File calendario (.ics) scaricato!');
}

let addExamCourseData = {
  areas: [],
  courses: []
};

async function openAddExamCourseModal() {
  const modal = document.getElementById('addExamCourseModal');
  modal.classList.add('active');

  const areaSelect = document.getElementById('addExamCourseArea');
  const courseSelect = document.getElementById('addExamCourseSelect');
  const customInput = document.getElementById('addExamCourseCustomCode');
  const btnConfirm = document.getElementById('btnConfirmAddExamCourse');

  customInput.value = '';
  btnConfirm.disabled = true;

  if (!addExamCourseData.areas.length) {
    areaSelect.innerHTML = '<option value="">Caricamento aree...</option>';
    courseSelect.disabled = true;
    try {
      const yr = state.config ? state.config.anno : '2026';
      const data = await fetchJson(`/api/options?anno=${yr}`);
      addExamCourseData.areas = data.areas || [];
      addExamCourseData.courses = data.courses || [];

      areaSelect.innerHTML = '<option value="">-- Seleziona Area Didattica --</option>' + 
        addExamCourseData.areas.map(a => `<option value="${escapeHtml(a.value)}">${escapeHtml(a.label)}</option>`).join('');
    } catch (err) {
      areaSelect.innerHTML = '<option value="">Errore caricamento aree</option>';
    }
  }
}

function closeAddExamCourseModal() {
  document.getElementById('addExamCourseModal').classList.remove('active');
}

function onAddExamCourseAreaChange() {
  const areaVal = document.getElementById('addExamCourseArea').value;
  const courseSelect = document.getElementById('addExamCourseSelect');
  const btnConfirm = document.getElementById('btnConfirmAddExamCourse');

  if (!areaVal) {
    courseSelect.innerHTML = '<option value="">Seleziona prima l\'area</option>';
    courseSelect.disabled = true;
    btnConfirm.disabled = !document.getElementById('addExamCourseCustomCode').value.trim();
    return;
  }

  const matching = addExamCourseData.courses.filter(c => c.area === areaVal);
  courseSelect.innerHTML = '<option value="">-- Seleziona Corso --</option>' +
    matching.map(c => `<option value="${escapeHtml(c.value)}" data-label="${escapeHtml(c.label)}">${escapeHtml(c.label)} [${escapeHtml(c.value)}]</option>`).join('');
  courseSelect.disabled = false;
}

function onAddExamCourseSelectChange() {
  const courseSelect = document.getElementById('addExamCourseSelect');
  const btnConfirm = document.getElementById('btnConfirmAddExamCourse');
  const customInput = document.getElementById('addExamCourseCustomCode');

  if (courseSelect.value) {
    customInput.value = '';
    btnConfirm.disabled = false;
  } else {
    btnConfirm.disabled = !customInput.value.trim();
  }
}

function onAddExamCourseCustomCodeInput() {
  const customInput = document.getElementById('addExamCourseCustomCode');
  const courseSelect = document.getElementById('addExamCourseSelect');
  const btnConfirm = document.getElementById('btnConfirmAddExamCourse');

  if (customInput.value.trim()) {
    courseSelect.value = '';
    btnConfirm.disabled = false;
  } else {
    btnConfirm.disabled = !courseSelect.value;
  }
}

function confirmAddExamCourse() {
  const courseSelect = document.getElementById('addExamCourseSelect');
  const customInput = document.getElementById('addExamCourseCustomCode');

  let code = '';
  let label = '';

  if (courseSelect.value) {
    code = courseSelect.value.trim().toUpperCase();
    const opt = courseSelect.selectedOptions[0];
    label = opt.getAttribute('data-label') || code;
  } else if (customInput.value.trim()) {
    code = customInput.value.trim().toUpperCase();
    label = code;
  }

  if (!code) return;

  const active = getActiveExamCourses();
  if (active.some(c => c.code === code)) {
    showToast('Corso già presente nei corsi monitorati!');
    closeAddExamCourseModal();
    return;
  }

  examsState.extraCourses.push({ code, label });
  saveExamCourses(examsState.extraCourses);
  renderExamCourseChips();
  closeAddExamCourseModal();
  showToast(`Aggiunto corso ${label}`);
  loadExams();
}

function removeExamCourse(code) {
  examsState.extraCourses = examsState.extraCourses.filter(c => c.code !== code);
  saveExamCourses(examsState.extraCourses);
  renderExamCourseChips();
  showToast('Corso rimosso dal calendario esami');
  loadExams();
}

