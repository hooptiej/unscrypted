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

/* the running build stamp (#102): a tiny, unobtrusive line in the clock band, never on a tile */
{
  const buildEl = $("build");
  if (buildEl && cfg.build) buildEl.textContent = cfg.build;
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

/* tiles: no blank tile ever; a dark tile always says why. A tile that has shown a picture keeps its
   last decoded frame (#113): through a blip you see nothing but that frame, and when the camera has
   really been gone a while the banner goes over the dimmed frame, never a black box. */
const NO_PICTURE_MS = 15000, RECREATE_MS = 60000;
const graceMs = (cfg.offlineGraceSeconds || 20) * 1000;
const HELD_W = 960, PERSIST_MS = 30000;
const tiles = {};
for (const cam of cfg.cameras) {
  const tile = document.createElement("div");
  tile.className = "cam is-off";
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");
  tile.innerHTML = `<div class="off">Checking the camera&hellip;</div><span class="s">checking&hellip;</span><span class="n"></span><canvas class="held gone" aria-hidden="true"></canvas>`;
  tile.querySelector(".n").textContent = cam.label;
  tile.addEventListener("click", () => openFull(cam));
  tile.addEventListener("keydown", (e) => { if (e.key === "Enter") openFull(cam); });
  $("cams").appendChild(tile);
  tiles[cam.id] = { tile, cam, el: null, made: 0, playing: false, everPlayed: false, lastPlayingAt: 0, lastTime: -1,
    camSt: null, canvas: tile.querySelector(".held"), frame: null, dirty: false, persistedAt: 0, trouble: null, view: null };
  restoreFrame(tiles[cam.id]);
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
  t.playing = false; t.everPlayed = false; t.lastTime = -1;
  t.tile.prepend(t.el);
}
function stopStream(t) {
  if (t.el) { t.el.remove(); t.el = null; }
  t.playing = false; t.everPlayed = false; t.lastTime = -1;
}
const videoOf = (el) => (el ? el.querySelector("video") : null);

const liveLabel = (cam) => `live · ${cam.which === "sub" ? "sub" : "main"}`;

/* "9:37 AM" today, "Tue 9:37 AM" on another day (a kept picture can be days old after a reload) */
function whenOf(ms, nowMs) {
  const d = new Date(ms), n = new Date(nowMs);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === n.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/* What one tile shows (#113). Pure: everything it needs comes in as `i`, so a test can run it.
   i.st: the server's verdict (null = not known yet; else {up, reason, since}); the server has already
   waited out its grace before it says up:false. i.playing: a live frame is advancing right now.
   i.prev: the {kind, since} this returned last time, so a trouble's age survives between calls.
   Returns { stream: "start"|"stop"|"keep", why, badge, held: "none"|"plain"|"dim", trouble, recreate }.
   `held` = show the kept frame (plain = no banner, a blip; dim = under a banner). */
function tileView(i) {
  const label = `live · ${i.which === "sub" ? "sub" : "main"}`;
  const kept = i.hasFrame ? ` Showing the last picture, from ${i.whenOf(i.frameAt, i.now)}.` : "";
  if (!i.st) {
    // Nothing known yet. A kept frame is better than words; the badge still says we're checking.
    return { stream: "keep", why: i.hasFrame ? null : "Checking the camera…", badge: "checking…", held: i.hasFrame && !i.playing ? "plain" : "none", trouble: null, recreate: false };
  }
  if (!i.st.up) {
    // Offline past the grace: the banner goes over the dimmed last picture, "since" being when it stopped answering.
    return { stream: "stop", why: `${i.st.reason || "Camera not answering"} since ${i.clock(i.st.since)}.${kept}`, badge: "offline",
      held: i.hasFrame ? "dim" : "none", trouble: null, recreate: false };
  }
  // Up as far as the server knows. What can still be wrong is on this side of the wire.
  let kind = null, onset = null;
  if (!i.playerReady) kind = "player";
  else if (i.go2rtc && i.go2rtc.state !== "running" && i.go2rtc.state !== "unknown") kind = "server";
  else if (!i.everPlayed) { kind = "nopicture"; onset = i.madeAt; }
  else if (!i.playing) { kind = "stalled"; onset = i.lastPlayingAt; }
  if (kind && onset === null) onset = i.prev && i.prev.kind === kind ? i.prev.since : i.now;
  const trouble = kind ? { kind, since: onset } : null;
  const aged = kind ? i.now - onset : 0;
  const held = i.hasFrame && !i.playing ? "plain" : "none";
  if (!kind || aged < i.graceMs) return { stream: "start", why: null, badge: label, held, trouble, recreate: false };   // fine, or a blip: nothing but the kept frame
  const secs = Math.round(aged / 1000);
  const says = {
    player: ["The camera player didn't load; the page retries in a minute.", "no player"],
    // Keep the stream element: go2rtc's player reconnects on its own when the server is back.
    server: [`Video server restarting: ${i.go2rtc && (i.go2rtc.lastError || i.go2rtc.state)}.`, "reconnecting…"],
    nopicture: [`Video didn't start: no picture from the camera within ${secs} s. Retrying.`, "no picture"],
    stalled: [`Video stopped: no new picture for ${secs} s. Reconnecting.`, "reconnecting…"],
  }[kind];
  return { stream: "start", why: says[0] + kept, badge: says[1], held: i.hasFrame ? "dim" : "none", trouble,
    recreate: (kind === "nopicture" || kind === "stalled") && aged > i.recreateMs };   // once a minute until a frame arrives
}

/* the kept frame: copied from the playing video, remembered in this browser across reloads */
function captureFrame(t, v) {
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return;
  const cw = Math.min(HELD_W, w), ch = Math.max(1, Math.round((h * cw) / w));
  if (t.canvas.width !== cw || t.canvas.height !== ch) { t.canvas.width = cw; t.canvas.height = ch; }
  try {
    t.canvas.getContext("2d").drawImage(v, 0, 0, cw, ch);
    t.frame = { at: Date.now() };
    t.dirty = true;
  } catch (err) {
    setNotice(`frame-${t.cam.id}`, `Couldn't keep the last picture of ${t.cam.label} (${err.message}). Its tile will go dark if the camera drops.`);
  }
}
const frameKey = (t) => `unscrypted.dash.frame.${t.cam.id}`;
function persistFrame(t) {
  if (!t.frame || !t.dirty) return;
  try {
    localStorage.setItem(frameKey(t), JSON.stringify({ at: t.frame.at, data: t.canvas.toDataURL("image/jpeg", 0.7) }));
    t.dirty = false;
    t.persistedAt = Date.now();
    setNotice(`save-${t.cam.id}`, null);
  } catch (err) {
    t.dirty = false;   // say it once, not every 30 s
    t.persistedAt = Date.now();
    setNotice(`save-${t.cam.id}`, `Couldn't save the last picture of ${t.cam.label} in this browser (${err.message}). It's still kept while this page stays open, but a page reload would lose it.`);
  }
}
function restoreFrame(t) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(frameKey(t)) || "null"); } catch { saved = null; }
  if (!saved || typeof saved.data !== "string" || !saved.data.startsWith("data:image/jpeg;base64,") || typeof saved.at !== "number") return;
  const img = new Image();
  img.onload = () => {
    if (t.frame) return;   // a live frame beat it
    t.canvas.width = img.naturalWidth; t.canvas.height = img.naturalHeight;
    t.canvas.getContext("2d").drawImage(img, 0, 0);
    t.frame = { at: saved.at };
    render(t);
  };
  img.onerror = () => setNotice(`restore-${t.cam.id}`, `The saved last picture of ${t.cam.label} couldn't be read, so it starts without one.`);
  img.src = saved.data;
}

