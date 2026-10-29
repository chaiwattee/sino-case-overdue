/* Sino Case Tracker dashboard (no build step, plain JS). */
(function () {
  "use strict";
  const $app = document.getElementById("app");

  // ------------------------------------------------------------ utils
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  function fd(iso, year) {
    if (!iso) return "-";
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return `${d} ${TH_MONTHS[m - 1]}${year ? " " + (y + 543) : ""}`;
  }
  function fdt(ts) {
    if (!ts) return "-";
    const t = new Date(ts);
    return `${t.getDate()} ${TH_MONTHS[t.getMonth()]} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }
  const isoDay = (dt) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const daysAgo = (n) => {
    const t = new Date();
    t.setDate(t.getDate() - n);
    return isoDay(t);
  };

  const STAGE = {
    normal: "ปกติ",
    r1: "แจ้งรอบ 1",
    r2: "แจ้งรอบ 2",
    overdue: "เกิน Due",
    no_start: "ไม่มี Start date",
    closed: "ปิดแล้ว",
  };
  const ALERT = { r1: "แจ้งรอบ 1", r2: "แจ้งรอบ 2", overdue: "เกิน Due" };
  const chip = (stage, text) => `<span class="chip c-${stage}">${esc(text || STAGE[stage] || stage)}</span>`;

  let cfg = { slaDays: 7, alert1Day: 3, alert2Day: 6 };

  function ageCell(c) {
    if (c.stage === "closed")
      return `<div class="age"><div class="track"><div class="f-closed" style="width:100%"></div></div><small>${
        c.closedOnTime === true ? "ปิดทัน SLA" : c.closedOnTime === false ? "ปิดเกิน Due" : "ปิดแล้ว"
      }${c.age != null ? ` · ${c.age} วัน` : ""}</small></div>`;
    if (c.age == null) return `<small class="muted">ไม่มี Start date</small>`;
    const pct = Math.min(100, Math.round(((c.age + 1) / (cfg.slaDays + 1)) * 100));
    let txt = `วันที่ ${c.age}`;
    if (c.stage === "overdue") txt += ` · เกิน ${c.daysOverdue} วัน`;
    else txt += c.daysLeft === 0 ? " · ครบกำหนดวันนี้" : ` · เหลือ ${c.daysLeft} วัน`;
    return `<div class="age"><div class="track"><div class="f-${c.stage}" style="width:${pct}%"></div></div><small>${txt}</small></div>`;
  }

  async function api(path, opts = {}) {
    const res = await fetch("api" + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    if (!res.ok) throw new Error((body && body.error) || res.statusText);
    return body;
  }

  function toast(msg, ms = 3500) {
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function setNav(name) {
    document.querySelectorAll("nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
  }

  function renderSources(sources) {
    if (!sources) return;
    document.getElementById("nav-sources").innerHTML =
      "ข้อมูลจาก tab Case List ของ " +
      sources
        .map((s) =>
          s.webUrl
            ? `<a href="${esc(s.webUrl)}" target="_blank" rel="noopener">${esc(s.label)}</a>${s.error ? " (อ่านไม่ได้)" : ""}`
            : `${esc(s.label)}${s.error ? " (อ่านไม่ได้)" : ""}`
        )
        .join(", ");
  }

  // Top bar: last sync time, source errors, and the dry-run banner.
  async function refreshStatus() {
    try {
      const s = await api("/status");
      const pill = document.getElementById("sync-pill");
      const failed = (s.sources || []).filter((x) => x.error);
      pill.classList.toggle("bad", !!s.error || failed.length > 0);
      document.getElementById("sync-text").textContent = s.error
        ? "อ่านข้อมูลไม่ได้"
        : failed.length
        ? `อ่านไม่ได้ ${failed.length} เอกสาร`
        : s.syncedAt
        ? `Sync ${fdt(s.syncedAt)}`
        : "ยังไม่ได้ Sync";
      document.getElementById("dry-banner").hidden = !s.dryRunEmail;
      renderSources(s.sources);
    } catch (e) {
      /* the page itself shows the error */
    }
  }

  (function themeToggle() {
    const btn = document.getElementById("theme");
    btn.onclick = () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch (e) {}
    };
  })();

  const qs = (o) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

  function parseHash() {
    const h = location.hash.replace(/^#/, "") || "/";
    const [path, query] = h.split("?");
    const params = Object.fromEntries(new URLSearchParams(query || ""));
    const parts = path.split("/").filter(Boolean);
    return { parts, params };
  }

  function caseTable(cases, { showOwner = true } = {}) {
    if (!cases.length) return `<div class="empty">ไม่มีเคส</div>`;
    return `<div class="tablewrap"><table style="min-width:${showOwner ? 980 : 880}px">
<thead><tr><th>เลขเคส</th><th>ลูกค้า / งาน</th>${showOwner ? "<th>Owner</th>" : ""}<th>เอกสาร</th><th>เปิดเคส</th><th>Due</th><th>อายุเคส</th><th>สถานะ</th></tr></thead>
<tbody>${cases
      .map(
        (c) => `<tr>
<td class="mono">${esc(c.csNumber || "-")}</td>
<td><div style="font-weight:600">${esc(c.site || "-")}</div><div class="muted" style="font-size:12px">${esc(c.task || "")}</div></td>
${showOwner ? `<td><a href="#/owner/${encodeURIComponent(c.ownerId)}" style="text-decoration:none">${esc(c.owner || "-")}</a></td>` : ""}
<td>${esc(c.sourceLabel)}<div class="muted" style="font-size:12px">แถว ${c.rowNumber}</div></td>
<td>${fd(c.startDate)}</td>
<td>${fd(c.dueDate)}${c.targetMismatch ? `<div class="t-r2" style="font-size:12px" title="Target date ในไฟล์ไม่ตรงกับ Start date + ${cfg.slaDays}">Target ในไฟล์: ${fd(c.targetDate)}</div>` : ""}</td>
<td>${ageCell(c)}</td>
<td>${chip(c.stage)}<div class="muted" style="font-size:12px;margin-top:4px">${esc(c.status || "")}</div></td>
</tr>`
      )
      .join("")}</tbody></table></div>`;
  }

  function changeRows(changes) {
    if (!changes.length) return `<div class="empty">ไม่พบการแก้ไข Start date / Target date</div>`;
    const DIR = { later: "เลื่อนออกไป", earlier: "เลื่อนเข้ามา", set: "ใส่ค่าใหม่", cleared: "ลบค่าออก" };
    return `<div class="tablewrap"><table style="min-width:820px"><thead><tr><th>ตรวจพบเมื่อ</th><th>เคส</th><th>Owner</th><th>ช่อง</th><th>เดิม → ใหม่</th><th>แก้ไฟล์ล่าสุดโดย</th></tr></thead><tbody>${changes
      .map(
        (c) => `<tr>
<td>${fdt(c.detected_at)}</td>
<td><span class="mono">${esc(c.cs_number || c.case_key)}</span><div class="muted" style="font-size:12px">${esc(c.source)} · ${esc(c.site || "-")}</div></td>
<td>${esc(c.owner || "-")}</td>
<td>${c.field === "start_date" ? "Start date" : "Target date"}</td>
<td>${fd(c.old_value, true)} → <strong>${fd(c.new_value, true)}</strong><div style="font-size:12px" class="${c.direction === "later" ? "t-r2" : "muted"}">${esc(DIR[c.direction] || "")}</div></td>
<td>${esc(c.last_modified_by || "-")}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ overview
  async function viewOverview(params) {
    setNav("overview");
    const data = await api("/overview?" + qs({ source: params.source }));
    cfg = data.config;
    renderSources(data.sources);
    const k = data.kpis;
    const openTotal = k.open || 0;
    const segs = ["normal", "r1", "r2", "overdue", "no_start"].filter((s) => k[s] > 0);
    const RANGE = {
      normal: `0–${cfg.alert1Day - 1} วัน`,
      r1: `${cfg.alert1Day}–${cfg.alert2Day - 1} วัน`,
      r2: `${cfg.alert2Day}–${cfg.slaDays} วัน`,
      overdue: `${cfg.slaDays + 1} วันขึ้นไป`,
      no_start: "",
    };
    const sourceOpts = data.sources
      .map((s) => `<option value="${esc(s.key)}" ${params.source === s.key ? "selected" : ""}>${esc(s.label)}</option>`)
      .join("");
    const failed = data.sources.filter((s) => s.error);

    const kpi = (stage, label, value, sub) =>
      `<a class="kpi k-${stage}" href="#/cases?${qs({ stage: stage === "all" ? "" : stage, source: params.source, open: stage === "all" ? 1 : "" })}">
<div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></a>`;

    // SLA runway: every open case placed on its day since Start date.
    const zoneOf = (day) => (day < cfg.alert1Day ? "normal" : day < cfg.alert2Day ? "r1" : "r2");
    const cols = [];
    for (let day = 0; day <= cfg.slaDays; day++) cols.push({ day, zone: zoneOf(day), items: data.runway.filter((c) => c.age === day) });
    const over = data.runway.filter((c) => c.age > cfg.slaDays).sort((a, b) => b.daysOverdue - a.daysOverdue);
    const dotHtml = (c) =>
      `<a class="rw-dot c-${c.stage}" href="#/owner/${encodeURIComponent(c.ownerId)}" title="${esc(
        `${c.csNumber || "-"} · ${c.site || "-"} · ${c.owner || "-"} · วันที่ ${c.age}${c.daysOverdue ? ` (เกิน ${c.daysOverdue} วัน)` : ""}`
      )}" aria-label="${esc(`${c.csNumber || "เคส"} ของ ${c.owner || "-"} วันที่ ${c.age}`)}"></a>`;
    const dayLabel = (d) =>
      d === 0 ? "เปิดเคส" : d === cfg.alert1Day ? "แจ้งรอบ 1" : d === cfg.alert2Day ? "แจ้งรอบ 2" : d === cfg.slaDays ? "ครบ Due" : "&nbsp;";
    const runwayHtml = `<div class="runway-wrap"><div class="runway" role="img" aria-label="เคสที่ยังเปิดอยู่ แยกตามจำนวนวันนับจาก Start date">
${cols
  .map(
    (c) => `<div class="rw-col"><div class="rw-count">${c.items.length || ""}</div><div class="rw-dots">${c.items.map(dotHtml).join("")}</div>
<div class="rw-band z-${c.zone}"></div><div class="rw-day"><strong>วันที่ ${c.day}</strong>${dayLabel(c.day)}</div></div>`
  )
  .join("")}
<div class="rw-col due"><div class="rw-count">${over.length || ""}</div><div class="rw-dots">${over.map(dotHtml).join("")}</div>
<div class="rw-band z-overdue"></div><div class="rw-day"><strong>เกิน Due</strong>แจ้งทุกวัน</div></div>
</div></div>`;

    $app.innerHTML = `
<div class="head"><div><h1>ภาพรวมสถานะเคส</h1>
<p>ทุกเคสต้องปิดภายใน ${cfg.slaDays} วันนับจาก Start date ระบบส่ง email ถึง Owner ในวันที่ ${cfg.alert1Day} วันที่ ${cfg.alert2Day} และทุกวันหลังเกิน Due</p></div>
<div class="actions"><button class="btn" id="btn-sync" type="button">Sync ตอนนี้</button>
<a class="btn" href="api/export?${qs({ from: daysAgo(29), to: daysAgo(0) })}">Export Excel (30 วัน)</a>
<a class="btn primary" href="#/reports">ส่ง Report ให้ Manager</a></div></div>
${data.syncError ? `<div class="banner err">${esc(data.syncError)}</div>` : ""}
${failed.length ? `<div class="banner warn">อ่านเอกสารไม่ได้: ${failed.map((s) => `${esc(s.label)} (${esc(s.error)})`).join(", ")} · แสดงข้อมูลล่าสุดที่อ่านได้</div>` : ""}
<form class="filters" id="flt" onsubmit="return false">
<label class="f">เอกสาร<select name="source"><option value="">ทั้งหมด (${data.sources.length})</option>${sourceOpts}</select></label>
<label class="f" style="flex:2 1 260px">ค้นหาเคส<input type="search" name="q" placeholder="เลขเคส, ลูกค้า, Owner, งาน"></label>
</form>
<div class="kpis">
${kpi("all", "เคสที่ยังไม่ปิด", openTotal, `รวม ${params.source ? "เอกสารนี้" : data.sources.length + " เอกสาร"}`)}
${kpi("normal", `ปกติ (วันที่ 0–${cfg.alert1Day - 1})`, k.normal || 0, "ยังไม่ถึงรอบแจ้งเตือน")}
${kpi("r1", `แจ้งรอบ 1 (วันที่ ${cfg.alert1Day}–${cfg.alert2Day - 1})`, k.r1 || 0, "ส่ง email แล้ว")}
${kpi("r2", `แจ้งรอบ 2 (วันที่ ${cfg.alert2Day}–${cfg.slaDays})`, k.r2 || 0, "ใกล้ครบ Due")}
${kpi("overdue", "เกิน Due", k.overdue || 0, "แจ้งทุกวันจนกว่าจะปิด")}
${kpi("closed", "ปิดแล้ว (30 วัน)", k.sla.closed, k.sla.pct === null ? "-" : `ทัน SLA ${k.sla.pct}%`)}
</div>
<section class="card"><div class="title"><h2>SLA runway: เคสที่ยังเปิดอยู่ทั้งหมด</h2><span>1 จุด = 1 เคส · ชี้เพื่อดูรายละเอียด คลิกเพื่อไปหน้า Owner</span></div>
${data.runway.length ? runwayHtml : `<div class="empty">ไม่มีเคสที่เปิดอยู่ เคสใหม่จะขึ้นที่นี่หลัง Sync</div>`}
<div class="rw-zones">${segs.map((s) => `<span><span class="dot d-${s}" aria-hidden="true"></span>${STAGE[s]}${RANGE[s] ? ` (${RANGE[s]})` : ""}: ${k[s]}</span>`).join("")}</div>
</section>
<section class="card"><div class="title"><h2>สถานะแยกตาม Owner</h2><span>คลิกแถวเพื่อดูรายเคส</span></div>
${data.owners.length ? `<div class="tablewrap"><table style="min-width:820px"><thead><tr><th>Owner</th><th class="n">เปิดอยู่</th><th class="n">ปกติ</th><th class="n">แจ้งรอบ 1</th><th class="n">แจ้งรอบ 2</th><th class="n">เกิน Due</th><th class="n">ปิดทัน SLA (30 วัน)</th></tr></thead><tbody>
${data.owners
  .map(
    (o) => `<tr class="click" data-href="#/owner/${encodeURIComponent(o.id)}">
<td><a href="#/owner/${encodeURIComponent(o.id)}" style="font-weight:600;text-decoration:none">${esc(o.owner)}</a><div class="muted" style="font-size:12px">${esc(o.email || "ไม่มีอีเมลในไฟล์")}</div></td>
<td class="n" style="font-weight:600">${o.open}</td><td class="n">${o.normal}</td><td class="n t-r1">${o.r1}</td><td class="n t-r2">${o.r2}</td><td class="n t-over">${o.overdue}</td>
<td class="n">${o.sla.pct === null ? "-" : `${o.sla.pct}% <span class="muted">(${o.sla.onTime}/${o.sla.closed})</span>`}</td></tr>`
  )
  .join("")}</tbody></table></div>` : `<div class="empty">ไม่มีข้อมูล</div>`}
</section>
${data.topCases.length ? `<section class="card"><div class="title"><h2>เคสที่ต้องตามด่วน</h2><span>แจ้งรอบ 2 และเกิน Due · 10 อันดับแรก</span></div>${caseTable(data.topCases)}</section>` : ""}
<section class="card"><div class="title"><h2>Email แจ้งเตือนที่ส่งวันนี้</h2><span>ถึง Owner · CC ${esc((cfg.alertCc || []).join(", "))}</span></div>
${data.alertsToday.length ? `<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>เวลา</th><th>เลขเคส</th><th>ลูกค้า</th><th>Owner</th><th>ประเภท</th><th>ผล</th></tr></thead><tbody>
${data.alertsToday
  .map(
    (a) => `<tr><td>${fdt(a.sent_at)}</td><td class="mono">${esc(a.cs_number || a.case_key)}</td><td>${esc(a.site || "-")}</td><td>${esc(a.owner || "-")}</td>
<td>${chip(a.alert_type, ALERT[a.alert_type])}</td><td>${a.ok ? chip("ok", "ส่งแล้ว") : `<span class="chip c-fail" title="${esc(a.error)}">ส่งไม่สำเร็จ</span>`}</td></tr>`
  )
  .join("")}</tbody></table></div>` : `<div class="empty">วันนี้ยังไม่มีการส่ง email แจ้งเตือน</div>`}
</section>
<section class="card"><div class="title"><h2>การแก้ไข Start date / Target date (14 วัน)</h2><a href="#/audit" style="font-size:13px">ดูทั้งหมด →</a></div>${changeRows(data.changes.slice(0, 8))}</section>`;

    const f = document.getElementById("flt");
    f.source.onchange = () => (location.hash = "#/?" + qs({ source: f.source.value }));
    f.q.onkeydown = (e) => {
      if (e.key === "Enter") location.hash = "#/cases?" + qs({ q: f.q.value, source: f.source.value });
    };
    bindRowLinks();
    bindSync(() => viewOverview(params));
  }

  function bindRowLinks() {
    document.querySelectorAll("tr.click").forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest("a")) return;
        location.hash = tr.dataset.href;
      };
    });
  }

  function bindSync(reload) {
    const b = document.getElementById("btn-sync");
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = "กำลัง Sync…";
      try {
        const r = await api("/sync", { method: "POST" });
        toast(`Sync แล้ว ${r.cases} เคส${r.changes ? ` · พบการแก้ไขวันที่ ${r.changes} รายการ` : ""}`);
        await reload();
        refreshStatus();
      } catch (e) {
        toast("Sync ไม่สำเร็จ: " + e.message, 6000);
        b.disabled = false;
        b.textContent = "Sync ตอนนี้";
      }
    };
  }

  // ------------------------------------------------------------ case list
  async function viewCases(params) {
    setNav("overview");
    const data = await api("/cases?" + qs({ stage: params.stage, source: params.source, q: params.q }));
    let cases = data.cases;
    if (params.open) cases = cases.filter((c) => c.stage !== "closed");
    if (params.stage === "closed") {
      const since = daysAgo(30);
      cases = cases.filter((c) => (c.endDate || "") >= since);
    }
    cases.sort((a, b) => (b.age || 0) - (a.age || 0));
    const title = params.q ? `ผลค้นหา “${params.q}”` : params.stage ? STAGE[params.stage] : "เคสที่ยังไม่ปิด";
    $app.innerHTML = `<div class="crumb"><a href="#/">ภาพรวม</a> / ${esc(title)}</div>
<div class="head"><div><h1>${esc(title)}</h1><p>${cases.length} เคส</p></div></div>
<section class="card">${caseTable(cases)}</section>`;
  }

  // ------------------------------------------------------------ owner
  async function viewOwner(id) {
    setNav("owner");
    if (!id) {
      const ov = await api("/overview");
      renderSources(ov.sources);
      if (ov.owners.length) {
        location.replace("#/owner/" + encodeURIComponent(ov.owners[0].id));
        return;
      }
      $app.innerHTML = `<div class="empty">ยังไม่มีข้อมูล Owner</div>`;
      return;
    }
    const o = await api("/owner/" + encodeURIComponent(id));
    const k = o.kpis;
    const initial = (o.owner || "?").trim().charAt(0).toUpperCase();
    const open = o.cases.filter((c) => c.stage !== "closed");
    const closed = o.cases.filter((c) => c.stage === "closed");
    const maxWeek = Math.max(1, ...o.weeks.map((w) => w.onTime + w.late));
    const caseByKey = Object.fromEntries(o.cases.map((c) => [c.key, c]));

    // Alert history grouped by case (most recent cases first).
    const byCase = {};
    o.alerts.forEach((a) => (byCase[a.case_key] = byCase[a.case_key] || []).push(a));
    const historyHtml = Object.entries(byCase)
      .slice(0, 6)
      .map(([key, list]) => {
        const c = caseByKey[key];
        const items = list
          .slice()
          .reverse()
          .map(
            (a) => `<div class="it"><span class="dot d-${a.alert_type}" aria-hidden="true"></span><div><div class="t">${ALERT[a.alert_type]} · ${fdt(
              a.sent_at
            )}</div><div class="s">${a.ok ? `ถึง ${esc(a.to_list)}${a.cc_list ? " · CC " + esc(a.cc_list) : ""}` : "ส่งไม่สำเร็จ: " + esc(a.error)}</div></div></div>`
          )
          .join("");
        return `<div><div style="font-weight:600;margin-bottom:8px"><span class="mono">${esc(c?.csNumber || key)}</span> · ${esc(c?.site || "")}</div><div class="timeline">${items}</div></div>`;
      })
      .join("");

    $app.innerHTML = `
<div class="crumb"><a href="#/">ภาพรวม</a> / ${esc(o.owner)}</div>
<section class="card owner-head" style="flex-direction:row">
<div style="display:flex;align-items:center;gap:16px"><div class="avatar" aria-hidden="true">${esc(initial)}</div>
<div><h1 style="font-size:24px">${esc(o.owner)}</h1><div class="muted" style="font-size:14px">${esc(o.email || "ไม่มีอีเมลในไฟล์")} · มีเคสใน ${esc(o.sources.join(", "))}</div></div></div>
<div class="actions"><label class="f" style="flex:0 1 240px;flex-direction:row;align-items:center;gap:8px">เปลี่ยน Owner
<select id="pick">${o.owners.map((x) => `<option value="${esc(x.id)}" ${x.id === o.id ? "selected" : ""}>${esc(x.owner || x.id)}</option>`).join("")}</select></label>
<a class="btn" href="api/export?${qs({ from: daysAgo(29), to: daysAgo(0), owner: o.id })}">Export เคสของ Owner นี้</a></div>
</section>
<div class="kpis">
<div class="kpi k-all"><div class="l">ยังไม่ปิด</div><div class="v">${k.open}</div></div>
<div class="kpi k-normal"><div class="l">ปกติ</div><div class="v">${k.normal}</div></div>
<div class="kpi k-r1"><div class="l">แจ้งรอบ 1</div><div class="v">${k.r1}</div></div>
<div class="kpi k-r2"><div class="l">แจ้งรอบ 2</div><div class="v">${k.r2}</div></div>
<div class="kpi k-overdue"><div class="l">เกิน Due</div><div class="v">${k.overdue}</div></div>
<div class="kpi k-closed"><div class="l">ปิดทัน SLA (30 วัน)</div><div class="v">${k.sla.pct === null ? "-" : k.sla.pct + "%"}</div><div class="s">${k.sla.onTime} จาก ${k.sla.closed} เคส</div></div>
</div>
<section class="card"><div class="title"><h2>เคสที่ยังไม่ปิด</h2><span>เรียงจากเปิดนานสุด · Due = Start date + ${cfg.slaDays} วัน</span></div>${caseTable(open, { showOwner: false })}</section>
<div class="grid2">
<section class="card"><h2>ประวัติแจ้งเตือน (60 วัน)</h2>${historyHtml || `<div class="empty">ยังไม่มี email แจ้งเตือน</div>`}</section>
<section class="card"><h2>ปิดเคสย้อนหลัง 4 สัปดาห์</h2>
<div class="weeks">${o.weeks
      .map(
        (w) => `<div class="w"><div>${w.onTime} / ${w.late}</div>
<div class="stack" style="height:${((w.onTime + w.late) / maxWeek) * 100}%;min-height:${w.onTime + w.late ? 6 : 2}px;background:${w.onTime + w.late ? "transparent" : "var(--row)"}">
${w.late ? `<div style="flex:${w.late};background:var(--over)"></div>` : ""}${w.onTime ? `<div style="flex:${w.onTime};background:var(--normal)"></div>` : ""}</div>
<div>สัปดาห์ ${fd(w.from)}</div></div>`
      )
      .join("")}</div>
<div class="legend"><span><span class="dot d-normal" aria-hidden="true"></span>ปิดทัน SLA</span><span><span class="dot d-overdue" aria-hidden="true"></span>ปิดเกิน Due</span></div>
</section></div>
${o.changes.length ? `<section class="card"><h2>การแก้ไขวันที่ในเคสของ Owner นี้</h2>${changeRows(o.changes)}</section>` : ""}
${closed.length ? `<section class="card"><div class="title"><h2>ปิดแล้วใน 30 วัน</h2><span>${closed.length} เคส</span></div>${caseTable(closed, { showOwner: false })}</section>` : ""}`;
    document.getElementById("pick").onchange = (e) => (location.hash = "#/owner/" + encodeURIComponent(e.target.value));
  }

  // ------------------------------------------------------------ reports
  const DOW = ["", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
  const RANGE_TYPES = {
    prev_week: "สัปดาห์ก่อนหน้า (จ.–อา.)",
    last_7: "7 วันล่าสุด",
    prev_month: "เดือนก่อนหน้า",
    month_to_date: "ต้นเดือนถึงวันนี้",
    last_30: "30 วันล่าสุด",
    yesterday: "เมื่อวาน",
  };

  async function viewReports() {
    setNav("reports");
    const [{ schedules }, { reports }, ov] = await Promise.all([
      api("/schedules"),
      api("/reports/history"),
      api("/overview"),
    ]);
    renderSources(ov.sources);
    const ownerOpts = ov.owners.map((o) => `<option value="${esc(o.id)}">${esc(o.owner)}</option>`).join("");

    $app.innerHTML = `
<div class="head"><div><h1>Report &amp; Export</h1><p>ตั้งรอบส่ง report ให้ Manager ทาง email หรือ export เองตามช่วงวันที่ที่ต้องการ</p></div></div>
<section class="sched">
${schedules
  .map(
    (s) => `<div class="card"><div class="title"><h2>${esc(s.name)}</h2>${s.enabled ? chip("ok", "เปิดใช้") : chip("closed", "ปิดอยู่")}</div>
<div class="meta">${esc(s.description)} · ${esc(RANGE_TYPES[s.range_type] || s.range_type)}<br>ถึง: ${esc(s.recipients)}${s.cc ? `<br>CC: ${esc(s.cc)}` : ""}<br>แนบ: ${s.attach_excel === false ? "ไม่แนบไฟล์" : "Excel"}</div>
<div class="muted" style="font-size:13px">ส่งล่าสุด: ${s.last_sent_at ? fdt(s.last_sent_at) : "ยังไม่เคยส่ง"} · รอบหน้าใช้ข้อมูล ${esc(s.nextRange)}</div>
<div class="actions"><button class="btn" type="button" data-edit="${s.id}">แก้ไข</button><button class="btn" type="button" data-test="${s.id}">ส่งทดสอบ</button><button class="btn danger" type="button" data-del="${s.id}">ลบ</button></div></div>`
  )
  .join("")}
<button class="add" type="button" id="add-sched">เพิ่มรอบส่ง Report</button>
</section>

<section class="card"><h2>ส่ง Report / Export แบบ Manual</h2>
<form id="manual" class="formgrid" onsubmit="return false">
<label class="f">ตั้งแต่วันที่<input type="date" name="from" value="${daysAgo(29)}" required></label>
<label class="f">ถึงวันที่<input type="date" name="to" value="${daysAgo(0)}" required></label>
<label class="f">Owner<select name="owner"><option value="">ทุกคน</option>${ownerOpts}</select></label>
<label class="f">รูปแบบไฟล์<select name="format"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label>
<label class="f" style="grid-column:1/-1">ส่งถึง (คั่นด้วย , ถ้ามีหลายคน)<input type="text" name="recipients" placeholder="manager@sinostech.co.th"></label>
</form>
<div id="preview" class="muted" style="font-size:14px"></div>
<div class="right"><button class="btn" type="button" id="btn-preview">ดูตัวเลขก่อน</button><button class="btn" type="button" id="btn-send">ส่งช่วงนี้ทาง Email ตอนนี้</button><button class="btn primary" type="button" id="btn-dl">ดาวน์โหลด</button></div>
</section>

<section class="card"><h2>ประวัติการส่ง Report</h2>
${reports.length ? `<div class="tablewrap"><table style="min-width:680px"><thead><tr><th>ส่งเมื่อ</th><th>Report</th><th>ช่วงข้อมูล</th><th>ผู้รับ</th><th>ผล</th></tr></thead><tbody>
${reports
  .map(
    (r) => `<tr><td>${fdt(r.sent_at)}</td><td>${esc(r.title)}</td><td>${fd(r.range_from)} – ${fd(r.range_to)}</td><td>${esc(r.recipients)}</td><td>${r.ok ? chip("ok", "ส่งแล้ว") : `<span class="chip c-fail" title="${esc(r.error)}">ไม่สำเร็จ</span>`}</td></tr>`
  )
  .join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีการส่ง report</div>`}
</section>
<dialog id="dlg"></dialog>`;

    const m = document.getElementById("manual");
    const params = () => ({ from: m.from.value, to: m.to.value, owner: m.owner.value });
    document.getElementById("btn-dl").onclick = () => {
      location.href = "api/export?" + qs({ ...params(), format: m.format.value });
    };
    document.getElementById("btn-preview").onclick = async () => {
      try {
        const p = await api("/reports/preview?" + qs(params()));
        const k = p.kpis;
        document.getElementById("preview").innerHTML = `ช่วง ${esc(p.rangeLabel)}: เปิดใหม่ <strong>${k.opened}</strong> · ปิด <strong>${k.closed}</strong> (ทัน SLA ${
          k.slaPct === null ? "-" : k.slaPct + "%"
        }) · ยังเปิดอยู่ ${k.openNow} · เกิน Due ขณะนี้ <strong>${k.overdueNow}</strong> · แก้ไขวันที่ ${p.changes} ครั้ง`;
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    document.getElementById("btn-send").onclick = async (ev) => {
      if (!m.recipients.value.trim()) return toast("กรุณาใส่อีเมลผู้รับ");
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        const r = await api("/reports/send", { method: "POST", body: JSON.stringify({ ...params(), recipients: m.recipients.value, title: "รายงานสถานะเคส" }) });
        toast(r.dryRun ? "โหมดทดสอบ: บันทึกแล้วแต่ยังไม่ได้ส่ง email จริง" : `ส่ง report ถึง ${r.recipients.join(", ")} แล้ว`, 5000);
        viewReports();
      } catch (e) {
        toast("ส่งไม่สำเร็จ: " + e.message, 6000);
        b.disabled = false;
      }
    };
    document.getElementById("add-sched").onclick = () => openSchedule(null);
    $app.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openSchedule(schedules.find((s) => s.id == b.dataset.edit))));
    $app.querySelectorAll("[data-del]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm("ลบรอบส่งนี้?")) return;
          await api("/schedules/" + b.dataset.del, { method: "DELETE" });
          viewReports();
        })
    );
    $app.querySelectorAll("[data-test]").forEach(
      (b) =>
        (b.onclick = async () => {
          const to = prompt("ส่งทดสอบไปที่อีเมล (เว้นว่าง = ส่งถึงผู้รับจริงของรอบนี้)", "");
          if (to === null) return;
          b.disabled = true;
          try {
            const r = await api(`/schedules/${b.dataset.test}/test`, { method: "POST", body: JSON.stringify(to ? { to } : {}) });
            toast(r.dryRun ? "โหมดทดสอบ: ยังไม่ได้ส่ง email จริง" : `ส่งทดสอบถึง ${r.recipients.join(", ")} แล้ว`, 5000);
            viewReports();
          } catch (e) {
            toast("ส่งไม่สำเร็จ: " + e.message, 6000);
            b.disabled = false;
          }
        })
    );
  }

  function openSchedule(s) {
    const v = s || { name: "Weekly Report", enabled: true, frequency: "weekly", day_of_week: 1, day_of_month: 1, send_time: "08:30", range_type: "prev_week", recipients: "", cc: "", attach_excel: true };
    const dlg = document.getElementById("dlg");
    dlg.innerHTML = `<form class="card" method="dialog" id="sf">
<h2>${s ? "แก้ไขรอบส่ง" : "เพิ่มรอบส่ง Report"}</h2>
<div class="formgrid">
<label class="f">ชื่อ Report<input name="name" value="${esc(v.name)}" required></label>
<label class="f">ผู้รับ (Manager)<input name="recipients" value="${esc(v.recipients)}" placeholder="manager@sinostech.co.th" required></label>
<label class="f">CC<input name="cc" value="${esc(v.cc || "")}"></label>
<label class="f">ความถี่<select name="frequency">${[["daily", "ทุกวัน"], ["weekly", "ทุกสัปดาห์"], ["monthly", "ทุกเดือน"]]
      .map(([k, t]) => `<option value="${k}" ${v.frequency === k ? "selected" : ""}>${t}</option>`)
      .join("")}</select></label>
<label class="f" data-for="weekly">วันที่ส่ง<select name="day_of_week">${DOW.slice(1)
      .map((t, i) => `<option value="${i + 1}" ${Number(v.day_of_week) === i + 1 ? "selected" : ""}>วัน${t}</option>`)
      .join("")}</select></label>
<label class="f" data-for="monthly">วันที่ของเดือน<input type="number" min="1" max="28" name="day_of_month" value="${esc(v.day_of_month || 1)}"></label>
<label class="f">เวลา<input type="time" name="send_time" value="${esc(v.send_time)}"></label>
<label class="f">ช่วงข้อมูล<select name="range_type">${Object.entries(RANGE_TYPES)
      .map(([k, t]) => `<option value="${k}" ${v.range_type === k ? "selected" : ""}>${t}</option>`)
      .join("")}</select></label>
</div>
<fieldset><legend>ตัวเลือก</legend>
<label class="chk"><input type="checkbox" name="enabled" ${v.enabled ? "checked" : ""}>เปิดใช้รอบส่งนี้</label>
<label class="chk"><input type="checkbox" name="attach_excel" ${v.attach_excel !== false ? "checked" : ""}>แนบไฟล์ Excel</label>
</fieldset>
<div class="right"><button class="btn" value="cancel" type="submit" formnovalidate>ยกเลิก</button><button class="btn primary" value="save" type="submit">บันทึกรอบส่ง</button></div>
</form>`;
    const f = dlg.querySelector("#sf");
    const toggle = () =>
      f.querySelectorAll("[data-for]").forEach((el) => (el.style.display = el.dataset.for === f.frequency.value ? "" : "none"));
    f.frequency.onchange = toggle;
    toggle();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "save") return;
      const body = {
        name: f.name.value.trim(),
        recipients: f.recipients.value.trim(),
        cc: f.cc.value.trim(),
        frequency: f.frequency.value,
        day_of_week: Number(f.day_of_week.value),
        day_of_month: Number(f.day_of_month.value),
        send_time: f.send_time.value,
        range_type: f.range_type.value,
        enabled: f.enabled.checked,
        attach_excel: f.attach_excel.checked,
      };
      try {
        await api(s ? `/schedules/${s.id}` : "/schedules", { method: s ? "PUT" : "POST", body: JSON.stringify(body) });
        toast("บันทึกรอบส่งแล้ว");
        viewReports();
      } catch (e) {
        toast("บันทึกไม่สำเร็จ: " + e.message, 6000);
      }
    };
    dlg.showModal();
  }

  // ------------------------------------------------------------ audit
  async function viewAudit(params) {
    setNav("audit");
    const days = Number(params.days || 90);
    const { changes } = await api("/changes?days=" + days);
    const starts = changes.filter((c) => c.field === "start_date").length;
    $app.innerHTML = `<div class="head"><div><h1>ประวัติแก้ไขวันที่</h1>
<p>Start date ถูก stamp อัตโนมัติครั้งเดียวตอนเปิดเคส ระบบเทียบกับค่าที่เคยเห็นทุก 15 นาที ถ้ามีการแก้จะแจ้ง ${esc((cfg.alertCc || []).join(", "))} ทาง email และ Telegram</p></div>
<div class="actions"><select id="days" aria-label="ช่วงเวลา" style="width:auto">${[7, 30, 90, 180]
      .map((n) => `<option value="${n}" ${n === days ? "selected" : ""}>${n} วันล่าสุด</option>`)
      .join("")}</select></div></div>
<div class="kpis"><div class="kpi"><div class="l">แก้ Start date</div><div class="v">${starts}</div></div>
<div class="kpi"><div class="l">แก้ Target date</div><div class="v">${changes.length - starts}</div></div>
<div class="kpi"><div class="l">เลื่อนออกไป (ทำให้ดูไม่เกิน Due)</div><div class="v t-r2">${changes.filter((c) => c.direction === "later").length}</div></div></div>
<section class="card">${changeRows(changes)}</section>`;
    document.getElementById("days").onchange = (e) => (location.hash = "#/audit?days=" + e.target.value);
  }

  // ------------------------------------------------------------ router
  async function route() {
    const { parts, params } = parseHash();
    window.scrollTo(0, 0);
    refreshStatus();
    try {
      if (parts[0] === "owner") await viewOwner(parts[1] ? decodeURIComponent(parts[1]) : null);
      else if (parts[0] === "reports") await viewReports();
      else if (parts[0] === "audit") await viewAudit(params);
      else if (parts[0] === "cases") await viewCases(params);
      else await viewOverview(params);
    } catch (e) {
      $app.innerHTML = `<div class="banner err">โหลดข้อมูลไม่สำเร็จ: ${esc(e.message)}</div>`;
    }
  }
  window.addEventListener("hashchange", route);
  route();
})();
