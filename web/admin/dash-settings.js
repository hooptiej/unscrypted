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

/* ---------- status lights editor (#109): add/remove/relabel any light, edit its check, build page
   and link, pick a parent for a new one, and test a check live. The wall shows a short label; the
   full reason shows here. ids are generated once from the label on Add and never change. ---------- */
const clone = (v) => JSON.parse(JSON.stringify(v));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const opt = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };

/* The working tree the page edits; the live states come from data.lights, matched by id. */
let services = [];
/* Check kinds, in the order the picker lists them, with the words the owner reads. */
const CHECK_KINDS = [
  ["tcp", "Port reachable (TCP connects)"],
  ["alive", "Host answers (a refused TCP port still counts)"],
  ["http", "Web page (HTTP)"],
  ["bridge", "HomeKit bridge"],
  ["blocked", "Can't check here (show a reason)"],
];

const slugify = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
const allIds = (ns) => ns.flatMap((n) => [n.id, ...allIds(n.children || [])]);
function uniqueId(base) {
  const taken = new Set(allIds(services));
  const root = base || "light";
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i++;
  return `${root}-${i}`;
}
function findNode(id, ns = services) {
  for (let i = 0; i < ns.length; i++) {
    if (ns[i].id === id) return { node: ns[i], siblings: ns, index: i };
    if (ns[i].children) { const r = findNode(id, ns[i].children); if (r) return r; }
  }
  return null;
}

/* id -> the live light node (state/reason/pulse/buildError), from the open dashboard's own report. */
function liveMap(lights) {
  const m = new Map();
  const walk = (ns) => (ns || []).forEach((n) => { m.set(n.id, n); walk(n.children); });
  if (lights && Array.isArray(lights.services)) walk(lights.services);
  return m;
}

function renderLights(lights, model) {
  const box = $("lights");
  const rows = [];
  if (lights && lights.error) {
    rows.push(el("p", "hint warn", `${lights.error} You can still edit the lights below; their live state will show once the dashboard answers.`));
  }
  const live = liveMap(lights);
  const walk = (ns, depth) => (ns || []).forEach((n) => { rows.push(lightRow(n, depth, live)); walk(n.children, depth + 1); });
  walk(model, 0);
  if (!allIds(model).length) rows.push(el("p", "hint", "No status lights yet. Add one below."));
  const add = el("div", "ladd");
  const addBtn = el("button", null, "+ Add status light");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => openPanel({ mode: "add" }));
  add.append(addBtn);
  rows.push(add);
  box.replaceChildren(...rows);
}

function lightRow(n, depth, live) {
  const s = live.get(n.id);
  const state = s ? s.state : "unknown";
  const row = el("div", "l");
  row.style.paddingLeft = `calc(${depth * 26}*var(--u))`;
  const dot = el("span", `dot ${state}`);
  dot.title = s ? "" : "not checked yet; save to start checking it";
  const name = el("span", "nm", n.name);
  row.append(dot, name);
  if (s && state !== "ok" && (s.reason || s.short)) row.append(el("span", "full", s.reason || s.short));
  if (!s) row.append(el("span", "full", "new; save to start checking"));
  if (s && s.pulse) row.append(el("span", "full acc", s.pulse.build ? `new build ${s.pulse.build} is waiting on test` : "something is waiting on test"));
  if (s && s.buildError) row.append(el("span", "full warn", `build page: ${s.buildError}`));
  const btns = el("span", "lbtns");
  // #116: move a light up or down within its group. Ids never change, so /api/pulse/<id> and deploy.sh keep working.
  const pos = findNode(n.id);
  for (const [txt, dir] of [["↑", -1], ["↓", 1]]) {
    const b = el("button", "mv", txt);
    b.type = "button";
    b.dataset.lid = n.id; b.dataset.dir = String(dir);
    const atEnd = !pos || (dir < 0 ? pos.index === 0 : pos.index === pos.siblings.length - 1);
    const where = depth === 0 ? "the list" : "its group";
    b.setAttribute("aria-label", `Move ${n.name} ${dir < 0 ? "up" : "down"}`);
    b.title = atEnd ? `${n.name} is already ${dir < 0 ? "first" : "last"} in ${where}` : `Move ${dir < 0 ? "up" : "down"} within ${where}`;
    b.disabled = atEnd;
    b.addEventListener("click", () => moveLight(n.id, dir));
    btns.append(b);
  }
  const edit = el("button", null, "✎");
  edit.type = "button"; edit.title = "Edit"; edit.setAttribute("aria-label", `Edit ${n.name}`);
  edit.addEventListener("click", () => openPanel({ mode: "edit", id: n.id, row }));
  const del = el("button", null, "🗑");
  del.type = "button"; del.title = "Remove"; del.setAttribute("aria-label", `Remove ${n.name}`);
  del.addEventListener("click", () => removeLight(n.id));
  btns.append(edit, del);
  row.append(btns);
  return row;
}

