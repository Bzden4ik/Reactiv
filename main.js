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

// Границы значений парения и полёта: всё, что приходит из настроек или config.json, зажимается в них
const MOTION_RANGES = {
  floatAmp: [0, 120],        // размах парения вверх-вниз, px
  floatPeriod: [1, 12],      // один цикл вверх-вниз, сек
  roamSpeed: [20, 800],      // скорость полёта, px/сек
  roamPauseChance: [0, 100], // шанс задержаться на месте после перелёта, %
  roamPauseMin: [0, 60],     // на сколько задерживается — от, сек
  roamPauseMax: [0, 120],    // на сколько задерживается — до, сек
  evadeRadius: [60, 600],    // на каком расстоянии от курсора персонаж начинает убегать, px
  evadeDistance: [20, 500],  // на сколько отлетает за один рывок, px
  evadeSpeed: [20, 800],     // скорость убегания, px/сек
};
const MOTION_BOOLS = ['float', 'roam', 'roamFaceDirection', 'evade', 'evadeOrbit', 'clickFx'];
const MOTION_KEYS = [...Object.keys(MOTION_RANGES), ...MOTION_BOOLS];

// Оставляет в patch только известные настройки движения с допустимыми значениями
function sanitizeMotion(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(MOTION_RANGES)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n)) continue;
    const v = Math.min(hi, Math.max(lo, n));
    out[k] = k === 'floatPeriod' ? Math.round(v * 10) / 10 : Math.round(v);
  }
  for (const k of MOTION_BOOLS) {
    if (typeof patch[k] === 'boolean') out[k] = patch[k];
  }
  return out;
}

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

  float: true,             // парение вверх-вниз
  floatAmp: 12,            // размах парения, px
  floatPeriod: 3.5,        // один цикл вверх-вниз, сек
  roam: false,             // полёт по всему экрану
  roamSpeed: 140,          // скорость полёта, px/сек
  roamPauseChance: 60,     // шанс задержаться на месте после перелёта, %
  roamPauseMin: 4,         // задерживается не меньше, сек
  roamPauseMax: 12,        // …и не дольше, сек
  roamFaceDirection: true, // в полёте смотреть в сторону движения (вместо «лицом к центру экрана»)

  evade: false,            // убегать от курсора
  evadeRadius: 200,        // начинает убегать, когда курсор ближе, px
  evadeDistance: 150,      // за один рывок отлетает не дальше, px
  evadeSpeed: 70,          // скорость убегания, px/сек
  evadeOrbit: true,        // если прижат к краю экрана — облетать курсор по дуге
  clickFx: true,           // пружинка и блёстки при клике по персонажу
};

function loadCfg() {
  let c;
  try {
    c = { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  } catch {
    c = { ...defaults };
  }
  // Значения движения из старого или испорченного конфига: годные зажимаем в границы, негодные — по умолчанию
  const ok = sanitizeMotion(c);
  for (const k of MOTION_KEYS) c[k] = k in ok ? ok[k] : defaults[k];
  if (c.roamPauseMax < c.roamPauseMin) c.roamPauseMax = c.roamPauseMin;
  return c;
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
let displayChanging = false; // …и пока она его меняет, парение и полёт стоят
let cfgTimer = null;

// Состояние движка парения и полёта (см. раздел «парение и полёт»)
const motion = {
  timer: null,
  last: 0,          // время прошлого кадра
  phase: 0,         // фаза парения, рад
  bx: 0, by: 0,     // «база»: левый верхний угол окна без учёта парения
  vx: 0, vy: 0,     // скорость базы, px/сек
  tx: 0, ty: 0,     // куда летим
  rest: false,      // в цели нужно остановиться (иначе пролетаем мимо к следующей)
  state: 'idle',    // 'idle' | 'fly' | 'hold'
  holdLeft: 0,      // сколько ещё стоим на месте, сек
  heading: 0,       // куда летим по горизонтали: -1 влево, 1 вправо, 0 — ещё не определено
  w: 0, h: 0,       // размер окна, который нужно сохранять
  area: null, areaAt: 0, // допустимая область полёта и когда её считали
  lastX: 0, lastY: 0, frame: 0,
  ev: { on: false, left: 0, cool: 0, side: 0, vx: 0, vy: 0 }, // убегание от курсора
  over: false,      // курсор над персонажем (окно временно принимает клики)
};

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
  // Пока окно парит или летает, «домом» считаем базу, а не текущую точку с поправкой на парение
  if (motion.timer) { b.x = Math.round(motion.bx); b.y = Math.round(motion.by); }
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
  // В полёте смотрим туда, куда летим (если направление уже известно)
  if (motion.timer && cfg.roam && cfg.roamFaceDirection && motion.heading !== 0) {
    const lookLeft = motion.heading < 0;
    return cfg.mirrorInvert ? !lookLeft : lookLeft;
  }
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
  displayChanging = true;
  motionSync(); // пока Windows двигает окна, парение и полёт стоят
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => {
    displayChanging = false;
    if (!win || win.isDestroyed()) return;
    const b = { x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height };
    if (b.x != null && b.y != null && onScreen(b)) win.setBounds(b);
    applyMirror();
    raise();
    motionSync();
  }, 2500);
}

