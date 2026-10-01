/**
 * UNIMIB Orari - Mobile Calendar App Logic
 */

const CONFIG_KEY = 'unimib_config';
const CALENDAR_CACHE_PREFIX = 'unimib_cal_';
const FAVORITE_COLORS = ['#8B5CF6', '#10B981', '#06B6D4', '#F59E0B', '#EC4899', '#3B82F6', '#F97316', '#84CC16'];

// Profile / sync keys
const PROFILE_KEY   = 'unimib_profile_id';   // stores the 8-char profile ID
const FRIENDS_KEY   = 'unimib_friends';       // stores [{id, nickname, color}]

// Colors assigned to friends in shared calendar
const FRIENDS_COLORS = ['#8B5CF6','#10B981','#F59E0B','#EC4899','#3B82F6','#F97316','#06B6D4','#84CC16'];

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
  activeTab: 'timetable'  // 'timetable', 'rooms', 'exams', 'friends'
};

const EXAM_COURSES_KEY = 'unimib_exam_courses';

let roomsState = {
  buildings: [],
  selectedBuilding: localStorage.getItem('unimib_rooms_building') || 'U06',
  selectedDate: '', // initialized in initApp
  selectedTime: 'now', // 'now', '09:00', '11:00', '13:00', '14:30', '16:30', 'all'
  activeFilter: 'all', // 'all', 'free', 'occupied'
  searchQuery: '',
  data: null,
  modalRoom: null,
  modalDate: ''
};

let examsState = {
  extraCourses: [], // initialized in initApp from localStorage
  activeSession: 'upcoming', // 'upcoming', 'winter', 'summer', 'autumn', 'custom'
  filterMode: 'all', // 'all', 'target' (only followed courses)
  yearFilter: '',
  searchQuery: '',
  exams: [],
  isLoading: false
};

// Profile state (in-memory only; persisted ID stored in localStorage PROFILE_KEY)
let profileState = {
  id:       null,   // 8-char ID (null = not logged in)
  nickname: '',
  syncing:  false,
  lastSync: null
};

