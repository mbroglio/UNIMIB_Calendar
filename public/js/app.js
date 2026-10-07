/**
 * UNIMIB Orari - Mobile Calendar App Logic
 */

const CONFIG_KEY = 'unimib_config';
const CALENDAR_CACHE_PREFIX = 'unimib_cal_';
const FAVORITE_COLORS = ['#8B5CF6', '#10B981', '#06B6D4', '#F59E0B', '#EC4899', '#3B82F6', '#F97316', '#84CC16'];

// Profile / sync keys
const PROFILE_KEY       = 'unimib_profile_id';       // stores { nickname, share_code }
const SESSION_TOKEN_KEY = 'unimib_session_token';   // stores opaque session token
const ACTIVE_GROUP_KEY   = 'unimib_active_group_id';  // stores active group ID
const FRIENDS_KEY       = 'unimib_friends';          // stores [{id, nickname, color}]

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

const FAVORITE_TEACHERS_KEY = 'unimib_favorite_teachers';

let teachersState = {
  academicYears: [],
  selectedYear: '',
  allTeachers: [],       // [{code, name, courses: [...]}]
  favoriteTeachers: [],  // [{code, name}]
  selectedTeacher: null, // {code, name, courses: [...]}
  selectedCourseFilter: '', // '' for all courses of teacher, or course code
  currentMonday: null,
  selectedDayDate: 'all', // 'all' or 'DD-MM-YYYY'
  viewMode: 'week',      // 'week' or 'all' (all events of semester)
  searchFilter: '',      // in-schedule query
  eventsData: null,      // { events: [...], giorni: [...], week_label: '...' }
  isLoading: false,
  requestId: 0
};

// Profile state: private credentials (nickname + PIN) & public shareCode
let profileState = {
  nickname:     '',
  shareCode:    null,   // public unique calendar code (e.g. K9X2P4)
  sessionToken: null,   // opaque session token st_...
  recoveryCode: null,   // one-time recovery code REC-XXXX-XXXX
  syncing:      false,
  lastSync:     null,
  _pin:         null    // in-memory session only
};
// Property alias so profileState.id maps to profileState.shareCode
Object.defineProperty(profileState, 'id', {
  get() { return this.shareCode; },
  set(v) { this.shareCode = v; }
});

// Friends/shared calendar state supporting multiple groups
let friendsState = {
  groups:           [],   // user's groups: [{id, name, creator, members_count}]
  activeGroupId:    localStorage.getItem(ACTIVE_GROUP_KEY) || null, // currently selected group ID
  groupInfo:        null, // { id: 'G9X2P4', name: 'Gruppo Studio' }
  friends:          [],   // [{id, share_code, nickname, color, config}]
  currentMonday:    null,
  events:           [],
  myEvents:         [],   // current user's own events (if profile is set)
  isLoading:        false,
  showMyself:       true, // whether to include the current user's own schedule
  viewMode:         'grid', // 'grid' | 'combined' | 'freeSlots' (defaults to hourly grid)
  selectedGridDate: null  // DD-MM-YYYY selected day for the grid timeline view
};

// Options loaded from the UNIMIB dropdown data while the setup modal is open
let setup = {
  seq: 0,
  courses: [],
  teachings: [],
  _pendingProfile: null
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
  teachersState.favoriteTeachers = loadFavoriteTeachers();
  teachersState.currentMonday = formatFormattedDate(getMonday(new Date()));

  setupEventListeners();
  updateRoomsDateDisplay();
  registerServiceWorker();
  syncGroupCloud();

  state.currentMonday = formatFormattedDate(getMonday(new Date()));
  state.config = loadConfig();

  const shared = readSharedConfig();
  const urlParams = new URLSearchParams(window.location.search);
  const friendParam = urlParams.get('friend') || urlParams.get('share_cal');
  const groupParam = urlParams.get('group');
  const teacherParam = urlParams.get('teacher') || urlParams.get('docente');
  const tabParam = urlParams.get('tab');

  if (shared) {
    enterPreview(shared);
  } else if (friendParam) {
    if (state.config) {
      applyConfig();
    } else {
      // No config – make sure the timetable spinner is hidden so the app
      // doesn't get stuck in an infinite loading state.
      showWelcome();
    }
    handleFriendShareUrl(friendParam);
  } else if (groupParam) {
    if (state.config) {
      applyConfig();
    } else {
      showWelcome();
    }
    handleSharedGroupUrl(groupParam);
  } else if (teacherParam) {
    if (state.config) {
      applyConfig();
    } else {
      showWelcome();
    }
    switchTab('teachers');
    handleTeacherParam(teacherParam);
  } else if (tabParam === 'docenti' || tabParam === 'teachers') {
    if (state.config) {
      applyConfig();
    } else {
      showWelcome();
    }
    switchTab('teachers');
  } else if (state.config) {
    applyConfig();
    loadCalendar(state.currentMonday);
  } else {
    const guestChosen = localStorage.getItem('unimib_guest_chosen');
    if (!profileState.id && !guestChosen) {
      showWelcome();
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
  document.getElementById('tabTeachers').addEventListener('click', () => switchTab('teachers'));
  document.getElementById('tabRooms').addEventListener('click', () => switchTab('rooms'));
  document.getElementById('tabExams').addEventListener('click', () => switchTab('exams'));
  document.getElementById('tabFriends').addEventListener('click', () => switchTab('friends'));

  setupTeachersEventListeners();

  // Profile button
  document.getElementById('btnProfile').addEventListener('click', openProfileModal);
  document.getElementById('btnCloseProfile').addEventListener('click', () => {
    document.getElementById('profileModal').classList.remove('active');
  });
  document.getElementById('btnCreateProfile').addEventListener('click', handleCreateProfileStep2);
  const btnCreateWithExt = document.getElementById('btnCreateWithExistingConfig');
  if (btnCreateWithExt) btnCreateWithExt.addEventListener('click', handleCreateWithExistingConfig);
  const btnBackStep1 = document.getElementById('btnBackToProfileStep1');
  if (btnBackStep1) btnBackStep1.addEventListener('click', handleBackToProfileStep1);
  document.getElementById('btnLoginProfile').addEventListener('click', handleLoginProfile);
  document.getElementById('btnLogoutProfile').addEventListener('click', handleLogoutProfile);
  document.getElementById('btnCopyProfileId').addEventListener('click', copyProfileId);
  const btnShareMyCal = document.getElementById('btnShareMyCalLink');
  if (btnShareMyCal) btnShareMyCal.addEventListener('click', shareMyCalendarLink);
  document.getElementById('btnSyncNow').addEventListener('click', syncProfileNow);

  // Enter key support for quick profile submit
  ['profileNickname', 'profilePin', 'profilePinConfirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCreateProfileStep2();
        }
      });
    }
  });
  ['profileLoginNickname', 'profileLoginPin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleLoginProfile();
        }
      });
    }
  });

  // Recovery form buttons
  const btnShowRecover = document.getElementById('btnShowRecoverForm');
  if (btnShowRecover) btnShowRecover.addEventListener('click', showProfileRecoverForm);
  const btnBackLogin = document.getElementById('btnBackToLoginFromRecover');
  if (btnBackLogin) btnBackLogin.addEventListener('click', hideProfileRecoverForm);
  const btnSubmitRecover = document.getElementById('btnSubmitRecoverPin');
  if (btnSubmitRecover) btnSubmitRecover.addEventListener('click', handleRecoverPin);
  const btnCopyRec = document.getElementById('btnCopyRecoveryCode');
  if (btnCopyRec) btnCopyRec.addEventListener('click', () => {
    if (profileState.recoveryCode) {
      copyGroupUrlToClipboard(profileState.recoveryCode);
      showToast('Codice di recupero copiato! 📋');
    }
  });

  // Multi-group management buttons
  const grpSelect = document.getElementById('friendsGroupSelect');
  if (grpSelect) grpSelect.addEventListener('change', (e) => switchActiveGroup(e.target.value));

  const btnNewGrp = document.getElementById('btnNewGroup');
  if (btnNewGrp) btnNewGrp.addEventListener('click', openCreateGroupModal);
  const btnEmptyNewGrp = document.getElementById('btnEmptyCreateGroup');
  if (btnEmptyNewGrp) btnEmptyNewGrp.addEventListener('click', openCreateGroupModal);
  const btnCloseCreateGrp = document.getElementById('btnCloseCreateGroup');
  if (btnCloseCreateGrp) btnCloseCreateGrp.addEventListener('click', closeCreateGroupModal);
  const btnConfirmCreateGrp = document.getElementById('btnConfirmCreateGroup');
  if (btnConfirmCreateGrp) btnConfirmCreateGrp.addEventListener('click', confirmCreateGroup);

  const btnJoinGrpModal = document.getElementById('btnJoinGroupModal');
  if (btnJoinGrpModal) btnJoinGrpModal.addEventListener('click', openJoinGroupModal);
  const btnEmptyJoinGrp = document.getElementById('btnEmptyJoinGroup');
  if (btnEmptyJoinGrp) btnEmptyJoinGrp.addEventListener('click', openJoinGroupModal);
  const btnCloseJoinGrp = document.getElementById('btnCloseJoinGroup');
  if (btnCloseJoinGrp) btnCloseJoinGrp.addEventListener('click', closeJoinGroupModal);
  const btnConfirmJoinGrp = document.getElementById('btnConfirmJoinGroup');
  if (btnConfirmJoinGrp) btnConfirmJoinGrp.addEventListener('click', confirmJoinGroup);

  const btnRenameGrp = document.getElementById('btnRenameGroup');
  if (btnRenameGrp) btnRenameGrp.addEventListener('click', openRenameGroupModal);
  const btnCloseRenameGrp = document.getElementById('btnCloseRenameGroup');
  if (btnCloseRenameGrp) btnCloseRenameGrp.addEventListener('click', closeRenameGroupModal);
  const btnConfirmRenameGrp = document.getElementById('btnConfirmRenameGroup');
  if (btnConfirmRenameGrp) btnConfirmRenameGrp.addEventListener('click', confirmRenameGroup);

  const btnLeaveGrp = document.getElementById('btnLeaveGroup');
  if (btnLeaveGrp) btnLeaveGrp.addEventListener('click', handleLeaveGroup);

  // Enter key support for modal inputs
  const createGrpInp = document.getElementById('createGroupNameInput');
  if (createGrpInp) createGrpInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmCreateGroup(); });
  const renameGrpInp = document.getElementById('renameGroupNameInput');
  if (renameGrpInp) renameGrpInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmRenameGroup(); });
  const joinGrpInp = document.getElementById('joinGroupCodeInput');
  if (joinGrpInp) joinGrpInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmJoinGroup(); });

  // Friends / shared calendar buttons
  document.getElementById('btnAddFriend').addEventListener('click', openAddFriendModal);
  document.getElementById('btnShareFriendsGroup').addEventListener('click', shareFriendsGroup);
  document.getElementById('btnCloseAddFriend').addEventListener('click', () => {
    document.getElementById('addFriendModal').classList.remove('active');
  });
  document.getElementById('btnLookupFriendCode').addEventListener('click', lookupFriendByCode);
  document.getElementById('btnConfirmAddFriendCode').addEventListener('click', confirmAddFriendByCode);
  const btnSearchName = document.getElementById('btnSearchFriendName');
  if (btnSearchName) btnSearchName.addEventListener('click', searchFriendByName);
  const friendCodeInput = document.getElementById('friendCodeInput');
  if (friendCodeInput) {
    friendCodeInput.addEventListener('input', () => {
      document.getElementById('friendCodePreview').style.display = 'none';
      document.getElementById('friendCodeError').style.display = 'none';
      document.getElementById('btnConfirmAddFriendCode').disabled = true;
      document.getElementById('btnConfirmAddFriendCode')._foundProfile = null;
    });
    friendCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const confBtn = document.getElementById('btnConfirmAddFriendCode');
        if (confBtn && !confBtn.disabled) {
          confirmAddFriendByCode();
        } else {
          lookupFriendByCode();
        }
      }
    });
  }
  document.getElementById('btnFriendsPrevWeek').addEventListener('click', () => changeFriendsWeek(-7));
  document.getElementById('btnFriendsNextWeek').addEventListener('click', () => changeFriendsWeek(7));
  document.getElementById('btnFriendsToday').addEventListener('click', () => {
    friendsState.currentMonday = formatFormattedDate(getMonday(new Date()));
    loadFriendsCalendar();
  });
  // Toggle: include myself in group view
  const btnToggleMyself = document.getElementById('btnToggleMyself');
  if (btnToggleMyself) {
    btnToggleMyself.addEventListener('click', () => {
      friendsState.showMyself = !friendsState.showMyself;
      btnToggleMyself.classList.toggle('active', friendsState.showMyself);
      btnToggleMyself.textContent = friendsState.showMyself ? '👤 Includi me' : '👤 Escludi me';
      renderFriendsView();
    });
  }
  // Toggle: view mode (combined list / grid / free slots)
  const btnViewCombined = document.getElementById('btnFriendsViewCombined');
  const btnViewGrid     = document.getElementById('btnFriendsViewGrid');
  const btnViewFreeSlots = document.getElementById('btnFriendsViewFreeSlots');

  const updateViewModeButtons = (mode) => {
    if (btnViewCombined) btnViewCombined.classList.toggle('active', mode === 'combined');
    if (btnViewGrid)     btnViewGrid.classList.toggle('active', mode === 'grid');
    if (btnViewFreeSlots) btnViewFreeSlots.classList.toggle('active', mode === 'freeSlots');
  };

  if (btnViewCombined) {
    btnViewCombined.addEventListener('click', () => {
      friendsState.viewMode = 'combined';
      updateViewModeButtons('combined');
      renderFriendsView();
    });
  }
  if (btnViewGrid) {
    btnViewGrid.addEventListener('click', () => {
      friendsState.viewMode = 'grid';
      updateViewModeButtons('grid');
      renderFriendsView();
    });
  }
  if (btnViewFreeSlots) {
    btnViewFreeSlots.addEventListener('click', () => {
      friendsState.viewMode = 'freeSlots';
      updateViewModeButtons('freeSlots');
      renderFriendsView();
    });
  }

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

  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      if (state.activeTab === 'timetable') {
        loadCalendar(state.currentMonday, true);
      } else if (state.activeTab === 'rooms') {
        loadRoomsOccupancy(true);
      } else if (state.activeTab === 'exams') {
        loadExams(true);
      }
    });
  }

  // Schedule Changes Notice Bell Button in Header
  const btnChangesNotice = document.getElementById('btnChangesNotice');
  if (btnChangesNotice) {
    btnChangesNotice.addEventListener('click', () => {
      const stored = getStoredChanges(state.currentMonday);
      if (stored && stored.changes) {
        openScheduleChangesModal(stored.changes, state.currentMonday, stored.weekLabel);
      }
    });
  }

  // Schedule Changes Modal Buttons
  const btnCloseChangesModal = document.getElementById('btnCloseScheduleChangesModal');
  if (btnCloseChangesModal) {
    btnCloseChangesModal.addEventListener('click', () => {
      acknowledgeScheduleChanges(state.currentMonday);
    });
  }

  const btnAckChanges = document.getElementById('btnAckScheduleChanges');
  if (btnAckChanges) {
    btnAckChanges.addEventListener('click', () => {
      acknowledgeScheduleChanges(state.currentMonday);
    });
  }

  // Timetable Changes Banner Actions
  const btnBannerViewChanges = document.getElementById('btnBannerViewChanges');
  if (btnBannerViewChanges) {
    btnBannerViewChanges.addEventListener('click', () => {
      const stored = getStoredChanges(state.currentMonday);
      if (stored && stored.changes) {
        openScheduleChangesModal(stored.changes, state.currentMonday, stored.weekLabel);
      }
    });
  }

  const btnBannerDismiss = document.getElementById('btnBannerDismissChanges');
  if (btnBannerDismiss) {
    btnBannerDismiss.addEventListener('click', () => {
      sessionDismissedBanners.add(state.currentMonday);
      const banner = document.getElementById('timetableChangesBanner');
      if (banner) banner.style.display = 'none';
    });
  }

  // Filter inside Schedule Changes Modal
  const btnModalFilterFav = document.getElementById('btnModalChangesFilterFav');
  const btnModalFilterAll = document.getElementById('btnModalChangesFilterAll');
  if (btnModalFilterFav && btnModalFilterAll) {
    btnModalFilterFav.addEventListener('click', () => {
      modalChangesFilter = 'fav';
      btnModalFilterFav.classList.add('active');
      btnModalFilterAll.classList.remove('active');
      renderScheduleChangesModalList();
    });
    btnModalFilterAll.addEventListener('click', () => {
      modalChangesFilter = 'all';
      btnModalFilterAll.classList.add('active');
      btnModalFilterFav.classList.remove('active');
      renderScheduleChangesModalList();
    });
  }

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
        if (overlay.id === 'onboardingModal') return;
        if (overlay.id === 'setupModal' && (!state.config || setup._pendingProfile)) return;
        if (overlay.id === 'scheduleChangesModal') {
          acknowledgeScheduleChanges(state.currentMonday);
          return;
        }
        overlay.classList.remove('active');
      }
    });
  });

  // Share link
  const btnShare = document.getElementById('btnShare');
  if (btnShare) {
    btnShare.addEventListener('click', openShare);
  }
  document.getElementById('btnCloseShare').addEventListener('click', () => {
    document.getElementById('shareModal').classList.remove('active');
  });
  document.getElementById('btnCopyShare').addEventListener('click', copyShareUrl);
  document.getElementById('btnNativeShare').addEventListener('click', nativeShare);

  // Calendar Export
  const btnExportCal = document.getElementById('btnExportCalendar');
  if (btnExportCal) btnExportCal.addEventListener('click', () => openExportModal(state.activeTab || 'timetable'));
  const btnExportFriends = document.getElementById('btnExportFriendsGroup');
  if (btnExportFriends) btnExportFriends.addEventListener('click', () => openExportModal('friends'));
  const btnExportExams = document.getElementById('btnExportAllExams');
  if (btnExportExams) btnExportExams.addEventListener('click', () => openExportModal('exams'));

  const btnCloseExport = document.getElementById('btnCloseExportModal');
  if (btnCloseExport) btnCloseExport.addEventListener('click', closeExportModal);

  const btnExpScopeWeek = document.getElementById('btnExportScopeWeek');
  if (btnExpScopeWeek) btnExpScopeWeek.addEventListener('click', () => setExportScope('week'));
  const btnExpScopeMonth = document.getElementById('btnExportScopeMonth');
  if (btnExpScopeMonth) btnExpScopeMonth.addEventListener('click', () => setExportScope('month'));

  const btnExpFiltTarget = document.getElementById('btnExportFilterTarget');
  if (btnExpFiltTarget) btnExpFiltTarget.addEventListener('click', () => setExportFilter('target'));
  const btnExpFiltAll = document.getElementById('btnExportFilterAll');
  if (btnExpFiltAll) btnExpFiltAll.addEventListener('click', () => setExportFilter('all'));

  const btnDlIcs = document.getElementById('btnDownloadIcs');
  if (btnDlIcs) btnDlIcs.addEventListener('click', () => handleExportDownload('ics'));
  const btnDlCsv = document.getElementById('btnDownloadCsv');
  if (btnDlCsv) btnDlCsv.addEventListener('click', () => handleExportDownload('csv'));
  const btnDlJson = document.getElementById('btnDownloadJson');
  if (btnDlJson) btnDlJson.addEventListener('click', () => handleExportDownload('json'));

  const btnCpWebCal = document.getElementById('btnCopyWebCal');
  if (btnCpWebCal) btnCpWebCal.addEventListener('click', copyWebCalUrl);

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

  if (mainEl) {
    mainEl.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    mainEl.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX;
      handleSwipe();
    }, { passive: true });
  }

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
  // Background sync to cloud profile if logged in
  if (profileState.id && (profileState.sessionToken || profileState._pin)) {
    _syncConfigToProfile().catch(e => console.warn('Profile sync error:', e));
  }
}

function configKey() {
  const c = state.config;
  if (!c) return 'default';
  return `${c.anno}_${c.corso}_${(c.anni || []).join(',')}`;
}

function clearCalendarCache() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CALENDAR_CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
    updateChangesUI(state.currentMonday);
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

// ══════════════════════════════════════════════════════════════
//  STANDARD CALENDAR EXPORT (.ICS, .CSV, .JSON, WEBCAL)
// ══════════════════════════════════════════════════════════════

let exportState = {
  source: 'timetable', // 'timetable' | 'friends' | 'exams'
  scope: 'week',       // 'week' | 'month'
  filter: 'target'     // 'target' | 'all'
};

