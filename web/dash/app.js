// Phase 1 cut: the clock only. The full Homedash port replaces this file.
const $ = (id) => document.getElementById(id);
function tick() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("day").textContent = now.toLocaleDateString([], { weekday: "long" });
  $("date").textContent = now.toLocaleDateString([], { month: "long", day: "numeric" });
}
tick();
setInterval(tick, 1000);