function render(t) {
  const now = Date.now();
  // Is a live frame advancing? currentTime moving is the proof; a frozen or blanked video isn't.
  const v = videoOf(t.el);
  const time = v && v.readyState >= 2 ? v.currentTime : -1;
  t.playing = time >= 0 && time !== t.lastTime;
  t.lastTime = time;
  if (t.playing) {
    t.everPlayed = true; t.lastPlayingAt = now;
    captureFrame(t, v);
    if (now - t.persistedAt > PERSIST_MS) persistFrame(t);
  }
  const view = tileView({ st: t.camSt, playerReady, go2rtc, playing: t.playing, everPlayed: t.everPlayed, madeAt: t.el ? t.made : now, lastPlayingAt: t.lastPlayingAt || now,
    hasFrame: Boolean(t.frame), frameAt: t.frame ? t.frame.at : 0, which: t.cam.which, now, graceMs, recreateMs: RECREATE_MS,
    prev: t.trouble, clock: clockTime, whenOf });
  t.trouble = view.trouble;
  t.view = view;
  if (view.stream === "stop") stopStream(t);
  else if (view.stream === "start" && (!t.el || view.recreate)) startStream(t);
  const why = view.why;
  // "live · main" / "live · sub" (#22): on a small tile 1080p and 360p look alike, so say which.
  t.tile.classList.toggle("is-off", why !== null);
  t.tile.querySelector(".s").textContent = view.badge;
  const off = t.tile.querySelector(".off");
  if (why !== null) off.textContent = why;
  off.classList.toggle("gone", why === null);
  off.classList.toggle("over", view.held === "dim");   // translucent over the dimmed frame; solid when there's no frame to show
  t.canvas.classList.toggle("gone", view.held === "none");
  t.canvas.classList.toggle("dim", view.held === "dim");
}
const renderAll = () => { Object.values(tiles).forEach(render); renderFullHeld(); };
setInterval(renderAll, 1000);   // the frame-advancing check and the no-picture watchdog
addEventListener("pagehide", () => Object.values(tiles).forEach(persistFrame));