function openExportModal(source = 'timetable') {
  exportState.source = source;
  const modal = document.getElementById('exportModal');
  if (!modal) return;

  const subtitle = document.getElementById('exportModalSubtitle');
  const scopeGroup = document.getElementById('exportScopeGroup');
  const filterGroup = document.getElementById('exportFilterGroup');
  const webCalBox = document.getElementById('exportWebCalBox');

  if (source === 'timetable') {
    if (subtitle) subtitle.textContent = state.config
      ? `Esporta orario lezioni di ${state.config.corsoLabel || 'corso'}`
      : 'Esporta orario lezioni';
    if (scopeGroup) scopeGroup.style.display = '';
    if (filterGroup) filterGroup.style.display = '';
    if (webCalBox) webCalBox.style.display = '';
  } else if (source === 'friends') {
    const groupName = (friendsState.groupInfo && friendsState.groupInfo.name) || 'Gruppo Studio';
    if (subtitle) subtitle.textContent = `Esporta orario del gruppo "${groupName}"`;
    if (scopeGroup) scopeGroup.style.display = '';
    if (filterGroup) filterGroup.style.display = 'none';
    if (webCalBox) webCalBox.style.display = 'none';
  } else if (source === 'exams') {
    if (subtitle) subtitle.textContent = 'Esporta calendario appelli d\'esame';
    if (scopeGroup) scopeGroup.style.display = 'none';
    if (filterGroup) filterGroup.style.display = 'none';
    if (webCalBox) webCalBox.style.display = 'none';
  }

  setExportScope('week');
  setExportFilter('target');
  updateWebCalUrl();

  modal.classList.add('active');
}

function closeExportModal() {
  const modal = document.getElementById('exportModal');
  if (modal) modal.classList.remove('active');
}

function setExportScope(scope) {
  exportState.scope = scope;
  const btnWeek = document.getElementById('btnExportScopeWeek');
  const btnMonth = document.getElementById('btnExportScopeMonth');
  if (btnWeek) btnWeek.classList.toggle('active', scope === 'week');
  if (btnMonth) btnMonth.classList.toggle('active', scope === 'month');
  updateWebCalUrl();
}

function setExportFilter(filter) {
  exportState.filter = filter;
  const btnTarget = document.getElementById('btnExportFilterTarget');
  const btnAll = document.getElementById('btnExportFilterAll');
  if (btnTarget) btnTarget.classList.toggle('active', filter === 'target');
  if (btnAll) btnAll.classList.toggle('active', filter === 'all');
  updateWebCalUrl();
}

function updateWebCalUrl() {
  const input = document.getElementById('exportWebCalUrl');
  const subLink = document.getElementById('btnSubscribeNativeCal');
  if (!input) return;

  const origin = window.location.origin;
  let url = '';

  if (profileState.shareCode) {
    url = `${origin}/api/export?code=${encodeURIComponent(profileState.shareCode)}&format=ics`;
    if (exportState.filter === 'all') url += '&filter=all';
  } else if (state.config) {
    const cfg = state.config;
    const params = new URLSearchParams({
      anno: cfg.anno,
      corso: cfg.corso,
      format: 'ics'
    });
    (cfg.anni || []).forEach(a => params.append('anno2', a));
    const favs = (cfg.favorites || []).map(f => f.code).filter(Boolean);
    if (favs.length && exportState.filter !== 'all') params.set('fav', favs.join(','));
    url = `${origin}/api/export?${params.toString()}`;
  } else {
    url = `${origin}/api/export`;
  }

  input.value = url;
  if (subLink) {
    const webcalUrl = url.replace(/^https?:\/\//i, 'webcal://');
    subLink.href = webcalUrl;
  }
}

async function copyWebCalUrl() {
  const input = document.getElementById('exportWebCalUrl');
  if (!input || !input.value) return;
  const url = input.value;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else if (!legacyCopy(url)) {
      throw new Error('Copy command failed');
    }
    showToast('Link sottoscrizione copiato! 📋 Aggiungilo a Calendar');
  } catch (e) {
    input.select();
    showToast('Premi Ctrl+C per copiare il link.');
  }
}

