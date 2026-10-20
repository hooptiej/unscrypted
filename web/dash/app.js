// The living-room dashboard, ported from Homedash's web/app.js. Live tiles are go2rtc's own
// player in WebRTC video-only mode, exactly as Homedash plays them; only the signalling socket
// goes through this server (/go2rtc/api/ws), the video comes straight from go2rtc's WebRTC port.
// Watch-only: nothing here changes anything. Every failure shows a reason on screen.
const $ = (id) => document.getElementById(id);
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/* notices: settings, bridge and connection warnings, one line each, never silent */
const notices = new Map();
function setNotice(key, text) {
  if (text) notices.set(key, text); else notices.delete(key);
  const box = $("notice");
  box.textContent = [...notices.values()].join("  ·  ");
  box.classList.toggle("gone", notices.size === 0);
}
const showNotice = (text) => setNotice(`n${notices.size}-${Date.now()}`, text);

let cfg;
try {
  const r = await fetch("/api/config", { cache: "no-store" });
  if (!r.ok) throw new Error(`the dashboard server answered ${r.status}`);
  cfg = await r.json();
} catch (err) {
  setNotice("config", `The dashboard couldn't load its settings (${err.message}). Retrying in 15 s.`);
  setTimeout(() => location.reload(), 15000);
  throw err;   // stops this module; the notice says why and the page retries
}

/* fonts: a system stack, or a font file registered with the FontFace API (the CSP blocks inline <style>) */
async function applyFonts(fonts) {
  const root = document.documentElement.style;
  for (const role of ["ui", "clock"]) {
    const f = (fonts || {})[role];
    if (!f) continue;
    let css = f.family || null;
    if (f.file) {
      try {
        const face = new FontFace(`hd-${role}`, `url("${f.file}")`);
        document.fonts.add(await face.load());
        css = `"hd-${role}"`;
      } catch (err) {
        setNotice(`font-${role}`, `The ${role === "ui" ? "interface" : "clock"} font "${f.name || f.file}" didn't load (${err.message}); using the system font. Pick another in the dashboard settings.`);
      }
    }
    if (css) root.setProperty(role === "ui" ? "--font-ui" : "--font-clock", css);
  }
}
void applyFonts(cfg.fonts);

let playerReady = true;
try {
  await import("/go2rtc/video-stream.js");
} catch (err) {
  playerReady = false;
  setNotice("player", `The camera player didn't load (${err.message}). The video server may be restarting; the page reloads in a minute to try again.`);
  setTimeout(() => { if ($("full").classList.contains("gone")) location.reload(); }, 60000);
}

const wsBase = location.origin.replace(/^http/, "ws");
const streamSrc = (stream) => `${wsBase}/go2rtc/api/ws?src=${encodeURIComponent(stream)}`;

function makeStream(cam) {
  const el = document.createElement("video-stream");
  el.mode = "webrtc";
  el.media = "video";
  el.src = streamSrc(cam.stream);
  return el;
}

/* tiles: no blank tile ever; a dark tile always says why */
const NO_PICTURE_MS = 15000, RECREATE_MS = 60000;
const tiles = {};
for (const cam of cfg.cameras) {
  const tile = document.createElement("div");
  tile.className = "cam is-off";
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");
  tile.innerHTML = `<div class="off">Checking the camera&hellip;</div><span class="s">checking&hellip;</span><span class="n"></span>`;
  tile.querySelector(".n").textContent = cam.label;
  tile.addEventListener("click", () => openFull(cam));
  tile.addEventListener("keydown", (e) => { if (e.key === "Enter") openFull(cam); });
  $("cams").appendChild(tile);
  tiles[cam.id] = { tile, cam, el: null, made: 0, playing: false, camSt: null };
}
if (!cfg.cameras.length) {
  const empty = document.createElement("div");
  empty.className = "cam is-off";
  empty.innerHTML = `<div class="off"></div>`;
  empty.querySelector(".off").textContent = "No cameras are switched on for this dashboard. Turn them on in the dashboard settings (admin password needed).";
  $("cams").appendChild(empty);
}

let go2rtc = null;   // the bridge's view of go2rtc, from /api/state

function startStream(t) {
  if (!playerReady) return;
  if (t.el) t.el.remove();
  t.el = makeStream(t.cam);
  t.made = Date.now();
  t.playing = false;
  t.tile.prepend(t.el);
}
function stopStream(t) {
  if (t.el) { t.el.remove(); t.el = null; }
  t.playing = false;
}
const videoOf = (el) => (el ? el.querySelector("video") : null);

