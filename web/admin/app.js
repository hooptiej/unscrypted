// unscrypted admin pane. One file, no framework, no build step.
// Everything that comes from the server (camera names are user input) is inserted as text,
// never as HTML.

const app = document.getElementById("app");
const banners = document.getElementById("banners");
let csrf = null;
let lastStatus = null;
let statusError = null;
let notices = { prebufferRestart: "", prebufferFields: [], recordingStreamSwitch: "" };

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

// The running build stamp (#102), shown in the footer on every screen. Set once we know it.
function showBuild(build) {
  const f = document.getElementById("build");
  if (f && build) f.textContent = build;
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
    showBuild(s.build);
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
/* Arrived from the kiosk's Settings button: if nobody types, go back to the dashboard.
   Esc goes back right away (#27); it doesn't count as activity, so it never restarts the wait. */
function loginIdleReturn(dash) {
  if (!NEXT || !NEXT.endsWith("from=dash") || !dash || !dash.url || loginIdleTimer) return;
  const total = Math.max(15, dash.idleSeconds || 30);
  let last = Date.now();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && location.hash === "#/login") { e.preventDefault(); location.href = dash.url; }
  }, { capture: true });
  ["pointerdown", "keydown", "input"].forEach((e) => window.addEventListener(e, (ev) => { if (ev.key !== "Escape") last = Date.now(); }, { capture: true }));
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
  showBuild(s.build);
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
  el("p", { class: "hint" }, "The password is in secrets/admin_password next to the container's compose file. Signing in keeps you signed in on this browser for 30 days, or until you sign out."),
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

// {{t:<ms>}} tokens in bridge text become the viewer's local time.
function localise(text) {
  return String(text || "").replace(/\{\{t:(\d+)\}\}/g, (_, ms) => new Date(Number(ms)).toLocaleTimeString());
}

const FEED_LABEL = { streaming: ["good", "video flowing"], idle: ["muted", "idle (nobody is reading it right now)"], starting: ["muted", "connecting"],
  stalled: ["badtext", "connected, but the camera stopped sending video"], down: ["badtext", "down"], unknown: ["muted", "unknown"] };

// go2rtc's view of a stream: it is the camera's only client, so this is also "is the camera up?".
function feedText(f) {
  if (!f) return el("span", { class: "muted" }, "not watched in this instance");
  const [cls, label] = FEED_LABEL[f.state] || ["muted", f.state];
  return el("span", { class: cls }, f.reason ? `${label}: ${f.reason}` : label);
}