/* which lights' full reasons are open, so a re-render (a changed poll) keeps them open */
const openReasons = {};
/* a short label that opens its full reason underneath on a tap (and keeps that open across re-renders) */
function tapReason(key, text, full, cls) {
  const why = document.createElement("button");
  why.type = "button";
  why.className = cls;
  why.textContent = text;
  why.title = full;
  const more = document.createElement("div");
  more.className = "whyfull";
  more.textContent = full;
  const setOpen = (open) => { more.hidden = !open; why.setAttribute("aria-expanded", String(open)); openReasons[key] = open; };
  setOpen(Boolean(openReasons[key]));
  why.addEventListener("click", () => setOpen(more.hidden));
  return { why, more };
}

/* The new-build pulse (#103): a light breathes in its own colour while a build waits on test. Red never does:
   a red light keeps its pulse on the server and shows it again once it's green. */
function showsPulse(node) {
  return Boolean(node && node.pulse && node.state !== "down");
}

/* The pulse knobs from the admin settings (#103): -100..+100 %, 0 = the standard breath (2 s, a full-strength halo).
   Speed: -100% is 3.3 s a breath, +100% is 0.7 s. Strength: -100% no halo, +100% doubles it. The page sets these as CSS values. */
function pulseVars(knobs) {
  const sp = Math.max(-100, Math.min(100, Number(knobs && knobs.speed) || 0));
  const st = Math.max(-100, Math.min(100, Number(knobs && knobs.strength) || 0));
  const mult = 1 + st / 100;
  return {
    period: `${(2 * (1 - sp / 150)).toFixed(2)}s`,
    alpha: `${Math.round(Math.max(0, Math.min(1, mult)) * 100)}%`,
    blur: String(Math.round(8 * mult)),
    spread: String(Math.round(2 * mult)),
  };
}
{
  const pv = pulseVars(cfg.pulse);
  const root = document.documentElement.style;
  root.setProperty("--pulse-period", pv.period);
  root.setProperty("--pulse-alpha", pv.alpha);
  root.setProperty("--pulse-blur", pv.blur);
  root.setProperty("--pulse-spread", pv.spread);
}