async function handleExportDownload(format = 'ics') {
  const btn = document.getElementById(`btnDownload${format.charAt(0).toUpperCase() + format.slice(1)}`);
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Generazione file...'; }

  try {
    if (exportState.source === 'exams') {
      const exams = (examsState.allExams || []).filter(ex => {
        if (examsState.filterMode === 'target' && typeof isExamCourseTracked === 'function') {
          return isExamCourseTracked(ex.course_code);
        }
        return true;
      });
      if (!exams.length) {
        showToast('Nessun appello trovato da esportare.');
        return;
      }
      const events = exams.map(ex => ({
        id: `exam-${ex.id || ex.date + '-' + ex.name}`,
        course: `Esame: ${ex.name}`,
        course_code: ex.course_code || '',
        date: ex.date,
        start_time: ex.time || '09:00',
        end_time: ex.end_time || (ex.time ? addHoursToTime(ex.time, 2) : '11:00'),
        aula: ex.classroom || ex.building || 'UNIMIB',
        docente: ex.professor || '',
        type: 'Appello d\'esame',
        notes: ex.notes || ''
      }));

      const filename = `appelli_esami_${formatDateIso(new Date())}.${format}`;
      if (format === 'ics') {
        const ics = generateIcs(events, 'Appelli d\'Esame UNIMIB');
        downloadFile(ics, 'text/calendar;charset=utf-8', filename);
      } else if (format === 'csv') {
        const csv = generateCsv(events);
        downloadFile(csv, 'text/csv;charset=utf-8', filename);
      } else if (format === 'json') {
        downloadFile(JSON.stringify(events, null, 2), 'application/json;charset=utf-8', filename);
      }
      showToast(`Esportati ${events.length} appelli in .${format}! 📝`);
      closeExportModal();
      return;
    }

    if (exportState.source === 'friends') {
      let events = [];
      if (friendsState.events && friendsState.events.length) {
        events = events.concat(friendsState.events);
      }
      if (friendsState.showMyself && friendsState.myEvents && friendsState.myEvents.length) {
        events = events.concat(friendsState.myEvents);
      }
      if (!events.length) {
        showToast('Nessuna lezione trovata da esportare nel gruppo.');
        return;
      }
      const groupTitle = (friendsState.groupInfo && friendsState.groupInfo.name) || 'Gruppo UNIMIB';
      const filename = `gruppo_${groupTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${formatDateIso(new Date())}.${format}`;
      if (format === 'ics') {
        const ics = generateIcs(events, groupTitle);
        downloadFile(ics, 'text/calendar;charset=utf-8', filename);
      } else if (format === 'csv') {
        const csv = generateCsv(events);
        downloadFile(csv, 'text/csv;charset=utf-8', filename);
      } else if (format === 'json') {
        downloadFile(JSON.stringify(events, null, 2), 'application/json;charset=utf-8', filename);
      }
      showToast(`Esportate ${events.length} lezioni in .${format}! 👥`);
      closeExportModal();
      return;
    }

    // Source === 'timetable'
    if (!state.config) {
      showToast('Seleziona prima il tuo corso di studi.');
      return;
    }

    if (exportState.scope === 'month') {
      let exportUrl = '';
      if (profileState.shareCode) {
        exportUrl = `/api/export?code=${encodeURIComponent(profileState.shareCode)}&format=${format}&weeks=4`;
        if (exportState.filter === 'all') exportUrl += '&filter=all';
      } else {
        const cfg = state.config;
        const params = new URLSearchParams({
          anno: cfg.anno,
          corso: cfg.corso,
          format: format,
          weeks: '4',
          date: state.currentMonday || ''
        });
        (cfg.anni || []).forEach(a => params.append('anno2', a));
        if (exportState.filter !== 'all') {
          const favs = (cfg.favorites || []).map(f => f.code).filter(Boolean);
          if (favs.length) params.set('fav', favs.join(','));
        } else {
          params.set('filter', 'all');
        }
        exportUrl = `/api/export?${params.toString()}`;
      }

      const resp = await fetch(exportUrl);
      if (!resp.ok) throw new Error('Errore durante la generazione dell\'esportazione');
      const blob = await resp.blob();
      const mime = format === 'ics' ? 'text/calendar;charset=utf-8' : (format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
      const filename = `orario_unimib_4settimane.${format}`;
      downloadFile(blob, mime, filename);
      showToast(`Calendario (4 settimane) esportato in .${format}! 📅`);
      closeExportModal();
      return;
    }

    // Single week timetable export (instant client-side)
    let evs = (state.calendarData && state.calendarData.events) || [];
    if (exportState.filter === 'target' && state.config && state.config.favorites && state.config.favorites.length) {
      evs = evs.filter(isFavorite);
    }
    if (!evs.length) {
      showToast('Nessuna lezione trovata nella settimana selezionata.');
      return;
    }

    const courseLabel = (state.config && state.config.corsoLabel) || 'lezione';
    const filename = `orario_${courseLabel.replace(/[^a-zA-Z0-9]/g, '_')}_${state.currentMonday}.${format}`;

    if (format === 'ics') {
      const ics = generateIcs(evs, `UNIMIB - ${courseLabel}`);
      downloadFile(ics, 'text/calendar;charset=utf-8', filename);
    } else if (format === 'csv') {
      const csv = generateCsv(evs);
      downloadFile(csv, 'text/csv;charset=utf-8', filename);
    } else if (format === 'json') {
      downloadFile(JSON.stringify(evs, null, 2), 'application/json;charset=utf-8', filename);
    }
    showToast(`Settimana esportata in .${format}! 📅`);
    closeExportModal();
  } catch (err) {
    console.error('Export error:', err);
    showToast('Errore durante l\'esportazione.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

function addHoursToTime(timeStr, hours) {
  const parts = (timeStr || '09:00').split(':').map(Number);
  const h = Math.min(23, (parts[0] || 0) + hours);
  const m = parts[1] || 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function generateIcs(events, calendarName = 'UNIMIB Orari') {
  const nowStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const escapeIcs = (str) => (str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const vEvents = events.map(ev => {
    const rawDate = (ev.date || '').replace(/\//g, '-').trim();
    const parts = rawDate.split('-');
    if (parts.length !== 3) return '';
    const dateClean = parts[0].length === 4 ? `${parts[0]}${parts[1]}${parts[2]}` : `${parts[2]}${parts[1]}${parts[0]}`;
    const startClean = (ev.start_time || '09:00').replace(':', '').padEnd(4, '0') + '00';
    const endClean = (ev.end_time || '11:00').replace(':', '').padEnd(4, '0') + '00';
    const dtStart = `${dateClean}T${startClean}`;
    const dtEnd = `${dateClean}T${endClean}`;
    const summary = ev.course || ev.name || 'Lezione';
    const location = ev.aula || ev.classroom || 'UNIMIB';

    let desc = [];
    if (ev.docente || ev.professore) desc.push(`Docente: ${ev.docente || ev.professore}`);
    if (ev.course_code) desc.push(`Codice: ${ev.course_code}`);
    if (ev.type) desc.push(`Tipo: ${ev.type}`);
    if (ev.notes) desc.push(`Note: ${ev.notes}`);
    if (ev.profile_id && ev.nickname && ev.profile_id !== 'MY_SELF') desc.push(`Membro: ${ev.nickname}`);
    const descStr = desc.join('\n');

    return [
      'BEGIN:VEVENT',
      `UID:unimib-${ev.id || Math.random().toString(36).slice(2)}@unimib.it`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART;TZID=Europe/Rome:${dtStart}`,
      `DTEND;TZID=Europe/Rome:${dtEnd}`,
      `SUMMARY:${escapeIcs(ev.is_canceled ? '[ANNULLATO] ' + summary : summary)}`,
      `LOCATION:${escapeIcs(location)}`,
      `DESCRIPTION:${escapeIcs(descStr)}`,
      ev.is_canceled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
      'END:VEVENT'
    ].join('\r\n');
  }).filter(Boolean);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UNIMIB Orari//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${(calendarName || 'UNIMIB Orari').replace(/[,;]/g, ' ')}`,
    'X-WR-TIMEZONE:Europe/Rome',
    ...vEvents,
    'END:VCALENDAR'
  ].join('\r\n') + '\r\n';
}

function generateCsv(events) {
  const rows = [
    ['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event', 'Description', 'Location']
  ];
  events.forEach(ev => {
    const rawDate = (ev.date || '').replace(/\//g, '-').trim();
    const parts = rawDate.split('-');
    let isoDate = rawDate;
    if (parts.length === 3) {
      if (parts[2].length === 4) isoDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
      else if (parts[0].length === 4) isoDate = `${parts[0]}-${parts[1]}-${parts[2]}`;
    }
    let desc = [];
    if (ev.docente || ev.professore) desc.push(`Docente: ${ev.docente || ev.professore}`);
    if (ev.course_code) desc.push(`Codice: ${ev.course_code}`);
    if (ev.type) desc.push(`Tipo: ${ev.type}`);
    if (ev.notes) desc.push(`Note: ${ev.notes}`);
    if (ev.profile_id && ev.nickname && ev.profile_id !== 'MY_SELF') desc.push(`Membro: ${ev.nickname}`);
    if (ev.is_canceled) desc.push('[ANNULLATO]');
    rows.push([
      ev.course || ev.name || 'Lezione',
      isoDate,
      ev.start_time || '09:00',
      isoDate,
      ev.end_time || '11:00',
      'False',
      desc.join(' | '),
      ev.aula || ev.classroom || 'UNIMIB'
    ]);
  });
  return '\uFEFF' + rows.map(r => r.map(f => `"${String(f || '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function downloadFile(content, mimeType, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Setup modal (mirrors the UNIMIB "By degree" form dropdowns) ----------

async function openSetup(presetOverride, pendingProfile) {
  document.getElementById('setupModal').classList.add('active');

  const pending = pendingProfile || setup._pendingProfile;
  const banner = document.getElementById('setupProfileBanner');
  const bannerNick = document.getElementById('setupProfileBannerNick');
  const modalTitle = document.getElementById('setupModalTitle');
  const btnBack = document.getElementById('btnBackToProfileStep1');
  const btnClose = document.getElementById('btnCloseSetup');
  const btnSave = document.getElementById('btnSaveSetup');

  if (pending) {
    if (banner) {
      banner.style.display = '';
      if (bannerNick) bannerNick.textContent = pending.nickname;
    }
    if (modalTitle) modalTitle.textContent = '🎓 Scegli il tuo corso e le materie';
    if (btnBack) btnBack.style.display = '';
    if (btnClose) btnClose.style.display = 'none';
    if (btnSave) btnSave.textContent = '🎉 Completa creazione profilo';
  } else {
    if (banner) banner.style.display = 'none';
    if (modalTitle) modalTitle.textContent = '🎓 Il tuo corso di studio';
    if (btnBack) btnBack.style.display = 'none';
    if (btnClose) btnClose.style.display = state.config ? '' : 'none';
    if (btnSave) btnSave.textContent = 'Salva';
  }

  const preset = presetOverride || state.config || {};
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
  setup._pendingProfile = null;
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

async function saveSetup() {
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

  const newConfig = {
    anno: document.getElementById('cfgYear').value,
    area: document.getElementById('cfgArea').value,
    corso,
    corsoLabel: course.label,
    anni,
    anniLabels: anni.map(a => (course.years.find(y => y.value === a) || { label: a }).label),
    favorites
  };

  // Step 2 profile creation flow
  if (setup._pendingProfile) {
    const btn = document.getElementById('btnSaveSetup');
    const oldText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Creazione profilo in corso...';
    }
    try {
      const resp = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: setup._pendingProfile.nickname,
          pin: setup._pendingProfile.pin,
          config: newConfig,
          exam_courses: examsState.extraCourses || []
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const errMsg = data.error || 'Errore durante la creazione del profilo.';
        handleBackToProfileStep1();
        const errEl = document.getElementById('profileCreateError');
        if (errEl) {
          errEl.textContent = errMsg;
          errEl.style.display = '';
        }
        showToast(errMsg);
        return;
      }

      profileState.nickname     = data.nickname;
      profileState.shareCode    = data.share_code;
      profileState.sessionToken = data.session_token || null;
      profileState.recoveryCode = data.recovery_code || null;
      profileState.lastSync     = Date.now();
      profileState._pin         = setup._pendingProfile.pin;
      saveProfileLocally();
      syncGroupCloud();

      state.config = newConfig;
      saveConfig(state.config);
      clearCalendarCache();
      if (state.preview) endPreview();

      setup._pendingProfile = null;
      closeSetup();
      applyConfig();
      state.calendarData = null;
      state.selectedDayDate = 'all';

      if (newConfig.favorites && newConfig.favorites.length > 0) {
        setFilter('target');
      }

      loadCalendar(state.currentMonday);
      showToast(`🎉 Profilo creato con successo! Codice calendario: ${data.share_code}`, 5000);
      return;
    } catch (err) {
      console.error('Profile creation error:', err);
      showToast('Errore di connessione durante la creazione del profilo.');
      return;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  // Normal config save
  state.config = newConfig;
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

let sessionDismissedBanners = new Set();
let modalChangesFilter = 'fav';
let currentModalChanges = [];
let currentModalMonday = '';

function matchEvents(oldEvents, newEvents) {
  const matchedOld = new Set();
  const matchedNew = new Set();
  const pairs = [];

  const oldById = new Map();
  oldEvents.forEach((ev, idx) => {
    if (ev.id) oldById.set(ev.id, idx);
  });

  newEvents.forEach((newEv, newIdx) => {
    if (newEv.id && oldById.has(newEv.id)) {
      const oldIdx = oldById.get(newEv.id);
      if (!matchedOld.has(oldIdx)) {
        matchedOld.add(oldIdx);
        matchedNew.add(newIdx);
        pairs.push({ oldEvent: oldEvents[oldIdx], newEvent: newEv });
      }
    }
  });

  oldEvents.forEach((oldEv, oldIdx) => {
    if (matchedOld.has(oldIdx)) return;
    let bestNewIdx = -1;
    let bestScore = -1;

    newEvents.forEach((newEv, newIdx) => {
      if (matchedNew.has(newIdx)) return;
      if (oldEv.date !== newEv.date) return;

      const sameCourse = (oldEv.course_code && newEv.course_code && oldEv.course_code === newEv.course_code) ||
                         (oldEv.course && newEv.course && oldEv.course.trim().toLowerCase() === newEv.course.trim().toLowerCase());
      if (!sameCourse) return;

      let score = 10;
      if (oldEv.docente && newEv.docente && oldEv.docente.trim().toLowerCase() === newEv.docente.trim().toLowerCase()) {
        score += 10;
      }
      if (oldEv.start_time === newEv.start_time) {
        score += 20;
      }

      if (score > bestScore) {
        bestScore = score;
        bestNewIdx = newIdx;
      }
    });

    if (bestNewIdx !== -1 && bestScore >= 10) {
      matchedOld.add(oldIdx);
      matchedNew.add(bestNewIdx);
      pairs.push({ oldEvent: oldEv, newEvent: newEvents[bestNewIdx] });
    }
  });

  const unmatchedOld = oldEvents.filter((_, idx) => !matchedOld.has(idx));
  const unmatchedNew = newEvents.filter((_, idx) => !matchedNew.has(idx));

  return { pairs, unmatchedOld, unmatchedNew };
}

function detectCalendarChanges(oldEvents, newEvents, mondayDateStr) {
  const { pairs, unmatchedOld, unmatchedNew } = matchEvents(oldEvents, newEvents);
  const changes = [];
  const normStr = s => (s ?? '').trim();

  pairs.forEach(({ oldEvent, newEvent }) => {
    const oldRoom = normStr(oldEvent.aula);
    const newRoom = normStr(newEvent.aula);
    const oldStart = normStr(oldEvent.start_time);
    const newStart = normStr(newEvent.start_time);
    const oldEnd = normStr(oldEvent.end_time);
    const newEnd = normStr(newEvent.end_time);
    const oldDate = normStr(oldEvent.date);
    const newDate = normStr(newEvent.date);
    const oldCanceled = Boolean(oldEvent.is_canceled);
    const newCanceled = Boolean(newEvent.is_canceled);
    const isFav = isFavorite(newEvent) || isFavorite(oldEvent);

    if (!oldCanceled && newCanceled) {
      changes.push({
        type: 'CANCELED',
        course: newEvent.course,
        courseCode: newEvent.course_code,
        docente: newEvent.docente,
        date: newDate,
        dayName: newEvent.day_name,
        startTime: newStart,
        endTime: newEnd,
        aula: newEvent.aula,
        isFavorite: isFav,
        eventId: newEvent.id
      });
      return;
    }

    if (oldCanceled && !newCanceled) {
      changes.push({
        type: 'REINSTATED',
        course: newEvent.course,
        courseCode: newEvent.course_code,
        docente: newEvent.docente,
        date: newDate,
        dayName: newEvent.day_name,
        startTime: newStart,
        endTime: newEnd,
        aula: newEvent.aula,
        isFavorite: isFav,
        eventId: newEvent.id
      });
    }

    const roomChanged = oldRoom !== newRoom;
    const timeChanged = (oldStart !== newStart) || (oldEnd !== newEnd);
    const dateChanged = oldDate !== newDate;

    if (roomChanged || timeChanged || dateChanged) {
      let type = 'MODIFIED';
      if (roomChanged && !timeChanged && !dateChanged) type = 'ROOM_CHANGED';
      else if (!roomChanged && timeChanged && !dateChanged) type = 'TIME_CHANGED';
      else if (dateChanged) type = 'DATE_CHANGED';
      else if (roomChanged && timeChanged) type = 'ROOM_AND_TIME_CHANGED';

      changes.push({
        type,
        course: newEvent.course,
        courseCode: newEvent.course_code,
        docente: newEvent.docente,
        date: newDate,
        oldDate: dateChanged ? oldDate : null,
        dayName: newEvent.day_name,
        startTime: newStart,
        endTime: newEnd,
        oldStartTime: oldStart,
        oldEndTime: oldEnd,
        oldRoom: oldEvent.aula,
        newRoom: newEvent.aula,
        isFavorite: isFav,
        eventId: newEvent.id
      });
    }
  });

  unmatchedOld.forEach(oldEv => {
    changes.push({
      type: 'REMOVED',
      course: oldEv.course,
      courseCode: oldEv.course_code,
      docente: oldEv.docente,
      date: oldEv.date,
      dayName: oldEv.day_name,
      startTime: oldEv.start_time,
      endTime: oldEv.end_time,
      oldRoom: oldEv.aula,
      isFavorite: isFavorite(oldEv),
      eventId: oldEv.id,
      oldEvent: oldEv
    });
  });

  unmatchedNew.forEach(newEv => {
    changes.push({
      type: 'ADDED',
      course: newEv.course,
      courseCode: newEv.course_code,
      docente: newEv.docente,
      date: newEv.date,
      dayName: newEv.day_name,
      startTime: newEv.start_time,
      endTime: newEv.end_time,
      newRoom: newEv.aula,
      isFavorite: isFavorite(newEv),
      eventId: newEv.id,
      newEvent: newEv
    });
  });

  return changes;
}

function generateChangesHash(changes) {
  if (!changes || !changes.length) return '';
  return changes
    .map(c => `${c.type}:${c.courseCode || c.course}:${c.date}:${c.startTime || ''}:${c.newRoom || c.oldRoom || ''}`)
    .sort()
    .join('|');
}

function getStoredChanges(mondayDateStr) {
  if (!mondayDateStr || !state.config) return null;
  const storageKey = `${CALENDAR_CACHE_PREFIX}changes_${configKey()}_${mondayDateStr}`;
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('Error reading stored changes:', e);
    return null;
  }
}

function handleCalendarUpdates(previousCacheData, data, mondayDateStr) {
  const changes = detectCalendarChanges(previousCacheData.events || [], data.events || [], mondayDateStr);
  if (!changes || changes.length === 0) return;

  const hash = generateChangesHash(changes);
  const storageKey = `${CALENDAR_CACHE_PREFIX}changes_${configKey()}_${mondayDateStr}`;
  const seenKey = `${CALENDAR_CACHE_PREFIX}seen_${configKey()}_${mondayDateStr}`;

  const storedPayload = {
    detectedAt: Date.now(),
    mondayDate: mondayDateStr,
    weekLabel: data.week_label || mondayDateStr,
    hash,
    changes
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(storedPayload));
  } catch (e) {
    console.warn('Storage save error for changes:', e);
  }

  const seenHash = localStorage.getItem(seenKey);
  const isUnseen = seenHash !== hash;

  if (isUnseen) {
    const hasFavorites = Boolean(state.config && state.config.favorites && state.config.favorites.length > 0);
    const favoriteChanges = changes.filter(c => c.isFavorite);

    if (!hasFavorites || favoriteChanges.length > 0 || state.activeFilter === 'all') {
      openScheduleChangesModal(changes, mondayDateStr, data.week_label);
    } else {
      showToast('ℹ️ Variazioni orario rilevate in altri corsi del tuo anno', 4000);
    }
  }
}

function getEventChange(e, mondayDateStr) {
  const stored = getStoredChanges(mondayDateStr);
  if (!stored || !stored.changes) return null;
  return stored.changes.find(c => {
    if (c.eventId && e.id && c.eventId === e.id) return true;
    const sameCourse = (c.courseCode && e.course_code && c.courseCode === e.course_code) ||
                       (c.course && e.course && c.course.trim().toLowerCase() === e.course.trim().toLowerCase());
    return c.date === e.date && sameCourse && (c.startTime === e.start_time || c.oldStartTime === e.start_time);
  }) || null;
}

function closeScheduleChangesModal() {
  const modal = document.getElementById('scheduleChangesModal');
  if (modal) modal.classList.remove('active');
}

function acknowledgeScheduleChanges(mondayDateStr) {
  mondayDateStr = mondayDateStr || state.currentMonday;
  if (mondayDateStr && state.config) {
    const stored = getStoredChanges(mondayDateStr);
    if (stored && stored.hash) {
      const seenKey = `${CALENDAR_CACHE_PREFIX}seen_${configKey()}_${mondayDateStr}`;
      try {
        localStorage.setItem(seenKey, stored.hash);
      } catch (e) {
        console.warn('Error saving seen changes hash:', e);
      }
    }
  }
  closeScheduleChangesModal();
  updateChangesUI(mondayDateStr);
}

function updateChangesUI(mondayDateStr) {
  mondayDateStr = mondayDateStr || state.currentMonday;
  const btnNotice = document.getElementById('btnChangesNotice');
  const badgeCount = document.getElementById('changesBadgeCount');
  const banner = document.getElementById('timetableChangesBanner');
  const bannerTitle = document.getElementById('changesBannerTitle');
  const bannerSubtitle = document.getElementById('changesBannerSubtitle');

  if (state.activeTab !== 'timetable' || !state.config || !mondayDateStr) {
    if (btnNotice) btnNotice.style.display = 'none';
    if (banner) banner.style.display = 'none';
    return;
  }

  const stored = getStoredChanges(mondayDateStr);
  if (!stored || !stored.changes || stored.changes.length === 0) {
    if (btnNotice) btnNotice.style.display = 'none';
    if (banner) banner.style.display = 'none';
    return;
  }

  const changes = stored.changes;
  const seenKey = `${CALENDAR_CACHE_PREFIX}seen_${configKey()}_${mondayDateStr}`;
  const isUnseen = localStorage.getItem(seenKey) !== stored.hash;

  if (btnNotice) {
    btnNotice.style.display = 'inline-flex';
    if (badgeCount) {
      badgeCount.style.display = isUnseen ? 'block' : 'none';
    }
  }

  if (banner) {
    if (sessionDismissedBanners.has(mondayDateStr)) {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'flex';
      const roomCount = changes.filter(c => c.type === 'ROOM_CHANGED' || c.type === 'ROOM_AND_TIME_CHANGED').length;
      const cancelCount = changes.filter(c => c.type === 'CANCELED' || c.type === 'REMOVED').length;
      const otherCount = changes.length - roomCount - cancelCount;

      const parts = [];
      if (roomCount > 0) parts.push(`${roomCount} ${roomCount === 1 ? 'aula cambiata' : 'aule cambiate'}`);
      if (cancelCount > 0) parts.push(`${cancelCount} ${cancelCount === 1 ? 'lezione annullata' : 'lezioni annullate'}`);
      if (otherCount > 0) parts.push(`${otherCount} ${otherCount === 1 ? 'altra modifica' : 'altre modifiche'}`);

      if (bannerTitle) bannerTitle.textContent = `⚠️ Variazioni nel calendario (${changes.length})`;
      if (bannerSubtitle) bannerSubtitle.textContent = parts.join(', ') || 'Rilevate modifiche per questa settimana';
    }
  }
}

function openScheduleChangesModal(changes, mondayDateStr, weekLabel) {
  const modal = document.getElementById('scheduleChangesModal');
  if (!modal) return;

  currentModalChanges = changes || [];
  currentModalMonday = mondayDateStr || state.currentMonday;

  const subtitle = document.getElementById('scheduleChangesModalSubtitle');
  if (subtitle) {
    subtitle.textContent = weekLabel
      ? `Aggiornamenti rilevati per la settimana ${weekLabel}`
      : `Aggiornamenti rilevati per la settimana del ${mondayDateStr}`;
  }

  const hasFavorites = Boolean(state.config && state.config.favorites && state.config.favorites.length > 0);
  const favCount = currentModalChanges.filter(c => c.isFavorite).length;
  const allCount = currentModalChanges.length;

  const filterBar = document.getElementById('scheduleChangesFilterBar');
  const btnFilterFav = document.getElementById('btnModalChangesFilterFav');
  const btnFilterAll = document.getElementById('btnModalChangesFilterAll');

  if (hasFavorites && favCount > 0 && favCount < allCount) {
    if (filterBar) filterBar.style.display = 'block';
    if (btnFilterFav) {
      btnFilterFav.textContent = `⭐ I tuoi corsi (${favCount})`;
      btnFilterFav.classList.toggle('active', modalChangesFilter === 'fav');
    }
    if (btnFilterAll) {
      btnFilterAll.textContent = `📚 Tutte le variazioni (${allCount})`;
      btnFilterAll.classList.toggle('active', modalChangesFilter === 'all');
    }
  } else {
    if (filterBar) filterBar.style.display = 'none';
    modalChangesFilter = 'all';
  }

  renderScheduleChangesModalList();
  modal.classList.add('active');
}

function renderScheduleChangesModalList() {
  const container = document.getElementById('scheduleChangesList');
  if (!container) return;
  container.innerHTML = '';

  const hasFavorites = Boolean(state.config && state.config.favorites && state.config.favorites.length > 0);
  let list = currentModalChanges;
  if (hasFavorites && modalChangesFilter === 'fav') {
    list = currentModalChanges.filter(c => c.isFavorite);
    if (list.length === 0) {
      list = currentModalChanges;
    }
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:20px; color:var(--text-secondary);">
        Nessuna variazione da mostrare.
      </div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    const dateDiff = parseAnyDate(a.date) - parseAnyDate(b.date);
    if (dateDiff !== 0) return dateDiff;
    return (a.startTime || '').localeCompare(b.startTime || '');
  });

  sorted.forEach(c => {
    const card = document.createElement('div');
    let typeClass = 'type-room';
    let badgeText = '📍 Aula cambiata';
    let badgeClass = 'badge-room';
    let detailHtml = '';

    if (c.type === 'CANCELED') {
      typeClass = 'type-canceled';
      badgeText = '❌ Lezione annullata';
      badgeClass = 'badge-canceled';
      detailHtml = `
        <div style="color:#EF4444; font-weight:600; margin-top:2px;">
          ⚠️ Questa lezione è stata annullata e non si terrà.
        </div>`;
    } else if (c.type === 'REMOVED') {
      typeClass = 'type-removed';
      badgeText = '⚠️ Lezione rimossa';
      badgeClass = 'badge-removed';
      detailHtml = `
        <div style="color:#EF4444; font-weight:600; margin-top:2px;">
          ❌ La lezione non compare più nell'orario ufficiale UNIMIB.
        </div>`;
    } else if (c.type === 'REINSTATED') {
      typeClass = 'type-reinstated';
      badgeText = '✅ Lezione ripristinata';
      badgeClass = 'badge-reinstated';
      detailHtml = `
        <div style="color:#10B981; font-weight:600; margin-top:2px;">
          La lezione precedentemente annullata è stata ripristinata.
        </div>`;
    } else if (c.type === 'TIME_CHANGED') {
      typeClass = 'type-time';
      badgeText = '⏰ Orario modificato';
      badgeClass = 'badge-time';
      detailHtml = `
        <div class="change-card-detail">
          <span>Nuovo orario:</span>
          <span class="change-new-val time-val">${escapeHtml(c.startTime)} - ${escapeHtml(c.endTime)}</span>
        </div>
        <div class="change-card-detail">
          <span class="change-old-val">In precedenza: ${escapeHtml(c.oldStartTime)} - ${escapeHtml(c.oldEndTime)}</span>
        </div>`;
    } else if (c.type === 'ROOM_AND_TIME_CHANGED') {
      typeClass = 'type-room-and-time';
      badgeText = '⚠️ Aula e Orario modificati';
      badgeClass = 'badge-room';
      detailHtml = `
        <div class="change-card-detail">
          <span>Nuova aula:</span>
          <span class="change-new-val room-val">${escapeHtml(c.newRoom || 'Non specificata')}</span>
          <span class="change-old-val">(${escapeHtml(c.oldRoom || 'Precedente')})</span>
        </div>
        <div class="change-card-detail">
          <span>Nuovo orario:</span>
          <span class="change-new-val time-val">${escapeHtml(c.startTime)} - ${escapeHtml(c.endTime)}</span>
          <span class="change-old-val">(${escapeHtml(c.oldStartTime)} - ${escapeHtml(c.oldEndTime)})</span>
        </div>`;
    } else if (c.type === 'ADDED') {
      typeClass = 'type-added';
      badgeText = '➕ Nuova lezione';
      badgeClass = 'badge-added';
      detailHtml = `
        <div style="color:#C4B5FD; font-weight:600; margin-top:2px;">
          Nuova lezione inserita in orario (Aula: ${escapeHtml(c.newRoom || 'Non specificata')}).
        </div>`;
    } else {
      typeClass = 'type-room';
      badgeText = '📍 Aula cambiata';
      badgeClass = 'badge-room';
      detailHtml = `
        <div class="change-card-detail">
          <span>Nuova aula:</span>
          <span class="change-new-val room-val">${escapeHtml(c.newRoom || 'Non specificata')}</span>
        </div>
        <div class="change-card-detail">
          <span class="change-old-val">Aula precedente: ${escapeHtml(c.oldRoom || 'Non specificata')}</span>
        </div>`;
    }

    card.className = `change-item-card ${typeClass}`;
    const dayLong = formatDateItalianLong(c.date);

    card.innerHTML = `
      <div class="change-card-header">
        <span class="change-badge ${badgeClass}">${badgeText}</span>
        <span class="change-card-time">⏰ ${escapeHtml(c.startTime)} - ${escapeHtml(c.endTime)}</span>
      </div>
      <div class="change-card-title">
        ${escapeHtml(c.course)}
        ${c.isFavorite ? '<span class="course-badge" style="margin-left:6px; background:rgba(139,92,246,0.2); color:#DDD6FE; font-size:0.68rem; padding:2px 6px; border-radius:4px;">⭐ Tuo corso</span>' : ''}
      </div>
      <div class="change-card-body">
        <div style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:2px;">
          📌 <strong>${escapeHtml(dayLong)}</strong>
          ${c.docente ? ` · 👨‍🏫 ${escapeHtml(c.docente)}` : ''}
        </div>
        ${detailHtml}
      </div>
      <div style="display:flex; justify-content:flex-end; margin-top:6px;">
        <button class="btn-changes-view btn-goto-change" data-date="${escapeHtml(c.date)}" type="button" style="padding:4px 10px; font-size:0.75rem;">
          Vai al giorno ➔
        </button>
      </div>
    `;

    card.querySelector('.btn-goto-change')?.addEventListener('click', () => {
      state.selectedDayDate = c.date;
      acknowledgeScheduleChanges(currentModalMonday);
      renderDayTabs();
      renderEvents();
    });

    container.appendChild(card);
  });
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
  let previousCacheData = null;
  try {
    const localCache = localStorage.getItem(cacheKey);
    if (localCache) {
      previousCacheData = JSON.parse(localCache);
    }
  } catch (e) {
    console.warn('Cache read error', e);
  }

  if (!forceRefresh && previousCacheData) {
    state.calendarData = previousCacheData;
    renderCalendar();
    updateChangesUI(mondayDateStr);
    showLoading(false);
  }

  try {
    const res = await fetch(calendarUrl(mondayDateStr, forceRefresh));
    if (!res.ok) throw new Error('Errore durante la risposta del server');

    const data = await res.json();
    if (requestId !== state.requestId) return;

    // Detect differences between previous cache and newly fetched data
    if (!state.preview && previousCacheData && Array.isArray(previousCacheData.events) && Array.isArray(data.events)) {
      handleCalendarUpdates(previousCacheData, data, mondayDateStr);
    }

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
    updateChangesUI(mondayDateStr);
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

  // Stored changes for the active week
  const storedChanges = getStoredChanges(state.currentMonday);
  const removedChanges = (storedChanges && storedChanges.changes)
    ? storedChanges.changes.filter(c => c.type === 'REMOVED')
    : [];

  let filteredRemoved = removedChanges;
  if (state.activeFilter === 'target' && hasFavorites) {
    filteredRemoved = filteredRemoved.filter(c => c.isFavorite);
  }
  if (state.selectedDayDate !== 'all') {
    filteredRemoved = filteredRemoved.filter(c => c.date === state.selectedDayDate);
  }
  if (state.searchQuery) {
    filteredRemoved = filteredRemoved.filter(c =>
      (c.course || '').toLowerCase().includes(state.searchQuery) ||
      (c.docente || '').toLowerCase().includes(state.searchQuery) ||
      (c.oldRoom || '').toLowerCase().includes(state.searchQuery)
    );
  }

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

  if (events.length === 0 && filteredRemoved.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <h3>Nessuna lezione trovata</h3>
        <p>${state.activeFilter === 'target' ? 'Nessuna lezione dei tuoi corsi in questo periodo.' : 'Nessuna lezione in programma per i filtri selezionati.'}</p>
      </div>
    `;
    return;
  }

  // Group events by day
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

  filteredRemoved.forEach(rem => {
    if (!grouped[rem.date]) {
      grouped[rem.date] = {
        date: rem.date,
        dayName: rem.dayName || '',
        items: []
      };
    }
  });

  // With several years of study selected, show which one each lesson belongs to
  const showCurriculum = state.config.anni.length > 1;

  const sortedDates = Object.keys(grouped).sort((a, b) => {
    const da = parseAnyDate(a);
    const db = parseAnyDate(b);
    return da - db;
  });

  sortedDates.forEach(dateKey => {
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

      const change = getEventChange(e, state.currentMonday);
      let changeBadgeHtml = '';
      if (change) {
        if (change.type === 'ROOM_CHANGED' || change.type === 'ROOM_AND_TIME_CHANGED') {
          changeBadgeHtml += `
            <div class="event-card-change-badge badge-room-change">
              <span>📍</span> <span>Aula variata: <strong>${escapeHtml(e.aula || 'Non specificata')}</strong> <del style="opacity:0.75; font-size:0.72rem;">(${escapeHtml(change.oldRoom || 'Precedente')})</del></span>
            </div>`;
        }
        if (change.type === 'TIME_CHANGED' || change.type === 'ROOM_AND_TIME_CHANGED') {
          changeBadgeHtml += `
            <div class="event-card-change-badge badge-time-change">
              <span>⏰</span> <span>Orario variato: <strong>${escapeHtml(e.start_time)} - ${escapeHtml(e.end_time)}</strong> <del style="opacity:0.75; font-size:0.72rem;">(${escapeHtml(change.oldStartTime)} - ${escapeHtml(change.oldEndTime)})</del></span>
            </div>`;
        }
      }

      card.innerHTML = `
        <div class="card-top">
          <span class="time-badge">⏰ ${escapeHtml(e.start_time)} - ${escapeHtml(e.end_time)}</span>
          ${color ? '<span class="course-badge">⭐ Mio corso</span>' : ''}
        </div>
        ${isCanceled ? '<div class="canceled-banner">⚠️ LEZIONE ANNULLATA</div>' : ''}
        <div class="course-title ${isCanceled ? 'canceled-text' : ''}">${escapeHtml(e.course)}</div>
        ${changeBadgeHtml}
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

    const dayRemoved = filteredRemoved.filter(r => r.date === dateKey);
    dayRemoved.forEach(rem => {
      const remCard = document.createElement('div');
      const color = state.favoriteColors[rem.courseCode];
      remCard.className = `event-card canceled event-card-removed ${color ? 'target' : ''}`;
      if (color) remCard.style.setProperty('--course-color', color);
      remCard.innerHTML = `
        <div class="card-top">
          <span class="time-badge">⏰ ${escapeHtml(rem.startTime)} - ${escapeHtml(rem.endTime)}</span>
          ${rem.isFavorite ? '<span class="course-badge">⭐ Mio corso</span>' : ''}
        </div>
        <div class="canceled-banner">❌ LEZIONE RIMOSSA DALL'ORARIO</div>
        <div class="course-title canceled-text">${escapeHtml(rem.course)}</div>
        <div class="card-details">
          <div class="detail-item">
            <span>📍</span> <span>Aula precedente: <del>${escapeHtml(rem.oldRoom || 'Non specificata')}</del></span>
          </div>
          <div class="detail-item">
            <span>👨‍🏫</span> <span>Docente: <strong>${escapeHtml(rem.docente || 'Non specificato')}</strong></span>
          </div>
          <div class="detail-item" style="color:#EF4444; font-size:0.78rem;">
            <span>ℹ️</span> <span>Questa lezione è stata rimossa dall'ultimo aggiornamento del calendario.</span>
          </div>
        </div>
      `;
      section.appendChild(remCard);
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

let toastTimeout = null;

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;

  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }

  toast.textContent = msg;
  toast.classList.add('show');

  // Allow clicking/tapping the toast to dismiss it immediately
  toast.onclick = () => {
    toast.classList.remove('show');
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      toastTimeout = null;
    }
  };

  const timeoutMs = typeof duration === 'number' && duration > 0 ? duration : 3000;
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
    toastTimeout = null;
  }, timeoutMs);
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

  const tabMap = { timetable: 'tabTimetable', teachers: 'tabTeachers', rooms: 'tabRooms', exams: 'tabExams', friends: 'tabFriends' };
  document.querySelectorAll('.bottom-nav .nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.id === tabMap[tabId]);
  });

  document.getElementById('viewTimetable').classList.toggle('hidden', tabId !== 'timetable');
  document.getElementById('viewTeachers').classList.toggle('hidden', tabId !== 'teachers');
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
    updateChangesUI(state.currentMonday);
  } else {
    const btnChangesNotice = document.getElementById('btnChangesNotice');
    if (btnChangesNotice) btnChangesNotice.style.display = 'none';
  }
  if (tabId === 'teachers') {
    document.getElementById('headerSubtitle').textContent = teachersState.selectedTeacher
      ? `Prof. ${teachersState.selectedTeacher.name}`
      : 'Calendario docenti';
    initTeachersView();
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
    loadFriendsCalendar();
  }
}

// ---------- Teachers Calendar (Calendario Docenti) ----------

function loadFavoriteTeachers() {
  try {
    const raw = localStorage.getItem(FAVORITE_TEACHERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Error reading favorite teachers', e);
    return [];
  }
}

function saveFavoriteTeachers(favs) {
  try {
    localStorage.setItem(FAVORITE_TEACHERS_KEY, JSON.stringify(favs));
  } catch (e) {
    console.warn('Error saving favorite teachers', e);
  }
}

async function initTeachersView() {
  renderFavoriteTeachersBar();
  renderTeacherQuickSuggestions();

  if (!teachersState.academicYears.length) {
    await loadTeacherYears();
  }

  if (!teachersState.allTeachers.length && teachersState.selectedYear) {
    await loadTeachersList();
  }

  if (teachersState.selectedTeacher) {
    loadTeacherCalendar();
  } else {
    // Show empty state
    const emptyState = document.getElementById('teachersEmptyState');
    const eventsContainer = document.getElementById('teachersEventsContainer');
    if (emptyState) emptyState.style.display = 'block';
    if (eventsContainer) eventsContainer.style.display = 'none';
  }
}

async function loadTeacherYears() {
  try {
    const res = await fetchJson('/api/options');
    teachersState.academicYears = res.academic_years || [];
    const select = document.getElementById('teachersYearSelect');
    if (select) {
      select.innerHTML = teachersState.academicYears.map(y =>
        `<option value="${escapeHtml(y.value)}" ${y.value === teachersState.selectedYear ? 'selected' : ''}>${escapeHtml(y.label)}</option>`
      ).join('');
      if (!teachersState.selectedYear && teachersState.academicYears.length > 0) {
        teachersState.selectedYear = teachersState.academicYears[0].value;
        select.value = teachersState.selectedYear;
      }
    }
  } catch (e) {
    console.warn('Error loading academic years for teachers', e);
  }
}

async function loadTeachersList(force = false) {
  if (!teachersState.selectedYear) return;
  const input = document.getElementById('teachersSearchInput');
  if (input && !teachersState.allTeachers.length) {
    input.placeholder = 'Caricamento elenco docenti da UNIMIB...';
  }

  try {
    const res = await fetchJson(`/api/teachers?anno=${encodeURIComponent(teachersState.selectedYear)}${force ? '&refresh=1' : ''}`);
    teachersState.allTeachers = res.teachers || [];
  } catch (e) {
    console.error('Error loading teachers list', e);
    showToast('Errore nel caricamento dei docenti UNIMIB');
  } finally {
    if (input) {
      input.placeholder = '🔍 Cerca docente (es. Abbotto, Arcelli, Antoniotti)...';
    }
  }
}

function normalizeSearchText(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function renderTeacherAutocomplete(query) {
  const container = document.getElementById('teachersAutocompleteList');
  if (!container) return;

  const q = normalizeSearchText(query);
  if (!q || q.length < 2) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  const matches = teachersState.allTeachers.filter(t => {
    const nameNorm = normalizeSearchText(t.name);
    if (nameNorm.includes(q)) return true;
    return (t.courses || []).some(c => 
      normalizeSearchText(c.name).includes(q) || normalizeSearchText(c.code).includes(q)
    );
  }).slice(0, 20);

  if (!matches.length) {
    container.innerHTML = `
      <div style="padding: 12px 14px; color: var(--text-muted); font-size: 0.82rem; text-align: center;">
        Nessun docente trovato per "<strong>${escapeHtml(query)}</strong>"
      </div>
    `;
    container.style.display = 'block';
    return;
  }

  container.innerHTML = '';
  matches.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'teachers-autocomplete-item';
    if (idx === 0) item.classList.add('active');

    const isFav = teachersState.favoriteTeachers.some(f => f.code === t.code);
    const coursesSummary = (t.courses || []).map(c => c.name).slice(0, 2).join(' · ');

    item.innerHTML = `
      <div class="teacher-item-name">
        <span>👨‍🏫 ${escapeHtml(t.name)}</span>
        ${isFav ? '<span title="Docente preferito">⭐</span>' : ''}
      </div>
      ${coursesSummary ? `<div class="teacher-item-courses">${escapeHtml(coursesSummary)}</div>` : ''}
    `;

    item.addEventListener('click', () => {
      selectTeacher(t);
    });

    container.appendChild(item);
  });

  container.style.display = 'block';
}

function selectTeacher(teacher, autoFetch = true) {
  if (!teacher) return;
  teachersState.selectedTeacher = teacher;
  teachersState.selectedCourseFilter = '';

  const input = document.getElementById('teachersSearchInput');
  if (input) input.value = teacher.name;

  const btnClear = document.getElementById('btnClearTeacherSearch');
  if (btnClear) btnClear.style.display = 'block';

  const dropdown = document.getElementById('teachersAutocompleteList');
  if (dropdown) dropdown.style.display = 'none';

  // Update selected teacher card
  const card = document.getElementById('selectedTeacherCard');
  if (card) {
    card.style.display = 'block';
    document.getElementById('selectedTeacherName').textContent = teacher.name;

    const emailContainer = document.getElementById('selectedTeacherEmails');
    if (emailContainer) emailContainer.innerHTML = '';

    // Update favorite button icon
    const isFav = teachersState.favoriteTeachers.some(f => f.code === teacher.code);
    const favBtn = document.getElementById('btnToggleTeacherFavorite');
    if (favBtn) {
      favBtn.textContent = isFav ? '⭐' : '☆';
      favBtn.title = isFav ? 'Rimuovi dai preferiti' : 'Salva tra i preferiti';
    }

    // Populate course filter
    const courseFilterContainer = document.getElementById('teacherCourseFilterContainer');
    const courseSelect = document.getElementById('teacherCourseSelect');
    if (courseFilterContainer && courseSelect) {
      if (teacher.courses && teacher.courses.length > 1) {
        courseFilterContainer.style.display = 'block';
        courseSelect.innerHTML = `<option value="">📚 Tutti i corsi del docente (${teacher.courses.length})</option>` +
          teacher.courses.map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.name)}</option>`).join('');
      } else {
        courseFilterContainer.style.display = 'none';
        courseSelect.innerHTML = '<option value="">📚 Tutti i corsi del docente</option>';
      }
    }
  }

  // Update header subtitle
  if (state.activeTab === 'teachers') {
    document.getElementById('headerSubtitle').textContent = `Prof. ${teacher.name}`;
  }

  // Update active chip state in favorites bar
  renderFavoriteTeachersBar();

  if (autoFetch) {
    loadTeacherCalendar();
  }
}

async function handleTeacherParam(teacherCode) {
  if (!teacherCode) return;
  const cleanCode = teacherCode.trim();

  // If teachers not loaded yet, wait for years and list
  if (!teachersState.academicYears.length) {
    await loadTeacherYears();
  }
  if (!teachersState.allTeachers.length && teachersState.selectedYear) {
    await loadTeachersList();
  }

  // Try finding in allTeachers
  let found = teachersState.allTeachers.find(t => t.code === cleanCode || t.name.toLowerCase() === cleanCode.toLowerCase());
  if (found) {
    selectTeacher(found, true);
  } else {
    // Direct fetch using the code
    selectTeacher({ code: cleanCode, name: `Docente (${cleanCode})`, courses: [] }, true);
  }
}

function toggleTeacherFavorite(teacher) {
  if (!teacher) return;
  const exists = teachersState.favoriteTeachers.some(f => f.code === teacher.code);
  if (exists) {
    teachersState.favoriteTeachers = teachersState.favoriteTeachers.filter(f => f.code !== teacher.code);
    showToast('Docente rimosso dai preferiti');
  } else {
    teachersState.favoriteTeachers.push({ code: teacher.code, name: teacher.name });
    showToast('Docente salvato nei preferiti ⭐');
  }
  saveFavoriteTeachers(teachersState.favoriteTeachers);

  // Update button
  const favBtn = document.getElementById('btnToggleTeacherFavorite');
  if (favBtn) {
    const isNowFav = !exists;
    favBtn.textContent = isNowFav ? '⭐' : '☆';
    favBtn.title = isNowFav ? 'Rimuovi dai preferiti' : 'Salva tra i preferiti';
  }

  renderFavoriteTeachersBar();
}

function renderFavoriteTeachersBar() {
  const section = document.getElementById('teachersFavoritesSection');
  const container = document.getElementById('teachersFavoritesList');
  if (!section || !container) return;

  if (!teachersState.favoriteTeachers.length) {
    section.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = '';

  teachersState.favoriteTeachers.forEach(fav => {
    const chip = document.createElement('div');
    const isSelected = teachersState.selectedTeacher && teachersState.selectedTeacher.code === fav.code;
    chip.className = `teacher-favorite-chip ${isSelected ? 'active' : ''}`;

    // Format shorter label, e.g. "Abbotto A."
    const parts = fav.name.split(' ');
    const shortName = parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : fav.name;

    chip.innerHTML = `<span>⭐ ${escapeHtml(shortName)}</span>`;
    chip.title = fav.name;
    chip.addEventListener('click', () => {
      // Find full teacher object if available
      const full = teachersState.allTeachers.find(t => t.code === fav.code) || fav;
      selectTeacher(full, true);
    });

    container.appendChild(chip);
  });
}

function renderTeacherQuickSuggestions() {
  const container = document.getElementById('teachersQuickSuggestions');
  if (!container) return;

  const suggestions = [
    { name: 'Abbotto Alessandro', code: '013696' },
    { name: 'Arcelli Fontana Francesca', code: '000857' },
    { name: 'Antoniotti Marco', code: '001919' },
    { name: 'Bernardinello Luca', code: '000600' }
  ];

  container.innerHTML = suggestions.map(s => `
    <button class="teacher-suggestion-chip" data-code="${escapeHtml(s.code)}" data-name="${escapeHtml(s.name)}">
      🔍 ${escapeHtml(s.name)}
    </button>
  `).join('');

  container.querySelectorAll('.teacher-suggestion-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-code');
      const name = btn.getAttribute('data-name');
      const full = teachersState.allTeachers.find(t => t.code === code) || { code, name, courses: [] };
      selectTeacher(full, true);
    });
  });
}

async function shareTeacherCalendar(teacher) {
  if (!teacher) return;
  const url = `${window.location.origin}/?tab=docenti&docente=${encodeURIComponent(teacher.code)}`;
  const title = `Orario lezioni - Prof. ${teacher.name}`;
  const text = `Consulta l'orario delle lezioni e le aule del Prof. ${teacher.name} su UNIMIB Orari`;

  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Share error', e);
    }
  }

  // Fallback to clipboard
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link orario docente copiato! 📋');
  } catch (e) {
    showToast('Copia il link: ' + url);
  }
}

async function loadTeacherCalendar(forceRefresh = false) {
  if (!teachersState.selectedTeacher) {
    const emptyState = document.getElementById('teachersEmptyState');
    const eventsContainer = document.getElementById('teachersEventsContainer');
    if (emptyState) emptyState.style.display = 'block';
    if (eventsContainer) eventsContainer.style.display = 'none';
    return;
  }

  const requestId = ++teachersState.requestId;
  const spinner = document.getElementById('teachersSpinnerContainer');
  const emptyState = document.getElementById('teachersEmptyState');
  const eventsContainer = document.getElementById('teachersEventsContainer');

  if (spinner) spinner.style.display = 'flex';
  if (emptyState) emptyState.style.display = 'none';
  if (eventsContainer) eventsContainer.style.display = 'none';

  if (!teachersState.currentMonday) {
    teachersState.currentMonday = formatFormattedDate(getMonday(new Date()));
  }

  const params = new URLSearchParams({
    anno: teachersState.selectedYear || '',
    docente: teachersState.selectedTeacher.code,
    date: teachersState.currentMonday
  });

  if (teachersState.viewMode === 'all') {
    params.set('all_events', '1');
  }
  if (teachersState.selectedCourseFilter) {
    params.set('corso', teachersState.selectedCourseFilter);
  }
  if (forceRefresh) {
    params.set('refresh', '1');
  }

  try {
    const res = await fetchJson(`/api/teachers?${params.toString()}`);
    if (requestId !== teachersState.requestId) return;

    teachersState.eventsData = res;

    // Check if events have email addresses for the selected teacher
    if (res.events && res.events.length > 0) {
      const emailContainer = document.getElementById('selectedTeacherEmails');
      const allEmails = [];
      res.events.forEach(e => {
        (e.emails || []).forEach(em => {
          if (!allEmails.includes(em)) allEmails.push(em);
        });
      });
      if (allEmails.length > 0 && emailContainer) {
        emailContainer.innerHTML = allEmails.map(em =>
          `<a href="mailto:${escapeHtml(em)}" class="teacher-email-link" title="Scrivi email">✉️ ${escapeHtml(em)}</a>`
        ).join(' ');
      }
    }

    renderTeacherCalendar();
  } catch (err) {
    if (requestId !== teachersState.requestId) return;
    console.error('Error fetching teacher calendar', err);
    if (emptyState) {
      emptyState.style.display = 'block';
      document.getElementById('teachersEmptyTitle').textContent = 'Errore di caricamento';
      document.getElementById('teachersEmptyDesc').textContent = 'Impossibile recuperare il calendario del docente. Verifica la connessione e riprova.';
    }
    showToast('Errore di connessione a UNIMIB');
  } finally {
    if (requestId === teachersState.requestId && spinner) {
      spinner.style.display = 'none';
    }
  }
}

function changeTeacherWeek(dayOffset) {
  if (!teachersState.currentMonday) return;
  const parts = teachersState.currentMonday.split('-');
  const dt = new Date(parts[2], parts[1] - 1, parts[0]);
  dt.setDate(dt.getDate() + dayOffset);

  const monday = getMonday(dt);
  teachersState.currentMonday = formatFormattedDate(monday);
  teachersState.selectedDayDate = 'all';
  loadTeacherCalendar();
}

function renderTeacherCalendar() {
  const data = teachersState.eventsData;
  if (!data) return;

  const weekLabel = document.getElementById('teachersWeekLabelText');
  if (weekLabel) {
    weekLabel.textContent = data.week_label || teachersState.currentMonday;
  }

  renderTeacherDayTabs();
  renderTeacherEvents();
}

function renderTeacherDayTabs() {
  const tabsContainer = document.getElementById('teachersDaysTabBar');
  if (!tabsContainer) return;
  tabsContainer.innerHTML = '';

  const giorni = (teachersState.eventsData && teachersState.eventsData.giorni) || [];

  // "TUTTI" Tab
  const allTab = document.createElement('div');
  allTab.className = `day-tab ${teachersState.selectedDayDate === 'all' ? 'active' : ''}`;
  allTab.innerHTML = `
    <div class="tab-name">TUTTI</div>
    <div class="tab-date">${giorni.length > 0 ? giorni.length + 'GG' : 'TUTTI'}</div>
  `;
  allTab.addEventListener('click', () => {
    teachersState.selectedDayDate = 'all';
    renderTeacherDayTabs();
    renderTeacherEvents();
  });
  tabsContainer.appendChild(allTab);

  giorni.forEach(g => {
    const tab = document.createElement('div');
    const isSelected = teachersState.selectedDayDate === g.data;
    tab.className = `day-tab ${isSelected ? 'active' : ''}`;

    const dayShort = g.label ? g.label.split(' ')[0].substring(0, 3).toUpperCase() : 'GG';
    const dayNum = g.data ? g.data.split('-')[0] : '';

    const dayEvents = ((teachersState.eventsData && teachersState.eventsData.events) || []).filter(e => e.date === g.data);
    let dotsHtml = '';
    if (dayEvents.length > 0) {
      dotsHtml = '<div class="tab-dots">';
      for (let i = 0; i < Math.min(dayEvents.length, 3); i++) {
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
      teachersState.selectedDayDate = g.data;
      renderTeacherDayTabs();
      renderTeacherEvents();
    });

    tabsContainer.appendChild(tab);
  });
}

function renderTeacherEvents() {
  const container = document.getElementById('teachersEventsContainer');
  const emptyState = document.getElementById('teachersEmptyState');
  if (!container) return;

  container.innerHTML = '';

  if (!teachersState.eventsData || !teachersState.eventsData.events) {
    return;
  }

  let events = teachersState.eventsData.events;

  // Filter 1: By day
  if (teachersState.selectedDayDate !== 'all') {
    events = events.filter(e => e.date === teachersState.selectedDayDate);
  }

  // Filter 2: By selected course of study
  if (teachersState.selectedCourseFilter) {
    events = events.filter(e => {
      const codeMatch = (e.course_code || '').toLowerCase().includes(teachersState.selectedCourseFilter.toLowerCase());
      const curriculaMatch = (e.curricula || []).some(c => c.toLowerCase().includes(teachersState.selectedCourseFilter.toLowerCase()));
      return codeMatch || curriculaMatch;
    });
  }

  // Filter 3: In-schedule search query
  if (teachersState.searchFilter) {
    const q = teachersState.searchFilter;
    events = events.filter(e =>
      (e.course || '').toLowerCase().includes(q) ||
      (e.aula || '').toLowerCase().includes(q) ||
      (e.notes || '').toLowerCase().includes(q) ||
      (e.type || '').toLowerCase().includes(q)
    );
  }

  if (events.length === 0) {
    if (emptyState) {
      emptyState.style.display = 'block';
      document.getElementById('teachersEmptyTitle').textContent = 'Nessuna lezione trovata';
      document.getElementById('teachersEmptyDesc').textContent = 'Nessuna lezione in programma per i filtri selezionati in questo periodo.';
    }
    container.style.display = 'none';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';

  // Export week toolbar
  const topBar = document.createElement('div');
  topBar.style.display = 'flex';
  topBar.style.justifyContent = 'space-between';
  topBar.style.alignItems = 'center';
  topBar.style.padding = '8px 16px';
  topBar.style.marginBottom = '8px';
  topBar.innerHTML = `
    <span style="font-size:0.82rem; color:var(--text-secondary); font-weight:600;">
      📚 ${events.length} ${events.length === 1 ? 'lezione' : 'lezioni'}
    </span>
    <button id="btnExportTeacherWeekIcs" class="btn-ics-action" style="padding: 6px 12px; font-size: 0.78rem;">
      📥 Esporta tutte (.ics)
    </button>
  `;
  container.appendChild(topBar);

  topBar.querySelector('#btnExportTeacherWeekIcs').addEventListener('click', () => {
    downloadTeacherWeekIcs(events, teachersState.selectedTeacher);
  });

  // Group events by date
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

    const itDateTitle = formatDateItalianLong(group.date);
    section.innerHTML = `<div class="day-header-title">📌 ${escapeHtml(itDateTitle)}</div>`;

    group.items.forEach(e => {
      const card = document.createElement('div');
      const isCanceled = e.is_canceled;
      card.className = `event-card ${isCanceled ? 'canceled' : ''}`;

      card.innerHTML = `
        <div class="card-top">
          <span class="time-badge">⏰ ${escapeHtml(e.start_time)} - ${escapeHtml(e.end_time)}</span>
          <span class="badge-status" style="font-size: 0.72rem; padding: 2px 8px;">${escapeHtml(e.type || 'Lezione')}</span>
        </div>
        ${isCanceled ? '<div class="canceled-banner">⚠️ LEZIONE ANNULLATA</div>' : ''}
        <div class="course-title ${isCanceled ? 'canceled-text' : ''}">${escapeHtml(e.course)}</div>
        <div class="card-details">
          <div class="detail-item">
            <span>📍</span>
            <span>Aula: <strong class="room-pill">${escapeHtml(e.aula || 'Non specificata')}</strong></span>
          </div>
          ${(e.curricula && e.curricula.length > 0) ? `
          <div class="detail-item">
            <span>🎓</span>
            <span>${escapeHtml(e.curricula.join(' · '))}</span>
          </div>` : ''}
          ${e.docente ? `
          <div class="detail-item">
            <span>👨‍🏫</span>
            <span>${escapeHtml(e.docente)}</span>
          </div>` : ''}
          ${e.primary_email ? `
          <div class="detail-item">
            <span>✉️</span>
            <a href="mailto:${escapeHtml(e.primary_email)}" class="teacher-email-link" title="Invia email">${escapeHtml(e.primary_email)}</a>
          </div>` : ''}
          ${e.notes ? `
          <div class="detail-item" style="grid-column: 1 / -1; background: rgba(255,255,255,0.03); border-radius: 8px; padding: 6px 10px; margin-top: 4px;">
            <span style="font-size: 0.8rem;">📝</span>
            <span style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.4;">${escapeHtml(e.notes)}</span>
          </div>` : ''}
        </div>
        <div style="display: flex; justify-content: flex-end; margin-top: 10px; gap: 8px;">
          <button class="btn-ics-action btn-single-ics">📅 Salva .ics</button>
        </div>
      `;

      card.querySelector('.btn-single-ics').addEventListener('click', (evt) => {
        evt.stopPropagation();
        downloadTeacherEventIcs(e);
      });

      section.appendChild(card);
    });

    container.appendChild(section);
  });
}

function downloadTeacherEventIcs(ev) {
  if (!ev) return;
  const parts = (ev.date || '').split('-');
  if (parts.length !== 3) return;
  const dateClean = `${parts[2]}${parts[1]}${parts[0]}`;
  const startClean = (ev.start_time || '09:00').replace(':', '') + '00';
  const endClean = (ev.end_time || '11:00').replace(':', '') + '00';
  const dtStart = `${dateClean}T${startClean}`;
  const dtEnd = `${dateClean}T${endClean}`;
  const summary = `Lezione: ${ev.course}`;
  const location = ev.aula || 'UNIMIB';
  const description = `Docente: ${ev.docente || ''}\nAula: ${ev.aula || ''}\nTipo: ${ev.type || 'Lezione'}\nNote: ${ev.notes || ''}`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UNIMIB Orari//IT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:teacher-lesson-${ev.id || Date.now()}@unimib.it`,
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
  link.download = `lezione_${ev.course.replace(/[^a-zA-Z0-9]/g, '_')}_${ev.date}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Lezione salvata in .ics! 📅');
}

function downloadTeacherWeekIcs(events, teacher) {
  if (!events || !events.length) return;

  const nowStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const vEvents = events.map(ev => {
    const parts = (ev.date || '').split('-');
    if (parts.length !== 3) return '';
    const dateClean = `${parts[2]}${parts[1]}${parts[0]}`;
    const startClean = (ev.start_time || '09:00').replace(':', '') + '00';
    const endClean = (ev.end_time || '11:00').replace(':', '') + '00';
    const dtStart = `${dateClean}T${startClean}`;
    const dtEnd = `${dateClean}T${endClean}`;
    const summary = `Lezione: ${ev.course}`;
    const location = ev.aula || 'UNIMIB';
    const description = `Docente: ${ev.docente || ''}\nAula: ${ev.aula || ''}\nTipo: ${ev.type || 'Lezione'}\nNote: ${ev.notes || ''}`;

    return [
      'BEGIN:VEVENT',
      `UID:teacher-lesson-${ev.id || Math.random()}@unimib.it`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${summary.replace(/,/g, '\\,')}`,
      `LOCATION:${location.replace(/,/g, '\\,')}`,
      `DESCRIPTION:${description.replace(/\n/g, '\\n').replace(/,/g, '\\,')}`,
      'END:VEVENT'
    ].join('\r\n');
  }).filter(Boolean);

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UNIMIB Orari//IT',
    'CALSCALE:GREGORIAN',
    ...vEvents,
    'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const teacherNameClean = (teacher ? teacher.name : 'docente').replace(/[^a-zA-Z0-9]/g, '_');
  link.download = `lezioni_${teacherNameClean}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('Tutte le lezioni esportate in .ics! 📅');
}

function setupTeachersEventListeners() {
  const yearSelect = document.getElementById('teachersYearSelect');
  if (yearSelect) {
    yearSelect.addEventListener('change', () => {
      teachersState.selectedYear = yearSelect.value;
      teachersState.allTeachers = [];
      loadTeachersList(true);
      if (teachersState.selectedTeacher) {
        loadTeacherCalendar(true);
      }
    });
  }

  const searchInput = document.getElementById('teachersSearchInput');
  const autocompleteList = document.getElementById('teachersAutocompleteList');
  const btnClear = document.getElementById('btnClearTeacherSearch');

  let debounceTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const val = searchInput.value;
      if (btnClear) btnClear.style.display = val ? 'block' : 'none';

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        renderTeacherAutocomplete(val);
      }, 150);
    });

    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim().length >= 2) {
        renderTeacherAutocomplete(searchInput.value);
      }
    });

    searchInput.addEventListener('keydown', (e) => {
      if (!autocompleteList || autocompleteList.style.display === 'none') return;
      const items = autocompleteList.querySelectorAll('.teachers-autocomplete-item');
      if (!items.length) return;

      let activeIndex = Array.from(items).findIndex(el => el.classList.contains('active'));

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (activeIndex >= 0) items[activeIndex].classList.remove('active');
        activeIndex = (activeIndex + 1) % items.length;
        items[activeIndex].classList.add('active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (activeIndex >= 0) items[activeIndex].classList.remove('active');
        activeIndex = (activeIndex - 1 + items.length) % items.length;
        items[activeIndex].classList.add('active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && items[activeIndex]) {
          items[activeIndex].click();
        }
      } else if (e.key === 'Escape') {
        autocompleteList.style.display = 'none';
      }
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      btnClear.style.display = 'none';
      if (autocompleteList) autocompleteList.style.display = 'none';
    });
  }

  // Click outside closes autocomplete
  document.addEventListener('click', (e) => {
    if (autocompleteList && !autocompleteList.contains(e.target) && e.target !== searchInput) {
      autocompleteList.style.display = 'none';
    }
  });

  const btnFav = document.getElementById('btnToggleTeacherFavorite');
  if (btnFav) {
    btnFav.addEventListener('click', () => {
      toggleTeacherFavorite(teachersState.selectedTeacher);
    });
  }

  const btnShare = document.getElementById('btnShareTeacherLink');
  if (btnShare) {
    btnShare.addEventListener('click', () => {
      shareTeacherCalendar(teachersState.selectedTeacher);
    });
  }

  const courseSelect = document.getElementById('teacherCourseSelect');
  if (courseSelect) {
    courseSelect.addEventListener('change', () => {
      teachersState.selectedCourseFilter = courseSelect.value;
      renderTeacherEvents();
    });
  }

  const btnViewWeek = document.getElementById('btnTeacherViewWeek');
  const btnViewAll = document.getElementById('btnTeacherViewAll');
  const weekNav = document.getElementById('teachersWeekNavigator');
  const daysBar = document.getElementById('teachersDaysTabBar');

  if (btnViewWeek && btnViewAll) {
    btnViewWeek.addEventListener('click', () => {
      teachersState.viewMode = 'week';
      btnViewWeek.classList.add('active');
      btnViewAll.classList.remove('active');
      if (weekNav) weekNav.style.display = 'flex';
      if (daysBar) daysBar.style.display = 'flex';
      loadTeacherCalendar();
    });

    btnViewAll.addEventListener('click', () => {
      teachersState.viewMode = 'all';
      btnViewAll.classList.add('active');
      btnViewWeek.classList.remove('active');
      if (weekNav) weekNav.style.display = 'none';
      if (daysBar) daysBar.style.display = 'none';
      loadTeacherCalendar();
    });
  }

  const eventFilterInput = document.getElementById('teachersEventFilterInput');
  if (eventFilterInput) {
    eventFilterInput.addEventListener('input', () => {
      teachersState.searchFilter = eventFilterInput.value.trim().toLowerCase();
      renderTeacherEvents();
    });
  }

  const btnPrevWeek = document.getElementById('btnTeachersPrevWeek');
  const btnNextWeek = document.getElementById('btnTeachersNextWeek');
  const btnToday = document.getElementById('btnTeachersToday');

  if (btnPrevWeek) btnPrevWeek.addEventListener('click', () => changeTeacherWeek(-7));
  if (btnNextWeek) btnNextWeek.addEventListener('click', () => changeTeacherWeek(7));
  if (btnToday) {
    btnToday.addEventListener('click', () => {
      teachersState.currentMonday = formatFormattedDate(getMonday(new Date()));
      teachersState.selectedDayDate = 'all';
      loadTeacherCalendar();
    });
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
  if (profileState.id && (profileState.sessionToken || profileState._pin)) {
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
      if (typeof parsed === 'object' && parsed !== null) {
        profileState.nickname     = parsed.nickname || '';
        profileState.shareCode    = parsed.share_code || parsed.shareCode || parsed.id || null;
        profileState.recoveryCode = parsed.recovery_code || null;
      } else if (typeof parsed === 'string') {
        profileState.shareCode = parsed;
        profileState.nickname  = parsed;
      }
    } catch (e) {
      // Legacy plain-text ID string (e.g. "mario123")
      profileState.shareCode = stored.trim();
      profileState.nickname  = stored.trim();
    }
  }
  profileState.sessionToken = localStorage.getItem(SESSION_TOKEN_KEY) || null;
  updateProfileButton();
}

function updateProfileButton() {
  const btn = document.getElementById('btnProfile');
  if (!btn) return;
  const isLogged = Boolean(profileState.nickname && profileState.shareCode);
  btn.classList.toggle('profile-active', isLogged);
  btn.title = isLogged
    ? `${profileState.nickname} [Codice: ${profileState.shareCode}]`
    : 'Il tuo profilo';
}

function saveProfileLocally() {
  if (profileState.shareCode) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      nickname:      profileState.nickname,
      share_code:    profileState.shareCode,
      recovery_code: profileState.recoveryCode || null
    }));
  } else {
    localStorage.removeItem(PROFILE_KEY);
  }
  if (profileState.sessionToken) {
    localStorage.setItem(SESSION_TOKEN_KEY, profileState.sessionToken);
  } else {
    localStorage.removeItem(SESSION_TOKEN_KEY);
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
  const loggedIn = Boolean(profileState.nickname && profileState.shareCode);
  document.getElementById('profileLoggedOut').style.display = loggedIn ? 'none' : '';
  document.getElementById('profileLoggedIn').style.display  = loggedIn ? ''     : 'none';

  if (loggedIn) {
    document.getElementById('profileDisplayNickname').textContent = profileState.nickname;
    document.getElementById('profileDisplayId').textContent       = profileState.shareCode;
    document.getElementById('profileSyncText').textContent        = profileState.lastSync
      ? `Sincronizzato il ${new Date(profileState.lastSync).toLocaleTimeString('it-IT')}`
      : 'Non ancora sincronizzato';

    const recBox = document.getElementById('profileRecoveryCodeBox');
    const recDisplay = document.getElementById('profileRecoveryCodeDisplay');
    if (recBox && recDisplay) {
      if (profileState.recoveryCode) {
        recDisplay.textContent = profileState.recoveryCode;
        recBox.style.display = '';
      } else {
        recBox.style.display = 'none';
      }
    }
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

    // Hide recovery form and show login form if user switches back
    const recForm = document.getElementById('profileRecoverForm');
    if (recForm) recForm.style.display = 'none';
    const loginForm = document.getElementById('profileLoginForm');
    if (loginForm && document.getElementById('profileTabLogin').classList.contains('active')) {
      loginForm.style.display = '';
    }

    // Existing Course info box (shown if state.config is already set)
    const configBox = document.getElementById('profileCurrentConfigBox');
    const configTitle = document.getElementById('profileCurrentConfigTitle');
    const configFavs = document.getElementById('profileCurrentConfigFavs');
    const btnWithExisting = document.getElementById('btnCreateWithExistingConfig');
    const btnCreate = document.getElementById('btnCreateProfile');

    if (state.config && state.config.corsoLabel) {
      if (configBox) configBox.style.display = '';
      if (configTitle) {
        const yearsStr = state.config.anniLabels && state.config.anniLabels.length
          ? ` (${state.config.anniLabels.join(', ')})`
          : '';
        configTitle.textContent = `${state.config.corsoLabel}${yearsStr}`;
      }
      if (configFavs) {
        const favCount = (state.config.favorites || []).length;
        configFavs.textContent = favCount > 0
          ? `⭐ ${favCount} ${favCount === 1 ? 'materia seguita' : 'materie seguite'}`
          : 'Nessuna materia selezionata con la stella';
      }
      if (btnWithExisting) {
        btnWithExisting.style.display = '';
        btnWithExisting.textContent = '✨ Salva profilo con questo corso';
      }
      if (btnCreate) btnCreate.textContent = '📚 Scegli un altro corso ➡️';
    } else {
      if (configBox) configBox.style.display = 'none';
      if (btnWithExisting) btnWithExisting.style.display = 'none';
      if (btnCreate) btnCreate.textContent = 'Continua: Scegli i tuoi corsi ➡️';
    }
  }
}

function showProfileTab(tab) {
  document.getElementById('profileCreateForm').style.display = tab === 'create' ? '' : 'none';
  document.getElementById('profileLoginForm').style.display  = tab === 'login'  ? '' : 'none';
  const recForm = document.getElementById('profileRecoverForm');
  if (recForm) recForm.style.display = 'none';
  document.getElementById('profileTabCreate').classList.toggle('active', tab === 'create');
  document.getElementById('profileTabLogin').classList.toggle('active', tab === 'login');
}

function validateProfileInputs() {
  const nickname = document.getElementById('profileNickname').value.trim();
  const pin      = document.getElementById('profilePin').value.trim();
  const pinConf  = document.getElementById('profilePinConfirm').value.trim();
  const errEl    = document.getElementById('profileCreateError');

  if (errEl) errEl.style.display = 'none';

  if (!nickname) {
    if (errEl) {
      errEl.textContent = 'Inserisci un soprannome.';
      errEl.style.display = '';
    }
    return null;
  }
  if (!pin || pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
    if (errEl) {
      errEl.textContent = 'Il PIN deve essere formato da 4 a 8 cifre numeriche.';
      errEl.style.display = '';
    }
    return null;
  }
  if (pin !== pinConf) {
    if (errEl) {
      errEl.textContent = 'I PIN non corrispondono.';
      errEl.style.display = '';
    }
    return null;
  }
  return { nickname, pin };
}

function handleCreateProfileStep2() {
  const creds = validateProfileInputs();
  if (!creds) return;

  setup._pendingProfile = creds;
  document.getElementById('profileModal').classList.remove('active');
  openSetup(state.config || {}, creds);
}

const handleCreateProfile = handleCreateProfileStep2;

async function handleCreateWithExistingConfig() {
  const creds = validateProfileInputs();
  if (!creds) return;

  const btn = document.getElementById('btnCreateWithExistingConfig');
  const oldText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Creazione profilo in corso...';
  }
  const errEl = document.getElementById('profileCreateError');
  if (errEl) errEl.style.display = 'none';

  try {
    const body = {
      nickname: creds.nickname,
      pin: creds.pin,
      config: state.config || null,
      exam_courses: examsState.extraCourses || []
    };
    const resp = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (errEl) {
        errEl.textContent = data.error || 'Errore durante la creazione.';
        errEl.style.display = '';
      }
      return;
    }
    profileState.nickname     = data.nickname;
    profileState.shareCode    = data.share_code;
    profileState.sessionToken = data.session_token || null;
    profileState.recoveryCode = data.recovery_code || null;
    profileState.lastSync     = Date.now();
    profileState._pin         = creds.pin;
    saveProfileLocally();
    syncGroupCloud();
    renderProfileModal();
    showToast(`🎉 Profilo creato! Il tuo codice calendario è: ${data.share_code}`, 5000);
    setTimeout(() => {
      document.getElementById('profileModal').classList.remove('active');
    }, 1200);
  } catch (e) {
    if (errEl) {
      errEl.textContent = 'Errore di connessione. Riprova.';
      errEl.style.display = '';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

function handleBackToProfileStep1() {
  const pending = setup._pendingProfile;
  setup.seq++;
  document.getElementById('setupModal').classList.remove('active');
  setup._pendingProfile = null;
  openProfileModal();
  showProfileTab('create');
  if (pending) {
    const nickEl = document.getElementById('profileNickname');
    const pinEl = document.getElementById('profilePin');
    const confEl = document.getElementById('profilePinConfirm');
    if (nickEl) nickEl.value = pending.nickname || '';
    if (pinEl) pinEl.value = pending.pin || '';
    if (confEl) confEl.value = pending.pin || '';
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

  const btn = document.getElementById('btnLoginProfile');
  btn.disabled = true;
  btn.textContent = 'Accesso in corso...';

  try {
    const resp = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname: nick,
        pin,
        config: state.config || null,
        exam_courses: examsState.extraCourses || []
      })
    });
    const data = await resp.json();
    if (resp.status === 404) {
      errEl.textContent = data.error || `Nessun account trovato per '${nick}'.`;
      errEl.style.display = '';
      return;
    }
    if (resp.status === 403) {
      errEl.textContent = data.error || 'PIN non corretto.';
      errEl.style.display = '';
      return;
    }
    if (resp.status === 429) {
      errEl.textContent = data.error || 'Troppi tentativi falliti. Riprova tra 10 minuti.';
      errEl.style.display = '';
      return;
    }
    if (!resp.ok) {
      errEl.textContent = data.error || 'Errore di accesso.';
      errEl.style.display = '';
      return;
    }

    if (data.config) {
      state.config = data.config;
      saveConfig(state.config);
      applyConfig();
      if (data.config.favorites && data.config.favorites.length > 0) {
        setFilter('target');
      }
      loadCalendar(state.currentMonday);
    }
    if (data.exam_courses && data.exam_courses.length && !examsState.extraCourses.length) {
      examsState.extraCourses = data.exam_courses;
      saveExamCourses(examsState.extraCourses);
    }

    profileState.nickname     = data.nickname;
    profileState.shareCode    = data.share_code;
    profileState.sessionToken = data.session_token || null;
    if (data.recovery_code) {
      profileState.recoveryCode = data.recovery_code;
    }
    profileState.lastSync     = Date.now();
    profileState._pin         = pin;
    saveProfileLocally();
    syncGroupCloud();
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

function showProfileRecoverForm() {
  const loginForm = document.getElementById('profileLoginForm');
  const recForm = document.getElementById('profileRecoverForm');
  if (loginForm) loginForm.style.display = 'none';
  if (recForm) recForm.style.display = '';
  const errEl = document.getElementById('profileRecoverError');
  if (errEl) errEl.style.display = 'none';
  const nickInput = document.getElementById('profileRecoverNickname');
  const loginNick = document.getElementById('profileLoginNickname');
  if (nickInput && loginNick && loginNick.value) {
    nickInput.value = loginNick.value;
  }
}

function hideProfileRecoverForm() {
  const recForm = document.getElementById('profileRecoverForm');
  const loginForm = document.getElementById('profileLoginForm');
  if (recForm) recForm.style.display = 'none';
  if (loginForm) loginForm.style.display = '';
}

async function handleRecoverPin() {
  const nick = (document.getElementById('profileRecoverNickname').value || '').trim();
  const code = (document.getElementById('profileRecoverCode').value || '').trim();
  const pin = (document.getElementById('profileRecoverNewPin').value || '').trim();
  const pinConf = (document.getElementById('profileRecoverNewPinConfirm').value || '').trim();
  const errEl = document.getElementById('profileRecoverError');

  if (errEl) errEl.style.display = 'none';

  if (!nick) {
    if (errEl) { errEl.textContent = 'Inserisci il tuo soprannome.'; errEl.style.display = ''; }
    return;
  }
  if (!code) {
    if (errEl) { errEl.textContent = 'Inserisci il tuo codice di recupero (REC-XXXX-XXXX).'; errEl.style.display = ''; }
    return;
  }
  if (!pin || pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
    if (errEl) { errEl.textContent = 'Il nuovo PIN deve essere formato da 4 a 8 cifre numeriche.'; errEl.style.display = ''; }
    return;
  }
  if (pin !== pinConf) {
    if (errEl) { errEl.textContent = 'I PIN non corrispondono.'; errEl.style.display = ''; }
    return;
  }

  const btn = document.getElementById('btnSubmitRecoverPin');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Reimpostazione in corso...'; }

  try {
    const resp = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reset_pin',
        nickname: nick,
        recovery_code: code,
        new_pin: pin
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (errEl) {
        errEl.textContent = data.error || 'Errore durante il recupero.';
        errEl.style.display = '';
      }
      return;
    }

    profileState.nickname     = data.nickname;
    profileState.shareCode    = data.share_code;
    profileState.sessionToken = data.session_token || null;
    profileState.recoveryCode = data.recovery_code || null;
    profileState.lastSync     = Date.now();
    profileState._pin         = pin;
    saveProfileLocally();
    syncGroupCloud();
    renderProfileModal();
    showToast(`PIN reimpostato con successo! 🎉 Nuovo codice: ${data.recovery_code}`, 6000);
    setTimeout(() => {
      document.getElementById('profileModal').classList.remove('active');
    }, 1200);
  } catch (e) {
    if (errEl) { errEl.textContent = 'Errore di connessione.'; errEl.style.display = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

function handleLogoutProfile() {
  if (profileState.sessionToken) {
    fetch('/api/profile', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${profileState.sessionToken}` }
    }).catch(() => {});
  }
  profileState.shareCode    = null;
  profileState.nickname     = '';
  profileState.sessionToken = null;
  profileState.recoveryCode = null;
  profileState.lastSync     = null;
  profileState._pin         = null;
  localStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(ACTIVE_GROUP_KEY);
  saveProfileLocally();
  friendsState.groups        = [];
  friendsState.activeGroupId = null;
  friendsState.groupInfo     = null;
  friendsState.friends       = [];
  friendsState.events        = [];
  renderProfileModal();
  renderGroupSwitcher();
  renderFriendChips();
  renderFriendsView();
  showToast('Profilo rimosso da questo dispositivo');
}