// Friends/shared calendar state
let friendsState = {
  friends: [],        // [{id, nickname, color}]
  currentMonday: null,
  events: [],
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

  // Load profile + friends from localStorage
  initProfile();
  friendsState.friends = loadFriends();
  friendsState.currentMonday = formatFormattedDate(getMonday(new Date()));

  setupEventListeners();
  updateRoomsDateDisplay();
  registerServiceWorker();

  state.currentMonday = formatFormattedDate(getMonday(new Date()));
  state.config = loadConfig();

  const shared = readSharedConfig();
  const urlParams = new URLSearchParams(window.location.search);
  const groupParam = urlParams.get('group');

  if (shared) {
    enterPreview(shared);
  } else if (groupParam) {
    handleSharedGroupUrl(groupParam);
  } else if (state.config) {
    applyConfig();
    loadCalendar(state.currentMonday);
  } else {
    const guestChosen = localStorage.getItem('unimib_guest_chosen');
    if (!profileState.id && !guestChosen) {
      openOnboardingModal();
    } else {
      showWelcome();
      openSetup();
    }
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
  document.getElementById('tabFriends').addEventListener('click', () => switchTab('friends'));

  // Profile button
  document.getElementById('btnProfile').addEventListener('click', openProfileModal);
  document.getElementById('btnCloseProfile').addEventListener('click', () => {
    document.getElementById('profileModal').classList.remove('active');
  });
  document.getElementById('btnCreateProfile').addEventListener('click', handleCreateProfile);
  document.getElementById('btnLoginProfile').addEventListener('click', handleLoginProfile);
  document.getElementById('btnLogoutProfile').addEventListener('click', handleLogoutProfile);
  document.getElementById('btnCopyProfileId').addEventListener('click', copyProfileId);
  document.getElementById('btnSyncNow').addEventListener('click', syncProfileNow);

  // Friends / shared calendar buttons
  document.getElementById('btnAddFriend').addEventListener('click', openAddFriendModal);
  document.getElementById('btnShareFriendsGroup').addEventListener('click', shareFriendsGroup);
  document.getElementById('btnCloseAddFriend').addEventListener('click', () => {
    document.getElementById('addFriendModal').classList.remove('active');
  });
  document.getElementById('btnLookupFriendCode').addEventListener('click', lookupFriendByCode);
  document.getElementById('btnConfirmAddFriendCode').addEventListener('click', confirmAddFriendByCode);
  document.getElementById('btnSearchFriendName').addEventListener('click', searchFriendByName);
  document.getElementById('friendCodeInput').addEventListener('input', () => {
    // Hide preview / error on new input
    document.getElementById('friendCodePreview').style.display = 'none';
    document.getElementById('friendCodeError').style.display = 'none';
    document.getElementById('btnConfirmAddFriendCode').disabled = true;
    document.getElementById('btnConfirmAddFriendCode')._foundProfile = null;
  });
  document.getElementById('btnFriendsPrevWeek').addEventListener('click', () => changeFriendsWeek(-7));
  document.getElementById('btnFriendsNextWeek').addEventListener('click', () => changeFriendsWeek(7));
  document.getElementById('btnFriendsToday').addEventListener('click', () => {
    friendsState.currentMonday = formatFormattedDate(getMonday(new Date()));
    loadFriendsCalendar();
  });

  // Onboarding Modal listeners
  const btnOnbCreate = document.getElementById('btnOnboardingCreate');
  if (btnOnbCreate) btnOnbCreate.addEventListener('click', handleOnboardingCreate);
  const btnOnbLogin = document.getElementById('btnOnboardingLogin');
  if (btnOnbLogin) btnOnbLogin.addEventListener('click', handleOnboardingLogin);
  const btnOnbGuest = document.getElementById('btnOnboardingGuest');
  if (btnOnbGuest) btnOnbGuest.addEventListener('click', handleOnboardingGuest);

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
      updateRoomsDateDisplay();
      loadRoomsOccupancy();
    }
  });

  const roomsDateWrapper = document.getElementById('roomsDateWrapper');
  if (roomsDateWrapper) {
    roomsDateWrapper.addEventListener('click', (e) => {
      const input = document.getElementById('roomsDateInput');
      if (input && typeof input.showPicker === 'function' && e.target !== input) {
        try {
          input.showPicker();
        } catch (err) {}
      }
    });
  }

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

  document.querySelectorAll('#roomsTimeBar .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#roomsTimeBar .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      roomsState.selectedTime = pill.getAttribute('data-time') || 'now';
      loadRoomsOccupancy();
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

  const btnExamAll = document.getElementById('btnExamFilterAll');
  if (btnExamAll) btnExamAll.addEventListener('click', () => setExamFilter('all'));
  const btnExamTarget = document.getElementById('btnExamFilterTarget');
  if (btnExamTarget) btnExamTarget.addEventListener('click', () => setExamFilter('target'));

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

  const examDateFromInput = document.getElementById('examDateFrom');
  const examDateFromText = document.getElementById('examDateFromText');
  if (examDateFromInput && examDateFromText) {
    examDateFromInput.addEventListener('change', () => {
      examDateFromText.textContent = examDateFromInput.value ? formatDateItalianShort(examDateFromInput.value) : 'gg/mm/aaaa';
    });
  }

  const examDateToInput = document.getElementById('examDateTo');
  const examDateToText = document.getElementById('examDateToText');
  if (examDateToInput && examDateToText) {
    examDateToInput.addEventListener('change', () => {
      examDateToText.textContent = examDateToInput.value ? formatDateItalianShort(examDateToInput.value) : 'gg/mm/aaaa';
    });
  }

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
  // Background sync to cloud profile if logged in and PIN is in session memory
  if (profileState.id && profileState._pin) {
    _syncConfigToProfile().catch(e => console.warn('Profile sync error:', e));
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

    const itDateTitle = formatDateItalianLong(group.date);
    section.innerHTML = `<div class="day-header-title">📌 ${escapeHtml(itDateTitle)}</div>`;

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
const MONTHS_NAMES_IT = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
];

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

function parseAnyDate(d) {
  if (!d) return new Date();
  if (d instanceof Date) return d;
  if (typeof d === 'string') {
    if (d.includes('T')) return new Date(d);
    const partsHyphen = d.split('-');
    if (partsHyphen.length === 3) {
      if (partsHyphen[0].length === 4) {
        return new Date(Number(partsHyphen[0]), Number(partsHyphen[1]) - 1, Number(partsHyphen[2]));
      } else {
        return new Date(Number(partsHyphen[2]), Number(partsHyphen[1]) - 1, Number(partsHyphen[0]));
      }
    }
    const partsSlash = d.split('/');
    if (partsSlash.length === 3) {
      return new Date(Number(partsSlash[2]), Number(partsSlash[1]) - 1, Number(partsSlash[0]));
    }
  }
  return new Date(d);
}

function formatDateItalianLong(d) {
  const dt = parseAnyDate(d);
  if (!dt || isNaN(dt.getTime())) return String(d || '');
  const dayName = DAYS_NAMES_IT[dt.getDay()];
  const mName = MONTHS_NAMES_IT[dt.getMonth()];
  return `${dayName} ${dt.getDate()} ${mName} ${dt.getFullYear()}`;
}

function formatDateItalianShort(d) {
  const dt = parseAnyDate(d);
  if (!dt || isNaN(dt.getTime())) return String(d || '');
  const day = String(dt.getDate()).padStart(2, '0');
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${dt.getFullYear()}`;
}

function isoToDisplayDate(iso) {
  return formatDateItalianLong(iso);
}

// ---------- Tab Navigation Switcher ----------

 function switchTab(tabId) {
  state.activeTab = tabId;

  const tabMap = { timetable: 'tabTimetable', rooms: 'tabRooms', exams: 'tabExams', friends: 'tabFriends' };
  document.querySelectorAll('.bottom-nav .nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.id === tabMap[tabId]);
  });

  document.getElementById('viewTimetable').classList.toggle('hidden', tabId !== 'timetable');
  document.getElementById('viewRooms').classList.toggle('hidden', tabId !== 'rooms');
  document.getElementById('viewExams').classList.toggle('hidden', tabId !== 'exams');
  document.getElementById('viewFriends').classList.toggle('hidden', tabId !== 'friends');

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
  } else if (tabId === 'friends') {
    document.getElementById('headerSubtitle').textContent = 'Calendario condiviso amici';
    renderFriendChips();
    if (friendsState.friends.length && !friendsState.events.length) {
      loadFriendsCalendar();
    } else {
      renderFriendsView();
    }
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
    updateRoomsDateDisplay();
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
  let timeParam = '';
  if (roomsState.selectedTime && roomsState.selectedTime !== 'now') {
    timeParam = `&time=${encodeURIComponent(roomsState.selectedTime)}`;
  }

  try {
    const data = await fetchJson(`/api/rooms?sede=${encodeURIComponent(roomsState.selectedBuilding)}&date=${encodeURIComponent(apiDate)}${timeParam}`);
    roomsState.data = data;
    spinner.style.display = 'none';
    grid.style.display = 'grid';

    document.getElementById('roomsSummaryBanner').style.display = 'flex';
    document.getElementById('roomsFilterBar').style.display = 'flex';

    document.getElementById('badgeRoomsTotal').textContent = `${data.total_rooms} aule`;
    document.getElementById('badgeRoomsFree').textContent = `🟢 ${data.free_rooms} libere`;
    document.getElementById('badgeRoomsOccupied').textContent = `🔴 ${data.occupied_rooms} occupate`;

    const dateDisplay = document.getElementById('roomsDateDisplay');
    if (dateDisplay) {
      dateDisplay.textContent = data.date_long || formatDateItalianLong(roomsState.selectedDate);
    }

    const dateLabel = data.date_long || formatDateItalianLong(roomsState.selectedDate);
    const timeLabel = data.check_time ? ` · Ore ${data.check_time}` : (roomsState.selectedTime === 'all' ? ' · Tutta la giornata' : '');
    document.getElementById('roomsSummaryText').textContent = data.is_today && (!roomsState.selectedTime || roomsState.selectedTime === 'now')
      ? `Stato in tempo reale${timeLabel}`
      : `${dateLabel}${timeLabel}`;

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

  grid.innerHTML = filtered.map(r => {
    const statusBadgeText = r.is_free ? 'LIBERA' : 'OCCUPATA';
    let bodyHtml = '';

    if (r.is_free) {
      let freeHeading = '';
      let freeSub = '';
      if (r.free_until && r.free_until !== 'fine giornata') {
        freeHeading = `Libera adesso · Fino alle ${escapeHtml(r.free_until)}`;
        if (r.next_event) {
          freeSub = `<div style="color:var(--text-secondary); font-size:0.8rem; margin-top:4px;">📖 Prossima: <strong>${escapeHtml(r.next_event.name)}</strong> (${escapeHtml(r.next_event.from)} - ${escapeHtml(r.next_event.to)})</div>`;
        }
      } else if (r.events_count > 0) {
        freeHeading = `Libera per il resto della giornata`;
        freeSub = `<div style="color:var(--text-secondary); font-size:0.8rem; margin-top:4px;">Lezioni terminate per oggi (${r.events_count} svolte)</div>`;
      } else {
        freeHeading = `Libera tutta la giornata`;
        freeSub = `<div style="color:var(--text-secondary); font-size:0.8rem; margin-top:4px;">Nessuna lezione o evento programmato</div>`;
      }
      bodyHtml = `<strong>${freeHeading}</strong>${freeSub}`;
    } else {
      // OCCUPIED
      const untilTime = r.occupied_until || (r.current_event ? r.current_event.to : '');
      const fromTime = r.occupied_from || (r.current_event ? r.current_event.from : '');
      let occHeading = '';
      if (untilTime && fromTime && roomsState.selectedTime === 'all') {
        occHeading = `Occupata dalle ${escapeHtml(fromTime)} alle ${escapeHtml(untilTime)}`;
      } else if (untilTime) {
        occHeading = `Occupata fino alle ${escapeHtml(untilTime)}`;
      } else if (fromTime) {
        occHeading = `Occupata dalle ${escapeHtml(fromTime)}`;
      } else {
        occHeading = `Attualmente occupata`;
      }

      let currentSub = '';
      if (r.current_event) {
        currentSub += `<div style="color:#FFF; font-weight:600; margin-top:4px; font-size:0.85rem;">📖 In corso: ${escapeHtml(r.current_event.name)} <span style="color:var(--accent-purple); font-size:0.78rem;">(${escapeHtml(r.current_event.from)} - ${escapeHtml(r.current_event.to)})</span></div>`;
        if (r.current_event.docenti && r.current_event.docenti.length) {
          currentSub += `<div style="color:var(--text-secondary); font-size:0.78rem;">👤 ${escapeHtml(r.current_event.docenti.join(', '))}</div>`;
        }
      }
      if (r.chained_next_event) {
        currentSub += `<div style="color:var(--accent-cyan); font-size:0.78rem; margin-top:3px;">⏭️ A seguire: ${escapeHtml(r.chained_next_event.name)} (${escapeHtml(r.chained_next_event.from)} - ${escapeHtml(r.chained_next_event.to)})</div>`;
      }
      bodyHtml = `<strong style="color:var(--danger);">${occHeading}</strong>${currentSub}`;
    }

    return `
      <div class="room-card ${r.is_free ? 'free' : 'occupied'}" data-code="${escapeHtml(r.code)}">
        <div class="room-card-top">
          <div>
            <div class="room-card-title">${escapeHtml(r.name)}</div>
            <div class="room-card-capacity">👥 ${r.capacity > 0 ? r.capacity + ' posti' : 'Capienza n/d'} · ${escapeHtml(r.code)}</div>
          </div>
          <div class="status-badge ${r.is_free ? 'free' : 'occupied'}">
            <span class="status-indicator-dot"></span>
            ${statusBadgeText}
          </div>
        </div>
        <div class="room-card-body">
          ${bodyHtml}
        </div>
        <div class="room-card-footer">
          <span>${r.events_count} ${r.events_count === 1 ? 'lezione/evento oggi' : 'lezioni/eventi oggi'}</span>
          <span>Tutte le lezioni ➔</span>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('click', () => {
      const code = card.getAttribute('data-code');
      const room = roomsState.data.rooms.find(r => r.code === code);
      if (room) openRoomSchedule(room);
    });
  });
}

