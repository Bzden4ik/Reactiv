'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Ссылка на персонажа по умолчанию (можно поменять в «Настройки…» из трея)
const DEFAULT_URL = 'https://reactive.fugi.tech/basic/424904274900680715';

const PRESETS = [
  { name: 'Маленький', w: 250, h: 320 },
  { name: 'Средний', w: 400, h: 500 },
  { name: 'Большой', w: 600, h: 750 },
];

// CSS, который включается только в режиме перемещения: рамка + возможность таскать окно мышкой
const EDIT_CSS = `
  html, body, body * { -webkit-app-region: drag !important; cursor: move !important; }
  html { outline: 2px dashed rgba(167,139,250,.95) !important; outline-offset: -2px !important;
         background: rgba(20,20,32,.35) !important; }
`;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Чтобы анимация не «замирала», когда окно перекрыто другими окнами
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/* ---------------- конфиг ---------------- */

const cfgPath = path.join(app.getPath('userData'), 'config.json');
const defaults = {
  url: DEFAULT_URL,
  width: 400,
  height: 500,
  x: null,
  y: null,
  alwaysOnTop: true,
  autostart: false,
  opacity: 1,
  mirror: 'auto',        // 'auto' — лицом к центру экрана, 'off' — не поворачивать, 'on' — всегда отзеркалить
  mirrorInvert: false,   // поменять направление авто-поворота (если исходный персонаж смотрит влево)
};

function loadCfg() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}
function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить конфиг:', e);
  }
}

let cfg = loadCfg();
let win = null;
let settingsWin = null;
let tray = null;
let editMode = false;
let cssKey = null;
let mirrored = null; // текущее состояние отзеркаливания внутри страницы (null — ещё не применяли)
let saveTimer = null;
let retryTimer = null;
let restoreTimer = null;
let displayChangeUntil = 0; // пока игра меняет разрешение, позицию окна не сохраняем

/* ---------------- утилиты ---------------- */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function onScreen(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 &&
           b.y < a.y + a.height - 40 && b.y + b.height > a.y + 40;
  });
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  if (Date.now() < displayChangeUntil) return; // позиция «поплыла» из-за смены разрешения
  const b = win.getBounds();
  cfg.x = b.x; cfg.y = b.y; cfg.width = b.width; cfg.height = b.height;
  saveCfg();
}

function applyAutostart() {
  if (!app.isPackaged) return; // в режиме разработки не трогаем автозапуск
  app.setLoginItemSettings({ openAtLogin: !!cfg.autostart });
}

/* ---------------- поворот персонажа ---------------- */

// Нужно ли сейчас отзеркалить персонажа
function wantMirror() {
  if (!win || win.isDestroyed()) return false;
  if (cfg.mirror === 'on') return true;
  if (cfg.mirror === 'off') return false;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const onRight = b.x + b.width / 2 > d.bounds.x + d.bounds.width / 2;
  // По умолчанию считаем, что персонаж смотрит вправо: на правой половине экрана — отзеркаливаем,
  // чтобы он смотрел влево, к центру. «mirrorInvert» меняет это на противоположное.
  return cfg.mirrorInvert ? !onRight : onRight;
}

function applyMirror(force = false) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) return; // применится в did-finish-load
  const m = wantMirror();
  if (!force && m === mirrored) return;
  const first = mirrored === null; // при первой установке — без анимации разворота
  mirrored = m;
  const js = `(() => {
    const s = document.documentElement.style;
    ${first ? '' : "s.setProperty('transition', 'transform .2s ease', 'important');"}
    s.setProperty('min-height', '100vh', 'important');
    s.setProperty('transform-origin', '50% 0', 'important');
    s.setProperty('transform', '${m ? 'scaleX(-1)' : 'none'}', 'important');
  })()`;
  win.webContents.executeJavaScript(js).catch(() => { /* страница ещё не готова */ });
}

/* ---------------- «поверх всех окон» ---------------- */