async function copyProfileId() {
  const code = profileState.shareCode;
  if (!code) return;
  copyGroupUrlToClipboard(code);
  showToast(`Codice calendario ${code} copiato! 📋`);
}

function shareMyCalendarLink() {
  const code = profileState.shareCode;
  if (!code) {
    showToast('Codice calendario non disponibile');
    return;
  }
  const url = `${window.location.origin}/?friend=${encodeURIComponent(code)}`;
  if (navigator.share) {
    navigator.share({
      title: 'Calendario UNIMIB - ' + profileState.nickname,
      text: `Ecco il mio orario lezioni UNIMIB! Aggiungimi al tuo Calendario Amici: ${url}`,
      url: url
    }).catch(err => {
      if (err.name !== 'AbortError') copyGroupUrlToClipboard(url);
    });
  } else {
    copyGroupUrlToClipboard(url);
  }
}

async function syncProfileNow() {
  if (!profileState.nickname || !profileState.shareCode) return;

  const btn  = document.getElementById('btnSyncNow');
  const text = document.getElementById('profileSyncText');
  btn.disabled = true;
  text.textContent = 'Sincronizzazione...';

  try {
    if (profileState.sessionToken || profileState._pin) {
      await _syncConfigToProfile();
      text.textContent = `Sincronizzato alle ${new Date().toLocaleTimeString('it-IT')}`;
      showToast('Profilo sincronizzato ✅');
    } else {
      const resp = await fetch(`/api/profile?code=${encodeURIComponent(profileState.shareCode)}`);
      if (resp.ok) {
        text.textContent = 'Raggiungibile (riaccedi col PIN per sincronizzare)';
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

async function _syncConfigToProfile() {
  if (!profileState.nickname || (!profileState.sessionToken && !profileState._pin)) return;
  const headers = { 'Content-Type': 'application/json' };
  if (profileState.sessionToken) {
    headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
  }
  const body = {
    nickname:     profileState.nickname,
    config:       state.config || null,
    exam_courses: examsState.extraCourses || []
  };
  if (profileState._pin) {
    body.pin = profileState._pin;
  }
  const resp = await fetch('/api/profile', {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
  if (resp.ok) {
    const data = await resp.json();
    if (data.session_token) {
      profileState.sessionToken = data.session_token;
    }
    profileState.lastSync = Date.now();
    saveProfileLocally();
  } else if (resp.status === 401) {
    profileState.sessionToken = null;
    saveProfileLocally();
  }
}


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

/**
 * Cloud Multi-Group Sync
 * Keeps local friends list and Redis cloud groups in synchronization.
 * Supports multiple groups per user and zero-group initial state.
 */
async function syncGroupCloud(targetGroupId = null) {
  if (!profileState.shareCode) {
    renderGroupSwitcher();
    return;
  }
  const myCode = profileState.shareCode.toUpperCase();
  const gid = targetGroupId || friendsState.activeGroupId || '';

  try {
    const url = `/api/group?user=${encodeURIComponent(myCode)}${gid ? `&group_id=${encodeURIComponent(gid)}` : ''}`;
    const headers = {};
    if (profileState.sessionToken) {
      headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) return;

    const data = await resp.json();
    friendsState.groups = Array.isArray(data.groups) ? data.groups : [];

    if (data.group && data.group.id) {
      friendsState.groupInfo = data.group;
      friendsState.activeGroupId = data.group.id;
      localStorage.setItem(ACTIVE_GROUP_KEY, data.group.id);

      const otherMembers = (data.members || []).filter(m =>
        (m.share_code || m.id || '').toUpperCase() !== myCode
      );

      friendsState.friends = otherMembers.map((m, idx) => ({
        id:         m.share_code || m.id,
        share_code: m.share_code || m.id,
        nickname:   m.nickname || m.id,
        config:     m.config,
        color:      m.color || FRIENDS_COLORS[idx % FRIENDS_COLORS.length]
      }));
      saveFriends(friendsState.friends);
    } else {
      friendsState.groupInfo = null;
      friendsState.activeGroupId = null;
      friendsState.friends = [];
      localStorage.removeItem(ACTIVE_GROUP_KEY);
      saveFriends([]);
    }

    renderGroupSwitcher();
    renderFriendChips();
    updateFriendsGroupHeader();
  } catch (err) {
    console.warn('Group cloud sync error:', err);
  }
}

function renderGroupSwitcher() {
  const select = document.getElementById('friendsGroupSelect');
  const noGroupsState = document.getElementById('friendsNoGroupsState');
  const activeContainer = document.getElementById('friendsActiveGroupContainer');
  const btnRename = document.getElementById('btnRenameGroup');
  const btnLeave  = document.getElementById('btnLeaveGroup');

  const hasGroups = friendsState.groups && friendsState.groups.length > 0;

  if (noGroupsState && activeContainer) {
    if (hasGroups) {
      noGroupsState.style.display = 'none';
      activeContainer.style.display = '';
    } else {
      noGroupsState.style.display = '';
      activeContainer.style.display = 'none';
    }
  }

  if (btnRename) btnRename.disabled = !hasGroups;
  if (btnLeave)  btnLeave.disabled  = !hasGroups;

  if (!select) return;

  if (!hasGroups) {
    select.innerHTML = '<option value="">Nessun gruppo</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = friendsState.groups.map(g => {
    const isSelected = g.id === friendsState.activeGroupId ? 'selected' : '';
    const memberLabel = g.members_count === 1 ? '1 membro' : `${g.members_count} membri`;
    return `<option value="${escapeHtml(g.id)}" ${isSelected}>👥 ${escapeHtml(g.name)} (${memberLabel})</option>`;
  }).join('');
}

async function switchActiveGroup(groupId) {
  if (!groupId || groupId === friendsState.activeGroupId) return;
  friendsState.activeGroupId = groupId;
  localStorage.setItem(ACTIVE_GROUP_KEY, groupId);
  friendsState.events = [];
  friendsState.isLoading = true;
  renderFriendsView();

  await syncGroupCloud(groupId);
  await loadFriendsCalendar();
}

function openCreateGroupModal() {
  if (!profileState.shareCode) {
    showToast('Accedi o crea un profilo per creare un gruppo');
    openProfileModal();
    return;
  }
  const modal = document.getElementById('createGroupModal');
  if (modal) {
    modal.classList.add('active');
    const input = document.getElementById('createGroupNameInput');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
    const err = document.getElementById('createGroupError');
    if (err) err.style.display = 'none';
  }
}

function closeCreateGroupModal() {
  const modal = document.getElementById('createGroupModal');
  if (modal) modal.classList.remove('active');
}

async function confirmCreateGroup() {
  const input = document.getElementById('createGroupNameInput');
  const name = (input ? input.value : '').trim();
  const errEl = document.getElementById('createGroupError');

  if (errEl) errEl.style.display = 'none';
  if (!name) {
    if (errEl) { errEl.textContent = 'Inserisci un nome per il gruppo.'; errEl.style.display = ''; }
    return;
  }

  const btn = document.getElementById('btnConfirmCreateGroup');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Creazione in corso...'; }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (profileState.sessionToken) {
      headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
    }
    const resp = await fetch('/api/group', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'create_group',
        name,
        session_token: profileState.sessionToken
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (errEl) { errEl.textContent = data.error || 'Errore nella creazione del gruppo.'; errEl.style.display = ''; }
      return;
    }

    closeCreateGroupModal();
    friendsState.groups = data.groups || [];
    friendsState.groupInfo = data.group;
    friendsState.activeGroupId = data.group.id;
    localStorage.setItem(ACTIVE_GROUP_KEY, data.group.id);
    friendsState.friends = [];
    friendsState.events = [];

    renderGroupSwitcher();
    renderFriendChips();
    updateFriendsGroupHeader();
    loadFriendsCalendar();
    showToast(`🎉 Gruppo "${data.group.name}" creato! Codice: ${data.group.id}`, 5000);
  } catch (e) {
    if (errEl) { errEl.textContent = 'Errore di connessione.'; errEl.style.display = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

function openJoinGroupModal() {
  if (!profileState.shareCode) {
    showToast('Accedi o crea un profilo per unirti a un gruppo');
    openProfileModal();
    return;
  }
  const modal = document.getElementById('joinGroupModal');
  if (modal) {
    modal.classList.add('active');
    const input = document.getElementById('joinGroupCodeInput');
    if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
    const err = document.getElementById('joinGroupError');
    if (err) err.style.display = 'none';
  }
}

function closeJoinGroupModal() {
  const modal = document.getElementById('joinGroupModal');
  if (modal) modal.classList.remove('active');
}

async function confirmJoinGroup() {
  const input = document.getElementById('joinGroupCodeInput');
  const code = (input ? input.value : '').trim().toUpperCase();
  const errEl = document.getElementById('joinGroupError');

  if (errEl) errEl.style.display = 'none';
  if (code.length < 3) {
    if (errEl) { errEl.textContent = 'Inserisci un codice gruppo valido (es. G7K2P9).'; errEl.style.display = ''; }
    return;
  }

  const btn = document.getElementById('btnConfirmJoinGroup');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Accesso in corso...'; }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (profileState.sessionToken) {
      headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
    }
    const resp = await fetch('/api/group', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'join_group',
        group_id: code,
        session_token: profileState.sessionToken
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (errEl) { errEl.textContent = data.error || 'Codice gruppo non trovato.'; errEl.style.display = ''; }
      return;
    }

    closeJoinGroupModal();
    friendsState.groups = data.groups || [];
    friendsState.groupInfo = data.group;
    friendsState.activeGroupId = data.group.id;
    localStorage.setItem(ACTIVE_GROUP_KEY, data.group.id);

    const myCode = (profileState.shareCode || '').toUpperCase();
    const otherMembers = (data.members || []).filter(m => (m.share_code || m.id || '').toUpperCase() !== myCode);
    friendsState.friends = otherMembers.map((m, idx) => ({
      id:         m.share_code || m.id,
      share_code: m.share_code || m.id,
      nickname:   m.nickname || m.id,
      config:     m.config,
      color:      m.color || FRIENDS_COLORS[idx % FRIENDS_COLORS.length]
    }));

    friendsState.events = [];
    renderGroupSwitcher();
    renderFriendChips();
    updateFriendsGroupHeader();
    loadFriendsCalendar();
    showToast(`Ti sei unito al gruppo "${data.group.name}"! 🎉`);
  } catch (e) {
    if (errEl) { errEl.textContent = 'Errore di connessione.'; errEl.style.display = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

function openRenameGroupModal() {
  if (!friendsState.activeGroupId || !friendsState.groupInfo) {
    showToast('Nessun gruppo selezionato');
    return;
  }
  const modal = document.getElementById('renameGroupModal');
  if (modal) {
    modal.classList.add('active');
    const input = document.getElementById('renameGroupNameInput');
    if (input) {
      input.value = friendsState.groupInfo.name || '';
      setTimeout(() => input.focus(), 50);
    }
    const err = document.getElementById('renameGroupError');
    if (err) err.style.display = 'none';
  }
}

function closeRenameGroupModal() {
  const modal = document.getElementById('renameGroupModal');
  if (modal) modal.classList.remove('active');
}

async function confirmRenameGroup() {
  const input = document.getElementById('renameGroupNameInput');
  const newName = (input ? input.value : '').trim();
  const errEl = document.getElementById('renameGroupError');

  if (errEl) errEl.style.display = 'none';
  if (!newName) {
    if (errEl) { errEl.textContent = 'Inserisci un nome valido per il gruppo.'; errEl.style.display = ''; }
    return;
  }

  const btn = document.getElementById('btnConfirmRenameGroup');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Salvataggio...'; }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (profileState.sessionToken) {
      headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
    }
    const resp = await fetch('/api/group', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'rename_group',
        group_id: friendsState.activeGroupId,
        name: newName,
        session_token: profileState.sessionToken
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (errEl) { errEl.textContent = data.error || 'Errore nella rinomina.'; errEl.style.display = ''; }
      return;
    }

    closeRenameGroupModal();
    if (data.group) {
      friendsState.groupInfo = data.group;
    }
    if (data.groups) {
      friendsState.groups = data.groups;
    }
    renderGroupSwitcher();
    updateFriendsGroupHeader();
    showToast('Gruppo rinominato ✅');
  } catch (e) {
    if (errEl) { errEl.textContent = 'Errore di connessione.'; errEl.style.display = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

async function handleLeaveGroup() {
  if (!friendsState.activeGroupId || !friendsState.groupInfo) {
    showToast('Nessun gruppo selezionato');
    return;
  }
  const groupName = friendsState.groupInfo.name || 'questo gruppo';
  if (!confirm(`Sei sicuro di voler uscire da "${groupName}"?`)) {
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (profileState.sessionToken) {
      headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
    }
    const resp = await fetch('/api/group', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'leave_group',
        group_id: friendsState.activeGroupId,
        session_token: profileState.sessionToken
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      showToast(data.error || "Errore durante l'uscita dal gruppo");
      return;
    }

    friendsState.groups = data.groups || [];
    if (friendsState.groups.length > 0) {
      const nextGid = friendsState.groups[0].id;
      friendsState.activeGroupId = nextGid;
      localStorage.setItem(ACTIVE_GROUP_KEY, nextGid);
      await syncGroupCloud(nextGid);
      await loadFriendsCalendar();
    } else {
      friendsState.activeGroupId = null;
      friendsState.groupInfo = null;
      friendsState.friends = [];
      friendsState.events = [];
      localStorage.removeItem(ACTIVE_GROUP_KEY);
      renderGroupSwitcher();
      renderFriendChips();
      updateFriendsGroupHeader();
      renderFriendsView();
    }
    showToast(`Sei uscito dal gruppo "${groupName}"`);
  } catch (e) {
    showToast('Errore di connessione');
  }
}

function updateFriendsGroupHeader() {
  const titleEl = document.getElementById('friendsGroupTitle');
  const subEl   = document.getElementById('friendsGroupSubtitle');
  if (friendsState.groupInfo) {
    if (titleEl) titleEl.textContent = `👥 ${friendsState.groupInfo.name || 'Gruppo Studio'}`;
    const totalCount = friendsState.friends.length + 1;
    if (subEl) {
      subEl.innerHTML = `Codice Gruppo: <strong style="color:var(--accent-purple); font-family:monospace; letter-spacing:0.05em;">${escapeHtml(friendsState.groupInfo.id)}</strong> • ${totalCount} ${totalCount === 1 ? 'membro' : 'membri'}`;
    }
  } else {
    if (titleEl) titleEl.textContent = '👥 Calendario Gruppo';
    if (subEl) subEl.textContent = 'Confronta i vostri orari e trovate i momenti liberi in comune';
  }
}

function openAddFriendModal() {
  const modal = document.getElementById('addFriendModal');
  if (!modal) return;
  modal.classList.add('active');
  const input = document.getElementById('friendCodeInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }
  const prev = document.getElementById('friendCodePreview');
  if (prev) prev.style.display = 'none';
  const err = document.getElementById('friendCodeError');
  if (err) err.style.display = 'none';
  const confBtn = document.getElementById('btnConfirmAddFriendCode');
  if (confBtn) {
    confBtn.disabled = true;
    confBtn.textContent = '+ Aggiungi al gruppo';
    confBtn._foundProfile = null;
  }
}

function showFriendTab(tab) {
  const byCode = document.getElementById('friendByCode');
  const byName = document.getElementById('friendByName');
  const tabCode = document.getElementById('friendTabCode');
  const tabName = document.getElementById('friendTabName');
  if (byCode) byCode.style.display = tab === 'code' ? '' : 'none';
  if (byName) byName.style.display = tab === 'name' ? '' : 'none';
  if (tabCode) tabCode.classList.toggle('active', tab === 'code');
  if (tabName) tabName.classList.toggle('active', tab === 'name');
}

async function lookupFriendByCode() {
  const input   = document.getElementById('friendCodeInput');
  const code    = (input ? input.value : '').trim().toUpperCase();
  const errEl   = document.getElementById('friendCodeError');
  const prev    = document.getElementById('friendCodePreview');
  const confBtn = document.getElementById('btnConfirmAddFriendCode');

  if (errEl) errEl.style.display = 'none';
  if (prev) prev.style.display   = 'none';
  if (confBtn) {
    confBtn.disabled = true;
    confBtn.textContent = '+ Aggiungi al gruppo';
    confBtn._foundProfile = null;
  }

  if (code.length < 3) {
    if (errEl) {
      errEl.textContent   = 'Inserisci il codice calendario di un amico (es. K9X2P4) o di un gruppo (es. G7K2P9).';
      errEl.style.display = '';
    }
    return;
  }

  // Check not self
  if (profileState.shareCode && code === profileState.shareCode.toUpperCase()) {
    if (errEl) {
      errEl.textContent   = 'Questo è il tuo codice calendario!';
      errEl.style.display = '';
    }
    return;
  }

  // Check not already added
  if (friendsState.friends.some(f => (f.id || '').toUpperCase() === code || (f.share_code || '').toUpperCase() === code)) {
    if (errEl) {
      errEl.textContent   = 'Questo amico è già presente nel tuo gruppo.';
      errEl.style.display = '';
    }
    return;
  }

  const btn = document.getElementById('btnLookupFriendCode');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Ricerca in corso...';
  }

  try {
    // 1. Check if it's a Group ID first
    let isGroup = false;
    let groupData = null;
    try {
      const gResp = await fetch(`/api/group?id=${encodeURIComponent(code)}`);
      if (gResp.ok) {
        const gJson = await gResp.json();
        if (gJson && gJson.group) {
          isGroup = true;
          groupData = gJson;
        }
      }
    } catch (ge) {}

    if (isGroup && groupData) {
      const g = groupData.group;
      const count = (groupData.members || []).length;
      const nickEl = document.getElementById('friendCodePreviewNick');
      if (nickEl) nickEl.textContent = `Gruppo "${g.name}" (${count} ${count === 1 ? 'membro' : 'membri'})`;
      if (prev) prev.style.display = '';
      if (confBtn) {
        confBtn.disabled = false;
        confBtn.textContent = '🤝 Unisciti al gruppo';
        confBtn._foundProfile = { isGroup: true, group_id: g.id, group_name: g.name, members: groupData.members };
      }
      return;
    }

    // 2. Otherwise check if it's a Friend Calendar Code
    let resp = await fetch(`/api/profile?code=${encodeURIComponent(code)}`);
    if (!resp.ok) {
      resp = await fetch(`/api/profile?id=${encodeURIComponent(code)}`);
    }
    const data = await resp.json();
    if (!resp.ok) {
      if (errEl) {
        errEl.textContent   = data.error || 'Codice non trovato. Verifica il codice e riprova.';
        errEl.style.display = '';
      }
      return;
    }
    const friendCode = data.share_code || data.id || code;
    const nickname   = data.nickname || friendCode;
    const nickEl = document.getElementById('friendCodePreviewNick');
    if (nickEl) nickEl.textContent = `Amico: ${nickname}`;
    if (prev) prev.style.display = '';
    if (confBtn) {
      confBtn.disabled      = false;
      confBtn.textContent   = '+ Aggiungi al gruppo';
      confBtn._foundProfile = { isGroup: false, id: friendCode, nickname: nickname };
    }
  } catch (e) {
    if (errEl) {
      errEl.textContent   = 'Errore di connessione.';
      errEl.style.display = '';
    }
  } finally {
    if (btn) {
      btn.disabled    = false;
      btn.textContent = '🔍 Verifica codice';
    }
  }
}

function confirmAddFriendByCode() {
  const btn     = document.getElementById('btnConfirmAddFriendCode');
  const profile = btn ? btn._foundProfile : null;
  if (!profile) return;

  if (btn) {
    btn._foundProfile = null;
    btn.disabled = true;
    btn.textContent = '+ Aggiungi al gruppo';
  }

  const input = document.getElementById('friendCodeInput');
  if (input) input.value = '';
  const prev = document.getElementById('friendCodePreview');
  if (prev) prev.style.display = 'none';
  const err = document.getElementById('friendCodeError');
  if (err) err.style.display = 'none';

  if (!profileState.shareCode) {
    showToast("Nota: crea o accedi col tuo profilo per salvare i tuoi gruppi nel cloud!", 4500);
  }

  if (profile.isGroup) {
    handleJoinGroup(profile);
  } else {
    _addFriend({ id: profile.id, nickname: profile.nickname });
  }

  const modal = document.getElementById('addFriendModal');
  if (modal) modal.classList.remove('active');
}

async function handleJoinGroup(groupProfile) {
  const myCode = (profileState.shareCode || '').toUpperCase();
  if (myCode) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (profileState.sessionToken) {
        headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
      }
      const resp = await fetch('/api/group', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'join_group',
          user_code: myCode,
          group_id: groupProfile.group_id,
          session_token: profileState.sessionToken
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        friendsState.groups = data.groups || [];
      }
    } catch (e) {
      console.warn('Error joining group on server:', e);
    }
  }

  friendsState.groupInfo = { id: groupProfile.group_id, name: groupProfile.group_name };
  friendsState.activeGroupId = groupProfile.group_id;
  localStorage.setItem(ACTIVE_GROUP_KEY, groupProfile.group_id);

  friendsState.friends = (groupProfile.members || [])
    .filter(m => (m.share_code || m.id || '').toUpperCase() !== myCode)
    .map((m, idx) => ({
      id:         m.share_code || m.id,
      share_code: m.share_code || m.id,
      nickname:   m.nickname || m.id,
      config:     m.config,
      color:      m.color || FRIENDS_COLORS[idx % FRIENDS_COLORS.length]
    }));

  saveFriends(friendsState.friends);
  renderGroupSwitcher();
  renderFriendChips();
  updateFriendsGroupHeader();
  friendsState.events = [];
  loadFriendsCalendar();
  showToast(`Ti sei unito al gruppo "${groupProfile.group_name}"! 🎉`);
}

async function searchFriendByName() {
  // Retained for backward compatibility
}

function addFriendFromSearch(id, nickname) {
  if (friendsState.friends.some(f => (f.id || '').toUpperCase() === id.toUpperCase())) {
    showToast('Questo amico è già nel gruppo');
    return;
  }
  _addFriend({ id, nickname });
  const modal = document.getElementById('addFriendModal');
  if (modal) modal.classList.remove('active');
}

async function _addFriend({ id, nickname }) {
  if (friendsState.friends.some(f => (f.id || '').toUpperCase() === (id || '').toUpperCase())) {
    showToast(`${nickname} è già nel gruppo`);
    return;
  }

  // If no group is currently active, prompt or auto-create a new group with this friend
  if (!friendsState.activeGroupId) {
    if (!profileState.shareCode) {
      const colorIndex = friendsState.friends.length % FRIENDS_COLORS.length;
      const color      = FRIENDS_COLORS[colorIndex];
      friendsState.friends.push({ id, nickname, color });
      saveFriends(friendsState.friends);
      friendsState.events = [];
      renderFriendChips();
      showToast(`${nickname} aggiunto! Crea o accedi a un profilo per salvare il gruppo nel cloud ☁️`);
      loadFriendsCalendar();
      return;
    }
    // Create new group automatically for this friend
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (profileState.sessionToken) {
        headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
      }
      const cResp = await fetch('/api/group', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'create_group',
          name: `Gruppo con ${nickname}`,
          session_token: profileState.sessionToken
        })
      });
      if (cResp.ok) {
        const cData = await cResp.json();
        friendsState.groups = cData.groups || [];
        friendsState.groupInfo = cData.group;
        friendsState.activeGroupId = cData.group.id;
        localStorage.setItem(ACTIVE_GROUP_KEY, cData.group.id);
      }
    } catch (e) {
      console.warn('Auto create group error:', e);
    }
  }

  const colorIndex = friendsState.friends.length % FRIENDS_COLORS.length;
  const color      = FRIENDS_COLORS[colorIndex];
  friendsState.friends.push({ id, nickname, color });
  saveFriends(friendsState.friends);
  friendsState.events = [];
  renderFriendChips();
  showToast(`${nickname} aggiunto al gruppo! 🎉`);

  // Cloud sync to join friend to active group in Redis
  if (profileState.shareCode && friendsState.activeGroupId) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (profileState.sessionToken) {
        headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
      }
      const resp = await fetch('/api/group', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'add_member',
          group_id: friendsState.activeGroupId,
          friend_code: id.toUpperCase(),
          session_token: profileState.sessionToken
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.group) {
          friendsState.groupInfo = data.group;
          updateFriendsGroupHeader();
        }
        if (data && data.groups) {
          friendsState.groups = data.groups;
          renderGroupSwitcher();
        }
      }
    } catch (err) {
      console.warn('Cloud group add member error:', err);
    }
  }

  if (state.activeTab === 'friends') {
    loadFriendsCalendar();
  }
}

