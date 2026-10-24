// Homedash's one-screen settings page (Homedash #16), ported. Served by the admin server behind
// the admin password; saving needs this session's CSRF token. Everything from the server goes in
// as text, never as HTML. When opened from the kiosk's Settings button (?from=dash) it idles back
// to the dashboard and signs this browser out first, so the living room never stays signed in.
const $ = (id) => document.getElementById(id);
const fromDash = new URLSearchParams(location.search).get("from") === "dash";
const SYSTEM_LABEL = { sans: "Sans (system)", serif: "Serif (system)", mono: "Monospace (system)", inherit: "Same as interface font" };
const STACK = { sans: "system-ui, sans-serif", serif: "Georgia, serif", mono: "ui-monospace, Consolas, monospace" };
let csrf = null;
let loaded = null;   // what the server last sent
let dashUrl = "/";
let dirty = false;

const signInUrl = () => `/?next=${encodeURIComponent("/dash-settings" + (fromDash ? "?from=dash" : ""))}#/login`;

function say(kind, ...lines) {
  const m = $("msg");
  m.className = kind;
  m.replaceChildren(...lines.filter(Boolean).map((l) => { const p = document.createElement("p"); p.textContent = l; return p; }));
}
function sayError(e) {
  say("err", `${e.attempted || "That"} didn't work: ${e.happened || "no reason given"}`, `What changed: ${e.changed || "unknown"}  What to do: ${e.next || "reload the page"}`);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  let r;
  try {
    r = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  } catch (err) {
    return { status: 0, error: { attempted: `${method} ${path}`, happened: `Couldn't reach the admin pane (${err.message}).`, changed: "Unknown: the request may not have arrived.", next: "The bridge may be restarting. Wait a few seconds and try again." } };
  }
  let j;
  try { j = await r.json(); } catch { j = { error: { attempted: `${method} ${path}`, happened: `The server answered ${r.status} with something that isn't JSON.`, changed: "Unknown.", next: "Reload the page; if it repeats, check docker logs unscrypted." } }; }
  if (r.status === 401) { location.href = signInUrl(); }
  return { status: r.status, ...j };
}

/* Leave for the dashboard. From the kiosk, sign out first; if that fails, say so and stay. */
async function leave() {
  if (fromDash) {
    const r = await api("POST", "/api/logout");
    if (r.error) { sayError({ ...r.error, changed: `${r.error.changed} You're still signed in on this browser.` }); return; }
  }
  location.href = dashUrl;
}

/* ---------- fonts ---------- */
const faces = new Map();
async function faceFor(file) {
  if (faces.has(file)) return faces.get(file);
  const family = `hdp-${faces.size}`;
  const p = new FontFace(family, `url("/dash-fonts/${encodeURIComponent(file)}")`).load().then((f) => { document.fonts.add(f); return family; });
  faces.set(file, p);
  return p;
}
function fontSelect(select, role, spec) {
  select.replaceChildren();
  const sys = document.createElement("optgroup");
  sys.label = "System";
  for (const f of role === "clock" ? ["inherit", "sans", "serif", "mono"] : ["sans", "serif", "mono"]) {
    const o = document.createElement("option");
    o.value = `system:${f}`; o.textContent = SYSTEM_LABEL[f];
    sys.append(o);
  }
  select.append(sys);
  const files = document.createElement("optgroup");
  files.label = loaded.fonts.length ? "Fonts folder" : "Fonts folder (empty: drop files in data/dash/fonts)";
  for (const f of loaded.fonts) {
    const o = document.createElement("option");
    o.value = `file:${f.file}`; o.textContent = f.name;
    files.append(o);
  }
  select.append(files);
  // #14: Constructicon's fonts. Never hidden: when the list can't be had, the group is there, greyed out, and says why.
  const cx = loaded.constructicon || { available: false, reason: "this admin pane doesn't know about Constructicon fonts", fonts: [] };
  const grp = document.createElement("optgroup");
  if (cx.available) {
    grp.label = cx.fonts.length ? "From Constructicon" : "From Constructicon (no font files there yet)";
    for (const f of cx.fonts) {
      if (f.file && loaded.fonts.some((x) => x.file === f.file)) continue;   // already in the folder: listed above
      const o = document.createElement("option");
      o.value = `cx:${f.slug}`; o.textContent = `${f.name} (copy from Constructicon)`;
      grp.append(o);
    }
  } else {
    grp.label = `From Constructicon (unavailable: ${cx.reason || "no reason given"})`;
    grp.disabled = true;
  }
  select.append(grp);
  select.value = spec.kind === "file" ? `file:${spec.file}` : `system:${spec.family}`;
  if (!select.value) {
    // The saved font file is gone: show that instead of quietly picking another.
    const o = document.createElement("option");
    o.value = `system:${role === "clock" ? "inherit" : "sans"}`; o.textContent = `"${spec.file}" (missing from the fonts folder; saving uses the system font)`;
    select.prepend(o);
    select.value = o.value;
  }
}
const parseFont = (v) => { const i = v.indexOf(":"); const kind = v.slice(0, i), rest = v.slice(i + 1); return kind === "file" ? { kind: "file", file: rest } : { kind: "system", family: rest }; };