function raise() {
  if (!win || win.isDestroyed() || !win.isVisible() || !cfg.alwaysOnTop) return;
  if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop(); // игры в «окне без рамки» тоже становятся topmost — перебиваем их
}

// Игра может сменить разрешение монитора — Windows при этом двигает/ужимает окна.
// Ждём, пока всё устаканится, и возвращаем персонажа на сохранённое место.
function onDisplayChange() {
  displayChangeUntil = Date.now() + 4000;
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = { x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height };
    if (b.x != null && b.y != null && onScreen(b)) win.setBounds(b);
    applyMirror();
    raise();
  }, 2500);
}

/* ---------------- окно персонажа ---------------- */

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = { width: cfg.width, height: cfg.height, x: cfg.x, y: cfg.y };
  if (b.x == null || b.y == null || !onScreen(b)) {
    b.x = wa.x + wa.width - b.width - 24;
    b.y = wa.y + wa.height - b.height - 24;
  }

  win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(!!cfg.alwaysOnTop, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // клики проходят «сквозь» персонажа
  win.setMenuBarVisibility(false);

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!/^https:/i.test(url)) e.preventDefault(); });
  wc.on('did-finish-load', () => {
    cssKey = null;
    mirrored = null;
    applyMirror(true);
    refreshCss();
  });
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = отмена загрузки
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(cfg.url); }, 5000);
  });

  win.on('move', () => {
    applyMirror(); // сразу разворачиваем, как только окно пересекло середину экрана
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  });
  win.on('closed', () => { win = null; });

  win.loadURL(cfg.url);
  win.showInactive();
}

async function refreshCss() {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isLoading()) return; // применится в did-finish-load
  if (cssKey) {
    try { await wc.removeInsertedCSS(cssKey); } catch { /* страница уже другая */ }
    cssKey = null;
  }
  let css = '';
  if (cfg.opacity < 1) css += `html { opacity: ${cfg.opacity} !important; }`;
  if (editMode) css += EDIT_CSS;
  if (css) {
    try { cssKey = await wc.insertCSS(css); } catch { /* ignore */ }
  }
}

async function setEditMode(on) {
  editMode = !!on;
  if (!win || win.isDestroyed()) return;
  if (editMode) {
    if (!win.isVisible()) win.showInactive();
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.moveTop();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    saveBounds();
  }
  await refreshCss();
  rebuildMenu();
}

function setSize(w, h) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const nw = clamp(Math.round(w), 120, 3000);
  const nh = clamp(Math.round(h), 120, 3000);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  win.setBounds({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), width: nw, height: nh });
  applyMirror();
  saveBounds();
}

function scaleWindow(factor) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  setSize(b.width * factor, b.height * factor);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide(); else { win.showInactive(); raise(); }
  rebuildMenu();
}

function reload() {
  if (win && !win.isDestroyed()) win.loadURL(cfg.url);
}

/* ---------------- настройки ---------------- */

function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Reactive Avatar — настройки',
    backgroundColor: '#16161d',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.setAlwaysOnTop(true, 'screen-saver'); // иначе оверлей может перекрыть окно настроек
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('settings:get', (e) => {
  if (!settingsWin || e.sender !== settingsWin.webContents) return null;
  return { url: cfg.url, width: cfg.width, height: cfg.height };
});