/* A tap on a pulsing light (or on its link) says "seen it": the open dashboard can only clear a pulse, never set one (#103). */
async function clearPulse(node) {
  const key = `pulse-${node.id}`;
  try {
    const r = await fetch(`/api/pulse/${encodeURIComponent(node.id)}/clear`, { method: "POST", headers: { "x-dash-action": "clear" }, cache: "no-store" });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body && body.error ? `${body.error.happened} ${body.error.next}` : `the dashboard answered ${r.status}`);
    setNotice(key, null);
  } catch (err) {
    setNotice(key, `Couldn't clear the new-build pulse on ${node.name} (${err.message}). It stays on until you try again.`);
    return;
  }
  void pollState();
}

function svcNode(node) {
  const wrap = document.createElement("div");
  const line = document.createElement("div");
  line.className = "sline";
  const dot = document.createElement("span");
  dot.className = `dot ${node.state}${showsPulse(node) ? " pulse" : ""}`;
  if (node.pulse) {
    // a tap on the dot says "seen it"; it's a button for keyboards and screen readers too
    dot.setAttribute("role", "button");
    dot.tabIndex = 0;
    dot.title = "Tap when you've seen this build";
    dot.setAttribute("aria-label", `${node.name}: a new build is waiting. Tap to clear.`);
    dot.addEventListener("click", () => void clearPulse(node));
    dot.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void clearPulse(node); } });
  }
  if (node.link) {
    // a new tab, so the dashboard keeps running and its self-refresh never strands the page
    const a = document.createElement("a");
    a.href = node.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = node.name;
    // opening the test install is seeing its build too (#103)
    if (node.pulse) a.addEventListener("click", () => void clearPulse(node));
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
    const tap = tapReason(node.id, short || "no reason given (a bug: please report it)", full || short || "no reason given (a bug: please report it)", "why");
    line.append(tap.why);
    wrap.append(tap.more);
  }
  if (node.pulse) {
    // the "new build" label; its full reason opens on a tap, the same as the reasons do
    const tap = tapReason(`${node.id}:pulse`, "new build", node.pulse.reason, "why pulse-tag");
    line.append(tap.why);
    wrap.append(tap.more);
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
/* Glow knobs (#25, admin dashboard settings): percents -100..+100, 0 = the look above.
   KNOBS_AT_NIGHT: true = the knobs scale the night glow too; false = daytime only (they fade
   out over dawn and dusk with the size easing, so night stays at 0.07 / 60%). Owner's call. */
const KNOBS_AT_NIGHT = true;
const SIZE_MIN = 10, SIZE_MAX = 200;    /* ellipse %, so -100% size never collapses the gradient */
const knobPct = (v) => (Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0);

function glowFor(min, rise, set, knobs) {
  /* Daytime keys +50% (#24, owner: "+50% on both"): 0.20 -> 0.30, 0.16 -> 0.24; night 0.07 unchanged. */
  const k = [
    [rise - 60, OLIVE, 0.07], [rise - 45, OLIVE, 0.0], [rise, WARM, 0.30], [rise + 90, OLIVE, 0.24],
    [set - 90, OLIVE, 0.24], [set, WARM, 0.30], [set + 60, OLIVE, 0.07],
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
  /* size: 60% at night, 90% (+50%, #24) by day, easing in over dawn and out over dusk */
  const day = min < rise ? clamp01((min - (rise - 45)) / 45) : min > set ? clamp01(1 - (min - set) / 60) : 1;
  let size = Math.round(lerp(60, 90, day));
  /* the knobs: multiplier 1 + pct/100 on the strength and on the ellipse */
  const reach = KNOBS_AT_NIGHT ? 1 : day;
  const kn = knobs || {};
  const iMul = lerp(1, 1 + knobPct(kn.intensity) / 100, reach);
  const sMul = lerp(1, 1 + knobPct(kn.size) / 100, reach);
  alpha = clamp01(alpha * iMul);
  if (sMul !== 1) size = Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, size * sMul)));
  return { rgb, alpha, x, size };
}

