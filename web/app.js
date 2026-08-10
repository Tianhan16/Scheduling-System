// Day-grid frontend, shared by the staff view (index.html) and the admin
// view (admin.html — which sets window.IS_ADMIN before loading this file).

const IS_ADMIN = !!window.IS_ADMIN;
const API_BASE = IS_ADMIN ? "/api/admin" : "/api";

// Store hours shown on the grid. PLACEHOLDER — set to the real store hours.
const OPEN_MIN = 10 * 60;   // 10:00
const CLOSE_MIN = 20 * 60;  // 20:00
const PX_PER_MIN = 1;       // 60px per hour
const SLOT_MIN = 15;        // tap-to-add rounds to this granularity
const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let currentDate = todayISO();
let dayData = null;

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const hourLabel = (min) => {
  const h = Math.floor(min / 60);
  return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
};

function shiftDate(days) {
  const d = new Date(`${currentDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  currentDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  refresh();
}

async function refresh() {
  try {
    const res = await fetch(`${API_BASE}/day?date=${currentDate}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dayData = await res.json();
    $("status").hidden = true;
    render();
  } catch {
    $("status").hidden = false; // keep showing the last good grid
  }
}

function render() {
  const data = dayData;
  $("dateLabel").textContent = new Date(`${data.date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });

  const services = new Map(data.services.map((s) => [s.id, s]));
  const colHeight = (CLOSE_MIN - OPEN_MIN) * PX_PER_MIN;

  const grid = document.createElement("div");
  grid.className = "board";
  grid.style.setProperty("--cols", data.therapists.length);

  const corner = document.createElement("div");
  corner.className = "corner";
  grid.appendChild(corner);
  for (const t of data.therapists) {
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = t.name;
    grid.appendChild(name);
  }

  const gutter = document.createElement("div");
  gutter.className = "gutter";
  gutter.style.height = `${colHeight}px`;
  for (let m = OPEN_MIN; m <= CLOSE_MIN; m += 60) {
    const lab = document.createElement("span");
    lab.className = "tlab";
    lab.style.top = `${(m - OPEN_MIN) * PX_PER_MIN}px`;
    lab.textContent = hourLabel(m);
    gutter.appendChild(lab);
  }
  grid.appendChild(gutter);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const showNow = data.date === todayISO() && nowMin >= OPEN_MIN && nowMin <= CLOSE_MIN;

  for (const t of data.therapists) {
    const col = document.createElement("div");
    col.className = "col";
    col.style.height = `${colHeight}px`;

    for (const a of data.appointments.filter((x) => x.therapistId === t.id)) {
      col.appendChild(apptBlock(a, services));
    }
    if (showNow) {
      const line = document.createElement("div");
      line.className = "nowline";
      line.style.top = `${(nowMin - OPEN_MIN) * PX_PER_MIN}px`;
      col.appendChild(line);
    }
    if (IS_ADMIN) {
      col.addEventListener("click", (e) => {
        if (e.target.closest(".appt")) return;
        const y = e.clientY - col.getBoundingClientRect().top;
        const min = OPEN_MIN + Math.round(y / PX_PER_MIN / SLOT_MIN) * SLOT_MIN;
        openAddDialog(t.id, Math.min(Math.max(min, OPEN_MIN), CLOSE_MIN - SLOT_MIN));
      });
    }
    grid.appendChild(col);
  }

  const main = $("board");
  const scrollLeft = main.scrollLeft;
  main.replaceChildren(grid);
  main.scrollLeft = scrollLeft;
}

function apptBlock(a, services) {
  const svc = services.get(a.serviceId);
  const div = document.createElement("div");
  div.className = `appt b-${svc?.color ?? "gray"}`;
  div.style.top = `${(toMinutes(a.start) - OPEN_MIN) * PX_PER_MIN}px`;
  div.style.height = `${a.durationMin * PX_PER_MIN - 2}px`;

  const l1 = document.createElement("div");
  l1.className = "l1";
  l1.textContent = `${svc?.name ?? "Service"} · ${a.durationMin}m`;
  div.appendChild(l1);

  const l2 = document.createElement("div");
  l2.textContent = a.customerName;
  div.appendChild(l2);

  const phoneText = IS_ADMIN ? a.phone : a.phoneLast4 && `••• ${a.phoneLast4}`;
  if (phoneText) {
    const l3 = document.createElement("div");
    l3.textContent = phoneText;
    div.appendChild(l3);
  }

  if (IS_ADMIN) {
    div.addEventListener("click", async () => {
      const ok = confirm(`Cancel ${svc?.name ?? "appointment"} for ${a.customerName} at ${a.start}?`);
      if (!ok) return;
      await fetch(`${API_BASE}/appointments/${currentDate}/${a.id}`, { method: "DELETE" });
      refresh();
    });
  }
  return div;
}

// ---- Admin: add-appointment dialog -----------------------------------------

function openAddDialog(therapistId, startMin) {
  const fT = $("fTherapist");
  const fS = $("fService");
  fT.replaceChildren(...dayData.therapists.map((t) => new Option(t.name, t.id)));
  fS.replaceChildren(...dayData.services.map((s) => new Option(`${s.name} (${s.durationMin}m)`, s.id)));
  fT.value = therapistId;
  $("fStart").value = toHHMM(startMin);
  $("fDuration").value = dayData.services[0].durationMin;
  $("fName").value = "";
  $("fPhone").value = "";
  $("fNotes").value = "";
  $("fError").hidden = true;
  $("addDialog").showModal();
}

if (IS_ADMIN) {
  document.body.classList.add("admin");

  $("fService").addEventListener("change", () => {
    const svc = dayData.services.find((s) => s.id === $("fService").value);
    if (svc) $("fDuration").value = svc.durationMin;
  });

  $("fCancel").addEventListener("click", () => $("addDialog").close());

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      date: currentDate,
      therapistId: $("fTherapist").value,
      serviceId: $("fService").value,
      start: $("fStart").value,
      durationMin: parseInt($("fDuration").value, 10),
      customerName: $("fName").value,
      phone: $("fPhone").value || undefined,
      notes: $("fNotes").value || undefined,
    };
    const res = await fetch(`${API_BASE}/appointments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      $("addDialog").close();
      refresh();
    } else {
      const err = await res.json().catch(() => ({}));
      $("fError").textContent = err.message ?? `Error ${res.status}`;
      $("fError").hidden = false;
    }
  });
}

// ---- Wiring ----------------------------------------------------------------

$("prev").addEventListener("click", () => shiftDate(-1));
$("next").addEventListener("click", () => shiftDate(1));
$("today").addEventListener("click", () => { currentDate = todayISO(); refresh(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

refresh();
setInterval(refresh, POLL_MS);