/* ---------------- парение и полёт ---------------- */

// Окно двигается сразу двумя слоями: «база» медленно перелетает с места на место (полёт),
// а поверх неё накладывается покачивание вверх-вниз (парение). Положение окна = база + покачивание.

const TICK_MS = 16;
const rand = (a, b) => a + Math.random() * (b - a);

function featuresOn() {
  return (cfg.float && cfg.floatAmp > 0) || cfg.roam || cfg.evade || cfg.clickFx;
}

function motionWanted() {
  return featuresOn() && !!win && !win.isDestroyed() && win.isVisible() && !editMode && !displayChanging;
}

// Включает или выключает движок под текущие настройки и состояние окна
function motionSync() {
  if (motionWanted()) {
    if (!motion.timer) motionStart();
  } else if (motion.timer) {
    if (featuresOn()) motionPause(); // окно скрыто, его двигают мышкой или меняется разрешение
    else motionFinish();             // парение и полёт выключены совсем
  }
}

function motionPause() {
  clearInterval(motion.timer);
  motion.timer = null;
  if (motion.over) {
    motion.over = false;
    if (win && !win.isDestroyed() && !editMode) win.setIgnoreMouseEvents(true, { forward: true });
  }
}

// Всё выключено: оставляем персонажа в точке, где он сейчас «базируется», и запоминаем её
function motionFinish() {
  const x = Math.round(motion.bx);
  const y = Math.round(motion.by);
  motionPause();
  if (!win || win.isDestroyed()) return;
  win.setPosition(x, y);
  saveBounds();
  applyMirror();
}

function motionStart() {
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  Object.assign(motion, {
    bx: x, by: y, vx: 0, vy: 0, phase: 0, w, h,
    state: 'idle', holdLeft: 0,
    area: null, areaAt: 0, lastX: x, lastY: y, frame: 0, last: Date.now(),
    ev: { on: false, left: 0, cool: 0, side: 0, vx: 0, vy: 0 }, over: false,
  });
  motion.timer = setInterval(motionTick, TICK_MS);
}

// Где базе можно находиться: рабочая область того монитора, на котором сейчас персонаж
function roamArea() {
  const now = Date.now();
  if (motion.area && now - motion.areaAt < 1000) return motion.area;
  const wa = screen.getDisplayMatching({
    x: Math.round(motion.bx), y: Math.round(motion.by), width: motion.w, height: motion.h,
  }).workArea;
  const padY = cfg.float ? cfg.floatAmp : 0; // чтобы покачивание не выносило окно за край
  let minX = wa.x;
  let maxX = wa.x + wa.width - motion.w;
  let minY = wa.y + padY;
  let maxY = wa.y + wa.height - motion.h - padY;
  if (maxX < minX) minX = maxX = Math.round((minX + maxX) / 2); // окно больше экрана — по центру
  if (maxY < minY) minY = maxY = Math.round((minY + maxY) / 2);
  motion.area = { minX, maxX, minY, maxY };
  motion.areaAt = now;
  return motion.area;
}