function removeFriend(id) {
  friendsState.friends = friendsState.friends.filter(f => f.id !== id);
  friendsState.friends.forEach((f, i) => { f.color = FRIENDS_COLORS[i % FRIENDS_COLORS.length]; });
  saveFriends(friendsState.friends);
  friendsState.events   = [];
  friendsState.myEvents = [];
  renderFriendChips();

  if (profileState.shareCode && friendsState.activeGroupId) {
    const headers = { 'Content-Type': 'application/json' };
    if (profileState.sessionToken) {
      headers['Authorization'] = `Bearer ${profileState.sessionToken}`;
    }
    fetch('/api/group', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'remove_member',
        group_id: friendsState.activeGroupId,
        remove_code: id.toUpperCase(),
        session_token: profileState.sessionToken
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data && data.group) {
        friendsState.groupInfo = data.group;
        updateFriendsGroupHeader();
      }
      if (data && data.groups) {
        friendsState.groups = data.groups;
        renderGroupSwitcher();
      }
    })
    .catch(err => console.warn('Cloud group remove member error:', err));
  }

  const hasFriends = friendsState.friends.length > 0;
  const hasMyself  = friendsState.showMyself && profileState.shareCode && state.config;
  if (hasFriends || hasMyself) {
    loadFriendsCalendar();
  } else {
    renderFriendsView();
  }
  showToast('Membro rimosso dal gruppo');
}