function render(t) {
  const st = t.camSt;
  let why = null, badge = "live";
  if (!st) {
    why = "Checking the camera…"; badge = "checking…";
  } else if (!st.up) {
    stopStream(t);
    why = `${st.reason || "Camera not answering"} since ${clockTime(st.since)}.`;
    badge = "offline";
  } else {
    if (!t.el) startStream(t);
    const v = videoOf(t.el);
    if (v && v.readyState >= 2) t.playing = true;
    if (!playerReady) {
      why = "The camera player didn't load; the page retries in a minute."; badge = "no player";
    } else if (go2rtc && go2rtc.state !== "running" && go2rtc.state !== "unknown") {
      // Keep the stream element: go2rtc's player reconnects on its own when the server is back.
      why = `Video server restarting: ${go2rtc.lastError || go2rtc.state}.`; badge = "reconnecting…";
    } else if (!t.playing && Date.now() - t.made > NO_PICTURE_MS) {
      why = "Video didn't start: no picture from the camera within 15 s. Retrying."; badge = "no picture";
      if (Date.now() - t.made > RECREATE_MS) startStream(t);   // once a minute until a frame arrives
    }
  }
  t.tile.classList.toggle("is-off", why !== null);
  t.tile.querySelector(".s").textContent = badge;
  const off = t.tile.querySelector(".off");
  if (why !== null) off.textContent = why;
  off.classList.toggle("gone", why === null);
}
const renderAll = () => Object.values(tiles).forEach(render);
setInterval(renderAll, 2000);   // the no-picture watchdog

/* which lights' full reasons are open, so a re-render (a changed poll) keeps them open */
const openReasons = {};
function svcNode(node) {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "sline";
  const dot = document.createElement("span");
  dot.className = `dot ${node.state}`;
  if (node.link) {
    // a new tab, so the dashboard keeps running and its self-refresh never strands the page
    const a = document.createElement("a");
    a.href = node.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = node.name;
    line.append(dot, a);
  } else {
    line.append(dot, node.name);
  }
  wrap.append(line);
  // A non-green light always says something: a short one-line label here, the full reason on
  // hover (title) or a tap, which opens it underneath. An older server sends only `reason`.
  const full = node.reason || "";
  const short = node.short || full;
  if (node.state !== "ok" || short) {
    const text = short || "no reason given (a bug: please report it)";
    const why = document.createElement("button");
    why.type = "button";
    why.className = "why";
    why.textContent = text;
    why.title = full || text;
    const more = document.createElement("div");
    more.className = "whyfull";
    more.textContent = full || text;
    const setOpen = (open) => { more.hidden = !open; why.setAttribute("aria-expanded", String(open)); openReasons[node.id] = open; };
    setOpen(Boolean(openReasons[node.id]));
    why.addEventListener("click", () => setOpen(more.hidden));
    line.append(why);
    wrap.append(more);
  }
  if (node.children && node.children.length) {
    const kids = document.createElement("div");
    kids.className = "kids";
    node.children.forEach((c) => kids.append(svcNode(c)));
    wrap.append(kids);
  }
  return wrap;
}

let lastServicesJson = "";
function renderServices(tree, at, serverNow) {
  // A round older than three intervals (plus slack) means the checks stopped: say so, never pretend.
  // Both times come from the server, so a kiosk whose clock drifts can't fake a stale panel.
  const stale = at && serverNow - at > 3 * pollMs + 10000 ? `Status stale since ${clockTime(at)}: the checks stopped answering.` : "";
  // skip identical polls so a click never lands on a node that was just swapped out
  const json = JSON.stringify(tree) + stale;
  if (json === lastServicesJson) return;
  lastServicesJson = json;
  const root = $("svc");
  root.classList.remove("placeholder");
  const kids = tree.map(svcNode);
  if (stale) { const w = document.createElement("div"); w.className = "why"; w.textContent = stale; kids.push(w); }
  root.replaceChildren(...kids);
}

function renderWeather(wx, error) {
  const root = $("wx");
  if (!wx) {
    if (error) { const e = document.createElement("div"); e.className = "wxl"; e.textContent = error; root.replaceChildren(e); }
    else root.replaceChildren();
    return;
  }
  const temp = document.createElement("div");
  temp.className = "wxt";
  temp.textContent = `${wx.temp}°`;
  const line = document.createElement("div");
  line.className = "wxl";
  line.textContent = `${wx.condition} · H ${wx.high} L ${wx.low}`;
  const sun = document.createElement("div");
  sun.className = "wxl";
  sun.textContent = `Sunrise ${wx.sunrise} · Sunset ${wx.sunset}`;
  root.replaceChildren(temp, line, sun);
  if (error) { const e = document.createElement("div"); e.className = "wxl"; e.textContent = error; root.append(e); }
  sunTimes = { rise: wx.sunriseMin, set: wx.sunsetMin };
  applyBackground();
}