// Выбирает следующее место на экране и решает, остановимся ли там
function pickTarget() {
  const a = roamArea();
  const minDist = Math.min(250, Math.hypot(a.maxX - a.minX, a.maxY - a.minY) * 0.25);
  let tx = motion.bx;
  let ty = motion.by;
  for (let i = 0; i < 10; i++) {
    tx = rand(a.minX, a.maxX);
    ty = rand(a.minY, a.maxY);
    if (Math.hypot(tx - motion.bx, ty - motion.by) >= minDist) break; // не выбираем место прямо под собой
  }
  motion.tx = tx;
  motion.ty = ty;
  motion.rest = Math.random() * 100 < cfg.roamPauseChance;
  motion.state = 'fly';
}

// Гасит скорость базы (когда полёт выключили или персонаж завис на месте)
function dampVelocity(dt) {
  const k = 1 - Math.exp(-dt * 5);
  motion.vx -= motion.vx * k;
  motion.vy -= motion.vy * k;
  if (Math.abs(motion.vx) < 0.05) motion.vx = 0;
  if (Math.abs(motion.vy) < 0.05) motion.vy = 0;
}

function roamStep(dt) {
  const a = roamArea();
  if (motion.state === 'idle') pickTarget();

  if (motion.state === 'hold') {
    dampVelocity(dt);
    motion.holdLeft -= dt;
    if (motion.holdLeft <= 0) pickTarget();
  }

  if (motion.state === 'fly') {
    const tx = Math.min(a.maxX, Math.max(a.minX, motion.tx));
    const ty = Math.min(a.maxY, Math.max(a.minY, motion.ty));
    const dx = tx - motion.bx;
    const dy = ty - motion.by;
    const dist = Math.hypot(dx, dy);

    // Если нужно остановиться — перед целью плавно замедляемся, иначе летим на полной скорости
    const speed = motion.rest ? Math.min(cfg.roamSpeed, dist * 0.875) : cfg.roamSpeed;
    const dvx = dist > 0.001 ? (dx / dist) * speed : 0;
    const dvy = dist > 0.001 ? (dy / dist) * speed : 0;
    const k = 1 - Math.exp(-dt * 3.5); // скорость нарастает и меняется плавно, без рывков
    motion.vx += (dvx - motion.vx) * k;
    motion.vy += (dvy - motion.vy) * k;

    if (motion.rest) {
      if (dist < 5 && Math.hypot(motion.vx, motion.vy) < 12) {
        motion.state = 'hold';
        motion.holdLeft = rand(cfg.roamPauseMin, Math.max(cfg.roamPauseMin, cfg.roamPauseMax));
        saveBounds(); // запоминаем, где «базируется» персонаж
      }
    } else if (dist < Math.max(40, Math.min(160, cfg.roamSpeed * 0.5))) {
      pickTarget(); // место «по пути» — не останавливаемся, сразу летим дальше
    }
  }

  motion.bx = Math.min(a.maxX, Math.max(a.minX, motion.bx + motion.vx * dt));
  motion.by = Math.min(a.maxY, Math.max(a.minY, motion.by + motion.vy * dt));

  // Куда смотрит персонаж: порог, чтобы почти вертикальный полёт не вертел его туда-сюда
  if (Math.abs(motion.vx) > 15) {
    const h = motion.vx > 0 ? 1 : -1;
    if (h !== motion.heading) { motion.heading = h; applyMirror(); }
  }
}

// Полёт выключен — база просто дотормаживает и остаётся на месте
function settle(dt) {
  motion.state = 'idle';
  dampVelocity(dt);
  motion.bx += motion.vx * dt;
  motion.by += motion.vy * dt;
}

// Сколько пикселей центр персонажа может пролететь от точки (px, py) в направлении (ux, uy), не выйдя из области
function rayRoom(px, py, ux, uy, a, hw, hh) {
  let t = Infinity;
  if (ux > 1e-6) t = Math.min(t, (a.maxX + hw - px) / ux);
  else if (ux < -1e-6) t = Math.min(t, (a.minX + hw - px) / ux);
  if (uy > 1e-6) t = Math.min(t, (a.maxY + hh - py) / uy);
  else if (uy < -1e-6) t = Math.min(t, (a.minY + hh - py) / uy);
  return Math.max(0, t);
}