/* #116: swap a light with its neighbour in the same group (its children travel with it). Applied when you save. */
function moveLight(id, dir) {
  const f = findNode(id);
  if (!f) return;
  const to = f.index + dir;
  if (to < 0 || to >= f.siblings.length) return;
  if (openPanelEl && !window.confirm("A light editor is open. Moving a light closes it and drops what you typed there. Go on?")) return;
  if (openPanelEl) { openPanelEl.remove(); openPanelEl = null; }
  [f.siblings[f.index], f.siblings[to]] = [f.siblings[to], f.siblings[f.index]];
  dirty = true;
  renderLights(loaded.lights, services);
  // keep the keyboard where it was: the same arrow on the same light, or its twin if it just hit the end
  const mine = (d) => document.querySelector(`#lights button.mv[data-lid="${id}"][data-dir="${d}"]`);
  const next = mine(dir);
  (next && !next.disabled ? next : mine(-dir))?.focus();
}

function removeLight(id) {
  const f = findNode(id);
  if (!f) return;
  const kids = allIds(f.node.children || []).length;
  const msg = kids ? `Remove "${f.node.name}" and its ${kids} nested light${kids === 1 ? "" : "s"}? (applied when you save)` : `Remove "${f.node.name}"? (applied when you save)`;
  if (!window.confirm(msg)) return;
  f.siblings.splice(f.index, 1);
  dirty = true;
  renderLights(loaded.lights, services);
}

