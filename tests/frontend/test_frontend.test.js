const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appJsPath = fs.existsSync(path.join(__dirname, '../../public/js/app.js'))
  ? path.join(__dirname, '../../public/js/app.js')
  : path.join(__dirname, '../public/js/app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

// Full mock environment for app.js
const mockElement = () => ({
  addEventListener: () => {},
  removeEventListener: () => {},
  setAttribute: () => {},
  removeAttribute: () => {},
  getAttribute: () => null,
  classList: {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false
  },
  style: {},
  children: [],
  childNodes: [],
  appendChild: () => {},
  removeChild: () => {},
  innerHTML: '',
  textContent: '',
  value: ''
});

const sandbox = {
  window: {},
  document: {
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => mockElement(),
    querySelector: () => mockElement(),
    querySelectorAll: () => [],
    createElement: () => mockElement(),
    documentElement: mockElement(),
    body: mockElement()
  },
  navigator: { onLine: true, serviceWorker: { register: () => Promise.resolve() } },
  localStorage: {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
    clear() { this._data = {}; }
  },
  sessionStorage: {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; }
  },
  location: { search: '', href: 'http://localhost/', pathname: '/' },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  RegExp,
  JSON,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent
};
sandbox.window = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(appJsCode, context, { filename: appJsPath });

test('detectAreaColor maps degrees and keywords to correct colors', () => {
  const detectAreaColor = sandbox.detectAreaColor;
  assert.ok(typeof detectAreaColor === 'function');
  
  // Informatica -> scientifica (#00753B)
  assert.strictEqual(detectAreaColor('Informatica'), '#00753B');
  // Medicina -> medica (#D83424)
  assert.strictEqual(detectAreaColor('Medicina e Chirurgia'), '#D83424');
  // Economia -> economica (#E5C200)
  assert.strictEqual(detectAreaColor('Economia Aziendale'), '#E5C200');
  // Giurisprudenza -> giuridica (#005096)
  assert.strictEqual(detectAreaColor('Giurisprudenza'), '#005096');
  // Unknown -> null
  assert.strictEqual(detectAreaColor('Corso Sconosciuto'), null);
  assert.strictEqual(detectAreaColor(null), null);
});

test('extractBuildingCode and getBuildingMapUrl handle UNIMIB buildings U1-U28', () => {
  const extractBuildingCode = sandbox.extractBuildingCode;
  const getBuildingMapUrl = sandbox.getBuildingMapUrl;

  assert.strictEqual(extractBuildingCode('Aula U1-01'), 'U1');
  assert.strictEqual(extractBuildingCode('U07 Laboratorio'), 'U7');
  assert.strictEqual(extractBuildingCode('Aula U24/02'), 'U24');
  assert.strictEqual(extractBuildingCode('Edificio U14'), 'U14');
  assert.strictEqual(extractBuildingCode('Nessuna aula'), null);

  const mapU1 = getBuildingMapUrl('U1');
  assert.ok(mapU1.includes('google.com/maps'));
  assert.ok(mapU1.includes('Piazza%20della%20Scienza'));

  const mapU7 = getBuildingMapUrl('U7');
  assert.ok(mapU7.includes('google.com/maps'));
});

