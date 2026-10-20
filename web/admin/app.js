// unscrypted admin pane. One file, no framework, no build step.
// Everything that comes from the server (camera names are user input) is inserted as text,
// never as HTML.

const app = document.getElementById("app");
const banners = document.getElementById("banners");
let csrf = null;
let lastStatus = null;
let statusError = null;
let notices = { prebufferRestart: "", prebufferFields: [] };

// ---------- helpers ----------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

function networkError(method, path, err) {
  return {
    attempted: `${method} ${path}`,
    happened: `Couldn't reach the admin pane (${err && err.message ? err.message : err}).`,
    changed: "Unknown: the request may not have arrived.",
    next: "The bridge or the pane may be restarting. Wait a few seconds and reload the page.",
  };
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  let r;
  try {
    r = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  } catch (err) {
    return { status: 0, error: networkError(method, path, err) };
  }
  let j;
  try {
    j = await r.json();
  } catch {
    j = { error: { attempted: `${method} ${path}`, happened: `The server answered ${r.status} with something that isn't JSON.`, changed: "Unknown.", next: "Reload the page; if it repeats, check docker logs unscrypted." } };
  }
  if (r.status === 401 && path !== "/api/login") {
    csrf = null;
    if (location.hash !== "#/login") location.hash = "#/login";
  }
  return { status: r.status, ...j };
}

function errorBox(e) {
  const d = el("div", { class: "err", role: "alert" });
  for (const [label, k] of [["What we tried", "attempted"], ["What happened", "happened"], ["What changed", "changed"], ["What to do", "next"]]) {
    d.append(el("p", {}, el("b", {}, `${label}: `), e && e[k] ? e[k] : "(not given)"));
  }
  return d;
}

function msgBox(kind, ...lines) {
  return el("div", { class: `msg ${kind}`, role: "status" }, ...lines.filter(Boolean).map((l) => el("p", {}, l)));
}