/* background drifts with the real sun; subtle on purpose, it must stay dark */
let sunTimes = { rise: 7 * 60, set: 19 * 60 };
let overrideMin = null;
/* Same recipe as Constructicon's page background: a soft radial wash (60% ellipse) in the
   olive accent over a flat dark base. Here the wash travels along the bottom edge with the
   sun, warms at dawn and dusk, and rests dim in the bottom-right corner overnight. */
const BASE = "#0b0d08";
const OLIVE = [154, 168, 58];           /* Constructicon's --accent */
const WARM = [214, 128, 52];
/* [minute, rgb, alpha] */
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

function glowFor(min, rise, set) {
  const k = [
    [rise - 60, OLIVE, 0.07], [rise - 45, OLIVE, 0.0], [rise, WARM, 0.20], [rise + 90, OLIVE, 0.16],
    [set - 90, OLIVE, 0.16], [set, WARM, 0.20], [set + 60, OLIVE, 0.07],
  ];
  let rgb = OLIVE, alpha = 0.07;
  if (min > k[0][0] && min < k[k.length - 1][0]) {
    for (let i = 0; i < k.length - 1; i++) {
      if (min >= k[i][0] && min <= k[i + 1][0]) {
        const span = k[i + 1][0] - k[i][0];
        const t = span ? (min - k[i][0]) / span : 0;
        rgb = k[i][1].map((v, j) => Math.round(lerp(v, k[i + 1][1][j], t)));
        alpha = lerp(k[i][2], k[i + 1][2], t);
        break;
      }
    }
  }
  /* rest in the bottom-right corner at night; cross the bottom edge between sunrise and sunset */
  const x = min < rise - 45 ? 100 : clamp01((min - rise) / (set - rise)) * 100;
  return { rgb, alpha, x };
}

function applyBackground() {
  const now = new Date();
  const min = overrideMin !== null ? overrideMin : now.getHours() * 60 + now.getMinutes();
  const { rgb, alpha, x } = glowFor(min, sunTimes.rise, sunTimes.set);
  const c = $("stage").style;
  c.backgroundColor = BASE;
  c.backgroundImage =
    `radial-gradient(ellipse 60% 60% at ${x.toFixed(1)}% 100%, rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)}), transparent 100%)`;
}
setInterval(applyBackground, 30 * 1000);