function updateRoomsDateDisplay() {
  const el = document.getElementById('roomsDateDisplay');
  if (el) el.textContent = formatDateItalianLong(roomsState.selectedDate);
  const formattedBox = document.getElementById('roomsDateFormattedText');
  if (formattedBox) formattedBox.textContent = formatDateItalianShort(roomsState.selectedDate);
}

function setRoomsDateToday() {
  roomsState.selectedDate = formatDateIso(new Date());
  document.getElementById('roomsDateInput').value = roomsState.selectedDate;
  updateRoomsDateDisplay();
  loadRoomsOccupancy();
}

function changeRoomsDate(deltaDays) {
  const dt = isoToDate(roomsState.selectedDate);
  dt.setDate(dt.getDate() + deltaDays);
  roomsState.selectedDate = formatDateIso(dt);
  document.getElementById('roomsDateInput').value = roomsState.selectedDate;
  updateRoomsDateDisplay();
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
  if (profileState.id && profileState._pin) {
    _syncConfigToProfile().catch(e => console.warn('Profile sync error:', e));
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

function setExamFilter(filterType) {
  examsState.filterMode = filterType;
  const btnAll = document.getElementById('btnExamFilterAll');
  const btnTarget = document.getElementById('btnExamFilterTarget');
  if (btnAll) btnAll.classList.toggle('active', filterType === 'all');
  if (btnTarget) btnTarget.classList.toggle('active', filterType === 'target');
  renderExams();
}

function renderExams() {
  const container = document.getElementById('examsContainer');
  let list = examsState.exams || [];

  if (examsState.filterMode === 'target') {
    const favorites = (state.config && state.config.favorites) || [];
    if (!favorites.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⭐</div>
          <h3>Nessun corso seguito selezionato</h3>
          <p>Non hai ancora scelto i tuoi insegnamenti seguiti nelle impostazioni del corso di studio. Vai su ⚙️ per selezionarli, oppure visualizza tutti gli appelli del corso.</p>
          <button class="btn-primary" style="margin-top:15px; width:auto;" onclick="openSetup()">⚙️ Seleziona i tuoi corsi</button>
        </div>
      `;
      const countEl = document.getElementById('examsCountText');
      if (countEl) countEl.textContent = '0 appelli trovati (filtro: I Miei Corsi)';
      return;
    }

    list = list.filter(ex => {
      const exName = (ex.name || '').toLowerCase();
      const exDesc = (ex.description || '').toLowerCase();
      return favorites.some(fav => {
        const fCode = (fav.code || '').toLowerCase();
        const fLabel = (fav.label || '').toLowerCase();
        if (fCode && (exName.includes(fCode) || exDesc.includes(fCode))) return true;
        if (fLabel && (exName.includes(fLabel) || fLabel.includes(exName))) return true;
        const stripNoise = s => s.replace(/\b(corso|di|e|ed|il|la|del|della|dei|delle|lab|laboratorio|modulo|avanzato|base|1|2|i|ii)\b/gi, '').replace(/\s+/g, ' ').trim();
        const cleanF = stripNoise(fLabel);
        const cleanE = stripNoise(exName);
        if (cleanF.length >= 4 && cleanE.includes(cleanF)) return true;
        if (cleanE.length >= 4 && cleanF.includes(cleanE)) return true;
        return false;
      });
    });
  }

  const countEl = document.getElementById('examsCountText');
  if (countEl) {
    const suffix = examsState.filterMode === 'target' ? ' (I Miei Corsi)' : '';
    countEl.textContent = `${list.length} ${list.length === 1 ? 'appello trovato' : 'appelli trovati'}${suffix}`;
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>Nessun appello trovato</h3>
        <p>${examsState.filterMode === 'target' 
          ? 'Nessun appello trovato per i tuoi corsi seguiti nel periodo selezionato. Prova a selezionare "Tutti gli Appelli" o un\'altra sessione.' 
          : 'Nessun esame programmato nel periodo selezionato per i corsi monitorati. Prova a selezionare un\'altra sessione o verificare i filtri.'}</p>
      </div>
    `;
    return;
  }

  // Group exams by date
  const groups = {};
  list.forEach(ex => {
    const key = ex.date;
    if (!groups[key]) groups[key] = [];
    groups[key].push(ex);
  });

  container.innerHTML = Object.keys(groups).sort().map(dateKey => {
    const list = groups[dateKey];
    const first = list[0];
    const dateHeader = `📅 ${first.date_long || formatDateItalianLong(first.date)} (${first.date_formatted || formatDateItalianShort(first.date)})`;

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


// ══════════════════════════════════════════════════════════════
//  PROFILE (Anonymous Identity with Nickname + PIN)
// ══════════════════════════════════════════════════════════════

/**
 * On app start: if PROFILE_KEY exists in localStorage, populate profileState.
 * Also update the profile button indicator.
 */
function initProfile() {
  const stored = localStorage.getItem(PROFILE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      profileState.id       = parsed.id;
      profileState.nickname = parsed.nickname;
    } catch (e) { /* ignore */ }
  }
  updateProfileButton();
}

function updateProfileButton() {
  const btn = document.getElementById('btnProfile');
  if (!btn) return;
  btn.classList.toggle('profile-active', Boolean(profileState.id));
  btn.title = profileState.id
    ? `${profileState.nickname} (${profileState.id})`
    : 'Il tuo profilo';
}

function saveProfileLocally() {
  if (profileState.id) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      id: profileState.id,
      nickname: profileState.nickname
    }));
  } else {
    localStorage.removeItem(PROFILE_KEY);
  }
  updateProfileButton();
}

// Open the Profile modal, showing logged-in or logged-out state
function openProfileModal() {
  const modal = document.getElementById('profileModal');
  modal.classList.add('active');
  renderProfileModal();
}

function renderProfileModal() {
  const loggedIn  = Boolean(profileState.id);
  document.getElementById('profileLoggedOut').style.display = loggedIn ? 'none' : '';
  document.getElementById('profileLoggedIn').style.display  = loggedIn ? ''     : 'none';

  if (loggedIn) {
    document.getElementById('profileDisplayNickname').textContent = profileState.nickname;
    document.getElementById('profileDisplayId').textContent       = profileState.id;
    const hintEl = document.getElementById('profileDisplayCodeHint');
    if (hintEl) hintEl.textContent = profileState.id;
    document.getElementById('profileSyncText').textContent        = profileState.lastSync
      ? `Sincronizzato il ${new Date(profileState.lastSync).toLocaleTimeString('it-IT')}`
      : 'Non ancora sincronizzato';
  } else {
    // Reset forms
    showProfileTab('create');
    document.getElementById('profileNickname').value    = '';
    document.getElementById('profilePin').value         = '';
    document.getElementById('profilePinConfirm').value  = '';
    document.getElementById('profileCreateError').style.display = 'none';
    const loginNickEl = document.getElementById('profileLoginNickname');
    if (loginNickEl) loginNickEl.value = '';
    document.getElementById('profileLoginPin').value    = '';
    document.getElementById('profileLoginError').style.display  = 'none';
  }
}

function showProfileTab(tab) {
  document.getElementById('profileCreateForm').style.display = tab === 'create' ? '' : 'none';
  document.getElementById('profileLoginForm').style.display  = tab === 'login'  ? '' : 'none';
  document.getElementById('profileTabCreate').classList.toggle('active', tab === 'create');
  document.getElementById('profileTabLogin').classList.toggle('active', tab === 'login');
}

async function handleCreateProfile() {
  const nickname = document.getElementById('profileNickname').value.trim();
  const pin      = document.getElementById('profilePin').value;
  const pinConf  = document.getElementById('profilePinConfirm').value;
  const errEl    = document.getElementById('profileCreateError');

  errEl.style.display = 'none';

  if (!nickname) {
    errEl.textContent = 'Inserisci un soprannome.';
    errEl.style.display = '';
    return;
  }
  if (!pin || pin.length < 4 || !/^\d+$/.test(pin)) {
    errEl.textContent = 'Il PIN deve essere di almeno 4 cifre numeriche.';
    errEl.style.display = '';
    return;
  }
  if (pin !== pinConf) {
    errEl.textContent = 'I PIN non corrispondono.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btnCreateProfile');
  btn.disabled = true;
  btn.textContent = 'Creazione in corso...';

  try {
    const body = {
      nickname,
      pin,
      config:       state.config || null,
      exam_courses: examsState.extraCourses || []
    };
    const resp = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      errEl.textContent = data.error || 'Errore durante la creazione.';
      errEl.style.display = '';
      return;
    }
    profileState.id       = data.id;
    profileState.nickname = data.nickname;
    profileState.lastSync = Date.now();
    profileState._pin     = pin;  // session-only, for background auto-sync
    saveProfileLocally();
    renderProfileModal();
    showToast(`Profilo creato! Il tuo codice è: ${data.id}`);
    setTimeout(() => {
      document.getElementById('profileModal').classList.remove('active');
      if (!state.config) openSetup();
    }, 1200);
  } catch (e) {
    errEl.textContent = 'Errore di connessione. Riprova.';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crea profilo';
  }
}