/* A "cx:<slug>" pick: copy the font into the folder first, then select it as a folder font (#14). */
async function pickConstructicon(select, role) {
  const v = select.value;
  if (!v.startsWith("cx:")) return;
  const slug = v.slice(3);
  const prev = select.dataset.prev || `system:${role === "clock" ? "inherit" : "sans"}`;
  select.disabled = true;
  say("ok", "Copying the font from Constructicon\u2026");
  const r = await api("POST", "/api/dash/fonts/constructicon", { slug });
  select.disabled = false;
  if (r.error) { sayError(r.error); select.value = prev; return; }
  loaded.fonts = r.fonts;
  const spec = { kind: "file", file: r.file };
  fontSelect($("fontUi"), "ui", $("fontUi") === select ? spec : parseFont($("fontUi").value));
  fontSelect($("fontClock"), "clock", $("fontClock") === select ? spec : parseFont($("fontClock").value));
  say("ok", r.message || `"${r.name}" is in the fonts folder now; save to use it.`);
}

async function updatePreview() {
  const css = async (spec, fallback) => {
    if (spec.kind === "file") {
      try { return `"${await faceFor(spec.file)}", ${fallback}`; }
      catch (err) { $("previewName").textContent = `The font "${spec.file}" didn't load (${err.message}); the preview uses the system font.`; return fallback; }
    }
    return spec.family === "inherit" ? null : STACK[spec.family];
  };
  $("previewName").textContent = "Clock face shown above; the rest of the page uses the interface font.";
  const ui = await css(parseFont($("fontUi").value), STACK.sans);
  const clock = (await css(parseFont($("fontClock").value), ui)) || ui;
  $("preview").style.fontFamily = clock;
  document.body.style.fontFamily = ui;
}
/* The preview shows the live time (a fixed sample read like a broken clock), in the dashboard's format. */
function tickPreview() {
  $("previewTime").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* ---------- status lights: each one's full reason (the wall shows a short label) ---------- */
function renderLights(l) {
  const box = $("lights");
  if (!l || l.error || !Array.isArray(l.services)) {
    const p = document.createElement("p");
    p.className = "hint warn";
    p.textContent = (l && l.error) || "The server sent no status lights (an older version?). Reload the page.";
    box.replaceChildren(p);
    return;
  }
  const rows = [];
  const walk = (ns, depth) => ns.forEach((n) => {
    const row = document.createElement("div");
    row.className = "l";
    row.style.paddingLeft = `calc(${depth * 26}*var(--u))`;
    const dot = document.createElement("span");
    dot.className = `dot ${n.state}`;
    const full = document.createElement("span");
    full.className = "full";
    full.textContent = n.state === "ok" ? "" : (n.reason || n.short || "no reason given (a bug: please report it)");
    row.append(dot, n.name, full);
    rows.push(row);
    walk(n.children || [], depth + 1);
  });
  walk(l.services, 0);
  if (!rows.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "No status lights are set up."; rows.push(p); }
  box.replaceChildren(...rows);
}

/* ---------- cameras ---------- */
function updateGrid() {
  const rows = [...$("cams").children];
  const on = rows.filter((r) => !r.classList.contains("missing") && r.querySelector(".shown input").checked).length;
  const full = on >= loaded.gridMax;
  for (const r of rows) {
    if (r.classList.contains("missing")) continue;
    const box = r.querySelector(".shown input");
    box.disabled = full && !box.checked;
    box.title = box.disabled ? `the grid shows ${loaded.gridMax}; switch one off first` : "";
  }
  rows.forEach((r, i) => { r.querySelector(".up").disabled = i === 0; r.querySelector(".down").disabled = i === rows.length - 1; });
  const hint = $("gridhint");
  hint.textContent = full
    ? `${on} of ${loaded.gridMax} tiles in use: the grid is full. To show another camera, switch one off first.`
    : `${on} of ${loaded.gridMax} tiles in use.`;
  hint.classList.toggle("warn", full);
}

function camRow(cam) {
  const row = document.createElement("div");
  row.className = "cam";
  row.dataset.camera = cam.camera;
  const label = document.createElement("input");
  label.type = "text"; label.value = cam.label; label.maxLength = 40;
  label.setAttribute("aria-label", `Dashboard label for ${cam.camera}`);
  label.title = `Only on the dashboard; the HomeKit name stays "${cam.camera}"`;
  const key = document.createElement("span");
  key.className = "key"; key.textContent = cam.camera; key.title = cam.camera;
  const shown = document.createElement("label");
  shown.className = "shown";
  const box = document.createElement("input");
  box.type = "checkbox"; box.checked = cam.shown;
  box.setAttribute("aria-label", `Show ${cam.camera} on the dashboard`);
  box.addEventListener("change", updateGrid);
  shown.append(box);
  const stream = document.createElement("select");
  stream.setAttribute("aria-label", `Stream for ${cam.camera}`);
  for (const [v, t] of [["main", "main"], ["sub", cam.hasSub === false ? "sub (none)" : "sub"]]) {
    const o = document.createElement("option"); o.value = v; o.textContent = t; stream.append(o);
  }
  if (cam.hasSub === false) { stream.options[1].disabled = true; stream.title = "This camera has no sub stream in config.json (rtspSub), so it shows main."; }
  stream.value = cam.stream;
  const moves = document.createElement("span");
  moves.className = "moves";
  for (const [cls, txt, dir] of [["up", "↑", -1], ["down", "↓", 1]]) {
    const b = document.createElement("button");
    b.type = "button"; b.className = cls; b.textContent = txt;
    b.setAttribute("aria-label", `Move ${cam.camera} ${cls}`);
    b.addEventListener("click", () => {
      const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sib) return;
      if (dir < 0) sib.before(row); else sib.after(row);
      dirty = true;
      updateGrid();
    });
    moves.append(b);
  }
  row.append(label, key, shown, stream, moves);
  if (cam.missing) {
    row.classList.add("missing");
    for (const c of [label, box, stream]) c.disabled = true;
    const why = document.createElement("div");
    why.className = "why";
    why.textContent = `"${cam.camera}" isn't in config.json any more, so it can't be shown. Saving drops it from this list.`;
    row.append(why);
  }
  return row;
}