// Убегание от курсора. Работает рывками: курсор подошёл ближе радиуса — персонаж плавно отлетает
// не дальше заданной дистанции, потом короткая пауза и, если курсор всё ещё рядом, следующий рывок.
// Если путь прижат к краю экрана, направление поворачивается по касательной — персонаж облетает курсор по дуге.
// Возвращает true, пока персонаж убегает (в это время обычный полёт стоит).
function evadeStep(dt) {
  const ev = motion.ev;
  if (!cfg.evade) {
    if (ev.on || ev.cool > 0 || ev.vx || ev.vy) Object.assign(ev, { on: false, left: 0, cool: 0, side: 0, vx: 0, vy: 0 });
    return false;
  }
  const a = roamArea();
  const c = screen.getCursorScreenPoint();
  const hw = motion.w / 2;
  const hh = motion.h / 2;
  const px = motion.bx + hw;
  const py = motion.by + hh;
  let dx = px - c.x;
  let dy = py - c.y;
  let d = Math.hypot(dx, dy);
  if (d < 1) { dx = 1; dy = 0; d = 1; }
  const R = cfg.evadeRadius;

  if (ev.cool > 0) ev.cool -= dt;
  if (!ev.on && ev.cool <= 0 && d < R) {
    ev.on = true;
    ev.left = cfg.evadeDistance;
    ev.side = 0;
  }
  if (ev.on && (ev.left <= 0 || d > R * 1.15)) {
    ev.on = false;
    ev.cool = 0.5;
    ev.side = 0;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 800); // запоминаем, где остановился
  }

  let wx = 0;
  let wy = 0;
  if (ev.on) {
    let ux = dx / d;
    let uy = dy / d;
    if (cfg.evadeOrbit) {
      const room = rayRoom(px, py, ux, uy, a, hw, hh);
      const b = clamp(1 - room / Math.max(cfg.evadeDistance, 60), 0, 1); // 0 — путь свободен, 1 — упёрлись в край
      if (b > 0) {
        if (!ev.side) { // в какую сторону обходить: туда, где на экране больше места
          const cx = (a.minX + a.maxX) / 2 + hw - px;
          const cy = (a.minY + a.maxY) / 2 + hh - py;
          ev.side = (-uy * cx + ux * cy) >= 0 ? 1 : -1;
        }
        const tx = -uy * ev.side;
        const ty = ux * ev.side;
        ux = ux * (1 - b) + tx * b;
        uy = uy * (1 - b) + ty * b;
        const n = Math.hypot(ux, uy) || 1;
        ux /= n;
        uy /= n;
      }
    }
    const sp = cfg.evadeSpeed * clamp(0.5 + (1 - d / R), 0.5, 1); // чем ближе курсор, тем бодрее
    wx = ux * sp;
    wy = uy * sp;
  }
  const k = 1 - Math.exp(-dt * (ev.on ? 5 : 8));
  ev.vx += (wx - ev.vx) * k;
  ev.vy += (wy - ev.vy) * k;
  if (!ev.on && Math.hypot(ev.vx, ev.vy) < 3) { ev.vx = 0; ev.vy = 0; }

  const nx = clamp(motion.bx + ev.vx * dt, a.minX, a.maxX);
  const ny = clamp(motion.by + ev.vy * dt, a.minY, a.maxY);
  if (ev.on) ev.left -= Math.hypot(nx - motion.bx, ny - motion.by);
  motion.bx = nx;
  motion.by = ny;
  return ev.on || ev.cool > 0 || ev.vx !== 0 || ev.vy !== 0;
}