async function handleLoginProfile() {
  const nickEl = document.getElementById('profileLoginNickname');
  const nick = nickEl ? nickEl.value.trim() : '';
  const pin  = document.getElementById('profileLoginPin').value.trim();
  const errEl = document.getElementById('profileLoginError');

  errEl.style.display = 'none';
  if (!nick) {
    errEl.textContent = 'Inserisci il tuo soprannome.';
    errEl.style.display = '';
    return;
  }
  if (!pin) {
    errEl.textContent = 'Inserisci il tuo PIN.';
    errEl.style.display = '';
    return;
  }

  const cleanNick = nick.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const id = `${cleanNick}${pin}`;

  const btn = document.getElementById('btnLoginProfile');
  btn.disabled = true;
  btn.textContent = 'Accesso in corso...';

  try {
    // Verify by attempting a PUT with the config — the server validates the PIN
    const resp = await fetch(`/api/profile?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin,
        config: state.config || null,
        exam_courses: examsState.extraCourses || []
      })
    });
    const data = await resp.json();
    if (resp.status === 404) {
      errEl.textContent = 'Nessun profilo trovato per questo soprannome e PIN.';
      errEl.style.display = '';
      return;
    }
    if (resp.status === 403) {
      errEl.textContent = 'PIN non corretto.';
      errEl.style.display = '';
      return;
    }
    if (!resp.ok) {
      errEl.textContent = data.error || 'Errore di accesso.';
      errEl.style.display = '';
      return;
    }

    // Merge remote config into local if local is empty
    if (!state.config && data.config) {
      state.config = data.config;
      saveConfig(state.config);
      applyConfig();
      loadCalendar(state.currentMonday);
    }
    if (data.exam_courses && data.exam_courses.length && !examsState.extraCourses.length) {
      examsState.extraCourses = data.exam_courses;
      saveExamCourses(examsState.extraCourses);
    }

    profileState.id       = data.id;
    profileState.nickname = data.nickname;
    profileState.lastSync = Date.now();
    profileState._pin     = pin;  // session-only, for background auto-sync
    saveProfileLocally();
    renderProfileModal();
    showToast(`Bentornato, ${data.nickname}! 👋`);
    setTimeout(() => {
      document.getElementById('profileModal').classList.remove('active');
      if (!state.config) openSetup();
    }, 1200);
  } catch (e) {
    errEl.textContent = 'Errore di connessione. Riprova.';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Accedi';
  }
}

function handleLogoutProfile() {
  profileState.id       = null;
  profileState.nickname = '';
  profileState.lastSync = null;
  profileState._pin     = null;  // clear session PIN
  saveProfileLocally();
  renderProfileModal();
  showToast('Profilo rimosso da questo dispositivo');
}

async function copyProfileId() {
  const id = profileState.id;
  if (!id) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(id);
    } else {
      legacyCopy(id);
    }
    showToast(`Codice ${id} copiato!`);
  } catch (e) {
    showToast(`Il tuo codice è: ${id}`);
  }
}

async function syncProfileNow() {
  if (!profileState.id) return;

  const btn  = document.getElementById('btnSyncNow');
  const text = document.getElementById('profileSyncText');
  btn.disabled = true;
  text.textContent = 'Sincronizzazione...';

  try {
    if (profileState._pin) {
      // Full sync: push current config to server
      await _syncConfigToProfile();
      text.textContent = `Sincronizzato alle ${new Date().toLocaleTimeString('it-IT')}`;
      showToast('Profilo sincronizzato ✅');
    } else {
      // No PIN in session: just verify the profile is reachable
      const resp = await fetch(`/api/profile?id=${profileState.id}`);
      if (resp.ok) {
        text.textContent = `Raggiungibile (riaccedi per sincronizzare i dati)`;
        showToast('Profilo raggiungibile ✅');
      } else {
        text.textContent = 'Profilo non trovato sul server';
      }
    }
    profileState.lastSync = Date.now();
    saveProfileLocally();
  } catch (e) {
    text.textContent = 'Errore di connessione';
  } finally {
    btn.disabled = false;
  }
}

/**
 * Background sync: push current config + exam courses to the cloud profile.
 * Requires profileState._pin to be set (session memory only).
 */
async function _syncConfigToProfile() {
  if (!profileState.id || !profileState._pin) return;
  const resp = await fetch(`/api/profile?id=${profileState.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pin:          profileState._pin,
      config:       state.config || null,
      exam_courses: examsState.extraCourses || []
    })
  });
  if (resp.ok) {
    profileState.lastSync = Date.now();
    saveProfileLocally();
  }
}