ipcMain.handle('settings:save', (e, data) => {
  if (!settingsWin || e.sender !== settingsWin.webContents) return { ok: false, error: 'denied' };

  let url;
  try { url = new URL(String(data && data.url).trim()); } catch { return { ok: false, error: 'Некорректная ссылка' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'Ссылка должна начинаться с https://' };

  const w = parseInt(data.width, 10);
  const h = parseInt(data.height, 10);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return { ok: false, error: 'Укажите размер числами' };

  const urlChanged = cfg.url !== url.toString();
  cfg.url = url.toString();
  saveCfg();
  setSize(w, h);
  if (urlChanged) reload();
  return { ok: true };
});

ipcMain.on('settings:close', (e) => {
  if (settingsWin && e.sender === settingsWin.webContents) settingsWin.close();
});

/* ---------------- трей ---------------- */

function setMirrorMode(mode) {
  cfg.mirror = mode;
  saveCfg();
  applyMirror();
  rebuildMenu();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Режим перемещения (Ctrl+Alt+M)', type: 'checkbox', checked: editMode, click: () => setEditMode(!editMode) },
    { label: 'Показать / скрыть (Ctrl+Alt+H)', click: toggleVisible },
    { type: 'separator' },
    {
      label: 'Размер',
      submenu: [
        { label: 'Больше (Ctrl+Alt+=)', click: () => scaleWindow(1.1) },
        { label: 'Меньше (Ctrl+Alt+-)', click: () => scaleWindow(1 / 1.1) },
        { type: 'separator' },
        ...PRESETS.map((p) => ({ label: `${p.name} (${p.w}×${p.h})`, click: () => setSize(p.w, p.h) })),
      ],
    },
    {
      label: 'Поворот персонажа',
      submenu: [
        { label: 'Авто — лицом к центру экрана', type: 'radio', checked: cfg.mirror === 'auto', click: () => setMirrorMode('auto') },
        { label: 'Не поворачивать', type: 'radio', checked: cfg.mirror === 'off', click: () => setMirrorMode('off') },
        { label: 'Всегда отзеркалить', type: 'radio', checked: cfg.mirror === 'on', click: () => setMirrorMode('on') },
        { type: 'separator' },
        {
          label: 'Поменять направление авто-поворота',
          type: 'checkbox',
          checked: !!cfg.mirrorInvert,
          click: (item) => { cfg.mirrorInvert = item.checked; saveCfg(); applyMirror(); },
        },
      ],
    },
    {
      label: 'Прозрачность',
      submenu: [1, 0.8, 0.6, 0.4].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: cfg.opacity === v,
        click: () => { cfg.opacity = v; saveCfg(); refreshCss(); },
      })),
    },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: !!cfg.alwaysOnTop,
      click: (item) => {
        cfg.alwaysOnTop = item.checked;
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(item.checked, 'screen-saver');
        saveCfg();
      },
    },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: !!cfg.autostart,
      click: (item) => { cfg.autostart = item.checked; applyAutostart(); saveCfg(); },
    },
    { type: 'separator' },
    { label: 'Настройки… (ссылка, размер)', click: openSettings },
    { label: 'Перезагрузить персонажа (Ctrl+Alt+R)', click: reload },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]);
}

function rebuildMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Reactive Avatar — клик: режим перемещения вкл/выкл');
  tray.on('click', () => setEditMode(!editMode));
  rebuildMenu();
}

/* ---------------- запуск ---------------- */

function registerHotkeys() {
  const map = {
    'CommandOrControl+Alt+M': () => setEditMode(!editMode),
    'CommandOrControl+Alt+H': toggleVisible,
    'CommandOrControl+Alt+R': reload,
    'CommandOrControl+Alt+=': () => scaleWindow(1.1),
    'CommandOrControl+Alt+numadd': () => scaleWindow(1.1),
    'CommandOrControl+Alt+-': () => scaleWindow(1 / 1.1),
    'CommandOrControl+Alt+numsub': () => scaleWindow(1 / 1.1),
  };
  for (const [key, fn] of Object.entries(map)) {
    try { globalShortcut.register(key, fn); } catch { /* сочетание занято другим приложением */ }
  }
}

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
  );
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

  createWindow();
  createTray();
  registerHotkeys();
  applyAutostart();

  setInterval(raise, 1000);
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  try {
    tray.displayBalloon({
      title: 'Reactive Avatar запущен',
      content: 'Ctrl+Alt+M — двигать персонажа, клик по значку в трее — то же самое.',
    });
  } catch { /* не Windows */ }
});

app.on('second-instance', () => {
  if (win && !win.isDestroyed() && !win.isVisible()) { win.showInactive(); raise(); }
});

app.on('window-all-closed', () => { /* живём в трее */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