// Where HomeKit's next read of this camera goes, and why when it isn't the usual.
function viaText(c) {
  if (c.direct) return el("span", { class: "badtext" }, localise(c.direct.text));
  if (c.via === "go2rtc") return el("span", { class: "good" }, "through go2rtc (one connection per camera)");
  return el("span", { class: "muted" }, "the camera directly");
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
      add("Streams", streamsLine(cam.streams, r.dashStreams && r.dashStreams[cam.name]));
    } else {
      add("Motion source", MOTION_LABEL[s.motionKind] || s.motionKind);
      add("HKSV", s.hksv ? "on" : "off");
      if (s.offline) add("Camera", el("span", { class: "badtext" }, `offline since ${new Date(s.offline.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${s.offline.reason}). Home shows a fault on it${s.hksv || s.motionKind !== "none" ? "" : ", if it has a motion sensor, which this camera doesn't"}.`));
      add("Video (go2rtc)", feedText(s.feed));
      if (s.subFeed) add("Sub stream (go2rtc)", feedText(s.subFeed));
      add("HomeKit reads", viaText(s));
      add("Streams", streamsLine(s.streams, r.dashStreams && r.dashStreams[cam.name]));
      add("Live viewers", String(s.liveSessions));
      add("Recording", s.recordingActive ? "on" : "off");
      if (s.prebuffer) add("Recording buffer", s.prebuffer.running
        ? `running, reading the ${s.prebuffer.stream === "sub" ? "sub" : "main"} stream ${s.prebuffer.via === "go2rtc" ? "through go2rtc" : "the camera directly"}${s.prebuffer.lastFragmentAt ? `, last video ${ago(s.prebuffer.lastFragmentAt)}` : ", no video yet"}`
        : "not running (HomeKit hasn't asked for recording)");
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
  const notes = lastStatus && lastStatus.notices ? lastStatus.notices.filter((n) => /HomeKit is off/.test(n)) : [];
  app.replaceChildren(el("h1", {}, "Cameras"), ...notes.map((n) => msgBox("amber", n)),
    r.cameras.length ? globalHoldPanel(r) : null,
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
  const tile = el("div", { class: "tile" }, el("img", { alt: "Frame from the feed check", src: `${r.frameUrl}&t=${Date.now()}` }));
  const live = el("button", { type: "button", class: "secondary", onclick: () => watchLive(r, tile, live) }, "Watch live");
  const stop = el("button", { type: "button", class: "secondary", onclick: async () => {
    const d = await api("DELETE", `/api/cameras/check/${encodeURIComponent(r.stream)}`);
    out.replaceChildren(d.error ? errorBox(d.error) : msgBox("ok", "Preview closed."));
  } }, "Close preview");
  out.replaceChildren(msgBox("ok", "The feed works: go2rtc got a frame. Nothing was saved."), tile, el("div", { class: "row" }, live, stop));
}

async function watchLive(check, tile, btn) {
  btn.disabled = true;
  try {
    const mod = await import("/go2rtc/video-rtc.js");
    if (!customElements.get("video-rtc")) customElements.define("video-rtc", mod.VideoRTC);
    const v = document.createElement("video-rtc");
    v.mode = "mse";
    v.background = true;
    v.src = new URL(check.wsUrl, location.href).href;
    tile.replaceChildren(v);
  } catch (err) {
    btn.disabled = false;
    tile.replaceChildren(`Live preview didn't start: ${err.message}. The frame above shows the feed works; check docker logs unscrypted for go2rtc lines.`);
  }
}

// ---------- the motion hold slider (#90) ----------

/** Seconds the way the pane says them: "60 s", "2 min 30 s". */
function holdText(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** One camera's live motion state, in words, from the 5 s status poll. */
function motionLiveText(name) {
  if (!lastStatus) return "Live motion state: waiting for the bridge's status...";
  if (!lastStatus.hapEnabled) return "Live motion state: unavailable here. HomeKit is off on this instance, so motion sources aren't started.";
  const c = lastStatus.cameras.find((x) => x.name === name);
  if (!c) return "Live motion state: this camera isn't running yet (saved, waiting for the bridge or a restart).";
  if (c.motionKind === "none") return "Live motion state: this camera has no motion source.";
  return `Motion right now: ${c.motionActive ? "ON" : "off"}. Last motion: ${ago(c.lastMotionAt)}.`;
}

/**
 * A "hold motion for" slider, 5 to 180 s (the limits come from the server, which enforces them too).
 *  o.value        ms, or null to follow the default
 *  o.defaultMs    the default it follows
 *  o.canInherit   adds the "use the default" box (per-camera only)
 *  o.disabledWhy  () => string | null; when it says why, the slider is greyed and the reason shows
 *  o.liveFor      camera name whose live motion state shows beside the slider
 * Returns { node, get() -> ms | null (null = follow the default), refresh() }.
 */
function holdControl(o) {
  const minS = Math.round(o.limits.min / 1000), maxS = Math.round(o.limits.max / 1000);
  const hintId = `holdhint-${Math.random().toString(36).slice(2, 8)}`;
  const slider = el("input", { type: "range", min: String(minS), max: String(maxS), step: "1", "aria-describedby": hintId });
  const out = el("output", {});
  const inherit = o.canInherit ? el("input", { type: "checkbox", checked: o.value === null || o.value === undefined }) : null;
  const inheritLabel = inherit ? el("label", { class: "check" }, inherit, `Use the default (${holdText(o.defaultMs)})`) : null;
  const why = el("p", { class: "why", hidden: true });
  const live = o.liveFor ? el("p", { class: "hint live", role: "status" }) : null;
  slider.value = String(Math.round((o.value === null || o.value === undefined ? o.defaultMs : o.value) / 1000));
  const draw = () => {
    const reason = o.disabledWhy ? o.disabledWhy() : null;
    const following = inherit && inherit.checked;
    if (following) slider.value = String(Math.round(o.defaultMs / 1000));
    slider.disabled = Boolean(reason) || Boolean(following);
    if (inherit) inherit.disabled = Boolean(reason);
    out.textContent = following ? `${holdText(o.defaultMs)} (default)` : holdText(Number(slider.value) * 1000);
    why.hidden = !reason;
    why.textContent = reason || "";
    if (live) live.textContent = motionLiveText(o.liveFor);
  };
  slider.addEventListener("input", draw);
  if (inherit) inherit.addEventListener("change", draw);
  const hint = el("p", { class: "hint", id: hintId }, `Longer = fewer flickers in wind. How long the motion sensor stays on after the last movement (${minS} to ${maxS} seconds). Saving applies it live, with no restart.`);
  const node = el("div", { class: "hold" },
    el("div", { class: "knob" }, slider, out), inheritLabel, hint, why, live);
  draw();
  if (live) {
    const t = setInterval(() => { if (!node.isConnected) clearInterval(t); else draw(); }, 2000);
  }
  return {
    node, refresh: draw,
    get: () => (inherit && inherit.checked ? null : Number(slider.value) * 1000),
    set: (ms) => { slider.value = String(Math.round(ms / 1000)); draw(); },
  };
}

/** The Cameras page's panel for the install-wide default hold. */
function globalHoldPanel(r) {
  const limits = (r.limits && r.limits.motionCooldownMs) || { min: 5000, max: 180000 };
  const builtIn = (r.defaults && r.defaults.motionCooldownMs) || 60000;
  let current = typeof r.motionCooldownMs === "number" ? r.motionCooldownMs : null;
  const ctl = holdControl({ limits, value: current, defaultMs: builtIn, canInherit: false });
  const out = el("div");
  const save = el("button", { type: "button", class: "primary" }, "Save default");
  const reset = el("button", { type: "button", class: "secondary" }, `Use the built-in ${holdText(builtIn)}`);
  const withSource = r.cameras.filter((c) => c.foscam || c.onvif);
  const hold = (c) => (c.foscam || c.onvif).motionCooldownMs;
  const own = withSource.filter((c) => hold(c) !== undefined);
  const follow = withSource.filter((c) => hold(c) === undefined);
  const drawReset = () => {
    reset.disabled = current === null;
    reset.title = current === null ? `Already using the built-in default (${holdText(builtIn)}).` : "";
  };
  const send = async (value, btn, label) => {
    save.disabled = true; reset.disabled = true;
    btn.textContent = "Saving...";
    out.replaceChildren();
    const r2 = await api("PUT", "/api/settings/motion", { motionCooldownMs: value });
    btn.textContent = label;
    save.disabled = false;
    const extras = [r2.warning, r2.backupPath ? `Previous config.json kept at ${r2.backupPath}.` : null];
    if (r2.error) {
      out.replaceChildren(errorBox(r2.error), ...(r2.saved ? [msgBox("amber", ...extras)] : []));
    } else {
      current = value;
      if (value === null) ctl.set(builtIn);   // the slider follows the reset
      out.replaceChildren(msgBox(r2.status === 200 ? "ok" : "amber", r2.message, ...extras));
    }
    drawReset();
  };
  const resetLabel = reset.textContent;
  save.addEventListener("click", () => send(ctl.get(), save, "Save default"));
  reset.addEventListener("click", () => send(null, reset, resetLabel));
  drawReset();
  return el("section", { class: "panel" },
    el("h2", {}, "Motion hold for all cameras"),
    el("p", { class: "hint" }, "The default for every camera that doesn't set its own. A camera's own value (its Edit page) wins over this."),
    ctl.node,
    el("p", { class: "hint" }, follow.length ? `Following this default: ${follow.map((c) => c.name).join(", ")}.` : "No camera with a motion source is following this default."),
    own.length ? el("p", { class: "hint" }, `With their own hold: ${own.map((c) => `${c.name} (${holdText(hold(c))})`).join(", ")}.`) : null,
    el("div", { class: "row" }, save, reset), out);
}

// ---------- which stream each part uses (#87) ----------

const STREAM_DEFAULTS = { snapshot: "auto", live: "main", recording: "main" };
const STREAM_WORD = { auto: "automatic", main: "main", sub: "sub" };

/** One line for a camera card: "Wall tile: sub · Snapshots: automatic · Live view: main · Recording: main". */
function streamsLine(streams, dash) {
  const s = { ...STREAM_DEFAULTS, ...(streams || {}) };
  return `Wall tile: ${dash ? STREAM_WORD[dash] || dash : "unknown"} · Snapshots: ${STREAM_WORD[s.snapshot]} · Live view: ${STREAM_WORD[s.live]} · Recording: ${STREAM_WORD[s.recording]}`;
}

/** The four consumers. `fallback` is today's behaviour, which is what a camera with no choice saved uses. */
const STREAM_ROWS = [
  { key: "dash", label: "Wall dashboard tile", fallback: "main", options: [["main", "Main"], ["sub", "Sub"]],
    hint: "The living-room dashboard's tile for this camera. This one is a dashboard setting: it's saved there, and the dashboard reloads with it within a few seconds." },
  { key: "snapshot", label: "Snapshots", fallback: "auto", options: [["auto", "Automatic (default)"], ["main", "Main"], ["sub", "Sub"]],
    hint: "The still picture in the Home app's tile and room view. Automatic uses the cheapest: a stream that's already running, else the sub stream. Applies to the next snapshot." },
  { key: "live", label: "Live view", fallback: "main", options: [["main", "Main (default)"], ["sub", "Sub"]],
    hint: "What the Home app shows when you open the camera. Applies to the next live view; one that's already open keeps its stream until it's closed." },
  { key: "recording", label: "Recording", fallback: "main", options: [["main", "Main (default)"], ["sub", "Sub"]],
    hint: "What HomeKit Secure Video records from. Sub is lower resolution, so clips look softer in Home." },
];

/**
 * The "Streams" part of the camera form: one choice per consumer, current choice showing, Sub greyed (with the
 * reason) when the camera has no sub stream. Returns { node, edit(), dashChoice(), dashChanged(), refresh() }.
 *   o.cam         the stored camera (its `streams` are the saved choices)
 *   o.dash        the wall tile's saved stream ("main"/"sub"), or null when it can't be read
 *   o.dashWhy     why the wall tile's choice can't be changed here (or null)
 *   o.hasSub      () => whether the camera has a sub stream as the form stands now
 *   o.recordingWarning  the sentence shown when the recording choice differs from what's saved
 */
function streamsControl(o) {
  const saved = { ...STREAM_DEFAULTS, ...(o.cam.streams || {}), dash: o.dash || "main" };
  const rows = STREAM_ROWS.map((row) => {
    const sel = el("select", { id: `streams-${row.key}`, "aria-describedby": `streams-${row.key}-hint` },
      row.options.map(([v, t]) => el("option", { value: v }, t)));
    sel.value = saved[row.key];
    const why = el("p", { class: "why", hidden: true });
    const hint = el("p", { class: "hint", id: `streams-${row.key}-hint` }, row.hint);
    const wrap = el("div", { class: "streamrow" }, el("label", { class: "field", for: sel.id }, row.label, sel), hint, why);
    return { row, sel, why, wrap };
  });
  const warn = el("div", { class: "msg amber", hidden: true }, o.recordingWarning);
  const draw = () => {
    const sub = o.hasSub();
    for (const r of rows) {
      const subOpt = [...r.sel.options].find((x) => x.value === "sub");
      let reason = null;
      if (r.row.key === "dash" && o.dashWhy) { reason = o.dashWhy; r.sel.disabled = true; }
      else {
        r.sel.disabled = false;
        subOpt.disabled = !sub;
        subOpt.textContent = sub ? "Sub" : "Sub (no sub stream configured for this camera)";
        if (!sub && r.sel.value === "sub") {
          r.sel.value = r.row.fallback;
          reason = `Switched back to ${STREAM_WORD[r.row.fallback]}: this camera has no sub stream now, so Sub can't be used.`;
        } else if (!sub) {
          reason = "Sub is greyed out: no sub stream is configured for this camera. Give it a sub stream URL (Stream, above) to use it.";
        }
      }
      r.why.hidden = !reason;
      r.why.textContent = reason || "";
    }
    const rec = rows.find((r) => r.row.key === "recording").sel;
    warn.hidden = rec.value === saved.recording;
  };
  rows.forEach((r) => r.sel.addEventListener("change", draw));
  const get = (key) => rows.find((r) => r.row.key === key).sel.value;
  draw();
  return {
    node: el("div", { class: "streams" }, rows.map((r) => r.wrap), warn),
    refresh: draw,
    /** The camera's `streams` for config.json: a choice equal to today's behaviour is sent as null (= not set). */
    edit: () => Object.fromEntries(["snapshot", "live", "recording"].map((k) => [k, get(k) === STREAM_DEFAULTS[k] ? null : get(k)])),
    dashChoice: () => get("dash"),
    dashChanged: () => !o.dashWhy && get("dash") !== saved.dash,
    /** These choices are now what's saved (after a successful save), so "changed" and the recording warning start over. */
    commit: (keys) => { for (const k of keys) saved[k] = get(k); draw(); },
  };
}

/**
 * Save the wall tile's stream choice into the dashboard's settings (it lives there, not in config.json). Re-reads
 * the dashboard's settings first so nothing else on that page is touched. Returns { ok: true, message } or { error }.
 */
async function saveDashStream(cameraName, stream) {
  const cur = await api("GET", "/api/dash/settings");
  if (cur.error) return { error: cur.error };
  const cameras = (cur.cameras || []).filter((c) => !c.missing).map((c) => ({
    camera: c.camera, label: c.label, shown: c.shown, stream: c.camera === cameraName ? stream : c.stream,
  }));
  const r = await api("PUT", "/api/dash/settings", { cameras });
  if (r.error) return { error: r.error };
  return { ok: true, message: `The wall tile for "${cameraName}" now plays the ${stream} stream (saved in the dashboard settings; the dashboard reloads with it within a few seconds).` };
}

// ---------- add / edit form ----------

const PART_FIELDS = [["host", "Camera address (IP or host name)", "text"], ["rtspPort", "RTSP port", "number", "554"], ["rtspUser", "User name", "text"],
  ["rtspPassword", "Password", "password"], ["rtspMainPath", "Main stream path", "text", "/videoMain"], ["rtspSubPath", "Sub stream path", "text", "/videoSub"]];
const FOSCAM_FIELDS = [["cgiBase", "CGI base URL", "text", "http://192.168.1.50:88"], ["username", "User name", "text"], ["password", "Password", "password"],
  ["pollIntervalMs", "Poll every (ms)", "number", "1000"]];
const ONVIF_FIELDS = [["host", "ONVIF address", "text"], ["port", "ONVIF port", "number", "80 (XM cameras: 8080)"], ["username", "User name", "text"],
  ["password", "Password", "password"], ["notifyPort", "Push receiver port", "number", "0 = random"], ["notifyHost", "Push receiver address", "text", "auto-detected"],
  ["pollIntervalMs", "PullPoint wait (ms)", "number", "60000"]];

/**
 * A field's placeholder: the bridge's real default when the server sent one (GET /api/cameras
 * `defaults`, from src/config.ts), else the hint written above (#90: the hold hint said 8000 when
 * the bridge really holds for 60000).
 */
function placeholderFor(key, fallback, defaults) {
  const v = defaults && defaults[key];
  return typeof v === "number" ? String(v) : fallback;
}

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
  const fosIns = FOSCAM_FIELDS.map(([k, l, t, p]) => [k, t, input(k, l, t, placeholderFor(k, p, r.defaults), cam.foscam && cam.foscam[k])]);
  const onvIns = ONVIF_FIELDS.map(([k, l, t, p]) => [k, t, input(k, l, t, placeholderFor(k, p, r.defaults), cam.onvif && cam.onvif[k])]);
  const fosBox = el("div", { class: "two" }, fosIns.map(([, , x]) => x.node));
  const onvBox = el("div", { class: "two" }, onvIns.map(([, , x]) => x.node));
  const holdCtl = holdControl({
    limits: (r.limits && r.limits.motionCooldownMs) || { min: 5000, max: 180000 },
    value: kind === "none" ? null : (cam[kind] ? cam[kind].motionCooldownMs : null),
    defaultMs: typeof r.motionCooldownMs === "number" ? r.motionCooldownMs : ((r.defaults && r.defaults.motionCooldownMs) || 60000),
    canInherit: true,
    disabledWhy: () => (radios[0].checked ? "Pick Foscam CGI or ONVIF above: with no motion source there is nothing to hold." : null),
    liveFor: isNew ? null : cam.name,
  });
  const showMotion = () => { fosBox.hidden = !radios[1].checked; onvBox.hidden = !radios[2].checked; holdCtl.refresh(); };
  radios.forEach((r) => r.addEventListener("change", showMotion));

  // Recording / HomeKit.
  const hksv = el("input", { type: "checkbox", checked: cam.hksv !== false });
  const audio = el("input", { type: "checkbox", checked: cam.audio !== false });
  const copy = el("input", { type: "checkbox", checked: cam.copyVideo !== false });
  const pre = input("prebufferSeconds", "Prebuffer seconds (at least 4)", "number", "4", cam.prebufferSeconds, { min: 4 });
  const maxRec = input("maxRecordingSeconds", "Longest clip (seconds, max 180)", "number", "170", cam.maxRecordingSeconds);
  const manu = input("manufacturer", "Manufacturer", "text", "Foscam", cam.manufacturer);
  const model = input("model", "Model", "text", "IP Camera", cam.model);

  // Which stream each part reads (#87).
  const dashSaved = r.dashStreams && !isNew ? r.dashStreams[cam.name] || null : null;
  const streamsCtl = streamsControl({
    cam, dash: dashSaved,
    dashWhy: isNew ? "The wall tile's choice is a dashboard setting, which can be set once the camera has been added."
      : dashSaved ? null : "The dashboard's settings couldn't be read, so the wall tile's choice can't be changed here. Use the dashboard settings page.",
    hasSub: () => (modeParts.checked ? true : Boolean(subIn.i.value.trim())),
    recordingWarning: notices.recordingStreamSwitch,
  });
  const showStreams = () => streamsCtl.refresh();
  subIn.i.addEventListener("input", showStreams);
  modeUrl.addEventListener("change", showStreams);
  modeParts.addEventListener("change", showStreams);

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
    if (radios[1].checked || radios[2].checked) {
      const hold = holdCtl.get();
      const blk = radios[1].checked ? e.foscam : e.onvif;
      const stored = radios[1].checked ? cam.foscam : cam.onvif;
      if (hold !== null) blk.motionCooldownMs = hold;
      else if (stored && stored.motionCooldownMs !== undefined) blk.motionCooldownMs = null;   // back to following the default
    }
    e.streams = streamsCtl.edit();
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
    const extras = [...(r2.notes || []), r2.warning, r2.backupPath ? `Previous config.json kept at ${r2.backupPath}.` : null];
    // The wall tile's choice lives in the dashboard's settings: saved after the camera, and said separately (#87).
    let dashResult = null;
    if (!r2.error && !isNew && streamsCtl.dashChanged()) {
      saveBtn.textContent = "Saving the wall tile...";
      dashResult = await saveDashStream(cam.name, streamsCtl.dashChoice());
    }
    saveBtn.disabled = false;
    saveBtn.textContent = isNew ? "Add camera" : "Save";
    if (r2.error) {
      out.replaceChildren(errorBox(r2.error), ...(r2.saved ? [msgBox("amber", ...extras)] : []),
        ...(streamsCtl.dashChanged() ? [msgBox("amber", "The wall tile's stream choice was not saved either, because the camera didn't save. Nothing changed.")] : []));
    } else {
      const kindClass = r2.status === 200 && r2.mode !== "restart-needed" ? "ok" : "amber";
      streamsCtl.commit(["snapshot", "live", "recording"]);
      if (dashResult && dashResult.ok) streamsCtl.commit(["dash"]);
      out.replaceChildren(msgBox(kindClass, r2.message, ...extras),
        ...(dashResult && dashResult.ok ? [msgBox("ok", dashResult.message)] : []),
        ...(dashResult && dashResult.error ? [msgBox("amber", `The camera's settings were saved, but the wall tile's stream choice was not (it is a dashboard setting). The tile still plays the ${dashSaved} stream.`), errorBox(dashResult.error)] : []));
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
    fosBox, onvBox,
    el("h3", { class: "sub" }, "Hold motion for"), holdCtl.node),
  el("fieldset", {}, el("legend", {}, "Recording and HomeKit"),
    el("label", { class: "check" }, hksv, "HomeKit Secure Video recording"),
    el("label", { class: "check" }, audio, "Camera has audio"),
    el("label", { class: "check" }, copy, "Copy video as-is (no transcode)"),
    el("div", { class: "two" }, pre.node, maxRec.node, manu.node, model.node),
    el("p", { class: "hint" }, "HKSV, prebuffer, manufacturer and model are things Home sees: changing them is saved now and takes effect after a bridge restart.")),
  el("fieldset", {}, el("legend", {}, "Which stream each part uses"),
    el("p", { class: "hint" }, "Main is the full-quality stream; Sub is the small one. Each part can use either, and the default is how it worked before this setting: snapshots automatic, live view and recording on main. Changes apply without restarting the bridge."),
    streamsCtl.node),
  prebufferWarn,
  el("div", { class: "row" }, saveBtn, checkBtn, el("a", { href: "#/cameras" }, "Back to cameras")),
  checkWhy, checkOut, out);
  showMode();
  showMotion();
  app.replaceChildren(el("h1", {}, isNew ? "Add camera" : `Edit ${cam.name}`), form, ...(isNew ? [] : [removeSection(cam)]));
}