function renderFriendChips() {
  const container = document.getElementById('friendChips');
  if (!container) return;

  // Update group header
  updateFriendsGroupHeader();

  // Show/hide "Include me" row based on whether the user has a profile + config
  const myselfRow = document.getElementById('friendsMyselfRow');
  const hasProfile = Boolean(profileState.shareCode && state.config);
  if (myselfRow) myselfRow.style.display = hasProfile ? '' : 'none';

  // Sync the toggle button text to match current state
  const btnToggle = document.getElementById('btnToggleMyself');
  if (btnToggle) {
    btnToggle.classList.toggle('active', friendsState.showMyself);
    btnToggle.textContent = friendsState.showMyself ? '👤 Includi me' : '👤 Escludi me';
  }

  // Sync view mode buttons
  const btnViewCombined  = document.getElementById('btnFriendsViewCombined');
  const btnViewGrid      = document.getElementById('btnFriendsViewGrid');
  const btnViewFreeSlots = document.getElementById('btnFriendsViewFreeSlots');
  if (btnViewCombined)  btnViewCombined.classList.toggle('active', friendsState.viewMode === 'combined');
  if (btnViewGrid)      btnViewGrid.classList.toggle('active', friendsState.viewMode === 'grid');
  if (btnViewFreeSlots) btnViewFreeSlots.classList.toggle('active', friendsState.viewMode === 'freeSlots');

  const notLoggedInBanner = !profileState.shareCode
    ? `<div style="background:rgba(139,92,246,0.12); border:1px solid rgba(139,92,246,0.3); border-radius:10px; padding:8px 12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span style="font-size:0.78rem; color:var(--text-secondary);">👤 <strong style="color:#FFF;">Non hai ancora effettuato l'accesso?</strong> Accedi col tuo profilo per salvare il gruppo nel cloud e sincronizzarti all'istante con gli amici.</span>
        <button onclick="openProfileModal()" class="btn-primary" style="width:auto; padding:5px 12px; font-size:0.75rem; white-space:nowrap;">Accedi</button>
      </div>`
    : '';

  if (!friendsState.friends.length) {
    container.innerHTML = notLoggedInBanner + '<span style="color:var(--text-muted); font-size:0.8rem; line-height:32px;">Nessun amico nel gruppo — usa il pulsante + per aggiungere un amico o unirti a un gruppo</span>';
    return;
  }
  container.innerHTML = notLoggedInBanner + friendsState.friends.map(f => `
    <span class="friend-chip" style="background: ${hexToRgba(f.color, 0.18)}; border-color: ${hexToRgba(f.color, 0.4)};">
      <span class="friend-chip-dot" style="background:${f.color};"></span>
      <span style="overflow:hidden; text-overflow:ellipsis;">${escapeHtml(f.nickname)}</span>
      <button class="friend-chip-remove" onclick="removeFriend('${escapeHtml(f.id)}')" title="Rimuovi dal gruppo">✕</button>
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
  friendsState.isLoading = true;
  friendsState.myEvents  = [];
  renderFriendsView(); // shows spinner

  // If local friends list is empty, wait for cloud sync to pull members; otherwise sync in background
  const hasLocalFriends = friendsState.friends && friendsState.friends.length > 0;
  if (profileState.shareCode) {
    if (!hasLocalFriends) {
      await syncGroupCloud();
    } else {
      syncGroupCloud().catch(e => console.warn('Background syncGroupCloud error:', e));
    }
  }

  const hasFriends = friendsState.friends.length > 0;
  const hasMyself  = friendsState.showMyself && profileState.shareCode && state.config;

  if (!hasFriends && !hasMyself) {
    friendsState.isLoading = false;
    renderFriendsView();
    return;
  }

  const date = friendsState.currentMonday
    ? friendsState.currentMonday.split('-').join('-')
    : formatFormattedDate(getMonday(new Date()));

  // ── Parallel Fetch: Shared Friends Calendar + Own Calendar ──────────────────
  const fetchPromises = [];

  if (hasFriends) {
    const ids = friendsState.friends.map(f => f.share_code || f.id).join(',');
    fetchPromises.push(
      fetchJson(`/api/shared_calendar?ids=${encodeURIComponent(ids)}&date=${encodeURIComponent(date)}`)
        .catch(e => {
          console.warn('Friends calendar load error:', e);
          return { events: [], profiles: [] };
        })
    );
  } else {
    fetchPromises.push(Promise.resolve(null));
  }

  if (hasMyself) {
    const cfg = state.config;
    const calUrl = `/api/calendar?anno=${encodeURIComponent(cfg.anno)}&corso=${encodeURIComponent(cfg.corso)}&date=${encodeURIComponent(date)}` +
                   cfg.anni.map(a => `&anno2=${encodeURIComponent(a)}`).join('');
    fetchPromises.push(
      fetchJson(calUrl)
        .catch(e => {
          console.warn('Own calendar load error for friends view:', e);
          return null;
        })
    );
  } else {
    fetchPromises.push(Promise.resolve(null));
  }

  const [resp, calData] = await Promise.all(fetchPromises);

  if (resp) {
    friendsState.events = resp.events || [];
    (resp.profiles || []).forEach(p => {
      const pId = (p.share_code || p.id || '').toUpperCase();
      const local = friendsState.friends.find(f => (f.id || '').toUpperCase() === pId || (f.share_code || '').toUpperCase() === pId);
      if (local && p.color) local.color = p.color;
    });
    saveFriends(friendsState.friends);
  } else {
    friendsState.events = [];
  }

  if (calData && state.config) {
    const cfg = state.config;
    let myEvs = calData.events || [];
    const favCodes = new Set((cfg.favorites || []).map(f => (f.code || '').toUpperCase()).filter(Boolean));
    if (favCodes.size > 0) {
      myEvs = myEvs.filter(e => favCodes.has((e.course_code || '').toUpperCase()));
    }
    myEvs.forEach(ev => {
      ev.profile_id = 'MY_SELF';
      ev.nickname   = profileState.nickname || 'Io';
      ev.color      = '#2DD4BF';
    });
    friendsState.myEvents = myEvs;
  } else {
    friendsState.myEvents = [];
  }

  friendsState.isLoading = false;
  updateFriendsWeekLabel();
  renderFriendChips();
  renderFriendsView();
}

function changeFriendsWeek(offset) {
  const parts = (friendsState.currentMonday || formatFormattedDate(getMonday(new Date()))).split('-');
  const dt    = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  dt.setDate(dt.getDate() + offset);
  friendsState.currentMonday = formatFormattedDate(getMonday(dt));
  friendsState.events  = [];
  friendsState.myEvents = [];
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
    if (legend) legend.style.display = 'none';
    return;
  }

  spinner.style.display = 'none';

  const hasFriends = friendsState.friends.length > 0;
  const hasMyself  = friendsState.showMyself && profileState.shareCode && state.config && friendsState.myEvents.length > 0;

  if (!hasFriends && !hasMyself) {
    empty.style.display   = '';
    evtCont.style.display = 'none';
    if (legend) legend.style.display = 'none';
    return;
  }

  empty.style.display = 'none';

  // ── Build combined event list ───────────────────────────────────────────────
  const MY_COLOR = '#2DD4BF';
  const allEvents = [
    ...(hasMyself ? friendsState.myEvents : []),
    ...(hasFriends ? friendsState.events : [])
  ];

  // ── Render legend ───────────────────────────────────────────────────────────
  if (legend) {
    legend.style.display = '';
    let legendHtml = '';
    if (hasMyself) {
      legendHtml += `
        <div class="friends-legend-item">
          <span class="friends-legend-dot" style="background:${MY_COLOR};"></span>
          <span><strong>${escapeHtml(profileState.nickname || 'Io')}</strong> <span style="font-size:0.7rem;opacity:0.7;">(tu)</span></span>
        </div>`;
    }
    legendHtml += friendsState.friends.map(f => `
      <div class="friends-legend-item">
        <span class="friends-legend-dot" style="background:${f.color};"></span>
        <span>${escapeHtml(f.nickname)}</span>
      </div>
    `).join('');
    legend.innerHTML = legendHtml;
  }

  evtCont.style.display = '';

  // ── VIEW MODE: grid ─────────────────────────────────────────────────────────
  if (friendsState.viewMode === 'grid') {
    evtCont.innerHTML = renderFriendsGrid(allEvents, hasMyself, hasFriends);
    return;
  }

  // ── VIEW MODE: free slots ───────────────────────────────────────────────────
  if (friendsState.viewMode === 'freeSlots') {
    evtCont.innerHTML = renderFreeSlots(allEvents, hasMyself, hasFriends);
    return;
  }

  // ── VIEW MODE: combined list (default) ──────────────────────────────────────
  if (!allEvents.length) {
    evtCont.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding:24px 0;">Nessuna lezione trovata per questa settimana.</p>';
    return;
  }

  // Merge identical courses across multiple students
  const mergedEvents = mergeGroupEvents(allEvents);

  // Group by date, then sort by time within each day
  const byDate = {};
  mergedEvents.forEach(ev => {
    const d = ev.date || '';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(ev);
  });

  const toSortable = s => { const p = s.split('-'); return `${p[2]}-${p[1]}-${p[0]}`; };

  let html = '';
  Object.keys(byDate).sort((a, b) => toSortable(a).localeCompare(toSortable(b))).forEach(date => {
    const events = byDate[date].slice().sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    const dayLabel = events[0]?.day_name || formatDateItalianLong(dateFormattedToIso(date));
    html += `<div class="shared-date-group">📅 ${escapeHtml(dayLabel)} — ${escapeHtml(date.split('-').join('/'))}</div>`;
    events.forEach(ev => {
      const hasMe = ev.students.some(s => s.isMe);
      const primaryColor = hasMe ? MY_COLOR : (ev.students[0]?.color || '#8B5CF6');
      html += `
        <div class="shared-event-card${hasMe ? ' shared-event-card--me' : ''}" style="border-left-color:${primaryColor};">
          <div class="shared-event-header">
            <span class="shared-event-name">${escapeHtml(ev.course || '—')}</span>
            <div class="shared-event-tags">
              ${ev.students.map(s => `
                <span class="shared-event-owner" style="background:${hexToRgba(s.color, 0.25)}; border:1px solid ${hexToRgba(s.color, 0.5)}; color:${s.color};">
                  ${escapeHtml(s.nickname)}${s.isMe ? ' 👤' : ''}
                </span>
              `).join('')}
            </div>
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

/**
 * Merges events that represent the exact same lecture across multiple students.
 * Two events are identical if they occur on the same date, start_time, end_time,
 * and have the same course code or course name.
 */
function mergeGroupEvents(events) {
  const mergedMap = new Map();

  events.forEach(ev => {
    const d    = (ev.date || '').trim();
    const st   = (ev.start_time || '').trim();
    const et   = (ev.end_time || '').trim();
    const code = (ev.course_code || '').trim().toUpperCase();
    const name = (ev.course || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const courseKey = code || name;
    const key = `${d}_${st}_${et}_${courseKey}`;

    const studentInfo = {
      id: ev.profile_id,
      nickname: ev.nickname || (ev.profile_id === 'MY_SELF' ? 'Io' : 'Amico'),
      color: ev.color || '#8B5CF6',
      isMe: ev.profile_id === 'MY_SELF'
    };

    if (mergedMap.has(key)) {
      const existing = mergedMap.get(key);
      if (!existing.students.some(s => s.id === studentInfo.id)) {
        existing.students.push(studentInfo);
      }
      if (!existing.aula && ev.aula) existing.aula = ev.aula;
      if (!existing.docente && ev.docente) existing.docente = ev.docente;
    } else {
      mergedMap.set(key, {
        id: ev.id || key,
        date: d,
        day_name: ev.day_name || '',
        start_time: st,
        end_time: et,
        course: ev.course || '—',
        course_code: ev.course_code || '',
        aula: ev.aula || '',
        docente: ev.docente || '',
        is_canceled: ev.is_canceled || false,
        students: [studentInfo]
      });
    }
  });

  return Array.from(mergedMap.values());
}

/**
 * Visual Day Timeline Grid: 08:30 to 18:30
 * Renders lectures vertically according to their start/end times and places
 * overlapping different courses side by side in parallel lanes.
 */
function renderFriendsGrid(allEvents, hasMyself, hasFriends) {
  const START_MIN = 8 * 60 + 30;  // 510 = 08:30
  const END_MIN   = 18 * 60 + 30; // 1110 = 18:30
  const TOTAL_MIN = END_MIN - START_MIN; // 600 min

  const timeToMin = t => {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const minToTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // 1. Build week days (Mon-Fri + optional Sat)
  const parts = (friendsState.currentMonday || formatFormattedDate(getMonday(new Date()))).split('-');
  const mondayDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));

  const dayNamesShort = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  const dayNamesLong  = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
  const weekDays = [];

  for (let i = 0; i < 5; i++) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + i);
    const dStr = formatFormattedDate(d);
    weekDays.push({
      dateStr: dStr,
      nameShort: dayNamesShort[i],
      nameLong: dayNamesLong[i],
      dayNum: d.getDate(),
      monthShort: d.toLocaleDateString('it-IT', { month: 'short' }),
      isToday: dStr === formatFormattedDate(new Date())
    });
  }

  // Check if any event falls on Saturday
  const hasSaturday = allEvents.some(ev => {
    const p = (ev.date || '').split('-');
    if (p.length !== 3) return false;
    const d = new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
    return d.getDay() === 6;
  });
  if (hasSaturday) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + 5);
    const dStr = formatFormattedDate(d);
    weekDays.push({
      dateStr: dStr,
      nameShort: 'Sab',
      nameLong: 'Sabato',
      dayNum: d.getDate(),
      monthShort: d.toLocaleDateString('it-IT', { month: 'short' }),
      isToday: dStr === formatFormattedDate(new Date())
    });
  }

  // Ensure friendsState.selectedGridDate is valid
  if (!friendsState.selectedGridDate || !weekDays.some(w => w.dateStr === friendsState.selectedGridDate)) {
    const todayMatch = weekDays.find(w => w.isToday);
    friendsState.selectedGridDate = todayMatch ? todayMatch.dateStr : weekDays[0].dateStr;
  }

  const selectedDayInfo = weekDays.find(w => w.dateStr === friendsState.selectedGridDate) || weekDays[0];

  // 2. Day picker pills
  let pillsHtml = '<div class="friends-day-pills">';
  weekDays.forEach(w => {
    const isAct = w.dateStr === friendsState.selectedGridDate;
    const dayEvCount = allEvents.filter(e => e.date === w.dateStr).length;
    pillsHtml += `
      <button class="friends-day-pill${isAct ? ' active' : ''}" onclick="selectFriendsGridDay('${w.dateStr}')">
        <span class="day-pill-name">${w.nameShort}</span>
        <span class="day-pill-num">${w.dayNum}</span>
        ${dayEvCount > 0 
          ? `<span class="day-pill-dot" title="${dayEvCount} lezioni"></span>` 
          : `<span class="day-pill-dot free" title="Libero"></span>`}
        ${w.isToday ? '<span class="day-pill-today">Oggi</span>' : ''}
      </button>
    `;
  });
  pillsHtml += '</div>';

  // 3. Filter & Merge events for the selected day
  const rawDayEvents = allEvents.filter(e => e.date === friendsState.selectedGridDate);
  const dayEvents = mergeGroupEvents(rawDayEvents);

  // Compute start/end in minutes clamped to [START_MIN, END_MIN]
  const validEvents = [];
  dayEvents.forEach(ev => {
    const st = timeToMin(ev.start_time);
    const et = timeToMin(ev.end_time);
    if (!st || !et || et <= START_MIN || st >= END_MIN) return;

    const clampedStart = Math.max(START_MIN, st);
    const clampedEnd   = Math.min(END_MIN, et);
    if (clampedEnd <= clampedStart) return;

    validEvents.push({
      ...ev,
      origStart: st,
      origEnd: et,
      evStart: clampedStart,
      evEnd: clampedEnd,
      topPx: clampedStart - START_MIN,
      heightPx: Math.max(34, clampedEnd - clampedStart)
    });
  });

  // 4. Overlapping column layout algorithm
  validEvents.sort((a, b) => a.evStart - b.evStart || b.evEnd - a.evEnd);

  const clusters = [];
  let currentCluster = [];
  let clusterMaxEnd = -1;

  for (const ev of validEvents) {
    if (currentCluster.length === 0) {
      currentCluster.push(ev);
      clusterMaxEnd = ev.evEnd;
    } else if (ev.evStart < clusterMaxEnd) {
      currentCluster.push(ev);
      clusterMaxEnd = Math.max(clusterMaxEnd, ev.evEnd);
    } else {
      clusters.push(currentCluster);
      currentCluster = [ev];
      clusterMaxEnd = ev.evEnd;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  for (const cluster of clusters) {
    const columns = [];
    for (const ev of cluster) {
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        const lastInCol = columns[c][columns[c].length - 1];
        if (lastInCol.evEnd <= ev.evStart) {
          columns[c].push(ev);
          ev.colIndex = c;
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([ev]);
        ev.colIndex = columns.length - 1;
      }
    }
    const numCols = columns.length;
    for (const ev of cluster) {
      ev.numCols = numCols;
    }
  }

  // 5. Hour markers: 08:30 to 18:30 (every 60 min)
  const hourMarkers = [];
  for (let m = START_MIN; m <= END_MIN; m += 60) {
    hourMarkers.push({
      timeStr: minToTime(m),
      topPx: m - START_MIN
    });
  }

  // 6. Current time line (if selected day is today)
  let nowLineHtml = '';
  if (selectedDayInfo.isToday) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= START_MIN && nowMin <= END_MIN) {
      const nowTop = nowMin - START_MIN;
      nowLineHtml = `
        <div class="friends-grid-now" style="top:${nowTop}px;">
          <span class="friends-grid-now-badge">${minToTime(nowMin)}</span>
        </div>
      `;
    }
  }

  // 7. Render event cards on canvas
  let eventsHtml = '';
  if (validEvents.length === 0) {
    eventsHtml = `
      <div class="friends-grid-empty-banner">
        <div style="font-size:2rem; margin-bottom:6px;">🎉</div>
        <strong>Tutto il gruppo è libero ${selectedDayInfo.nameLong}!</strong>
        <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">Nessuna lezione in programma tra le 08:30 e le 18:30.</p>
      </div>
    `;
  } else {
    validEvents.forEach(ev => {
      const colWidthPercent = 100 / ev.numCols;
      const leftPercent     = ev.colIndex * colWidthPercent;
      const hasMe = ev.students.some(s => s.isMe);
      const primaryColor = hasMe ? '#2DD4BF' : (ev.students[0]?.color || '#8B5CF6');
      const isShort = ev.heightPx < 55;

      eventsHtml += `
        <div class="friends-grid-card${hasMe ? ' friends-grid-card--me' : ''}"
             style="top:${ev.topPx}px; height:${ev.heightPx}px; left:calc(${leftPercent}% + 2px); width:calc(${colWidthPercent}% - 4px); border-left-color:${primaryColor};"
             onclick="showFriendsEventDetail(this)"
             data-course="${escapeHtml(ev.course)}"
             data-time="${escapeHtml(ev.start_time)} – ${escapeHtml(ev.end_time)}"
             data-aula="${escapeHtml(ev.aula)}"
             data-docente="${escapeHtml(ev.docente)}"
             data-students="${escapeHtml(JSON.stringify(ev.students.map(s => s.nickname)))}">
          <div class="friends-grid-card-inner">
            <div class="friends-grid-card-tags">
              ${ev.students.map(s => `
                <span class="friends-grid-tag" style="background:${hexToRgba(s.color, 0.3)}; color:${s.color}; border:1px solid ${hexToRgba(s.color, 0.6)};">
                  ${escapeHtml(s.nickname)}${s.isMe ? ' 👤' : ''}
                </span>
              `).join('')}
            </div>
            <div class="friends-grid-card-title" title="${escapeHtml(ev.course)}">${escapeHtml(ev.course)}</div>
            <div class="friends-grid-card-time">🕐 ${escapeHtml(ev.start_time)}–${escapeHtml(ev.end_time)}</div>
            ${!isShort && ev.aula ? `<div class="friends-grid-card-room">📍 ${escapeHtml(ev.aula)}</div>` : ''}
            ${!isShort && ev.docente ? `<div class="friends-grid-card-prof">👩‍🏫 ${escapeHtml(ev.docente)}</div>` : ''}
          </div>
        </div>
      `;
    });
  }

  return `
    ${pillsHtml}
    
    <div class="friends-grid-header-info">
      <div>
        <strong style="color:var(--text-primary); font-size:0.95rem;">${selectedDayInfo.nameLong} ${selectedDayInfo.dayNum} ${selectedDayInfo.monthShort}</strong>
        <span style="font-size:0.75rem; color:var(--text-secondary); margin-left:8px;">08:30 – 18:30</span>
      </div>
      <span style="font-size:0.75rem; color:var(--text-muted);">${validEvents.length} ${validEvents.length === 1 ? 'lezione' : 'lezioni'}</span>
    </div>

    <div class="friends-grid-scroll-box">
      <div class="friends-grid-wrapper" style="height:${TOTAL_MIN}px;">
        <!-- Left Time Column -->
        <div class="friends-grid-times">
          ${hourMarkers.map(hm => `
            <div class="friends-grid-time-label" style="top:${hm.topPx}px;">
              ${hm.timeStr}
            </div>
          `).join('')}
        </div>

        <!-- Canvas with grid lines and cards -->
        <div class="friends-grid-canvas">
          ${hourMarkers.map(hm => `
            <div class="friends-grid-line" style="top:${hm.topPx}px;"></div>
          `).join('')}
          ${nowLineHtml}
          ${eventsHtml}
        </div>
      </div>
    </div>
  `;
}

