// Day-grid frontend, shared by the staff view (index.html) and the admin
// view (admin.html — which sets window.IS_ADMIN before loading this file).

const IS_ADMIN = !!window.IS_ADMIN;
const API_BASE = IS_ADMIN ? "/api/admin" : "/api";

// Store hours shown on the grid.
const OPEN_MIN = 9 * 60;    // 9:00 am
const CLOSE_MIN = 22 * 60;  // 10:00 pm
const PX_PER_MIN = 1.6;     // 96px per hour — keep in sync with the 96px/24px
                            // hour/quarter gradient in styles.css (.col)
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

// "4808609888" -> "480-860-9888"; unrecognized lengths pass through as-is.
const formatPhone = (p) => {
  if (!p) return p;
  const d = String(p).replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `1-${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
};

const addDays = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function shiftDate(days) {
  currentDate = addDays(currentDate, days);
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
  $("datePick").value = data.date;

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

  // Line order: phone (bold), duration + service, then notes and/or name.
  // Staff payloads have no notes field, so staff blocks never show notes.
  const phoneText = IS_ADMIN ? formatPhone(a.phone) : a.phoneLast4 && `••• ${a.phoneLast4}`;
  const lines = [
    { text: phoneText || "walk-in", cls: "l1" },
    { text: `${a.durationMin}m · ${svc?.name ?? "Service"}` },
  ];
  if (a.notes) lines.push({ text: a.notes });
  if (a.customerName) lines.push({ text: a.customerName });
  for (const { text, cls } of lines) {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    div.appendChild(line);
  }

  div.addEventListener("click", (e) => {
    e.stopPropagation();
    openDetail(a, svc);
  });
  return div;
}

// ---- Appointment detail popup (both views; cancel button is admin-only) ----

let detailAppt = null;

function openDetail(a, svc) {
  detailAppt = a;
  const end = toHHMM(toMinutes(a.start) + a.durationMin);
  const phoneText = IS_ADMIN ? formatPhone(a.phone) : a.phoneLast4 && `••• ${a.phoneLast4}`;

  const rows = [
    ["Time", `${a.start} – ${end} (${a.durationMin}m)`],
    ["Phone", phoneText || "walk-in"],
  ];
  if (a.customerName) rows.push(["Customer", a.customerName]);
  if (a.notes) rows.push(["Notes", a.notes]);

  const body = $("detailBody");
  body.replaceChildren();
  const title = document.createElement("h2");
  const chip = document.createElement("span");
  chip.className = `chip b-${svc?.color ?? "gray"}`;
  title.append(chip, document.createTextNode(svc?.name ?? "Service"));
  body.appendChild(title);
  for (const [key, value] of rows) {
    const row = document.createElement("div");
    row.className = "drow";
    const k = document.createElement("span");
    k.className = "dkey";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "dval";
    v.textContent = value;
    row.append(k, v);
    body.appendChild(row);
  }
  $("detailDialog").showModal();
}

// ---- Admin: add-appointment dialog -----------------------------------------

let editingId = null; // null = the form creates; an id = the form edits

function fillFormOptions() {
  $("fTherapist").replaceChildren(...dayData.therapists.map((t) => new Option(t.name, t.id)));
  $("fService").replaceChildren(...dayData.services.map((s) => new Option(s.name, s.id)));
}

function openAddDialog(therapistId, startMin) {
  editingId = null;
  fillFormOptions();
  $("formTitle").textContent = "New appointment";
  $("fTherapist").value = therapistId;
  $("fStart").value = toHHMM(startMin);
  $("fDuration").value = 60; // default booking length; admin adjusts per call
  $("fName").value = "";
  $("fPhone").value = "";
  $("fNotes").value = "";
  $("fError").hidden = true;
  $("addDialog").showModal();
}

function openEditDialog(a) {
  editingId = a.id;
  fillFormOptions();
  $("formTitle").textContent = "Edit appointment";
  $("fTherapist").value = a.therapistId;
  $("fService").value = a.serviceId;
  $("fStart").value = a.start;
  $("fDuration").value = a.durationMin;
  $("fName").value = a.customerName ?? "";
  $("fPhone").value = formatPhone(a.phone ?? "");
  $("fNotes").value = a.notes ?? "";
  $("fError").hidden = true;
  $("addDialog").showModal();
}

// ---- Admin: staff roster dialog --------------------------------------------

function rosterRow(selectedId, options) {
  const row = document.createElement("div");
  row.className = "rrow";
  const num = document.createElement("span");
  num.className = "num";
  const sel = document.createElement("select");
  sel.replaceChildren(...options.map((t) => new Option(t.name, t.id)));
  if (selectedId) sel.value = selectedId;
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "✕";
  del.setAttribute("aria-label", "Remove column");
  del.addEventListener("click", () => {
    row.remove();
    renumberRoster();
  });
  row.append(num, sel, del);
  return row;
}

function renumberRoster() {
  [...$("rosterRows").children].forEach((r, i) => {
    r.querySelector(".num").textContent = i + 1;
  });
}

function openRosterDialog() {
  const options = dayData.allTherapists ?? dayData.therapists;
  $("rosterRows").replaceChildren(...dayData.therapists.map((t) => rosterRow(t.id, options)));
  renumberRoster();
  $("rosterHint").textContent = dayData.rosterSet
    ? "Columns for this day, left to right"
    : "No roster saved for this day — currently showing all staff";
  $("rError").hidden = true;
  $("rosterDialog").showModal();
}

if (IS_ADMIN) {
  document.body.classList.add("admin");

  $("rosterBtn").addEventListener("click", openRosterDialog);
  $("rClose").addEventListener("click", () => $("rosterDialog").close());

  $("rAdd").addEventListener("click", () => {
    const options = dayData.allTherapists ?? dayData.therapists;
    const used = new Set([...$("rosterRows").querySelectorAll("select")].map((s) => s.value));
    const firstFree = options.find((t) => !used.has(t.id));
    $("rosterRows").appendChild(rosterRow(firstFree?.id, options));
    renumberRoster();
  });

  $("rYesterday").addEventListener("click", async () => {
    const res = await fetch(`${API_BASE}/day?date=${addDays(currentDate, -1)}`);
    if (!res.ok) return;
    const yesterday = await res.json();
    const options = dayData.allTherapists ?? dayData.therapists;
    $("rosterRows").replaceChildren(
      ...yesterday.therapists
        .filter((t) => options.some((o) => o.id === t.id))
        .map((t) => rosterRow(t.id, options))
    );
    renumberRoster();
  });

  $("rSave").addEventListener("click", async () => {
    const ids = [...$("rosterRows").querySelectorAll("select")].map((s) => s.value);
    const fail = (msg) => {
      $("rError").textContent = msg;
      $("rError").hidden = false;
    };
    if (ids.length === 0) return fail("Add at least one column");
    if (new Set(ids).size !== ids.length) return fail("Each therapist can only appear once");
    const res = await fetch(`${API_BASE}/roster/${currentDate}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ therapistIds: ids }),
    });
    if (res.ok) {
      $("rosterDialog").close();
      refresh();
    } else {
      const err = await res.json().catch(() => ({}));
      fail(err.message ?? `Error ${res.status}`);
    }
  });

  $("dEdit").addEventListener("click", () => {
    if (!detailAppt) return;
    $("detailDialog").close();
    openEditDialog(detailAppt);
  });

  $("dCancel").addEventListener("click", async () => {
    if (!detailAppt) return;
    if (!confirm("Cancel this appointment?")) return;
    await fetch(`${API_BASE}/appointments/${currentDate}/${detailAppt.id}`, { method: "DELETE" });
    $("detailDialog").close();
    refresh();
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
    const res = await fetch(
      editingId
        ? `${API_BASE}/appointments/${currentDate}/${editingId}`
        : `${API_BASE}/appointments`,
      {
        method: editingId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );
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

$("dClose").addEventListener("click", () => $("detailDialog").close());
$("prev").addEventListener("click", () => shiftDate(-1));
$("next").addEventListener("click", () => shiftDate(1));
$("today").addEventListener("click", () => { currentDate = todayISO(); refresh(); });
$("datePick").addEventListener("change", () => {
  if ($("datePick").value) {
    currentDate = $("datePick").value;
    refresh();
  }
});
// Desktop browsers only open the calendar from the input's tiny icon;
// showPicker() opens it from a click anywhere on the date pill.
$("datePick").addEventListener("click", () => {
  try {
    $("datePick").showPicker?.();
  } catch {
    /* older browsers: native focus behavior still applies */
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

refresh();
setInterval(refresh, POLL_MS);