const params = new URLSearchParams(location.search);
if (params.get("t")) {
  const [h, m] = params.get("t").split(":").map(Number);
  overrideMin = (h || 0) * 60 + (m || 0);
}
if (params.has("tune")) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:9;" +
    "background:#000;color:#c9d0b4;padding:6px 14px;border-radius:8px;font:14px system-ui;display:flex;gap:10px";
  const label = document.createElement("span");
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = 0; slider.max = 1439; slider.step = 5; slider.style.width = "480px";
  const nowDate = new Date();
  slider.value = overrideMin !== null ? overrideMin : nowDate.getHours() * 60 + nowDate.getMinutes();
  const show = () => {
    overrideMin = Number(slider.value);
    const h = Math.floor(overrideMin / 60), m = overrideMin % 60;
    label.textContent = `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    applyBackground();
  };
  slider.addEventListener("input", show);
  wrap.append(label, slider);
  document.body.append(wrap);
  show();
}
applyBackground();

/* state poll: camera reachability, go2rtc, settings changes; a lost server is said out loud */
const pollMs = (cfg.pollSeconds || 4) * 1000;
let seenSettingsVersion = null, reloadWhenClosed = false;
async function pollState() {
  let st;
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(`it answered ${r.status}`);
    st = await r.json();
  } catch (err) {
    if (!notices.has("stale")) {
      setNotice("stale", `Lost touch with the dashboard server at ${clockTime(Date.now())} (${err.message}); showing the last known state. Retrying every ${pollMs / 1000} s.`);
    }
    return;
  }
  setNotice("stale", null);
  go2rtc = st.go2rtc || null;
  for (const [id, t] of Object.entries(tiles)) t.camSt = (st.cameras || {})[id] || null;
  renderAll();
  if (st.services && st.services.length) renderServices(st.services, st.servicesAt, st.updated);
  const wxErr = st.weatherError
    ? (st.weatherErrorSince ? `Weather ${st.weather ? "not updated" : "unavailable"} since ${clockTime(st.weatherErrorSince)}: ${st.weatherError}` : st.weatherError)
    : null;
  renderWeather(st.weather, wxErr);
  setNotice("settings", [st.settingsWarning, ...(st.notices || [])].filter(Boolean).join("  ·  ") || null);
  if (seenSettingsVersion === null) seenSettingsVersion = st.settingsVersion;
  else if (st.settingsVersion !== seenSettingsVersion) {
    if ($("full").classList.contains("gone")) location.reload(); else reloadWhenClosed = true;
  }
}
pollState();
setInterval(pollState, pollMs);

/* fullscreen with idle return */
let left = 0, timer = null, fullEl = null;
const TOTAL = cfg.idleSeconds || 30;
function paint() {
  $("fbar").style.width = Math.round((left / TOTAL) * 100) + "%";
  $("ftxt").textContent = `Back to dashboard in ${left}s`;
}
function closeFull() {
  clearInterval(timer);
  timer = null;
  if (fullEl) { fullEl.remove(); fullEl = null; }
  $("full").classList.add("gone");
  if (reloadWhenClosed) location.reload();
}
function openFull(cam) {
  closeFull();
  $("fname").textContent = cam.label;
  if (playerReady) {
    fullEl = makeStream(cam);
    $("fullv").prepend(fullEl);
  }
  left = TOTAL;
  paint();
  $("full").classList.remove("gone");
  timer = setInterval(() => {
    left -= 1;
    if (left <= 0) closeFull(); else paint();
  }, 1000);
}
$("full").addEventListener("click", () => { left = TOTAL; paint(); });
$("fback").addEventListener("click", (e) => { e.stopPropagation(); closeFull(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("full").classList.contains("gone")) closeFull();
});

/* photo slideshow: two stacked images crossfade; the list is reshuffled on every refresh */
const photoBox = $("photo");
const slides = [document.createElement("img"), document.createElement("img")];
slides.forEach((img) => { img.alt = ""; img.draggable = false; });
let photoItems = [], photoIdx = -1, photoFront = 0, photoTimer = null;

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showNextPhoto() {
  if (!photoItems.length) return;
  photoIdx = (photoIdx + 1) % photoItems.length;
  const item = photoItems[photoIdx];
  const incoming = slides[1 - photoFront];
  incoming.onload = () => {
    incoming.classList.add("on");
    slides[photoFront].classList.remove("on");
    photoFront = 1 - photoFront;
  };
  // A photo that won't load (gone since the list was fetched) is skipped, never left as a frozen tile.
  incoming.onerror = () => setTimeout(showNextPhoto, 2000);
  incoming.src = `/api/photo/${item.id}?v=${item.v}`;
}

function photoPlaceholder(text) {
  if (photoItems.length) return;   // keep the slides already showing; the reason is for an empty tile
  const span = document.createElement("span");
  span.textContent = text;
  photoBox.classList.add("placeholder");
  photoBox.replaceChildren(span);
}

async function loadPhotos() {
  let data;
  try {
    const r = await fetch("/api/photos", { cache: "no-store" });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body && body.error ? body.error.happened : `the server answered ${r.status}`);
    data = body;
  } catch (err) {
    photoPlaceholder(`Photos didn't load (${err.message}). Retrying in 30 s.`);
    setTimeout(loadPhotos, 30000);
    return;
  }
  if (!data.items.length) {
    // The server may still be fetching the album list after a restart: look again soon.
    photoPlaceholder(data.error || "Loading photos… (the album is still being fetched)");
    setTimeout(loadPhotos, 30000);
    return;
  }
  photoItems = shuffled(data.items);
  photoIdx = -1;
  if (!photoBox.contains(slides[0])) {
    photoBox.classList.remove("placeholder");
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.id = "photocap";
    photoBox.replaceChildren(...slides, cap);
  }
  $("photocap").textContent = data.error || data.album || "";
  $("photocap").classList.toggle("gone", !(data.error || data.album));
  showNextPhoto();
  clearInterval(photoTimer);
  photoTimer = setInterval(showNextPhoto, (data.rotateSeconds || 20) * 1000);
}
loadPhotos();
setInterval(loadPhotos, 15 * 60 * 1000);

/* the Settings button opens the admin side, which asks for the admin password */
const settingsBtn = document.querySelector(".settings-btn");
// From config (UNSCRYPTED_ADMIN_URL) when the dashboard and the admin pane live on different addresses.
settingsBtn.href = cfg.settingsUrl || `http://${location.hostname}:${cfg.adminPort}/dash-settings?from=dash`;
settingsBtn.textContent = "Settings";

/* self-refresh so new deployments appear on their own; never while a camera is fullscreen */
const reloadAfterMs = (cfg.reloadMinutes || 20) * 60 * 1000;
const loadedAt = Date.now();
setInterval(() => {
  const inFullscreen = !$("full").classList.contains("gone");
  if (!inFullscreen && Date.now() - loadedAt >= reloadAfterMs) location.reload();
}, 15 * 1000);

/* clock and date */
function tick() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("day").textContent = now.toLocaleDateString([], { weekday: "long" });
  $("date").textContent = now.toLocaleDateString([], { month: "long", day: "numeric" });
}
tick();
setInterval(tick, 1000);