function selectFriendsGridDay(dateStr) {
  friendsState.selectedGridDate = dateStr;
  renderFriendsView();
}
if (typeof window !== 'undefined') {
  window.selectFriendsGridDay = selectFriendsGridDay;
}

function showFriendsEventDetail(el) {
  if (!el) return;
  const course = el.dataset.course || '';
  const time = el.dataset.time || '';
  const aula = el.dataset.aula || '';
  const docente = el.dataset.docente || '';
  let students = [];
  try {
    students = JSON.parse(el.dataset.students || '[]');
  } catch (e) {}

  let lines = [`📚 ${course}`, `🕐 ${time}`];
  if (aula) lines.push(`📍 ${aula}`);
  if (docente) lines.push(`👩‍🏫 ${docente}`);
  if (students && students.length) {
    lines.push(`👥 Partecipanti: ${students.join(', ')}`);
  }

  showToast(lines.join('\n'));
}
if (typeof window !== 'undefined') {
  window.showFriendsEventDetail = showFriendsEventDetail;
}

/**
 * Compute and render the "free slots" view: time windows during the week
 * when EVERYONE in the group has no lectures scheduled.
 *
 * Windows are bounded strictly between 08:30 and 18:30.
 */
function renderFreeSlots(allEvents, hasMyself, hasFriends) {
  const UNIVERSITY_START = '08:30';
  const UNIVERSITY_END   = '18:30';
  const MIN_FREE_MINUTES = 30;

  const totalMembers = (hasMyself ? 1 : 0) + (hasFriends ? friendsState.friends.length : 0);

  if (totalMembers < 2) {
    return '<p style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding:24px 0;">Aggiungi almeno un amico per vedere gli slot liberi in comune.</p>';
  }

  const timeToMin = t => {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const minToTime = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const dayStart = timeToMin(UNIVERSITY_START); // 510 = 08:30
  const dayEnd   = timeToMin(UNIVERSITY_END);   // 1110 = 18:30

  // 1. Group busy intervals by date, clamping strictly to [dayStart, dayEnd]
  const busyByDate = {};
  allEvents.forEach(ev => {
    const d = ev.date || '';
    if (!d || !ev.start_time || !ev.end_time) return;
    const s = timeToMin(ev.start_time);
    const e = timeToMin(ev.end_time);
    const clampedStart = Math.max(dayStart, s);
    const clampedEnd   = Math.min(dayEnd, e);
    if (clampedStart < clampedEnd) {
      if (!busyByDate[d]) busyByDate[d] = [];
      busyByDate[d].push({ start: clampedStart, end: clampedEnd });
    }
  });

  // 2. Generate all week days (Mon-Fri + optional Sat) so days with zero lectures are shown as 100% free
  const parts = (friendsState.currentMonday || formatFormattedDate(getMonday(new Date()))).split('-');
  const mondayDate = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  const weekDates = [];

  for (let i = 0; i < 5; i++) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + i);
    weekDates.push(formatFormattedDate(d));
  }

  // If any event falls on Saturday, include Saturday
  const hasSaturday = allEvents.some(ev => {
    const p = (ev.date || '').split('-');
    if (p.length !== 3) return false;
    const d = new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
    return d.getDay() === 6;
  });
  if (hasSaturday) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + 5);
    weekDates.push(formatFormattedDate(d));
  }

  let html = `<div class="free-slots-intro">
    <span style="font-size:1.3rem;">🤝</span>
    <div>
      <strong>Slot liberi per tutto il gruppo (08:30 – 18:30)</strong><br>
      <span style="font-size:0.78rem; color:var(--text-secondary);">Fasce orarie in cui <em>tutti</em> sono senza lezioni — ottimi momenti per trovarsi e studiare insieme!</span>
    </div>
  </div>`;

  let foundAny = false;

  weekDates.forEach(date => {
    const intervals = busyByDate[date] || [];
    // Merge overlapping busy intervals
    intervals.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const iv of intervals) {
      if (merged.length && iv.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, iv.end);
      } else {
        merged.push({ ...iv });
      }
    }

    const freeSlots = [];
    let cursor = dayStart;
    for (const busy of merged) {
      if (busy.start > cursor && (busy.start - cursor) >= MIN_FREE_MINUTES) {
        freeSlots.push({ start: cursor, end: busy.start });
      }
      cursor = Math.max(cursor, busy.end);
    }
    if (dayEnd - cursor >= MIN_FREE_MINUTES) {
      freeSlots.push({ start: cursor, end: dayEnd });
    }

    if (!freeSlots.length) return;
    foundAny = true;

    const dayLabel = formatDateItalianLong(dateFormattedToIso(date));
    html += `<div class="free-slots-day-header">📌 ${escapeHtml(dayLabel)}</div>`;
    freeSlots.forEach(slot => {
      const duration = slot.end - slot.start;
      const durationStr = duration >= 60
        ? `${Math.floor(duration / 60)}h${duration % 60 > 0 ? duration % 60 + 'min' : ''}`
        : `${duration} min`;
      html += `
        <div class="free-slot-card">
          <div class="free-slot-time">🟢 ${minToTime(slot.start)} – ${minToTime(slot.end)}</div>
          <div class="free-slot-duration">${durationStr} liberi • tutti disponibili</div>
        </div>`;
    });
  });

  if (!foundAny) {
    html += '<p style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding:24px 0;">Nessuno slot libero comune trovato tra le 08:30 e le 18:30 😅</p>';
  }

  return html;
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
//  SHARED CALENDAR & FRIEND LINKS
// ══════════════════════════════════════════════════════════════