function applyBackground() {
  const now = new Date();
  const min = overrideMin !== null ? overrideMin : now.getHours() * 60 + now.getMinutes();
  const { rgb, alpha, x, size } = glowFor(min, sunTimes.rise, sunTimes.set, cfg.glow);
  const c = $("stage").style;
  c.backgroundColor = BASE;
  c.backgroundImage =
    `radial-gradient(ellipse ${size}% ${size}% at ${x.toFixed(1)}% 100%, rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)}), transparent 100%)`;
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
// Capped at 3 s (#20): /api/state is cheap and carries settingsVersion, so a saved setting shows up
// within seconds; "Status checks every (s)" (pollSeconds) only paces the server-side checks.
const pollMs = Math.min((cfg.pollSeconds || 3) * 1000, 3000);
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
let left = 0, timer = null, fullEl = null, fullHeld = null, fullTile = null, fullLastTime = -1;
const TOTAL = cfg.idleSeconds || 30;
function paint() {
  $("fbar").style.width = Math.round((left / TOTAL) * 100) + "%";
  $("ftxt").textContent = `Back to dashboard in ${left}s`;
}
function closeFull() {
  clearInterval(timer);
  timer = null;
  if (fullEl) { fullEl.remove(); fullEl = null; }
  if (fullHeld) { fullHeld.remove(); fullHeld = null; }
  fullTile = null;
  $("fnote").classList.add("gone");
  $("full").classList.add("gone");
  if (reloadWhenClosed) location.reload();
}
function openFull(cam) {
  closeFull();
  $("fname").textContent = cam.label;
  document.querySelector("#full .flive").textContent = liveLabel(cam);
  if (playerReady) {
    fullEl = makeStream(cam);
    $("fullv").prepend(fullEl);
  }
  // The tile's kept picture (#113) shows here too while this view has no live picture of its own.
  fullTile = tiles[cam.id] || null;
  fullLastTime = -1;
  fullHeld = document.createElement("canvas");
  fullHeld.className = "held gone";
  fullHeld.setAttribute("aria-hidden", "true");
  $("fullv").append(fullHeld);
  left = TOTAL;
  paint();
  $("full").classList.remove("gone");
  timer = setInterval(() => {
    left -= 1;
    if (left <= 0) closeFull(); else paint();
  }, 1000);
}
/* The fullscreen view's kept picture and its reason (#113): while its own video isn't advancing, show the tile's last frame and say why. */
function renderFullHeld() {
  if (!fullEl || !fullHeld || !fullTile) return;
  const v = videoOf(fullEl);
  const time = v && v.readyState >= 2 ? v.currentTime : -1;
  const playing = time >= 0 && time !== fullLastTime;
  fullLastTime = time;
  const t = fullTile;
  const show = !playing && Boolean(t.frame) && t.canvas.width > 0;
  if (show) {
    if (fullHeld.width !== t.canvas.width || fullHeld.height !== t.canvas.height) { fullHeld.width = t.canvas.width; fullHeld.height = t.canvas.height; }
    fullHeld.getContext("2d").drawImage(t.canvas, 0, 0);
  }
  const dim = show && t.view && t.view.held === "dim";
  fullHeld.classList.toggle("gone", !show);
  fullHeld.classList.toggle("dim", Boolean(dim));
  const note = $("fnote");
  const text = !playing && t.view && t.view.why ? t.view.why : "";
  note.textContent = text;
  note.classList.toggle("gone", !text);
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