/* Build the add/edit panel, inserted after the row (edit) or before the Add button (add). */
let openPanelEl = null;
function openPanel({ mode, id, row }) {
  if (openPanelEl) { openPanelEl.remove(); openPanelEl = null; }
  const existing = mode === "edit" ? findNode(id).node : null;
  const p = el("div", "lpanel");

  const label = document.createElement("input");
  label.type = "text"; label.maxLength = 60; label.autocomplete = "off"; label.spellcheck = false;
  label.value = existing ? existing.name : "";
  const idOut = el("span", "lid", existing ? existing.id : "(from the label)");
  const kind = document.createElement("select");
  for (const [v, t] of CHECK_KINDS) kind.append(opt(v, t));

  // fields per kind
  const host = textInput("host, e.g. 192.168.1.10 or 127.0.0.1");
  const port = document.createElement("input"); port.type = "number"; port.min = "1"; port.max = "65535"; port.placeholder = "port";
  const urlIn = textInput("http://192.168.1.20/ or https://host/path");
  const ok200 = document.createElement("input"); ok200.type = "checkbox";
  const reason = textInput("why it can't be checked from here");
  const build = textInput("build page address (optional, a JSON page with a build field)");
  build.maxLength = 300;
  if (existing && existing.build && existing.build.url) build.value = existing.build.url;
  const link = textInput("link opened from the wall (optional, http(s)://)");
  link.maxLength = 300;
  if (existing && existing.link) link.value = existing.link;

  // seed check fields from the existing node
  const ec = existing ? existing.check : { kind: "tcp" };
  kind.value = ec.kind || "tcp";
  if (ec.kind === "tcp" || ec.kind === "alive") { host.value = ec.host || ""; port.value = ec.port != null ? ec.port : ""; }
  if (ec.kind === "http") { urlIn.value = ec.url || ""; ok200.checked = ec.ok === "200"; }
  if (ec.kind === "blocked") reason.value = ec.reason || "";

  const gTcp = field("Host", host); const gPort = field("Port", port);
  const gUrl = field("Address", urlIn);
  const gOk = fieldRow("Require a 200", labelWrap(ok200, "the page must answer 200 (otherwise any answer counts)"));
  const gReason = field("Reason", reason);
  const groups = { tcp: [gTcp, gPort], alive: [gTcp, gPort], http: [gUrl, gOk], bridge: [], blocked: [gReason] };
  const showKind = () => { for (const g of [gTcp, gPort, gUrl, gOk, gReason]) g.hidden = true; for (const g of groups[kind.value] || []) g.hidden = false; };
  kind.addEventListener("change", showKind);

  // live id preview on Add
  if (mode === "add") label.addEventListener("input", () => { idOut.textContent = uniqueId(slugify(label.value)) || "(from the label)"; });

  let parentSel = null;
  if (mode === "add") {
    parentSel = document.createElement("select");
    parentSel.append(opt("", "— top level —"));
    const walk = (ns, depth) => ns.forEach((n) => { parentSel.append(opt(n.id, `${"   ".repeat(depth)}${n.name}`)); walk(n.children || [], depth + 1); });
    walk(services, 0);
  }

  const msg = el("div", "ltest");
  const testBtn = el("button", "ghost", "Test"); testBtn.type = "button";
  const saveBtn = el("button", null, mode === "add" ? "Add" : "Save"); saveBtn.type = "button";
  const cancelBtn = el("button", "ghost", "Cancel"); cancelBtn.type = "button";

  const buildCheck = () => {
    const k = kind.value;
    if (k === "tcp" || k === "alive") return { kind: k, host: host.value.trim(), port: port.value === "" ? "" : Number(port.value) };
    if (k === "http") return { kind: "http", url: urlIn.value.trim(), ok: ok200.checked ? "200" : "any" };
    if (k === "bridge") return { kind: "bridge" };
    return { kind: "blocked", reason: reason.value.trim() };
  };
  const clientError = () => {
    if (!label.value.trim()) return "Give the light a name.";
    const k = kind.value;
    if ((k === "tcp" || k === "alive")) { if (!host.value.trim()) return "Enter a host."; const n = Number(port.value); if (!Number.isInteger(n) || n < 1 || n > 65535) return "Enter a port from 1 to 65535."; }
    if (k === "http" && !urlIn.value.trim()) return "Enter the web address to check.";
    if (k === "blocked" && !reason.value.trim()) return "Enter the reason to show.";
    return null;
  };

  testBtn.addEventListener("click", async () => {
    const err = clientError();
    if (err) { msg.className = "ltest warn"; msg.textContent = err; return; }
    msg.className = "ltest"; msg.textContent = "Checking…";
    const bu = build.value.trim();
    const r = await api("POST", "/api/dash/check", { check: buildCheck(), build: bu ? { url: bu } : undefined });
    if (r.error) { msg.className = "ltest err"; msg.textContent = `${r.error.happened} ${r.error.next || ""}`.trim(); return; }
    const bits = [r.reachable ? "Reachable" : "Not reachable", `state: ${r.state}`];
    if (r.reason) bits.push(r.reason);
    if (bu) bits.push(r.buildError ? `build page: ${r.buildError}` : `build: ${r.build == null ? "(none found)" : r.build}`);
    msg.className = `ltest ${r.reachable ? "ok" : "warn"}`;
    msg.textContent = bits.join(" — ");
  });

  saveBtn.addEventListener("click", () => {
    const err = clientError();
    if (err) { msg.className = "ltest warn"; msg.textContent = err; return; }
    const check = buildCheck();
    const bu = build.value.trim();
    const ln = link.value.trim();
    if (mode === "add") {
      const node = { id: uniqueId(slugify(label.value)), name: label.value.trim(), check };
      if (bu) node.build = { url: bu };
      if (ln) node.link = ln;
      const parentId = parentSel.value;
      if (!parentId) services.push(node);
      else { const f = findNode(parentId); (f.node.children = f.node.children || []).push(node); }
    } else {
      const node = findNode(id).node;
      node.name = label.value.trim();
      // keep a blocked check's existing short label if the kind and reason are unchanged
      if (check.kind === "blocked" && node.check && node.check.kind === "blocked" && node.check.short && node.check.reason === check.reason) check.short = node.check.short;
      node.check = check;
      if (bu) node.build = { url: bu }; else delete node.build;
      if (ln) node.link = ln; else delete node.link;
    }
    dirty = true;
    openPanelEl = null;
    renderLights(loaded.lights, services);
  });
  cancelBtn.addEventListener("click", () => { p.remove(); openPanelEl = null; });

  const buttons = el("div", "lbuttons");
  buttons.append(saveBtn, cancelBtn, testBtn, msg);
  p.append(
    field("Label", label),
    fieldRow("Light id", idOut),
    field("Check type", kind),
    gTcp, gPort, gUrl, gOk, gReason,
    field("Build page", build),
    field("Link", link),
    ...(parentSel ? [field("Parent", parentSel)] : []),
    buttons,
  );
  showKind();
  openPanelEl = p;
  if (mode === "edit" && row) row.after(p); else $("lights").querySelector(".ladd").before(p);
  label.focus();
}