test('escapeHtml prevents XSS injection', () => {
  const escapeHtml = sandbox.escapeHtml;
  assert.strictEqual(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.strictEqual(escapeHtml("Tom & Jerry's"), 'Tom &amp; Jerry&#39;s');
  assert.strictEqual(escapeHtml(''), '');
  assert.strictEqual(escapeHtml(null), '');
});

test('Date utilities: getMonday, formatFormattedDate, formatDateIso, parseAnyDate', () => {
  const getMonday = sandbox.getMonday;
  const formatFormattedDate = sandbox.formatFormattedDate;
  const formatDateIso = sandbox.formatDateIso;
  const parseAnyDate = sandbox.parseAnyDate;
  const dateFormattedToIso = sandbox.dateFormattedToIso;

  // 2026-10-07 is Wednesday
  const wed = new Date(2026, 9, 7);
  const mon = getMonday(wed);
  assert.strictEqual(mon.getDay(), 1); // Monday
  assert.strictEqual(formatFormattedDate(mon), '05-10-2026');
  assert.strictEqual(formatDateIso(mon), '2026-10-05');

  // parseAnyDate
  const parsed1 = parseAnyDate('05-10-2026');
  assert.strictEqual(parsed1.getDate(), 5);
  assert.strictEqual(parsed1.getMonth(), 9);
  assert.strictEqual(parsed1.getFullYear(), 2026);

  const parsed2 = parseAnyDate('2026-10-05');
  assert.strictEqual(parsed2.getDate(), 5);

  // dateFormattedToIso
  assert.strictEqual(dateFormattedToIso('05-10-2026'), '2026-10-05');
});

test('formatDateItalianLong and formatDateItalianShort produce valid Italian dates', () => {
  const formatDateItalianLong = sandbox.formatDateItalianLong;
  const formatDateItalianShort = sandbox.formatDateItalianShort;

  const d = new Date(2026, 9, 5); // 5 Ottobre 2026 (Lunedì)
  const longStr = formatDateItalianLong(d);
  assert.ok(longStr.toLowerCase().includes('lunedì'));
  assert.ok(longStr.toLowerCase().includes('ottobre'));
  assert.ok(longStr.includes('2026'));

  const shortStr = formatDateItalianShort(d);
  assert.strictEqual(shortStr, '05/10/2026');
});

test('hexToRgba converts hex colors to rgba string without spaces', () => {
  const hexToRgba = sandbox.hexToRgba;
  assert.strictEqual(hexToRgba('#3B82F6', 0.5), 'rgba(59,130,246,0.5)');
  assert.strictEqual(hexToRgba('#000000', 1), 'rgba(0,0,0,1)');
});

test('addHoursToTime handles hour calculations correctly', () => {
  const addHoursToTime = sandbox.addHoursToTime;
  assert.strictEqual(addHoursToTime('08:30', 2), '10:30');
  assert.strictEqual(addHoursToTime('22:00', 1), '23:00');
  assert.strictEqual(addHoursToTime('23:00', 1), '23:00'); // capped at 23
});

test('normalizeSearchText cleans diacritics and trims text', () => {
  const normalizeSearchText = sandbox.normalizeSearchText;
  assert.strictEqual(normalizeSearchText('Lunedì'), 'lunedi');
  assert.strictEqual(normalizeSearchText('   ANALISI   '), 'analisi');
  assert.strictEqual(normalizeSearchText(''), '');
});

test('generateChangesHash creates deterministic signatures', () => {
  const generateChangesHash = sandbox.generateChangesHash;
  const changesA = [
    { type: 'modified', event: { id: 'ev1', course: 'Analisi 1' } },
    { type: 'cancelled', event: { id: 'ev2', course: 'Fisica' } }
  ];
  const changesB = [
    { type: 'modified', event: { id: 'ev1', course: 'Analisi 1' } },
    { type: 'cancelled', event: { id: 'ev2', course: 'Fisica' } }
  ];
  assert.strictEqual(generateChangesHash(changesA), generateChangesHash(changesB));
});

test('getExamDateRange returns valid date ranges for sessions', () => {
  const getExamDateRange = sandbox.getExamDateRange;
  const winter = getExamDateRange('winter');
  assert.ok(winter.from);
  assert.ok(winter.to);

  const summer = getExamDateRange('summer');
  assert.ok(summer.from);
  assert.ok(summer.to);

  const autumn = getExamDateRange('autumn');
  assert.ok(autumn.from);
  assert.ok(autumn.to);
});

test('isFavorite checks whether an event matches marked favorite colors', () => {
  const isFavorite = sandbox.isFavorite;
  const appState = vm.runInContext('state', context);
  appState.favoriteColors = {
    'INF101': '#DC2626'
  };
  assert.strictEqual(isFavorite({ course_code: 'INF101' }), true);
  assert.strictEqual(isFavorite({ course_code: 'INF999' }), false);
  assert.strictEqual(isFavorite({}), false);
});

test('choiceItemHtml generates accessible markup for checkboxes', () => {
  const choiceItemHtml = sandbox.choiceItemHtml;
  const html = choiceItemHtml('val1', 'Label 1', 'Hint text', true);
  assert.ok(html.includes('value="val1"'));
  assert.ok(html.includes('checked'));
  assert.ok(html.includes('Label 1'));
  assert.ok(html.includes('Hint text'));
});

test('safeHtmlTag template literal sanitizes dynamic variables against XSS', () => {
  const safeHtmlTag = sandbox.safeHtmlTag;
  assert.ok(typeof safeHtmlTag === 'function');
  const userContent = '<script>alert("xss")</script>';
  const res = safeHtmlTag`<div class="test">${userContent}</div>`;
  assert.strictEqual(res, '<div class="test">&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>');

  // Supports pre-sanitized __isSafeHtml objects
  const safeObj = { __isSafeHtml: true, content: '<span>Safe</span>' };
  const res2 = safeHtmlTag`<div>${safeObj}</div>`;
  assert.strictEqual(res2, '<div><span>Safe</span></div>');
});

test('announceA11y updates live region element text content asynchronously', (t, done) => {
  const announceA11y = sandbox.announceA11y;
  assert.ok(typeof announceA11y === 'function');

  let announcerEl = { textContent: '' };
  sandbox.document.getElementById = (id) => {
    if (id === 'a11yAnnouncer') return announcerEl;
    return mockElement();
  };

  announceA11y('Filtri aggiornati con successo');
  setTimeout(() => {
    assert.strictEqual(announcerEl.textContent, 'Filtri aggiornati con successo');
    done();
  }, 100);
});

test('highlightMatch safely highlights queries without corrupting HTML entities', () => {
  const highlightMatch = sandbox.highlightMatch;
  assert.ok(typeof highlightMatch === 'function');

  // Matches query and wraps in <mark>
  const res1 = highlightMatch('Programmazione 1', 'programma');
  assert.strictEqual(res1, '<mark class="search-highlight">Programma</mark>zione 1');

  // Safe against ampersands without creating broken entities
  const res2 = highlightMatch('Economia & Finanza', '&');
  assert.strictEqual(res2, 'Economia <mark class="search-highlight">&amp;</mark> Finanza');

  // Regex special characters in query are escaped
  const res3 = highlightMatch('Fisica (Canale A)', '(Canale A)');
  assert.strictEqual(res3, 'Fisica <mark class="search-highlight">(Canale A)</mark>');

  // Null or empty handling
  assert.strictEqual(highlightMatch('', 'query'), '');
  assert.strictEqual(highlightMatch('Test', ''), 'Test');
});

test('renderBuildingBadgeHtml generates valid campus map badge markup', () => {
  const renderBuildingBadgeHtml = sandbox.renderBuildingBadgeHtml;
  assert.ok(typeof renderBuildingBadgeHtml === 'function');

  // Valid building code
  const htmlU1 = renderBuildingBadgeHtml('Aula U1-02');
  assert.ok(htmlU1.includes('building-badge'));
  assert.ok(htmlU1.includes('U1'));
  assert.ok(htmlU1.includes('google.com/maps'));

  // Building without code returns empty string
  const empty = renderBuildingBadgeHtml('Aula Magna Esterna');
  assert.strictEqual(empty, '');
});

test('debounce delays function execution until wait interval expires', (t, done) => {
  const debounce = sandbox.debounce;
  assert.ok(typeof debounce === 'function');

  let callCount = 0;
  const debouncedFn = debounce(() => {
    callCount++;
  }, 50);

  debouncedFn();
  debouncedFn();
  debouncedFn();
  assert.strictEqual(callCount, 0);

  setTimeout(() => {
    assert.strictEqual(callCount, 1);
    done();
  }, 80);
});

test('safeLoadConfig retrieves valid config and recovers from corrupt storage safely', () => {
  const safeLoadConfig = sandbox.safeLoadConfig;
  const configKey = 'unimib_config';

  // 1. Valid config
  const validCfg = {
    anno: '2026',
    corso: 'F1801Q',
    anni: ['1'],
    favorites: [{ code: 'INF101' }]
  };
  sandbox.localStorage.setItem(configKey, JSON.stringify(validCfg));
  const loaded = safeLoadConfig();
  assert.strictEqual(loaded.corso, 'F1801Q');
  assert.strictEqual(loaded.favorites.length, 1);

  // 2. Corrupt JSON in localStorage
  sandbox.localStorage.setItem(configKey, '{corrupted-json:');
  const fallback = safeLoadConfig();
  assert.strictEqual(fallback, null);
  // Backup was created
  assert.ok(sandbox.localStorage.getItem('unimib_config_backup'));
});