/* ---------- remove a camera (#8): a plain warning first, then one confirming click ---------- */
function removeSection(cam) {
  const out = el("div");
  const box = el("div", { class: "msg amber", hidden: true });
  const yes = el("button", { type: "button", class: "danger" }, `Yes, remove "${cam.name}"`);
  const no = el("button", { type: "button", class: "secondary", onclick: () => { box.hidden = true; } }, "Keep it");
  box.append(
    el("p", {}, el("strong", {}, `Removing "${cam.name}" takes it out of Home.`)),
    el("p", {}, "Home drops the camera, and with it its HomeKit Secure Video recordings, its room and any automations that use it. That can't be undone from here."),
    el("p", {}, "The camera's settings are kept in the config folder (removed-cameras/), so it can be put back under the same name later; Home will treat it as the same camera, but the old recordings are gone."),
    el("div", { class: "row" }, yes, no));
  yes.addEventListener("click", async () => {
    yes.disabled = true; no.disabled = true; yes.textContent = "Removing...";
    const r = await api("DELETE", `/api/cameras/${encodeURIComponent(cam.name)}`, { confirm: cam.name });
    yes.disabled = false; no.disabled = false; yes.textContent = `Yes, remove "${cam.name}"`;
    const extras = [r.warning, r.keptAt ? `Its settings are kept at ${r.keptAt}.` : null, r.backupPath ? `Previous config.json kept at ${r.backupPath}.` : null];
    if (r.error) {
      out.replaceChildren(errorBox(r.error), ...(r.saved ? [msgBox("amber", ...extras)] : []));
    } else {
      box.hidden = true;
      out.replaceChildren(msgBox(r.status === 200 ? "ok" : "amber", r.message, ...extras), el("p", {}, el("a", { href: "#/cameras" }, "Back to cameras")));
      await refreshStatus();
    }
    out.scrollIntoView({ block: "nearest" });
  });
  const open = el("button", { type: "button", class: "danger", onclick: () => { box.hidden = false; box.scrollIntoView({ block: "nearest" }); } }, "Remove this camera\u2026");
  return el("section", { class: "remove" }, el("h2", {}, "Remove"), el("p", { class: "hint" }, "Takes the camera out of the bridge and out of Home. You get a warning first."), open, box, out);
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
  if (s.homekitSource) add("HomeKit reads cameras", el("span", { class: s.homekitSource.mode === "direct" ? "badtext" : "" }, localise(s.homekitSource.text)));
  if (s.dash) {
    add("Dashboard", `${s.dash.state}, ${s.dash.restarts} restart${s.dash.restarts === 1 ? "" : "s"}`);
    add("Dashboard last error", s.dash.lastError || "none");
  } else {
    add("Dashboard", "not reported by this bridge version");
  }
  add("Cameras", String(s.cameras.length));
  app.replaceChildren(el("h1", {}, "Status"), facts, el("h2", {}, "Notes"),
    ...(s.notices && s.notices.length ? s.notices.map((n) => msgBox("amber", n)) : [el("p", { class: "muted" }, "Nothing to report.")]));
}

// ---------- start ----------

window.addEventListener("hashchange", () => void route());
setInterval(() => {
  if (!csrf || location.hash === "#/login") return;
  void (location.hash === "#/status" ? renderStatus() : refreshStatus());
}, 5000);
void route();