// Пока курсор над персонажем, окно принимает клики (иначе они проходят сквозь него).
// Вне персонажа окно снова «прозрачное» для мыши.
function hoverStep() {
  let over = false;
  if (cfg.clickFx && !editMode) {
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const rx = b.width * 0.32;
    const ry = b.height * 0.45;
    const nx = (c.x - (b.x + b.width / 2)) / rx;
    const ny = (c.y - (b.y + b.height / 2)) / ry;
    over = nx * nx + ny * ny <= 1;
  }
  if (over === motion.over) return;
  motion.over = over;
  if (over) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

// Раз в пару секунд проверяем, что окно не «поплыло» по размеру
// (на Windows с масштабом экрана не 100% повторные setPosition иногда сдвигают размер на пиксель)
function keepSize() {
  const [w, h] = win.getSize();
  if (w !== motion.w || h !== motion.h) {
    win.setBounds({ x: motion.lastX, y: motion.lastY, width: motion.w, height: motion.h });
  }
}

function motionTick() {
  if (!motionWanted()) { motionSync(); return; }
  const now = Date.now();
  const dt = Math.min(0.1, Math.max(0, (now - motion.last) / 1000));
  motion.last = now;

  if (evadeStep(dt)) settle(dt); // убегаем от курсора — обычный полёт на паузе
  else if (cfg.roam) roamStep(dt);
  else settle(dt);

  motion.phase = (motion.phase + (2 * Math.PI * dt) / cfg.floatPeriod) % (2 * Math.PI);
  const amp = cfg.float ? cfg.floatAmp : 0;
  const x = Math.round(motion.bx);
  const y = Math.round(motion.by + amp * Math.sin(motion.phase));
  if (x !== motion.lastX || y !== motion.lastY) {
    motion.lastX = x;
    motion.lastY = y;
    win.setPosition(x, y);
  }

  hoverStep();

  motion.frame++;
  if (motion.frame % 120 === 0) keepSize();
  // Если направление взгляда не привязано к полёту, «лицом к центру» проверяем пореже, а не на каждый кадр
  if (motion.frame % 8 === 0 && cfg.roam && !cfg.roamFaceDirection) applyMirror();
}

function motionSettings() {
  return Object.fromEntries(MOTION_KEYS.map((k) => [k, cfg[k]]));
}

// Применяет изменения настроек движения «на лету»; fromWc — окно настроек, которому слать ответ не нужно
function applyMotionPatch(patch, fromWc) {
  const clean = sanitizeMotion(patch);
  const keys = Object.keys(clean);
  if (!keys.length) return;
  Object.assign(cfg, clean);
  if (cfg.roamPauseMax < cfg.roamPauseMin) {
    if ('roamPauseMin' in clean) cfg.roamPauseMax = cfg.roamPauseMin; else cfg.roamPauseMin = cfg.roamPauseMax;
  }
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(saveCfg, 300);
  motionSync();
  applyMirror();
  if (keys.some((k) => MOTION_BOOLS.includes(k))) rebuildMenu();
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents !== fromWc) {
    settingsWin.webContents.send('settings:motion-changed', motionSettings());
  }
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
    injectFx();
  });
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = отмена загрузки
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(cfg.url); }, 5000);
  });

  win.on('move', () => {
    // Окном управляет парение/полёт: позицию не сохраняем, а поворот решает сам движок
    if (motion.timer) return;
    applyMirror(); // сразу разворачиваем, как только окно пересекло середину экрана
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  });
  win.on('closed', () => { motionPause(); win = null; });

  win.loadURL(cfg.url);
  win.showInactive();
  motionSync();
}

// Пружинка и блёстки при клике: скрипт выполняется внутри страницы персонажа
function fxPage() {
  if (window.__raFx) return;
  window.__raFx = true;
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647';
  document.documentElement.appendChild(cv);
  const ctx = cv.getContext('2d');
  const fit = () => {
    const d = window.devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * d);
    cv.height = Math.round(innerHeight * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  fit();
  addEventListener('resize', fit);

  const COLORS = ['#ffd75e', '#fff4b8', '#c4a8ff', '#a78bfa', '#ffffff'];
  let parts = [];
  let raf = 0;
  let last = 0;

  const star = (x, y, r, rot) => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = rot + (i * Math.PI) / 4;
      const rr = i % 2 ? r * 0.35 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  };

  const frame = (t) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.life -= dt;
      p.vy += 520 * dt;
      p.vx *= 1 - 1.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      star(p.x, p.y, p.size * (0.6 + 0.4 * (p.life / p.max)), p.rot);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    raf = parts.length ? requestAnimationFrame(frame) : 0;
  };

  const burst = (x, y) => {
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 140 + Math.random() * 260;
      const life = 0.7 + Math.random() * 0.6;
      parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140,
        life, max: life, size: 3 + Math.random() * 5,
        rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 10,
        color: COLORS[(Math.random() * COLORS.length) | 0],
      });
    }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  };

  let anim = null;
  const spring = () => {
    if (anim) anim.cancel();
    const ease = 'cubic-bezier(.3,.7,.4,1)';
    anim = document.body.animate([
      { transform: 'scale(1,1)', transformOrigin: '50% 85%', easing: ease },
      { transform: 'scale(1.16,0.8)', transformOrigin: '50% 85%', offset: 0.16, easing: ease },
      { transform: 'scale(0.92,1.13)', transformOrigin: '50% 85%', offset: 0.38, easing: ease },
      { transform: 'scale(1.05,0.96)', transformOrigin: '50% 85%', offset: 0.58, easing: ease },
      { transform: 'scale(0.99,1.01)', transformOrigin: '50% 85%', offset: 0.78, easing: ease },
      { transform: 'scale(1,1)', transformOrigin: '50% 85%' },
    ], { duration: 700 });
  };

  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Если страница отзеркалена (поворот персонажа), холст отзеркален вместе с ней
    const flip = new DOMMatrix(getComputedStyle(document.documentElement).transform).a < 0;
    burst(flip ? innerWidth - e.clientX : e.clientX, e.clientY);
    spring();
  }, true);
}