// ══════════════════════════════════════════════════════════════
//  FRIENDS / SHARED CALENDAR
// ══════════════════════════════════════════════════════════════

function loadFriends() {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveFriends(friends) {
  try {
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends));
  } catch (e) { /* ignore */ }
}

function openAddFriendModal() {
  const modal = document.getElementById('addFriendModal');
  modal.classList.add('active');
  // Reset state
  showFriendTab('code');
  document.getElementById('friendCodeInput').value = '';
  document.getElementById('friendCodePreview').style.display  = 'none';
  document.getElementById('friendCodeError').style.display    = 'none';
  document.getElementById('btnConfirmAddFriendCode').disabled = true;
  document.getElementById('friendNameInput').value = '';
  document.getElementById('friendNameResults').style.display  = 'none';
  document.getElementById('friendNameResults').innerHTML      = '';
}

function showFriendTab(tab) {
  document.getElementById('friendByCode').style.display = tab === 'code' ? '' : 'none';
  document.getElementById('friendByName').style.display = tab === 'name' ? '' : 'none';
  document.getElementById('friendTabCode').classList.toggle('active', tab === 'code');
  document.getElementById('friendTabName').classList.toggle('active', tab === 'name');
}

async function lookupFriendByCode() {
  const id     = document.getElementById('friendCodeInput').value.trim().toLowerCase();
  const errEl  = document.getElementById('friendCodeError');
  const prev   = document.getElementById('friendCodePreview');
  const confBtn = document.getElementById('btnConfirmAddFriendCode');

  errEl.style.display = 'none';
  prev.style.display  = 'none';
  confBtn.disabled    = true;
  confBtn._foundProfile = null;

  if (id.length < 3) {
    errEl.textContent   = 'Inserisci il codice del tuo amico (es. mario1234).';
    errEl.style.display = '';
    return;
  }
  // Check not already added
  if (friendsState.friends.some(f => f.id === id)) {
    errEl.textContent   = 'Questo amico è già nel tuo calendario.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('btnLookupFriendCode');
  btn.disabled = true;
  btn.textContent = 'Ricerca...';

  try {
    const resp = await fetch(`/api/profile?id=${id}`);
    const data = await resp.json();
    if (!resp.ok) {
      errEl.textContent   = 'Codice non trovato. Verifica e riprova.';
      errEl.style.display = '';
      return;
    }
    document.getElementById('friendCodePreviewNick').textContent = data.nickname || id;
    prev.style.display      = '';
    confBtn.disabled        = false;
    confBtn._foundProfile   = data;
  } catch (e) {
    errEl.textContent   = 'Errore di connessione.';
    errEl.style.display = '';
  } finally {
    btn.disabled    = false;
    btn.textContent = '🔍 Cerca';
  }
}

function confirmAddFriendByCode() {
  const btn     = document.getElementById('btnConfirmAddFriendCode');
  const profile = btn._foundProfile;
  if (!profile) return;

  _addFriend({ id: profile.id, nickname: profile.nickname });
  document.getElementById('addFriendModal').classList.remove('active');
}

async function searchFriendByName() {
  const nickname = document.getElementById('friendNameInput').value.trim();
  const resultsEl = document.getElementById('friendNameResults');

  if (!nickname) return;

  const btn = document.getElementById('btnSearchFriendName');
  btn.disabled = true;
  btn.textContent = 'Ricerca...';
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.8rem;">Ricerca in corso...</p>';

  try {
    const resp = await fetch(`/api/profile?lookup=${encodeURIComponent(nickname)}`);
    const data = await resp.json();
    const results = data.results || [];

    if (!results.length) {
      resultsEl.innerHTML = '<p style="color:var(--text-secondary); font-size:0.8rem;">Nessun profilo trovato con questo soprannome.</p>';
      return;
    }

    resultsEl.innerHTML = results.map(r => `
      <div class="friend-result-item" onclick="addFriendFromSearch('${escapeHtml(r.id)}','${escapeHtml(r.nickname)}')">
        <div class="friend-result-info">
          <span class="friend-result-nick">${escapeHtml(r.nickname)}</span>
          <span class="friend-result-id">${escapeHtml(r.id)}</span>
        </div>
        <button class="btn-primary" style="width:auto; padding:5px 10px; font-size:0.75rem;" onclick="event.stopPropagation(); addFriendFromSearch('${escapeHtml(r.id)}','${escapeHtml(r.nickname)}')">+ Aggiungi</button>
      </div>
    `).join('');
  } catch (e) {
    resultsEl.innerHTML = '<p style="color:#EF4444; font-size:0.8rem;">Errore di connessione.</p>';
  } finally {
    btn.disabled    = false;
    btn.textContent = '🔍 Cerca';
  }
}

function addFriendFromSearch(id, nickname) {
  if (friendsState.friends.some(f => f.id === id)) {
    showToast('Questo amico è già nel calendario');
    return;
  }
  _addFriend({ id, nickname });
  document.getElementById('addFriendModal').classList.remove('active');
}

function _addFriend({ id, nickname }) {
  const colorIndex = friendsState.friends.length % FRIENDS_COLORS.length;
  const color      = FRIENDS_COLORS[colorIndex];
  friendsState.friends.push({ id, nickname, color });
  saveFriends(friendsState.friends);
  // Clear cached events so next view forces a reload
  friendsState.events = [];
  renderFriendChips();
  showToast(`${nickname} aggiunto al calendario! 🎉`);
  // If we're already on the friends tab, reload
  if (state.activeTab === 'friends') {
    loadFriendsCalendar();
  }
}

function removeFriend(id) {
  friendsState.friends = friendsState.friends.filter(f => f.id !== id);
  saveFriends(friendsState.friends);
  // Reassign colors to maintain consistency
  friendsState.friends.forEach((f, i) => { f.color = FRIENDS_COLORS[i % FRIENDS_COLORS.length]; });
  saveFriends(friendsState.friends);
  friendsState.events = [];
  renderFriendChips();
  renderFriendsView();
  showToast('Amico rimosso dal calendario');
}

function renderFriendChips() {
  const container = document.getElementById('friendChips');
  if (!container) return;
  if (!friendsState.friends.length) {
    container.innerHTML = '<span style="color:var(--text-muted); font-size:0.8rem; line-height:32px;">Nessun amico aggiunto — usa il pulsante + per iniziare</span>';
    return;
  }
  container.innerHTML = friendsState.friends.map(f => `
    <span class="friend-chip" style="background: ${hexToRgba(f.color, 0.18)}; border-color: ${hexToRgba(f.color, 0.4)};">
      <span class="friend-chip-dot" style="background:${f.color};"></span>
      <span style="overflow:hidden; text-overflow:ellipsis;">${escapeHtml(f.nickname)}</span>
      <button class="friend-chip-remove" onclick="removeFriend('${escapeHtml(f.id)}')" title="Rimuovi">✕</button>
    </span>
  `).join('');
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

async function loadFriendsCalendar() {
  if (!friendsState.friends.length) {
    renderFriendsView();
    return;
  }

  friendsState.isLoading = true;
  renderFriendsView(); // shows spinner

  const ids  = friendsState.friends.map(f => f.id).join(',');
  const date = friendsState.currentMonday
    ? friendsState.currentMonday.split('-').join('-')  // already DD-MM-YYYY
    : formatFormattedDate(getMonday(new Date()));

  try {
    const resp = await fetchJson(`/api/shared_calendar?ids=${encodeURIComponent(ids)}&date=${encodeURIComponent(date)}`);
    friendsState.events  = resp.events || [];
    // Update friend colors from server response (in case order changed)
    (resp.profiles || []).forEach(p => {
      const local = friendsState.friends.find(f => f.id === p.id);
      if (local) local.color = p.color;
    });
    saveFriends(friendsState.friends);
  } catch (e) {
    console.warn('Friends calendar load error:', e);
    friendsState.events = [];
  } finally {
    friendsState.isLoading = false;
    updateFriendsWeekLabel();
    renderFriendChips();
    renderFriendsView();
  }
}

function changeFriendsWeek(offset) {
  const parts = (friendsState.currentMonday || formatFormattedDate(getMonday(new Date()))).split('-');
  const dt    = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  dt.setDate(dt.getDate() + offset);
  friendsState.currentMonday = formatFormattedDate(getMonday(dt));
  friendsState.events = [];
  loadFriendsCalendar();
}

function updateFriendsWeekLabel() {
  const labelEl = document.getElementById('friendsWeekLabel');
  if (!labelEl || !friendsState.currentMonday) return;
  const parts   = friendsState.currentMonday.split('-');
  const monday  = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  const friday  = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  labelEl.textContent = `${formatDateItalianShort(formatDateIso(monday))} – ${formatDateItalianShort(formatDateIso(friday))}`;
}

function renderFriendsView() {
  const spinner  = document.getElementById('friendsSpinnerContainer');
  const empty    = document.getElementById('friendsEmptyState');
  const evtCont  = document.getElementById('friendsEventsContainer');
  const legend   = document.getElementById('friendsLegend');

  if (friendsState.isLoading) {
    spinner.style.display  = '';
    empty.style.display    = 'none';
    evtCont.style.display  = 'none';
    legend.style.display   = 'none';
    return;
  }

  spinner.style.display = 'none';

  if (!friendsState.friends.length) {
    empty.style.display   = '';
    evtCont.style.display = 'none';
    legend.style.display  = 'none';
    return;
  }

  empty.style.display = 'none';

  // Render legend
  legend.style.display = '';
  legend.innerHTML = friendsState.friends.map(f => `
    <div class="friends-legend-item">
      <span class="friends-legend-dot" style="background:${f.color};"></span>
      <span>${escapeHtml(f.nickname)}</span>
    </div>
  `).join('');

  if (!friendsState.events.length) {
    evtCont.style.display = '';
    evtCont.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding:24px 0;">Nessuna lezione trovata per questa settimana.</p>';
    return;
  }

  evtCont.style.display = '';

  // Group by date
  const byDate = {};
  friendsState.events.forEach(ev => {
    const d = ev.date || '';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(ev);
  });

  let html = '';
  Object.keys(byDate).sort((a, b) => {
    // a,b are DD-MM-YYYY
    const toSortable = s => { const p = s.split('-'); return `${p[2]}-${p[1]}-${p[0]}`; };
    return toSortable(a).localeCompare(toSortable(b));
  }).forEach(date => {
    const events = byDate[date];
    const dayLabel = events[0]?.day_name || formatDateItalianLong(dateFormattedToIso(date));
    html += `<div class="shared-date-group">📅 ${escapeHtml(dayLabel)} — ${escapeHtml(date.split('-').join('/'))}</div>`;
    events.forEach(ev => {
      const f = friendsState.friends.find(fr => fr.id === ev.profile_id) || { color: '#8B5CF6', nickname: ev.nickname || '' };
      html += `
        <div class="shared-event-card" style="border-left-color:${f.color};">
          <div class="shared-event-header">
            <span class="shared-event-name">${escapeHtml(ev.course || '—')}</span>
            <span class="shared-event-owner" style="background:${hexToRgba(f.color, 0.25)}; border:1px solid ${hexToRgba(f.color, 0.5)}; color:${f.color};">${escapeHtml(ev.nickname || '')}</span>
          </div>
          <div class="shared-event-meta">
            ${ev.start_time ? `<span>🕐 ${escapeHtml(ev.start_time)}${ev.end_time ? '–' + escapeHtml(ev.end_time) : ''}</span>` : ''}
            ${ev.aula     ? `<span>📍 ${escapeHtml(ev.aula)}</span>` : ''}
            ${ev.docente  ? `<span>👩‍🏫 ${escapeHtml(ev.docente)}</span>` : ''}
          </div>
        </div>
      `;
    });
  });

  evtCont.innerHTML = html;
}

// Helper: DD-MM-YYYY → YYYY-MM-DD
function dateFormattedToIso(ddmmyyyy) {
  const p = ddmmyyyy.split('-');
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : ddmmyyyy;
}

// ══════════════════════════════════════════════════════════════
//  FIRST VISIT ONBOARDING MODAL
// ══════════════════════════════════════════════════════════════

function openOnboardingModal() {
  const modal = document.getElementById('onboardingModal');
  if (modal) modal.classList.add('active');
}

function closeOnboardingModal() {
  const modal = document.getElementById('onboardingModal');
  if (modal) modal.classList.remove('active');
}

function handleOnboardingCreate() {
  closeOnboardingModal();
  openProfileModal();
  showProfileTab('create');
}

function handleOnboardingLogin() {
  closeOnboardingModal();
  openProfileModal();
  showProfileTab('login');
}

function handleOnboardingGuest() {
  localStorage.setItem('unimib_guest_chosen', '1');
  closeOnboardingModal();
  showWelcome();
  openSetup();
}


// ══════════════════════════════════════════════════════════════
//  SHARED GROUP LINK (Import & Share URL)
// ══════════════════════════════════════════════════════════════

async function handleSharedGroupUrl(groupStr) {
  const ids = groupStr.split(',')
    .map(i => i.trim().toLowerCase())
    .filter(i => /^[a-z0-9_-]{3,40}$/.test(i));

  if (!ids.length) return;

  showToast('Caricamento gruppo amici... 👥');

  for (const id of ids) {
    if (!friendsState.friends.some(f => f.id === id) && id !== profileState.id) {
      try {
        const resp = await fetch(`/api/profile?id=${id}`);
        if (resp.ok) {
          const profile = await resp.json();
          const colorIndex = friendsState.friends.length % FRIENDS_COLORS.length;
          friendsState.friends.push({
            id: profile.id,
            nickname: profile.nickname || id,
            color: FRIENDS_COLORS[colorIndex]
          });
        }
      } catch (err) {
        console.warn('Error fetching group profile:', id, err);
      }
    }
  }

  saveFriends(friendsState.friends);
  renderFriendChips();
  // Clean URL without reloading page
  history.replaceState(null, '', window.location.pathname);
  switchTab('friends');
  loadFriendsCalendar();
  showToast('Gruppo amici caricato nel calendario! 🎉');
}

function shareFriendsGroup() {
  if (!friendsState.friends.length && !profileState.id) {
    showToast('Aggiungi prima degli amici al calendario per condividere il gruppo');
    return;
  }
  const ids = [];
  if (profileState.id) ids.push(profileState.id);
  friendsState.friends.forEach(f => {
    if (!ids.includes(f.id)) ids.push(f.id);
  });

  const url = `${window.location.origin}/?group=${ids.join(',')}`;

  if (navigator.share) {
    navigator.share({
      title: 'Calendario Amici UNIMIB',
      text: 'Unisciti al nostro calendario condiviso UNIMIB per confrontare gli orari!',
      url: url
    }).catch(err => {
      if (err.name !== 'AbortError') copyGroupUrlToClipboard(url);
    });
  } else {
    copyGroupUrlToClipboard(url);
  }
}

function copyGroupUrlToClipboard(url) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link gruppo copiato negli appunti! 📋');
    }).catch(() => {
      prompt('Copia questo link da inviare ai tuoi amici:', url);
    });
  } else {
    legacyCopy(url);
    showToast('Link gruppo copiato! 📋');
  }
}