/* ---------- load and save ---------- */
function render(data) {
  loaded = data;
  dashUrl = data.dashUrl || dashUrl;
  $("back").href = dashUrl;
  const s = data.settings;
  $("cxUrl").value = s.constructicon ? s.constructicon.url : "";
  fontSelect($("fontUi"), "ui", s.fonts.ui);
  fontSelect($("fontClock"), "clock", s.fonts.clock);
  void updatePreview();
  $("cams").replaceChildren(...data.cameras.map(camRow));
  renderLights(data.lights);
  updateGrid();
  $("phSource").value = s.photos.source;
  $("phUrl").value = s.photos.icloudUrl;
  $("phFolder").value = s.photos.folder;
  $("phSecs").value = s.photos.rotateSeconds;
  $("phCap").value = s.photos.caption;
  $("wxPlace").value = s.weather.place;
  $("wxUnit").value = s.weather.unit;
  $("wxLat").value = s.weather.lat === null ? "" : s.weather.lat;
  $("wxLon").value = s.weather.lon === null ? "" : s.weather.lon;
  $("idle").value = s.idleSeconds;
  $("reload").value = s.reloadMinutes;
  $("poll").value = s.pollSeconds;
  if (data.warning) say("err", data.warning);
  $("save").disabled = false;
}