async function handleFriendShareUrl(friendCode) {
  const code = (friendCode || '').trim().toUpperCase();
  if (!code) return;

  // Immediately switch to the friends tab so the user sees the loading state there,
  // not a stuck spinner on the timetable view.
  switchTab('friends');
  friendsState.isLoading = true;
  renderFriendsView();

  try {
    let resp = await fetch(`/api/profile?code=${encodeURIComponent(code)}`);
    if (!resp.ok) {
      resp = await fetch(`/api/profile?id=${encodeURIComponent(code)}`);
    }
    const data = await resp.json();
    if (!resp.ok) {
      friendsState.isLoading = false;
      renderFriendsView();
      showToast('Codice calendario amico non valido o non trovato ❌');
      return;
    }

    const friendId = data.share_code || data.id || code;
    const nickname = data.nickname || friendId;

    if (profileState.shareCode && friendId.toUpperCase() === profileState.shareCode.toUpperCase()) {
      showToast('Questo è il tuo link calendario!');
      friendsState.isLoading = false;
      renderFriendsView();
    } else if (friendsState.friends.some(f => (f.id || '').toUpperCase() === friendId.toUpperCase())) {
      showToast(`${nickname} è già nel tuo calendario amici`);
      friendsState.isLoading = false;
      loadFriendsCalendar(); // reload to ensure view is current
    } else {
      // _addFriend handles saving and triggers loadFriendsCalendar (we set isLoading=false first)
      friendsState.isLoading = false;
      _addFriend({ id: friendId, nickname: nickname });
    }
  } catch (err) {
    console.error('Error fetching friend by link:', err);
    friendsState.isLoading = false;
    renderFriendsView();
    showToast('Errore nel caricamento del link amico');
  } finally {
    // Clean URL without reloading page
    history.replaceState(null, '', window.location.pathname);
  }
}

async function handleSharedGroupUrl(groupStr) {
  const clean = (groupStr || '').trim();
  if (!clean) return;

  // Switch to friends tab immediately so the user sees the loading state there
  switchTab('friends');
  friendsState.isLoading = true;
  friendsState.events    = [];
  friendsState.myEvents  = [];
  renderFriendsView();

  try {
    // 1. Check if it's a Cloud Group Code (e.g. ?group=G9X2P4 or single group code)
    if (!clean.includes(',')) {
      try {
        const gResp = await fetch(`/api/group?id=${encodeURIComponent(clean.toUpperCase())}`);
        if (gResp.ok) {
          const groupData = await gResp.json();
          if (groupData && groupData.group) {
            await handleJoinGroup({
              group_id:   groupData.group.id,
              group_name: groupData.group.name,
              members:    groupData.members
            });
            return;
          }
        }
      } catch (ge) {}
    }

    // 2. Otherwise treat as comma-separated friend codes
    const codes = clean.split(',')
      .map(i => i.trim().toUpperCase())
      .filter(i => /^[A-Z0-9_-]{3,40}$/i.test(i));

    if (!codes.length) return;

    // Fetch all group member profiles in parallel for speed
    const fetchPromises = codes.map(async code => {
      const isSelf = (profileState.shareCode && code === profileState.shareCode.toUpperCase()) ||
                     (profileState.nickname && code.toLowerCase() === profileState.nickname.toLowerCase());
      if (friendsState.friends.some(f => (f.id || '').toUpperCase() === code) || isSelf) return null;
      try {
        let resp = await fetch(`/api/profile?code=${encodeURIComponent(code)}`);
        if (!resp.ok) {
          resp = await fetch(`/api/profile?id=${encodeURIComponent(code)}`);
        }
        if (resp.ok) {
          const profile = await resp.json();
          const friendId   = profile.share_code || profile.id || code;
          const friendNick = profile.nickname || friendId;
          return { id: friendId, nickname: friendNick };
        }
      } catch (err) {
        console.warn('Error fetching group profile:', code, err);
      }
      return null;
    });

    const newFriends = (await Promise.all(fetchPromises)).filter(Boolean);
    for (const nf of newFriends) {
      await _addFriend(nf);
    }

    friendsState.isLoading = false;
    loadFriendsCalendar();
    if (newFriends.length > 0) {
      showToast('Gruppo amici caricato nel calendario! 🎉');
    }
  } finally {
    // Clean URL without reloading page
    history.replaceState(null, '', window.location.pathname);
  }
}

function shareFriendsGroup() {
  if (friendsState.groupInfo && friendsState.groupInfo.id) {
    const url = `${window.location.origin}/?group=${encodeURIComponent(friendsState.groupInfo.id)}`;
    if (navigator.share) {
      navigator.share({
        title: `Gruppo ${friendsState.groupInfo.name || 'Amici'} UNIMIB`,
        text: `Unisciti al gruppo "${friendsState.groupInfo.name || 'Amici'}" sul calendario UNIMIB! Codice gruppo: ${friendsState.groupInfo.id}`,
        url: url
      }).catch(err => {
        if (err.name !== 'AbortError') copyGroupUrlToClipboard(url);
      });
    } else {
      copyGroupUrlToClipboard(url);
    }
    return;
  }

  if (!friendsState.friends.length && !profileState.shareCode) {
    showToast('Aggiungi prima degli amici al calendario per condividere il gruppo');
    return;
  }
  const codes = [];
  if (profileState.shareCode) codes.push(profileState.shareCode);
  friendsState.friends.forEach(f => {
    const code = f.share_code || f.id;
    if (code && !codes.some(c => c.toUpperCase() === code.toUpperCase())) {
      codes.push(code);
    }
  });

  const url = `${window.location.origin}/?group=${codes.join(',')}`;

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
      showToast('Link copiato negli appunti! 📋');
    }).catch(() => {
      prompt('Copia questo link da inviare ai tuoi amici:', url);
    });
  } else {
    legacyCopy(url);
    showToast('Link copiato! 📋');
  }
}

// Auto-sync friends group when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeTab === 'friends' && !friendsState.isLoading) {
    loadFriendsCalendar();
  }
});