function textInput(placeholder) { const i = document.createElement("input"); i.type = "text"; i.autocomplete = "off"; i.spellcheck = false; if (placeholder) i.placeholder = placeholder; return i; }
function field(labelText, control) { const f = el("div", "lf"); const l = el("label", null, labelText); f.append(l, control); return f; }
function fieldRow(labelText, control) { const f = el("div", "lf"); f.append(el("label", null, labelText), control); return f; }
function labelWrap(control, text) { const w = el("label", "chk"); w.append(control, document.createTextNode(" " + text)); return w; }

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

/* ---------- background glow knobs (#25): -100..+100 %, 0 = the standard look ---------- */
const GLOW_KNOBS = [["glowIntensity", "intensity"], ["glowSize", "size"]];
/* the new-build pulse knobs (#103): the same -100..+100 % shape, 0 = the standard breath */
const PULSE_KNOBS = [["pulseSpeed", "speed"], ["pulseStrength", "strength"]];
const pctText = (v) => `${v > 0 ? "+" : ""}${v}%`;
function showKnob(id) {
  const input = $(id);
  const v = Number(input.value);
  $(`${id}Out`).textContent = pctText(v);
  input.setAttribute("aria-valuetext", v === 0 ? "0%, the standard look" : pctText(v));
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
  services = clone(s.services || []);
  renderLights(data.lights, services);
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
  $("grace").value = s.offlineGraceSeconds;
  const glow = s.glow || { intensity: 0, size: 0 };
  for (const [id, key] of GLOW_KNOBS) { $(id).value = glow[key] ?? 0; showKnob(id); }
  const pulse = s.pulse || { speed: 0, strength: 0 };
  for (const [id, key] of PULSE_KNOBS) { $(id).value = pulse[key] ?? 0; showKnob(id); }
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
    idleSeconds: $("idle").value, reloadMinutes: $("reload").value, pollSeconds: $("poll").value, offlineGraceSeconds: $("grace").value,
    glow: { intensity: $("glowIntensity").value, size: $("glowSize").value },
    pulse: { speed: $("pulseSpeed").value, strength: $("pulseStrength").value },
    // #109: the whole edited status-light tree (it carries each light's build page and link)
    services,
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
  for (const [id] of GLOW_KNOBS) { $(id).addEventListener("input", () => showKnob(id)); showKnob(id); }
  for (const [id] of PULSE_KNOBS) { $(id).addEventListener("input", () => showKnob(id)); showKnob(id); }
  $("save").addEventListener("click", () => void save());
  $("back").addEventListener("click", (e) => {
    e.preventDefault();
    if (dirty && !window.confirm("Discard your unsaved changes and go back to the dashboard?")) return;
    void leave();
  });
  const toadmin = $("toadmin");
  if (toadmin) {
    toadmin.addEventListener("click", (e) => {
      if (dirty && !window.confirm("Discard your unsaved changes and go to the camera admin?")) e.preventDefault();
    });
  }
  $("signout").addEventListener("click", async () => {
    const r = await api("POST", "/api/logout");
    if (r.error) { sayError(r.error); return; }
    location.href = "/#/login";
  });
  const s = await api("GET", "/api/session");
  if (s.build) $("build").textContent = s.build;   // the running build stamp (#102)
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