function payload() {
  const s = loaded.settings;
  const wx = { place: $("wxPlace").value, unit: $("wxUnit").value };
  // only send coordinates when they were edited, so changing the place looks it up again
  if ($("wxLat").value !== String(s.weather.lat ?? "")) wx.lat = $("wxLat").value;
  if ($("wxLon").value !== String(s.weather.lon ?? "")) wx.lon = $("wxLon").value;
  return {
    fonts: { ui: parseFont($("fontUi").value), clock: parseFont($("fontClock").value) },
    constructicon: { url: $("cxUrl").value },
    cameras: [...$("cams").children].filter((r) => !r.classList.contains("missing")).map((r) => ({
      camera: r.dataset.camera,
      label: r.querySelector("input[type=text]").value,
      shown: r.querySelector(".shown input").checked,
      stream: r.querySelector("select").value,
    })),
    photos: { source: $("phSource").value, icloudUrl: $("phUrl").value, folder: $("phFolder").value, rotateSeconds: $("phSecs").value, caption: $("phCap").value },
    weather: wx,
    idleSeconds: $("idle").value, reloadMinutes: $("reload").value, pollSeconds: $("poll").value,
  };
}

async function save() {
  const btn = $("save");
  btn.disabled = true;
  say("", "Saving...");
  const r = await api("PUT", "/api/dash/settings", payload());
  btn.disabled = false;
  if (r.error) { sayError(r.error); return; }
  dirty = false;
  say("ok", `${r.message || "Saved."} Going back to the dashboard...`);
  await leave();
}

/* Same idle fall-back as the camera fullscreen, only when opened from the kiosk's Settings button. */
function startIdleReturn(total) {
  if (!fromDash || !total) return;
  let last = Date.now();
  $("idlebar").hidden = false;
  const touch = () => { last = Date.now(); };
  ["pointerdown", "keydown", "input", "scroll", "wheel", "touchstart"].forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
  let leaving = false;
  setInterval(() => {
    const left = Math.max(0, total - Math.floor((Date.now() - last) / 1000));
    $("idlemsg").textContent = `Back to the dashboard (and signed out) in ${left}s` + (dirty ? "; unsaved changes will be lost" : "");
    $("idletxt").classList.toggle("warn", dirty);
    $("idlefill").style.width = Math.round((left / total) * 100) + "%";
    if (left <= 0 && !leaving) { leaving = true; void leave().finally(() => { leaving = false; last = Date.now(); }); }
  }, 1000);
}

async function init() {
  tickPreview();
  setInterval(tickPreview, 1000);
  if (/TEST/.test(document.title)) $("env").hidden = false;
  ["input", "change"].forEach((e) => document.addEventListener(e, () => { dirty = true; }, true));
  for (const [id, role] of [["fontUi", "ui"], ["fontClock", "clock"]]) {
    const sel = $(id);
    sel.addEventListener("focus", () => { if (!sel.value.startsWith("cx:")) sel.dataset.prev = sel.value; });
    sel.addEventListener("change", async () => { await pickConstructicon(sel, role); void updatePreview(); });
  }
  $("save").addEventListener("click", () => void save());
  $("back").addEventListener("click", (e) => {
    e.preventDefault();
    if (dirty && !window.confirm("Discard your unsaved changes and go back to the dashboard?")) return;
    void leave();
  });
  $("signout").addEventListener("click", async () => {
    const r = await api("POST", "/api/logout");
    if (r.error) { sayError(r.error); return; }
    location.href = "/#/login";
  });
  const s = await api("GET", "/api/session");
  if (s.error) { sayError(s.error); return; }
  if (!s.signedIn) { location.href = signInUrl(); return; }
  csrf = s.csrf;
  if (s.dash && s.dash.url) { dashUrl = s.dash.url; $("back").href = dashUrl; }
  const d = await api("GET", "/api/dash/settings");
  if (d.error) { sayError(d.error); startIdleReturn(s.dash ? s.dash.idleSeconds : 30); return; }
  render(d);
  dirty = false;
  startIdleReturn(d.settings.idleSeconds);
}
void init();