function ago(ms) {
  if (!ms) return "never since start";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function setActiveNav() {
  for (const a of document.querySelectorAll("nav a")) a.classList.toggle("active", location.hash.startsWith(a.getAttribute("href")));
}

function go2rtcRunning() {
  return Boolean(lastStatus && lastStatus.go2rtc && lastStatus.go2rtc.state === "running");
}

function go2rtcWhy() {
  if (!lastStatus) return statusError ? `Bridge status unavailable: ${statusError.happened}` : "Waiting for the bridge's status...";
  const g = lastStatus.go2rtc;
  const when = g.nextRetryAt ? `, restarting in ${Math.max(0, Math.round((g.nextRetryAt - Date.now()) / 1000))}s` : "";
  return `Feed check unavailable: go2rtc isn't running (${g.state}${when}).${g.lastError ? ` Last error: ${g.lastError}` : ""}`;
}

// ---------- header, banners, status polling ----------

async function refreshStatus() {
  if (!csrf) return;
  const s = await api("GET", "/api/status");
  if (s.error) { statusError = s.error; lastStatus = null; } else { statusError = null; lastStatus = s; }
  renderBanners();
}

function renderBanners() {
  banners.replaceChildren();
  const dot = document.getElementById("g2dot");
  dot.hidden = !csrf;
  if (!csrf) return;
  if (statusError) {
    banners.append(el("div", { class: "banner bad" }, statusError.happened, " ", statusError.next));
  }
  if (lastStatus && !go2rtcRunning()) {
    banners.append(el("div", { class: "banner bad" }, go2rtcWhy()));
  }
  dot.classList.toggle("bad", !go2rtcRunning());
  dot.title = go2rtcRunning() ? "go2rtc running: previews and feed checks available" : go2rtcWhy();
  const pending = lastStatus ? lastStatus.cameras.filter((c) => c.pendingRestart).map((c) => c.name) : [];
  if (pending.length) {
    const btn = el("button", { type: "button", class: "primary", onclick: () => restartBridge(btn) }, "Restart bridge");
    banners.append(el("div", { class: "banner warn" },
      `Waiting for a bridge restart: ${pending.join(", ")}. Home shows cameras as No Response for about 30 seconds.`, btn));
  }
}

async function restartBridge(btn) {
  if (!confirm("Restart the bridge now? Home shows every camera as No Response for about 30 seconds, and you'll need to sign in again.")) return;
  btn.disabled = true;
  btn.textContent = "Restarting...";
  const r = await api("POST", "/api/bridge/restart");
  if (r.error) {
    btn.disabled = false;
    btn.textContent = "Restart bridge";
    banners.prepend(el("div", { class: "banner bad" }, errorBox(r.error)));
    return;
  }
  banners.prepend(el("div", { class: "banner warn" }, r.message || "Restarting.", " This page signs you out; sign in again in about 30 seconds."));
}

// ---------- routing ----------

async function route() {
  setActiveNav();
  const h = location.hash || "#/cameras";
  if (h === "#/login") return renderLogin();
  if (!csrf) {
    const s = await api("GET", "/api/session");
    if (!s.signedIn) { location.hash = "#/login"; return renderLogin(s.setupError); }
    csrf = s.csrf;
  }
  document.getElementById("nav").hidden = false;
  await refreshStatus();
  setActiveNav();
  if (h.startsWith("#/camera/")) return renderForm(decodeURIComponent(h.slice("#/camera/".length)));
  if (h === "#/add") return renderForm(null);
  if (h === "#/pairing") return renderPairing();
  if (h === "#/status") return renderStatus();
  return renderCameras();
}

// ---------- sign-in ----------

// After sign-in, go back where the visitor was sent from. Only the dashboard settings page is a
// valid target, so a crafted link can't bounce someone off to another site.
const NEXT = (() => {
  const n = new URLSearchParams(location.search).get("next");
  return n && /^\/dash-settings(\?from=dash)?$/.test(n) ? n : null;
})();
let loginIdleTimer = null;
/* Arrived from the kiosk's Settings button: if nobody types, go back to the dashboard. */
function loginIdleReturn(dash) {
  if (!NEXT || !NEXT.endsWith("from=dash") || !dash || !dash.url || loginIdleTimer) return;
  const total = Math.max(15, dash.idleSeconds || 30);
  let last = Date.now();
  ["pointerdown", "keydown", "input"].forEach((e) => window.addEventListener(e, () => { last = Date.now(); }, { capture: true }));
  const note = el("p", { class: "hint" });
  app.querySelector("form")?.append(note);
  loginIdleTimer = setInterval(() => {
    const left = Math.max(0, total - Math.floor((Date.now() - last) / 1000));
    note.textContent = `Back to the dashboard in ${left}s if nobody signs in.`;
    if (left <= 0) location.href = dash.url;
  }, 1000);
}

async function renderLogin(setupError) {
  document.getElementById("nav").hidden = true;
  banners.replaceChildren();
  document.getElementById("g2dot").hidden = true;
  const s = await api("GET", "/api/session");
  if (s.signedIn) { csrf = s.csrf; if (NEXT) location.href = NEXT; else location.hash = "#/cameras"; return; }
  if (setupError === undefined) setupError = s.setupError;
  const out = el("div");
  const pw = el("input", { type: "password", id: "pw", autocomplete: "current-password", required: true });
  const btn = el("button", { type: "submit", class: "primary" }, "Sign in");
  const form = el("form", { class: "login", onsubmit: async (ev) => {
    ev.preventDefault();
    btn.disabled = true;
    btn.textContent = "Signing in...";
    const r = await api("POST", "/api/login", { password: pw.value });
    btn.disabled = false;
    btn.textContent = "Sign in";
    if (r.error) { out.replaceChildren(errorBox(r.error)); return; }
    csrf = r.csrf;
    pw.value = "";
    if (NEXT) { location.href = NEXT; return; }
    location.hash = "#/cameras";
  } },
  el("h1", {}, NEXT ? "Sign in for the dashboard settings" : "Sign in"),
  el("label", { class: "field", for: "pw" }, "Admin password", pw),
  btn,
  el("p", { class: "hint" }, "The password is in secrets/admin_password next to the container's compose file. Signing in keeps you signed in on this browser for 30 days, or until the bridge restarts."),
  out);
  if (setupError) out.append(errorBox(setupError));
  app.replaceChildren(form);
  pw.focus();
  loginIdleReturn(s.dash);
}

document.getElementById("logout").addEventListener("click", async () => {
  const r = await api("POST", "/api/logout");
  if (r.error) { app.prepend(errorBox(r.error)); return; }
  csrf = null;
  lastStatus = null;
  location.hash = "#/login";
});

// ---------- cameras list ----------

function snapshotTile(stream) {
  const tile = el("div", { class: "tile" });
  if (!go2rtcRunning()) { tile.append(go2rtcWhy()); return tile; }
  const img = el("img", { alt: "Latest snapshot", src: `/go2rtc/api/frame.jpeg?src=${encodeURIComponent(stream)}&t=${Date.now()}` });
  tile.append("Loading snapshot...");
  img.addEventListener("load", () => tile.replaceChildren(img));
  img.addEventListener("error", async () => {
    // The <img> can't show why; ask the same address for its JSON error.
    let why = "the snapshot didn't load";
    try {
      const r = await fetch(img.src, { credentials: "same-origin" });
      const j = await r.json().catch(() => null);
      why = j && j.error ? `${j.error.happened} ${j.error.next}` : `go2rtc answered ${r.status}; the camera may be offline or the stream path wrong. Try "Check feed".`;
    } catch (err) {
      why = `couldn't reach the pane: ${err.message}`;
    }
    tile.replaceChildren(`No snapshot: ${why}`);
  });
  return tile;
}

// The bridge writes times in status text as {{t:<ms>}}; show them in this viewer's local time.
const clockTime = (ms) => new Date(Number(ms)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const localTimes = (s) => String(s).replace(/\{\{t:(\d+)\}\}/g, (_, ms) => clockTime(ms));

// go2rtc's view of a stream (#16): read from go2rtc's own state, never by probing the camera.
function feedText(f) {
  if (!f) return el("span", { class: "muted" }, "unknown: go2rtc isn't running, so the camera's state can't be read");
  switch (f.state) {
    case "streaming": return el("span", { class: "good" }, `video flowing (${f.consumers} viewer${f.consumers === 1 ? "" : "s"} through go2rtc)`);
    case "starting": return el("span", { class: "muted" }, "connecting...");
    case "idle": return el("span", { class: "muted" }, f.lastVideoAt ? `idle: nobody is watching (last video ${clockTime(f.lastVideoAt)})` : "idle: nobody has watched it since the bridge started");
    case "stalled": case "down": return el("span", { class: "badtext" }, `${f.reason} (since ${clockTime(f.since)})`);
    default: return el("span", { class: "muted" }, f.reason || "unknown");
  }
}
const viaText = (v) => (v === "go2rtc" ? "through go2rtc" : "the camera directly");
function bufferText(p) {
  if (!p.running) return "off (HomeKit hasn't turned recording on)";
  const age = p.lastFragmentAt ? `, last fragment ${Math.max(0, Math.round((Date.now() - p.lastFragmentAt) / 1000))} s ago` : ", no video yet";
  return `running, reading ${viaText(p.via)}${age}`;
}

const MOTION_LABEL = { "foscam-cgi": "Foscam CGI", onvif: "ONVIF", none: "none" };

// ---------- camera logins (#18) ----------
// The list only has user names. Passwords come from POST /api/cameras/<name>/credentials, one
// camera at a time, only when Show is pressed; they re-mask on Hide or after REVEAL_MS.

const MASKED = "••••••••";
const REVEAL_MS = 60_000;
const LOGIN_LABEL = { rtsp: "RTSP", foscam: "Foscam CGI", onvif: "ONVIF" };

/** The user names the redacted list already carries (no passwords), so nothing is fetched on load. */
function listedLogins(cam) {
  const urlUser = (u) => { const m = /^rtsp:\/\/([^:/@]+):[^@]*@/i.exec(u || ""); return m ? decodeURIComponent(m[1]) : null; };
  const rtspUser = cam.rtspUser !== undefined || cam.rtspPassword !== undefined ? (cam.rtspUser || "") : (urlUser(cam.rtspMain) ?? urlUser(cam.rtspSub));
  return {
    rtsp: rtspUser !== null ? { user: rtspUser } : null,
    foscam: cam.foscam ? { user: cam.foscam.username || "" } : null,
    onvif: cam.onvif ? { user: cam.onvif.username || "" } : null,
  };
}

/** Copy to the clipboard. The pane is plain http on the LAN, where navigator.clipboard doesn't exist, so fall back to a selection copy. */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return null; } catch (err) { /* fall through to the selection copy */ }
  }
  const ta = el("textarea", { readonly: true, class: "copybuf", "aria-hidden": "true" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok ? null : "The browser refused to copy. Press Show, select the text and copy it by hand.";
}

function copyButton(label, getValue, out) {
  const b = el("button", { type: "button", class: "link", onclick: async () => {
    const v = getValue();
    if (v === null) { out.replaceChildren(el("span", { class: "badtext" }, "Press Show first: the password isn't loaded yet.")); return; }
    const err = await copyText(v);
    out.replaceChildren(err ? el("span", { class: "badtext" }, err) : el("span", { class: "good" }, `${label} copied.`));
    if (!err) setTimeout(() => { if (out.textContent === `${label} copied.`) out.replaceChildren(); }, 3000);
  } }, "Copy");
  b.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
  return b;
}

function loginBox(cam) {
  const box = el("div", { class: "logins" });
  const rows = el("dl", { class: "facts" });
  const out = el("div", { class: "small", role: "status" });
  const showBtn = el("button", { type: "button", class: "secondary small" }, "👁 Show");
  let shown = null;   // the server's answer while shown, else null
  let timer = null;

  const draw = () => {
    const src = shown || listedLogins(cam);
    rows.replaceChildren();
    for (const kind of ["rtsp", "foscam", "onvif"]) {
      const l = src[kind];
      if (!l) continue;
      const pw = shown ? l.password : null;
      rows.append(
        el("dt", {}, `${LOGIN_LABEL[kind]} user`),
        el("dd", {}, el("span", { class: "secret" }, l.user || "(none)"), " ", copyButton(`${LOGIN_LABEL[kind]} user name`, () => l.user, out)),
        el("dt", {}, `${LOGIN_LABEL[kind]} password`),
        el("dd", {}, el("span", { class: "secret" }, pw === null ? MASKED : (pw || "(empty)")), " ", copyButton(`${LOGIN_LABEL[kind]} password`, () => pw, out)));
    }
    if (shown) {
      rows.append(el("dt", {}, "Web UI"), el("dd", {}, shown.webUi
        ? el("a", { href: shown.webUi, target: "_blank", rel: "noopener noreferrer" }, shown.webUi)
        : el("span", { class: "muted" }, "No address in config.json to link to.")));
    }
    if (!rows.childNodes.length) rows.append(el("dt", {}, "Logins"), el("dd", { class: "muted" }, "None in config.json for this camera."));
    showBtn.textContent = shown ? "Hide" : "👁 Show";
  };
  const hide = () => { if (timer) clearTimeout(timer); timer = null; shown = null; draw(); };

  showBtn.addEventListener("click", async () => {
    if (shown) { hide(); out.replaceChildren(); return; }
    showBtn.disabled = true;
    showBtn.textContent = "Loading...";
    const r = await api("POST", `/api/cameras/${encodeURIComponent(cam.name)}/credentials`, {});
    showBtn.disabled = false;
    if (r.error) { draw(); out.replaceChildren(errorBox(r.error)); return; }
    shown = r;
    out.replaceChildren(el("span", { class: "muted" }, "Shown for 60 seconds, then hidden again."));
    draw();
    timer = setTimeout(() => { hide(); out.replaceChildren(el("span", { class: "muted" }, "Hidden again after 60 seconds.")); }, REVEAL_MS);
  });

  draw();
  box.append(el("div", { class: "row" }, el("b", {}, "Login"), showBtn), rows, out);
  return box;
}

async function renderCameras() {
  const r = await api("GET", "/api/cameras");
  if (r.error) { app.replaceChildren(el("h1", {}, "Cameras"), errorBox(r.error)); return; }
  notices = r.notices || notices;
  const byName = new Map((lastStatus ? lastStatus.cameras : r.status || []).map((s) => [s.name, s]));
  const grid = el("div", { class: "grid" });
  for (const cam of r.cameras) {
    const s = byName.get(cam.name);
    const facts = el("dl", { class: "facts" });
    const add = (k, v) => facts.append(el("dt", {}, k), el("dd", {}, v));
    if (!s) {
      add("Status", "Not running yet (saved, waiting for the bridge or a restart).");
    } else {
      add("Motion source", MOTION_LABEL[s.motionKind] || s.motionKind);
      add("HKSV", s.hksv ? "on" : "off");
      add("Video", feedText(s.feed));
      if (s.subFeed) add("Sub stream", feedText(s.subFeed));
      add("HomeKit reads", s.direct ? el("span", { class: "badtext" }, `the camera directly until ${clockTime(s.direct.until)}: ${s.direct.reason}`) : viaText(s.via));
      if (s.prebuffer) add("Recording buffer", bufferText(s.prebuffer));
      add("Live viewers", String(s.liveSessions));
      add("Recording", s.recordingActive ? "on" : "off");
      add("Last motion", ago(s.lastMotionAt));
      if (s.pendingRestart) add("Pending", el("span", { class: "badtext" }, "change waits for a bridge restart"));
    }
    const checkOut = el("div");
    const checkBtn = el("button", { type: "button", class: "secondary", disabled: !go2rtcRunning(), title: go2rtcRunning() ? null : go2rtcWhy(),
      onclick: () => checkFeed(cam.name, {}, checkOut, checkBtn) }, "Check feed");
    grid.append(el("div", { class: "card" },
      el("h3", {}, cam.name),
      s ? snapshotTile(s.stream) : el("div", { class: "tile" }, "No snapshot: this camera isn't running yet."),
      facts,
      loginBox(cam),
      el("div", { class: "row" },
        el("button", { type: "button", class: "primary", onclick: () => { location.hash = `#/camera/${encodeURIComponent(cam.name)}`; } }, "Edit"),
        checkBtn),
      go2rtcRunning() ? null : el("p", { class: "why" }, go2rtcWhy()),
      checkOut));
  }
  const notes = lastStatus && lastStatus.notices ? lastStatus.notices.filter((n) => /HomeKit is off|HomeKit is reading/.test(n)) : [];
  app.replaceChildren(el("h1", {}, "Cameras"), ...notes.map((n) => msgBox("amber", localTimes(n))),
    r.cameras.length ? grid : el("p", { class: "muted" }, "No cameras in config.json yet. Use Add camera."));
}

// ---------- feed check + live preview ----------

async function checkFeed(name, edit, out, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Checking...";
  out.replaceChildren(el("p", { class: "muted" }, "Asking go2rtc for one frame (up to 15 seconds)..."));
  const r = await api("POST", "/api/cameras/check", { name: name || undefined, edit });
  btn.disabled = false;
  btn.textContent = label;
  if (r.error) { out.replaceChildren(errorBox(r.error)); return; }
  const tile = el("div", { class: "tile" }, el("img", { alt: "Frame from the feed check", src: r.frameUrl }));
  // Live preview only for a configured stream: an edited or new address gets one frame and its test connection closes (#16).
  const live = r.wsUrl ? el("button", { type: "button", class: "secondary", onclick: () => watchLive(r, tile, live) }, "Watch live") : null;
  const stop = el("button", { type: "button", class: "secondary", onclick: () => out.replaceChildren(msgBox("ok", "Preview closed.")) }, "Close preview");
  const msg = r.reused
    ? "The feed works: go2rtc got a frame from the stream it already has (no extra connection to the camera). Nothing was saved."
    : "The feed works: go2rtc got a frame. The test connection to the camera was closed right away (these cameras tolerate about one viewer). Nothing was saved. Save the camera to get a live preview.";
  out.replaceChildren(msgBox("ok", msg), tile, el("div", { class: "row" }, ...(live ? [live] : []), stop));
}

async function watchLive(check, tile, btn) {
  btn.disabled = true;
  try {
    const mod = await import("/go2rtc/video-rtc.js");
    if (!customElements.get("video-rtc")) customElements.define("video-rtc", mod.VideoRTC);
    const v = document.createElement("video-rtc");
    // WebRTC, video only: exactly how Homedash plays these cameras. Their streams don't play over
    // MSE in Chrome (go2rtc's own MSE player fails on them too). Signalling goes through the
    // pane's signed-in WebSocket proxy; the video itself comes from go2rtc's WebRTC port.
    v.mode = "webrtc";
    v.media = "video";
    v.background = true;
    v.src = new URL(check.wsUrl, location.href).href;
    tile.replaceChildren(v);
  } catch (err) {
    btn.disabled = false;
    tile.replaceChildren(`Live preview didn't start: ${err.message}. The frame above shows the feed works; check docker logs unscrypted for go2rtc lines.`);
  }
}

// ---------- add / edit form ----------

const PART_FIELDS = [["host", "Camera address (IP or host name)", "text"], ["rtspPort", "RTSP port", "number", "554"], ["rtspUser", "User name", "text"],
  ["rtspPassword", "Password", "password"], ["rtspMainPath", "Main stream path", "text", "/videoMain"], ["rtspSubPath", "Sub stream path", "text", "/videoSub"]];
const FOSCAM_FIELDS = [["cgiBase", "CGI base URL", "text", "http://192.168.1.50:88"], ["username", "User name", "text"], ["password", "Password", "password"],
  ["pollIntervalMs", "Poll every (ms)", "number", "1000"], ["motionCooldownMs", "Hold motion for (ms)", "number", "8000"]];
const ONVIF_FIELDS = [["host", "ONVIF address", "text"], ["port", "ONVIF port", "number", "80 (XM cameras: 8080)"], ["username", "User name", "text"],
  ["password", "Password", "password"], ["notifyPort", "Push receiver port", "number", "0 = random"], ["notifyHost", "Push receiver address", "text", "auto-detected"],
  ["pollIntervalMs", "PullPoint wait (ms)", "number", "60000"], ["motionCooldownMs", "Hold motion for (ms)", "number", "8000"]];

function input(key, label, type, placeholder, value, opts = {}) {
  const isSecret = type === "password";
  const set = isSecret && value && typeof value === "object" && value.set;
  const i = el("input", {
    name: key, type, autocomplete: isSecret ? "new-password" : "off",
    placeholder: set ? "saved (leave blank to keep)" : placeholder || "",
    readonly: opts.readonly, min: opts.min, step: type === "number" ? "1" : null,
  });
  if (!isSecret && value !== undefined && value !== null) i.value = String(value);
  return { i, node: el("label", { class: "field" }, label, i) };
}

/** Text/number field -> value to send: typed value, null to clear a stored one, undefined to leave alone. */
function fieldValue(inputEl, original, type) {
  const v = inputEl.value.trim();
  if (type === "password") return v ? inputEl.value : undefined;   // blank = keep the stored secret
  if (!v) return original !== undefined && original !== null ? null : undefined;
  if (type === "number") return Number(v);
  return v;
}

async function renderForm(name) {
  const isNew = name === null;
  const r = await api("GET", "/api/cameras");
  if (r.error) { app.replaceChildren(el("h1", {}, isNew ? "Add camera" : "Edit camera"), errorBox(r.error)); return; }
  notices = r.notices || notices;
  const cam = isNew ? { hksv: true, audio: true, copyVideo: true, prebufferSeconds: 4 } : r.cameras.find((c) => c.name === name);
  if (!cam) {
    app.replaceChildren(el("h1", {}, "Edit camera"), errorBox({ attempted: `Open camera "${name}"`, happened: "There's no camera with that name in config.json.", changed: "Nothing.", next: "Go back to Cameras and pick one from the list." }));
    return;
  }
  const inputs = {};
  const nameIn = input("name", "Name", "text", "e.g. Back Gate", cam.name, { readonly: !isNew });
  inputs.name = nameIn.i;
  const nameHint = isNew
    ? el("p", { class: "hint" }, "Pick carefully: this name is permanent. Home uses it as the camera's identity, so it can't be changed later.")
    : el("p", { class: "hint lock" }, "Name is the camera's HomeKit identity and can't be changed here. Rename it in the Home app instead.");

  // Stream: full URLs or parts.
  const usesParts = !cam.rtspMain && Boolean(cam.host);
  const modeUrl = el("input", { type: "radio", name: "smode", value: "url", checked: !usesParts });
  const modeParts = el("input", { type: "radio", name: "smode", value: "parts", checked: usesParts });
  const mainIn = input("rtspMain", "Main stream URL", "text", "rtsp://user:password@192.168.1.50:554/videoMain", cam.rtspMain);
  const subIn = input("rtspSub", "Sub stream URL (optional)", "text", "rtsp://user:password@192.168.1.50:554/videoSub", cam.rtspSub);
  const urlBox = el("div", { class: "two" }, mainIn.node, subIn.node);
  const urlHint = el("p", { class: "hint" }, "A password shown as *** stays as saved. Type a new one in its place to change it.");
  const partIns = PART_FIELDS.map(([k, l, t, p]) => [k, t, input(k, l, t, p, cam[k])]);
  const partBox = el("div", { class: "two" }, partIns.map(([, , x]) => x.node));
  const showMode = () => { urlBox.hidden = urlHint.hidden = !modeUrl.checked; partBox.hidden = !modeParts.checked; };
  modeUrl.addEventListener("change", showMode);
  modeParts.addEventListener("change", showMode);

  // Motion source.
  const kind = cam.foscam ? "foscam" : cam.onvif ? "onvif" : "none";
  const radios = ["none", "foscam", "onvif"].map((k) => el("input", { type: "radio", name: "motion", value: k, checked: kind === k }));
  const fosIns = FOSCAM_FIELDS.map(([k, l, t, p]) => [k, t, input(k, l, t, p, cam.foscam && cam.foscam[k])]);
  const onvIns = ONVIF_FIELDS.map(([k, l, t, p]) => [k, t, input(k, l, t, p, cam.onvif && cam.onvif[k])]);
  const fosBox = el("div", { class: "two" }, fosIns.map(([, , x]) => x.node));
  const onvBox = el("div", { class: "two" }, onvIns.map(([, , x]) => x.node));
  const showMotion = () => { fosBox.hidden = !radios[1].checked; onvBox.hidden = !radios[2].checked; };
  radios.forEach((r) => r.addEventListener("change", showMotion));

  // Recording / HomeKit.
  const hksv = el("input", { type: "checkbox", checked: cam.hksv !== false });
  const audio = el("input", { type: "checkbox", checked: cam.audio !== false });
  const copy = el("input", { type: "checkbox", checked: cam.copyVideo !== false });
  const pre = input("prebufferSeconds", "Prebuffer seconds (at least 4)", "number", "4", cam.prebufferSeconds, { min: 4 });
  const maxRec = input("maxRecordingSeconds", "Longest clip (seconds, max 180)", "number", "170", cam.maxRecordingSeconds);
  const manu = input("manufacturer", "Manufacturer", "text", "Foscam", cam.manufacturer);
  const model = input("model", "Model", "text", "IP Camera", cam.model);

  const prebufferWarn = el("div", { class: "msg amber", hidden: true }, notices.prebufferRestart);
  const out = el("div");
  const checkOut = el("div");
  const saveBtn = el("button", { type: "submit", class: "primary" }, isNew ? "Add camera" : "Save");
  const checkBtn = el("button", { type: "button", class: "secondary", disabled: !go2rtcRunning(), title: go2rtcRunning() ? null : go2rtcWhy() }, "Check feed");
  const checkWhy = go2rtcRunning() ? null : el("p", { class: "why" }, go2rtcWhy());

  function buildEdit() {
    const e = {};
    const put = (k, v) => { if (v !== undefined) e[k] = v; };
    if (isNew) put("name", inputs.name.value.trim());
    if (modeUrl.checked) {
      put("rtspMain", fieldValue(mainIn.i, cam.rtspMain, "text"));
      put("rtspSub", fieldValue(subIn.i, cam.rtspSub, "text"));
      if (cam.host) e.host = null;   // switching from parts to URLs
    } else {
      for (const [k, t, x] of partIns) put(k, fieldValue(x.i, cam[k], t));
      if (cam.rtspMain) e.rtspMain = null;   // switching from URLs to parts
      if (cam.rtspSub) e.rtspSub = null;
    }
    const block = (ins, stored) => {
      const b = {};
      for (const [k, t, x] of ins) {
        const v = fieldValue(x.i, stored && stored[k], t);
        if (v !== undefined && v !== null) b[k] = v;
      }
      return b;
    };
    if (radios[1].checked) { e.foscam = block(fosIns, cam.foscam); if (cam.onvif) e.onvif = null; }
    else if (radios[2].checked) { e.onvif = block(onvIns, cam.onvif); if (cam.foscam) e.foscam = null; }
    else { if (cam.foscam) e.foscam = null; if (cam.onvif) e.onvif = null; }
    e.hksv = hksv.checked;
    e.audio = audio.checked;
    e.copyVideo = copy.checked;
    put("prebufferSeconds", fieldValue(pre.i, cam.prebufferSeconds, "number"));
    put("maxRecordingSeconds", fieldValue(maxRec.i, cam.maxRecordingSeconds, "number"));
    put("manufacturer", fieldValue(manu.i, cam.manufacturer, "text"));
    put("model", fieldValue(model.i, cam.model, "text"));
    return e;
  }

  // Warn before saving when a change restarts the recording buffer (existing cameras only).
  function updateWarning() {
    if (isNew) return;
    const e = buildEdit();
    const changed = (notices.prebufferFields || []).some((k) => {
      if (!(k in e)) return false;
      if (k === "rtspPassword") return true;
      const before = cam[k] === undefined ? (k === "audio" || k === "copyVideo" ? true : null) : cam[k];
      return JSON.stringify(e[k]) !== JSON.stringify(before);
    });
    prebufferWarn.hidden = !changed;
  }

  checkBtn.addEventListener("click", () => {
    const e = buildEdit();
    if (!isNew) delete e.name;
    checkFeed(isNew ? null : cam.name, e, checkOut, checkBtn);
  });

  const form = el("form", { class: "edit", oninput: updateWarning, onchange: updateWarning, onsubmit: async (ev) => {
    ev.preventDefault();
    saveBtn.disabled = true;
    saveBtn.textContent = isNew ? "Adding..." : "Saving...";
    out.replaceChildren();
    const r2 = isNew ? await api("POST", "/api/cameras", buildEdit()) : await api("PUT", `/api/cameras/${encodeURIComponent(cam.name)}`, buildEdit());
    saveBtn.disabled = false;
    saveBtn.textContent = isNew ? "Add camera" : "Save";
    const extras = [...(r2.notes || []), r2.warning, r2.backupPath ? `Previous config.json kept at ${r2.backupPath}.` : null];
    if (r2.error) {
      out.replaceChildren(errorBox(r2.error), ...(r2.saved ? [msgBox("amber", ...extras)] : []));
    } else {
      const kindClass = r2.status === 200 && r2.mode !== "restart-needed" ? "ok" : "amber";
      out.replaceChildren(msgBox(kindClass, r2.message, ...extras));
      await refreshStatus();
      if (isNew && r2.saved) out.append(el("p", {}, el("a", { href: `#/camera/${encodeURIComponent(inputs.name.value.trim())}` }, "Open the new camera's settings")));
    }
    out.scrollIntoView({ block: "nearest" });
  } },
  el("fieldset", {}, el("legend", {}, "Camera"), nameIn.node, nameHint),
  el("fieldset", {}, el("legend", {}, "Stream"),
    el("div", { class: "row" }, el("label", { class: "check" }, modeUrl, "Full RTSP URLs"), el("label", { class: "check" }, modeParts, "Address + login + paths")),
    urlBox, urlHint, partBox),
  el("fieldset", {}, el("legend", {}, "Motion source"),
    el("div", { class: "row" }, el("label", { class: "check" }, radios[0], "None"), el("label", { class: "check" }, radios[1], "Foscam CGI"), el("label", { class: "check" }, radios[2], "ONVIF")),
    el("p", { class: "hint" }, "Without a motion source nothing triggers HomeKit Secure Video recordings. Changing the source type takes a bridge restart."),
    fosBox, onvBox),
  el("fieldset", {}, el("legend", {}, "Recording and HomeKit"),
    el("label", { class: "check" }, hksv, "HomeKit Secure Video recording"),
    el("label", { class: "check" }, audio, "Camera has audio"),
    el("label", { class: "check" }, copy, "Copy video as-is (no transcode)"),
    el("div", { class: "two" }, pre.node, maxRec.node, manu.node, model.node),
    el("p", { class: "hint" }, "HKSV, prebuffer, manufacturer and model are things Home sees: changing them is saved now and takes effect after a bridge restart.")),
  prebufferWarn,
  el("div", { class: "row" }, saveBtn, checkBtn, el("a", { href: "#/cameras" }, "Back to cameras")),
  checkWhy, checkOut, out);
  showMode();
  showMotion();
  app.replaceChildren(el("h1", {}, isNew ? "Add camera" : `Edit ${cam.name}`), form);
}

// ---------- pairing ----------

async function renderPairing() {
  const body = el("div");
  const refresh = el("button", { type: "button", class: "secondary", onclick: () => renderPairing() }, "Refresh");
  app.replaceChildren(el("h1", {}, "Pairing"), body, refresh);
  const r = await api("GET", "/api/pairing");
  if (r.error) { body.replaceChildren(errorBox(r.error)); return; }
  body.replaceChildren(
    el("img", { class: "qr", src: r.qrImage, alt: "HomeKit pairing QR code" }),
    el("p", {}, "Setup code"),
    el("p", { class: "pin" }, r.pin),
    msgBox(r.paired ? "amber" : "ok", r.note));
}

// ---------- status ----------

async function renderStatus() {
  await refreshStatus();
  if (!lastStatus) { app.replaceChildren(el("h1", {}, "Status"), errorBox(statusError || networkError("GET", "/api/status", "no answer"))); return; }
  const s = lastStatus;
  const facts = el("dl", { class: "facts" });
  const add = (k, v) => facts.append(el("dt", {}, k), el("dd", {}, v));
  add("Bridge", s.bridgeName);
  add("Version", s.version);
  add("Up since", `${new Date(s.startedAt).toLocaleString()} (${ago(s.startedAt).replace(" ago", "")})`);
  add("HomeKit", s.hapEnabled ? `on, port ${s.hapPort}` : "off on this instance (UNSCRYPTED_HAP=off)");
  add("Paired", s.hapEnabled ? (s.paired ? "yes" : "not yet") : "n/a (HomeKit off)");
  add("go2rtc", `${s.go2rtc.state}, ${s.go2rtc.restarts} restart${s.go2rtc.restarts === 1 ? "" : "s"}`);
  add("go2rtc last error", s.go2rtc.lastError || "none");
  if (s.dash) {
    add("Dashboard", `${s.dash.state}, ${s.dash.restarts} restart${s.dash.restarts === 1 ? "" : "s"}`);
    add("Dashboard last error", s.dash.lastError || "none");
  } else {
    add("Dashboard", "not reported by this bridge version");
  }
  add("Cameras", String(s.cameras.length));
  if (s.homekitSource) add("HomeKit reads", s.homekitSource.mode === "go2rtc" ? localTimes(s.homekitSource.text) : el("span", { class: "badtext" }, "the cameras directly (see Notes)"));
  app.replaceChildren(el("h1", {}, "Status"), facts, el("h2", {}, "Notes"),
    ...(s.notices && s.notices.length ? s.notices.map((n) => msgBox("amber", localTimes(n))) : [el("p", { class: "muted" }, "Nothing to report.")]));
}

// ---------- start ----------

window.addEventListener("hashchange", () => void route());
setInterval(() => {
  if (!csrf || location.hash === "#/login") return;
  void (location.hash === "#/status" ? renderStatus() : refreshStatus());
}, 5000);
void route();