function injectFx() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`(${fxPage.toString()})()`).catch(() => { /* страница ещё не готова */ });
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
  motionSync(); // пока окно двигают мышкой, парение и полёт на паузе; после фиксации летаем от нового места
  await refreshCss();
  rebuildMenu();
}

function setSize(w, h) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  if (motion.timer) { b.x = Math.round(motion.bx); b.y = Math.round(motion.by); } // центр считаем от базы, без парения
  const nw = clamp(Math.round(w), 120, 3000);
  const nh = clamp(Math.round(h), 120, 3000);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const nx = Math.round(cx - nw / 2);
  const ny = Math.round(cy - nh / 2);
  win.setBounds({ x: nx, y: ny, width: nw, height: nh });
  if (motion.timer) Object.assign(motion, { bx: nx, by: ny, w: nw, h: nh, lastX: nx, lastY: ny, area: null });
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
  motionSync(); // скрытое окно не двигаем
  rebuildMenu();
}

function reload() {
  if (win && !win.isDestroyed()) win.loadURL(cfg.url);
}

/* ---------------- настройки ---------------- */

function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  settingsWin = new BrowserWindow({
    width: 480,
    height: Math.min(720, wa.height - 40),
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
  return { url: cfg.url, width: cfg.width, height: cfg.height, motion: motionSettings() };
});

// Парение и полёт применяются сразу, как только двигают ползунок; в ответ — актуальные значения
ipcMain.handle('settings:motion', (e, patch) => {
  if (!settingsWin || e.sender !== settingsWin.webContents) return null;
  applyMotionPatch(patch, e.sender);
  return motionSettings();
});

// Сброс только числовых значений; переключатели «Парение» / «Полёт» не трогаем
ipcMain.handle('settings:motion-reset', (e) => {
  if (!settingsWin || e.sender !== settingsWin.webContents) return null;
  const numeric = {};
  for (const k of Object.keys(MOTION_RANGES)) numeric[k] = defaults[k];
  applyMotionPatch(numeric, e.sender);
  return motionSettings();
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
      label: 'Парение и полёт',
      submenu: [
        { label: 'Парение (вверх-вниз)', type: 'checkbox', checked: !!cfg.float, click: (item) => applyMotionPatch({ float: item.checked }) },
        { label: 'Полёт по всему экрану', type: 'checkbox', checked: !!cfg.roam, click: (item) => applyMotionPatch({ roam: item.checked }) },
        { type: 'separator' },
        { label: 'Убегать от курсора', type: 'checkbox', checked: !!cfg.evade, click: (item) => applyMotionPatch({ evade: item.checked }) },
        { label: 'Облетать курсор', type: 'checkbox', checked: !!cfg.evadeOrbit, click: (item) => applyMotionPatch({ evadeOrbit: item.checked }) },
        { label: 'Пружинка и блёстки при клике', type: 'checkbox', checked: !!cfg.clickFx, click: (item) => applyMotionPatch({ clickFx: item.checked }) },
        { type: 'separator' },
        { label: 'Настроить скорость, размах, паузы…', click: openSettings },
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
    { label: 'Настройки… (ссылка, размер, движение)', click: openSettings },
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
  if (win && !win.isDestroyed() && !win.isVisible()) { win.showInactive(); raise(); motionSync(); }
});

app.on('window-all-closed', () => { /* живём в трее */ });
// При выходе запоминаем, где «базировался» персонаж, чтобы в следующий раз начать оттуда
app.on('before-quit', () => { if (motion.timer) saveBounds(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
