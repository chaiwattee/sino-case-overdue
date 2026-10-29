/* Sino Case SLA v3 — web input, users and permissions (plain JS, no build step). */
(function () {
  "use strict";
  const $app = document.getElementById("app");

  // ------------------------------------------------------------ utils
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  function fd(iso, year) {
    if (!iso) return "-";
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    if (!y || !m) return esc(iso);
    return `${d} ${TH_MONTHS[m - 1]}${year ? " " + (y + 543) : ""}`;
  }
  function fdt(ts) {
    if (!ts) return "-";
    const t = new Date(ts);
    return `${t.getDate()} ${TH_MONTHS[t.getMonth()]} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }
  const isoDay = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const daysAgo = (n) => {
    const t = new Date();
    t.setDate(t.getDate() - n);
    return isoDay(t);
  };
  const STAGE = { normal: "ปกติ", r1: "แจ้งรอบ 1", r2: "แจ้งรอบ 2", overdue: "เกิน Due", no_start: "ไม่มี Start date", closed: "ปิดแล้ว" };
  const ALERT = { r1: "แจ้งรอบ 1", r2: "แจ้งรอบ 2", overdue: "เกิน Due" };
  const ROLE = { admin: "Admin", manager: "Manager", engineer: "Engineer", viewer: "Viewer" };
  const ROLE_CHIP = { admin: "overdue", manager: "r1", engineer: "ok", viewer: "closed" };
  const KINDS = ["ดำเนินการ", "ติดต่อลูกค้า", "เปิดเคส Vendor", "Remote / Onsite", "รอข้อมูล"];
  const chip = (stage, text) => `<span class="chip c-${stage}">${esc(text || STAGE[stage] || stage)}</span>`;
  const qs = (o) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

  let ME = null;
  let cfg = { slaDays: 7, alert1Day: 3, alert2Day: 6 };
  let LOOKUPS = null;

  const lvl = (perm) => (ME && ME.perms[perm]) || "none";
  const can = (perm, kase) => {
    const l = lvl(perm);
    if (l === "all") return true;
    if (l === "own") return kase ? kase.ownerUserId === ME.user.id : true;
    return false;
  };

  async function api(path, opts = {}) {
    const res = await fetch("api" + path, {
      credentials: "same-origin",
      ...opts,
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("กรุณาเข้าสู่ระบบ");
    }
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    if (res.status === 403 && body && body.code === "MUST_CHANGE") {
      if (location.hash !== "#/password") location.hash = "#/password";
      throw new Error(body.error);
    }
    if (!res.ok) throw new Error((body && body.error) || res.statusText);
    return body;
  }
  const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body || {}) });

  function toast(msg, ms = 3500) {
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  async function lookups(force) {
    if (!LOOKUPS || force) LOOKUPS = await api("/lookups");
    return LOOKUPS;
  }

  // ------------------------------------------------------------ chrome
  function buildChrome() {
    const tabs = [
      ["overview", "#/", "ภาพรวม", true],
      ["mine", "#/mine", "เคสของฉัน", lvl("case_create") !== "none" || lvl("case_edit") !== "none"],
      ["owner", "#/owner", "ราย Owner", true],
      ["reports", "#/reports", "Report &amp; Export", lvl("export") !== "none" || lvl("reports_manage") !== "none"],
      ["audit", "#/audit", "ประวัติแก้ไข", lvl("audit_view") !== "none"],
      ["users", "#/users", "จัดการผู้ใช้", lvl("users_manage") !== "none"],
      ["settings", "#/settings", "ตั้งค่า", lvl("settings_manage") !== "none"],
    ];
    document.getElementById("tabs").innerHTML = tabs
      .filter((t) => t[3])
      .map(([k, h, l]) => `<a href="${h}" data-nav="${k}">${l}</a>`)
      .join("");
    const u = ME.user;
    document.getElementById("me-av").textContent = (u.display_name || u.email).trim().charAt(0).toUpperCase();
    document.getElementById("me-name").innerHTML = `${esc(u.display_name.split(" ")[0])} <span class="muted">· ${ROLE[u.role]}</span>`;
    document.getElementById("me-head").innerHTML = `<strong>${esc(u.display_name)}</strong>${esc(u.email)}<br>${ROLE[u.role]} · ${
      u.role === "admin" ? "ทุกทีม" : esc(u.teams.map((t) => teamLabel(t)).join(", ") || "ยังไม่มีทีม")
    }`;
    document.getElementById("menu-pw").hidden = u.auth_type !== "local";
    const btn = document.getElementById("me-btn");
    const menu = document.getElementById("me-menu");
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    };
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target)) {
        menu.hidden = true;
        btn.setAttribute("aria-expanded", "false");
      }
    });
    document.getElementById("menu-logout").onclick = async () => {
      await fetch("/auth/logout", { method: "POST", headers: { "X-Requested-With": "fetch" } }).catch(() => {});
      location.href = "/login.html";
    };
    document.getElementById("dry-banner").hidden = !ME.config.dryRunEmail;
    document.getElementById("nav-sources").textContent = `ทีม: ${ME.teams.map((t) => t.label).join(", ")} · SLA ปิดเคสภายใน ${ME.config.slaDays} วัน`;
    document.getElementById("theme").onclick = () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch (e) {}
    };
  }
  const teamLabel = (code) => (ME.teams.find((t) => t.key === code) || {}).label || code;
  function setNav(name) {
    document.querySelectorAll("#tabs a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
  }

  // ------------------------------------------------------------ shared pieces
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

  function caseTable(cases, { showOwner = true } = {}) {
    if (!cases.length) return `<div class="empty">ไม่มีเคส</div>`;
    return `<div class="tablewrap"><table style="min-width:${showOwner ? 980 : 880}px">
<thead><tr><th>เลขเคส</th><th>ลูกค้า / งาน</th>${showOwner ? "<th>Owner</th>" : ""}<th>ทีม</th><th>เปิดเคส</th><th>Due</th><th>อายุเคส</th><th>สถานะ</th></tr></thead>
<tbody>${cases
      .map(
        (c) => `<tr class="click" data-href="#/case/${c.id}">
<td><a class="mono" href="#/case/${c.id}">${esc(c.csNumber || "#" + c.id)}</a></td>
<td><div style="font-weight:600">${esc(c.site || "-")}</div><div class="muted" style="font-size:12px">${esc(c.task || "")}</div></td>
${showOwner ? `<td><a href="#/owner/${encodeURIComponent(c.ownerId)}">${esc(c.owner || "-")}</a></td>` : ""}
<td>${esc(c.sourceLabel)}</td>
<td>${fd(c.startDate)}</td>
<td>${fd(c.dueDate)}</td>
<td>${ageCell(c)}</td>
<td>${chip(c.stage)}<div class="muted" style="font-size:12px;margin-top:4px">${esc(c.status || "")}</div></td>
</tr>`
      )
      .join("")}</tbody></table></div>`;
  }

  const FIELD = { start_date: "Start date", target_date: "Target date", status: "Status", owner: "Owner", deleted: "ลบเคส" };
  const DIR = { later: "เลื่อนออกไป", earlier: "เลื่อนเข้ามา", set: "ใส่ค่าใหม่", cleared: "ลบค่าออก" };
  function changeRows(changes, { empty = "ยังไม่มีประวัติการแก้ไข" } = {}) {
    if (!changes.length) return `<div class="empty">${empty}</div>`;
    const val = (c, v) => (c.field === "start_date" || c.field === "target_date" ? fd(v, true) : esc(v || "-"));
    return `<div class="tablewrap"><table style="min-width:860px"><thead><tr><th>เมื่อ</th><th>เคส</th><th>Owner</th><th>รายการ</th><th>เดิม → ใหม่</th><th>แก้โดย</th></tr></thead><tbody>${changes
      .map(
        (c) => `<tr>
<td>${fdt(c.detected_at)}</td>
<td>${c.case_id ? `<a class="mono" href="#/case/${c.case_id}">${esc(c.cs_number || "#" + c.case_id)}</a>` : `<span class="mono">${esc(c.cs_number || "-")}</span>`}<div class="muted" style="font-size:12px">${esc(teamLabel(c.team || c.source))} · ${esc(c.site || "-")}</div></td>
<td>${esc(c.owner || c.owner_name || "-")}</td>
<td>${esc(FIELD[c.field] || c.field)}</td>
<td>${val(c, c.old_value)} → <strong>${val(c, c.new_value)}</strong>${c.direction ? `<div style="font-size:12px" class="${c.direction === "later" ? "t-r2" : "muted"}">${esc(DIR[c.direction] || "")}</div>` : ""}${c.reason ? `<div class="hint">เหตุผล: ${esc(c.reason)}</div>` : ""}</td>
<td>${esc(c.changed_by_name || c.last_modified_by || "-")}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
  }

  function bindRowLinks() {
    document.querySelectorAll("tr.click").forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest("a,button,select,input,label")) return;
        location.hash = tr.dataset.href;
      };
    });
  }

  // ------------------------------------------------------------ overview
  async function viewOverview(params) {
    setNav("overview");
    const data = await api("/overview?" + qs({ source: params.source }));
    cfg = data.config;
    const k = data.kpis;
    const openTotal = k.open || 0;
    const segs = ["normal", "r1", "r2", "overdue"].filter((s) => k[s] > 0);
    const RANGE = { normal: `0–${cfg.alert1Day - 1} วัน`, r1: `${cfg.alert1Day}–${cfg.alert2Day - 1} วัน`, r2: `${cfg.alert2Day}–${cfg.slaDays} วัน`, overdue: `${cfg.slaDays + 1} วันขึ้นไป` };
    const teamOpts = data.sources.map((s) => `<option value="${esc(s.key)}" ${params.source === s.key ? "selected" : ""}>${esc(s.label)}</option>`).join("");
    const kpi = (stage, label, value, sub) =>
      `<a class="kpi k-${stage}" href="#/cases?${qs({ stage: stage === "all" ? "" : stage, source: params.source, open: stage === "all" ? 1 : "" })}"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></a>`;

    const zoneOf = (day) => (day < cfg.alert1Day ? "normal" : day < cfg.alert2Day ? "r1" : "r2");
    const cols = [];
    for (let day = 0; day <= cfg.slaDays; day++) cols.push({ day, zone: zoneOf(day), items: data.runway.filter((c) => c.age === day) });
    const over = data.runway.filter((c) => c.age > cfg.slaDays).sort((a, b) => b.daysOverdue - a.daysOverdue);
    const dotHtml = (c) =>
      `<a class="rw-dot c-${c.stage}" href="#/case/${c.id}" title="${esc(`${c.csNumber || "#" + c.id} · ${c.site || "-"} · ${c.owner || "-"} · วันที่ ${c.age}${c.daysOverdue ? ` (เกิน ${c.daysOverdue} วัน)` : ""}`)}" aria-label="${esc(`${c.csNumber || "เคส"} ของ ${c.owner || "-"} วันที่ ${c.age}`)}"></a>`;
    const dayLabel = (d) => (d === 0 ? "เปิดเคส" : d === cfg.alert1Day ? "แจ้งรอบ 1" : d === cfg.alert2Day ? "แจ้งรอบ 2" : d === cfg.slaDays ? "ครบ Due" : "&nbsp;");
    const runwayHtml = `<div class="runway-wrap"><div class="runway" role="img" aria-label="เคสที่ยังเปิดอยู่ แยกตามจำนวนวันนับจาก Start date">
${cols.map((c) => `<div class="rw-col"><div class="rw-count">${c.items.length || ""}</div><div class="rw-dots">${c.items.map(dotHtml).join("")}</div><div class="rw-band z-${c.zone}"></div><div class="rw-day"><strong>วันที่ ${c.day}</strong>${dayLabel(c.day)}</div></div>`).join("")}
<div class="rw-col due"><div class="rw-count">${over.length || ""}</div><div class="rw-dots">${over.map(dotHtml).join("")}</div><div class="rw-band z-overdue"></div><div class="rw-day"><strong>เกิน Due</strong>แจ้งทุกวัน</div></div>
</div></div>`;

    $app.innerHTML = `
<div class="head"><div><h1>ภาพรวมสถานะเคส</h1>
<p>ทุกเคสต้องปิดภายใน ${cfg.slaDays} วันนับจาก Start date ระบบส่ง email ถึง Owner ในวันที่ ${cfg.alert1Day} วันที่ ${cfg.alert2Day} และทุกวันหลังเกิน Due</p></div>
<div class="actions">
${lvl("export") === "all" ? `<a class="btn" href="api/export?${qs({ from: daysAgo(29), to: daysAgo(0), source: params.source })}">Export Excel (30 วัน)</a>` : ""}
${can("case_create") ? `<a class="btn primary" href="#/case/new">เปิดเคสใหม่</a>` : ""}</div></div>
<form class="filters" id="flt" onsubmit="return false">
<label class="f">ทีม<select name="source"><option value="">ทุกทีมที่เห็นได้ (${data.sources.length})</option>${teamOpts}</select></label>
<label class="f" style="flex:2 1 260px">ค้นหาเคส<input type="search" name="q" placeholder="เลขเคส, ลูกค้า, Owner, งาน"></label>
</form>
<div class="kpis">
${kpi("all", "เคสที่ยังไม่ปิด", openTotal, params.source ? esc(teamLabel(params.source)) : "ทุกทีมที่เห็นได้")}
${kpi("normal", `ปกติ (วันที่ 0–${cfg.alert1Day - 1})`, k.normal || 0, "ยังไม่ถึงรอบแจ้งเตือน")}
${kpi("r1", `แจ้งรอบ 1 (วันที่ ${cfg.alert1Day}–${cfg.alert2Day - 1})`, k.r1 || 0, "ส่ง email แล้ว")}
${kpi("r2", `แจ้งรอบ 2 (วันที่ ${cfg.alert2Day}–${cfg.slaDays})`, k.r2 || 0, "ใกล้ครบ Due")}
${kpi("overdue", "เกิน Due", k.overdue || 0, "แจ้งทุกวันจนกว่าจะปิด")}
${kpi("closed", "ปิดแล้ว (30 วัน)", k.sla.closed, k.sla.pct === null ? "-" : `ทัน SLA ${k.sla.pct}%`)}
</div>
<section class="card"><div class="title"><h2>SLA runway: เคสที่ยังเปิดอยู่ทั้งหมด</h2><span>1 จุด = 1 เคส · คลิกเพื่อเปิดเคส</span></div>
${data.runway.length ? runwayHtml : `<div class="empty">ไม่มีเคสที่เปิดอยู่</div>`}
<div class="rw-zones">${segs.map((s) => `<span><span class="dot d-${s}" aria-hidden="true"></span>${STAGE[s]} (${RANGE[s]}): ${k[s]}</span>`).join("")}</div>
</section>
<section class="card"><div class="title"><h2>สถานะแยกตาม Owner</h2><span>คลิกแถวเพื่อดูรายเคส</span></div>
${data.owners.length ? `<div class="tablewrap"><table style="min-width:820px"><thead><tr><th>Owner</th><th class="n">เปิดอยู่</th><th class="n">ปกติ</th><th class="n">แจ้งรอบ 1</th><th class="n">แจ้งรอบ 2</th><th class="n">เกิน Due</th><th class="n">ปิดทัน SLA (30 วัน)</th></tr></thead><tbody>
${data.owners.map((o) => `<tr class="click" data-href="#/owner/${encodeURIComponent(o.id)}">
<td><a href="#/owner/${encodeURIComponent(o.id)}" style="font-weight:600">${esc(o.owner)}</a><div class="muted" style="font-size:12px">${esc(o.email || "-")}</div></td>
<td class="n" style="font-weight:600">${o.open}</td><td class="n">${o.normal}</td><td class="n t-r1">${o.r1}</td><td class="n t-r2">${o.r2}</td><td class="n t-over">${o.overdue}</td>
<td class="n">${o.sla.pct === null ? "-" : `${o.sla.pct}% <span class="muted">(${o.sla.onTime}/${o.sla.closed})</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีเคส</div>`}
</section>
${data.topCases.length ? `<section class="card"><div class="title"><h2>เคสที่ต้องตามด่วน</h2><span>แจ้งรอบ 2 และเกิน Due · 10 อันดับแรก</span></div>${caseTable(data.topCases)}</section>` : ""}
<section class="card"><div class="title"><h2>Email แจ้งเตือนที่ส่งวันนี้</h2><span>ถึง Owner · CC ${esc((cfg.alertCc || []).join(", "))}</span></div>
${data.alertsToday.length ? `<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>เวลา</th><th>เลขเคส</th><th>ลูกค้า</th><th>Owner</th><th>ประเภท</th><th>ผล</th></tr></thead><tbody>
${data.alertsToday.map((a) => `<tr><td>${fdt(a.sent_at)}</td><td><a class="mono" href="#/case/${a.case_id}">${esc(a.cs_number || "#" + a.case_id)}</a></td><td>${esc(a.site || "-")}</td><td>${esc(a.owner || "-")}</td>
<td>${chip(a.alert_type, ALERT[a.alert_type])}</td><td>${a.ok ? chip("ok", "ส่งแล้ว") : `<span class="chip c-fail" title="${esc(a.error)}">ส่งไม่สำเร็จ</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">วันนี้ยังไม่มีการส่ง email แจ้งเตือน</div>`}
</section>
${lvl("audit_view") !== "none" ? `<section class="card"><div class="title"><h2>การแก้ไขล่าสุด (14 วัน)</h2><a href="#/audit">ดูทั้งหมด</a></div>${changeRows(data.changes.slice(0, 8))}</section>` : ""}`;

    const f = document.getElementById("flt");
    f.source.onchange = () => (location.hash = "#/?" + qs({ source: f.source.value }));
    f.q.onkeydown = (e) => {
      if (e.key === "Enter") location.hash = "#/cases?" + qs({ q: f.q.value, source: f.source.value });
    };
    bindRowLinks();
  }

  // ------------------------------------------------------------ case lists
  async function viewCases(params) {
    setNav("overview");
    let { cases } = await api("/cases?" + qs({ stage: params.stage, source: params.source, q: params.q }));
    if (params.open) cases = cases.filter((c) => c.stage !== "closed");
    if (params.stage === "closed") cases = cases.filter((c) => (c.endDate || "") >= daysAgo(30));
    cases.sort((a, b) => (b.age || 0) - (a.age || 0));
    const title = params.q ? `ผลค้นหา “${params.q}”` : params.stage ? STAGE[params.stage] : "เคสที่ยังไม่ปิด";
    $app.innerHTML = `<div class="crumb"><a href="#/">ภาพรวม</a> / ${esc(title)}</div>
<div class="head"><div><h1>${esc(title)}</h1><p>${cases.length} เคส</p></div></div>
<section class="card">${caseTable(cases)}</section>`;
    bindRowLinks();
  }

  async function viewMine(params) {
    setNav("mine");
    const [{ cases }, lk] = await Promise.all([api("/cases?mine=1"), lookups()]);
    const tab = params.tab || "open";
    const open = cases.filter((c) => c.stage !== "closed");
    const closed30 = cases.filter((c) => c.stage === "closed" && (c.endDate || "") >= daysAgo(30));
    let list = tab === "open" ? open : tab === "closed" ? closed30 : cases;
    if (params.q) {
      const s = params.q.toLowerCase();
      list = list.filter((c) => [c.csNumber, c.site, c.task, c.product].some((v) => String(v || "").toLowerCase().includes(s)));
    }
    list.sort((a, b) => (a.stage === "closed") - (b.stage === "closed") || (b.age || 0) - (a.age || 0));
    const cnt = (s) => open.filter((c) => c.stage === s).length;
    const soon = open.filter((c) => c.stage === "r2" || c.stage === "overdue");
    const sla = (() => {
      const cl = closed30;
      const ok = cl.filter((c) => c.closedOnTime === true).length;
      return cl.length ? Math.round((ok / cl.length) * 100) + "%" : "-";
    })();
    const statusSel = (c) => {
      const editable = can("case_edit", c);
      if (!editable) return `${esc(c.status)}`;
      const opts = lk.status.map((s) => `<option ${s === c.status ? "selected" : ""}>${esc(s)}</option>`).join("");
      return `<label><span class="sr">Status ของ ${esc(c.csNumber || c.id)}</span><select class="inline" data-status="${c.id}" data-prev="${esc(c.status)}">${opts}</select></label>`;
    };
    $app.innerHTML = `
<div class="head"><div><h1>เคสของฉัน</h1><p>เปิดเคสใหม่ อัปเดตความคืบหน้า และปิดเคสได้จากหน้านี้</p></div>
<div class="actions">${lvl("export") !== "none" ? `<a class="btn" href="api/export?${qs({ from: daysAgo(89), to: daysAgo(0), owner: ME.user.email })}">Export เคสของฉัน</a>` : ""}
${can("case_create") ? `<a class="btn primary" href="#/case/new">เปิดเคสใหม่</a>` : ""}</div></div>
${soon.length ? `<div class="banner warn" role="status">${soon.map((c) => `<a href="#/case/${c.id}">${esc(c.csNumber || "#" + c.id)}</a> ${c.stage === "overdue" ? `เกิน Due มาแล้ว ${c.daysOverdue} วัน` : c.daysLeft === 0 ? "ครบกำหนดวันนี้" : `เหลือ ${c.daysLeft} วัน`}`).join(" · ")}</div>` : ""}
<div class="kpis">
<div class="kpi k-all"><div class="l">ยังเปิดอยู่</div><div class="v">${open.length}</div></div>
<div class="kpi k-normal"><div class="l">ปกติ</div><div class="v">${cnt("normal")}</div></div>
<div class="kpi k-r1"><div class="l">แจ้งรอบ 1</div><div class="v">${cnt("r1")}</div></div>
<div class="kpi k-r2"><div class="l">แจ้งรอบ 2</div><div class="v">${cnt("r2")}</div></div>
<div class="kpi k-overdue"><div class="l">เกิน Due</div><div class="v">${cnt("overdue")}</div></div>
<div class="kpi k-closed"><div class="l">ปิดทัน SLA (30 วัน)</div><div class="v">${sla}</div></div>
</div>
<section class="card">
<div class="title"><div class="tabs2" role="tablist">
<a role="tab" href="#/mine?tab=open" class="${tab === "open" ? "on" : ""}" aria-selected="${tab === "open"}">ยังเปิดอยู่ (${open.length})</a>
<a role="tab" href="#/mine?tab=closed" class="${tab === "closed" ? "on" : ""}" aria-selected="${tab === "closed"}">ปิดแล้ว 30 วัน (${closed30.length})</a>
<a role="tab" href="#/mine?tab=all" class="${tab === "all" ? "on" : ""}" aria-selected="${tab === "all"}">ทั้งหมด (${cases.length})</a></div>
<label style="flex:0 1 280px"><span class="sr">ค้นหาเคส</span><input type="search" id="q" value="${esc(params.q || "")}" placeholder="ค้นหา CS, ลูกค้า, งาน"></label></div>
${list.length ? `<div class="tablewrap"><table style="min-width:980px"><thead><tr><th>เลขเคส</th><th>ลูกค้า / งาน</th><th>Product</th><th>เปิดเคส</th><th style="width:150px">อายุเคส</th><th style="width:170px">Status</th><th>อัปเดตล่าสุด</th><th></th></tr></thead><tbody>
${list.map((c) => `<tr class="click" data-href="#/case/${c.id}">
<td><a class="mono" href="#/case/${c.id}">${esc(c.csNumber || "#" + c.id)}</a><div class="hint">${esc(c.sourceLabel)}</div></td>
<td><div style="font-weight:600">${esc(c.site)}</div><div class="muted" style="font-size:12px">${esc(c.task)}</div></td>
<td>${esc(c.product || "-")}</td>
<td>${fd(c.startDate)}<div class="hint">Due ${fd(c.dueDate)}</div></td>
<td>${ageCell(c)}</td>
<td>${statusSel(c)}</td>
<td style="font-size:13px" class="muted">${fdt(c.updatedAt)}</td>
<td style="text-align:right"><a href="#/case/${c.id}" style="font-weight:600">แก้ไข</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${tab === "open" ? "ไม่มีเคสที่เปิดอยู่ กด “เปิดเคสใหม่” เพื่อเริ่ม" : "ไม่มีเคส"}</div>`}
</section>
<p class="hint">เปลี่ยน Status ในตารางแล้วบันทึกทันที ถ้าเลือก Success, Resolved, Cancel หรือ N/A ระบบจะใส่ End date ให้และหยุดแจ้งเตือน</p>`;
    bindRowLinks();
    const q = document.getElementById("q");
    q.onkeydown = (e) => {
      if (e.key === "Enter") location.hash = "#/mine?" + qs({ tab, q: q.value });
    };
    $app.querySelectorAll("select[data-status]").forEach((sel) => {
      sel.onchange = async () => {
        try {
          await post(`/case/${sel.dataset.status}`, { status: sel.value }, "PUT");
          toast(`บันทึก Status เป็น ${sel.value} แล้ว`);
          viewMine(params);
        } catch (e) {
          toast("บันทึกไม่สำเร็จ: " + e.message, 6000);
          sel.value = sel.dataset.prev;
        }
      };
    });
  }

  // ------------------------------------------------------------ case form
  function comboBox(name, value, options, { allowNew = true, required = true, label = "" } = {}) {
    return `<div class="combo" data-combo="${name}">
<label class="f"><span class="${required ? "req" : ""}">${label}</span>
<input type="text" name="${name}" value="${esc(value || "")}" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" ${required ? "required" : ""}></label>
<div class="combo-list" role="listbox" hidden></div>
${allowNew ? `<span class="hint">พิมพ์ชื่อใหม่ได้ ระบบจะเพิ่มเข้า dropdown ให้ทุกคนใช้ต่อ และแจ้ง Admin ตรวจชื่อซ้ำ</span>` : ""}</div>`;
  }
  function bindCombo(root, name, options, { allowNew = true } = {}) {
    const wrap = root.querySelector(`[data-combo="${name}"]`);
    const input = wrap.querySelector("input");
    const list = wrap.querySelector(".combo-list");
    let hl = -1;
    const render = () => {
      const v = input.value.trim().toLowerCase();
      const matches = options.filter((o) => !v || o.toLowerCase().includes(v)).slice(0, 12);
      const exact = options.some((o) => o.toLowerCase() === v);
      const items = matches.map((o) => `<button type="button" role="option" data-v="${esc(o)}">${esc(o)}</button>`);
      if (allowNew && v && !exact) items.push(`<button type="button" role="option" class="add-new" data-v="${esc(input.value.trim())}">+ เพิ่ม “${esc(input.value.trim())}” เป็นรายการใหม่</button>`);
      list.innerHTML = items.join("") || `<div class="hint" style="padding:8px">ไม่พบรายการ</div>`;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      hl = -1;
    };
    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    };
    input.addEventListener("focus", render);
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      const btns = [...list.querySelectorAll("button")];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) render();
        hl = Math.max(0, Math.min(btns.length - 1, hl + (e.key === "ArrowDown" ? 1 : -1)));
        btns.forEach((b, i) => b.classList.toggle("hl", i === hl));
      } else if (e.key === "Enter" && !list.hidden && hl >= 0) {
        e.preventDefault();
        input.value = btns[hl].dataset.v;
        close();
      } else if (e.key === "Escape") close();
    });
    list.addEventListener("mousedown", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      e.preventDefault();
      input.value = b.dataset.v;
      close();
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
  }

  function actsHtml(acts) {
    if (!acts.length) return `<div class="empty">ยังไม่มี Activity</div>`;
    const dotFor = (a) => (a.kind === "ปิดเคส" ? "d-normal" : a.is_system ? "d-closed" : "d-all");
    return `<div class="acts">${acts
      .map((a) => {
        const t = new Date(a.created_at);
        return `<div class="act ${a.is_system ? "sys" : ""}"><div class="dt"><strong>${fd(a.activity_date)}</strong>${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}</div>
<span class="dot ${dotFor(a)}" aria-hidden="true"></span>
<div><div class="k">${esc(a.kind)}</div><div class="x">${esc(a.detail)}</div><div class="by">${esc(a.by || (a.is_system ? "ระบบ" : "-"))}${
          a.activity_date !== isoDay(t) ? ` · บันทึกเมื่อ ${fdt(a.created_at)}` : ""
        }</div></div></div>`;
      })
      .join("")}</div>`;
  }

  async function viewCase(id) {
    setNav("mine");
    const isNew = id === "new";
    const [lk, usersRes, data] = await Promise.all([
      lookups(true),
      can("case_reassign") ? api("/users/options") : Promise.resolve({ users: [] }),
      isNew ? Promise.resolve(null) : api("/case/" + id),
    ]);
    const c = data ? data.case : { team: ME.user.teams[0] || (ME.teams[0] || {}).key, status: "In Progress", ownerUserId: ME.user.id, owner: ME.user.display_name, ownerEmail: ME.user.email };
    const permsC = data ? data.can : { edit: true, close: can("case_close"), reassign: can("case_reassign"), editStart: false, delete: false };
    const ro = !permsC.edit;
    const closed = data && data.case.stage === "closed";
    const myTeams = ME.user.role === "admin" ? ME.teams.map((t) => t.key) : ME.user.teams;
    const teamOpts = ME.teams.filter((t) => myTeams.includes(t.key) || t.key === c.team).map((t) => `<option value="${t.key}" ${t.key === c.team ? "selected" : ""}>${esc(t.label)}</option>`).join("");
    const statusOpts = lk.status
      .filter((s) => isNew || permsC.close || !["success", "resolved", "cancel", "n/a"].includes(s.toLowerCase()) || s === c.status)
      .map((s) => `<option ${s === c.status ? "selected" : ""}>${esc(s)}</option>`)
      .join("");
    const productOpts = [`<option value="">-</option>`, ...lk.product.map((p) => `<option ${p === c.product ? "selected" : ""}>${esc(p)}</option>`)].join("");
    const ownerField = permsC.reassign
      ? `<label class="f">Owner<select name="owner_id">${usersRes.users
          .filter((u) => u.teams.includes(c.team) || u.id === c.ownerUserId)
          .map((u) => `<option value="${u.id}" ${u.id === c.ownerUserId ? "selected" : ""}>${esc(u.display_name)}</option>`)
          .join("")}</select></label>`
      : `<label class="f">Owner<input type="text" value="${esc(c.owner || "-")}" readonly></label>`;

    const days = [];
    for (let i = 0; i <= cfg.slaDays; i++) {
      const z = i < cfg.alert1Day ? "var(--normal)" : i < cfg.alert2Day ? "var(--r1)" : "var(--r2)";
      days.push(`<div style="${data && data.case.age != null && i <= data.case.age && !closed ? `background:${z}` : ""}"></div>`);
    }
    const slaCard = data
      ? `<section class="card"><h2>สถานะ SLA</h2>
<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span style="font-size:38px;font-weight:700;line-height:1" class="${c.stage === "overdue" ? "t-over" : c.stage === "r2" ? "t-r2" : ""}">${closed ? "ปิดแล้ว" : `วันที่ ${c.age}`}</span>
<span class="muted">${closed ? (c.closedOnTime ? "ทัน SLA" : "เกิน Due") : c.stage === "overdue" ? `เกิน Due ${c.daysOverdue} วัน` : c.daysLeft === 0 ? "ครบกำหนดวันนี้" : `เหลือ ${c.daysLeft} วัน`}</span></div>
<div class="daybar" aria-hidden="true">${days.join("")}</div>
<div class="hint">${data.alerts.length ? data.alerts.slice(0, 4).map((a) => `${ALERT[a.alert_type]} ${fdt(a.sent_at)}${a.ok ? "" : " (ไม่สำเร็จ)"}`).join(" · ") : "ยังไม่มี email แจ้งเตือนสำหรับเคสนี้"}</div>
</section>`
      : "";

    $app.innerHTML = `
<div class="crumb"><a href="#/mine">เคสของฉัน</a> / ${isNew ? "เปิดเคสใหม่" : esc(c.csNumber || "#" + c.id)}</div>
<div class="head"><div><h1>${isNew ? "เปิดเคสใหม่" : `เคส <span class="mono" style="font-size:26px">${esc(c.csNumber || "#" + c.id)}</span>`}</h1>
<p>${isNew ? "Start date จะบันทึกเป็นวันนี้อัตโนมัติ และ Due = Start date + " + cfg.slaDays + " วัน" : `${esc(c.sourceLabel)} · Owner ${esc(c.owner || "-")} · ${chip(c.stage)}`}</p></div>
<div class="actions">
${!isNew && permsC.delete ? `<button class="btn danger" type="button" id="btn-del">ลบเคส</button>` : ""}
${!isNew && !closed && permsC.close ? `<button class="btn" type="button" id="btn-close" style="color:var(--normal-fg)">ปิดเคส</button>` : ""}
${!ro ? `<button class="btn primary" type="submit" form="cf">${isNew ? "เปิดเคส" : "บันทึก"}</button>` : ""}</div></div>
${ro ? `<div class="banner warn">คุณดูเคสนี้ได้อย่างเดียว ไม่มีสิทธิ์แก้ไข</div>` : ""}
<div class="cols">
<form id="cf" class="main" novalidate>
<fieldset class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px" ${ro ? "disabled" : ""}>
<legend style="font-size:15px;font-weight:600">ข้อมูลเคส</legend>
<label class="f">CS Number<input type="text" name="cs_number" value="${esc(c.csNumber || "")}" class="mono" placeholder="เช่น CS5056186"></label>
${comboBox("site", c.site, lk.site, { label: "Site / ลูกค้า" })}
<label class="f">Product<select name="product">${productOpts}</select></label>
<label class="f"><span class="req">Status</span><select name="status">${statusOpts}</select></label>
<label class="f"><span class="req">ทีม</span><select name="team" ${!isNew && !permsC.reassign ? "disabled" : ""}>${teamOpts}</select></label>
${ownerField}
<label class="f" style="grid-column:1/-1"><span class="req">Task / Case</span><input type="text" name="task" value="${esc(c.task || "")}" maxlength="300" required></label>
${isNew ? `<label class="f" style="grid-column:1/-1">รายละเอียดตอนเปิดเคส<textarea name="detail" rows="3" placeholder="ลูกค้าแจ้งอะไร อาการเป็นอย่างไร"></textarea></label>` : ""}
<label class="f" style="grid-column:1/-1">Note<textarea name="note" rows="2">${esc(c.note || "")}</textarea></label>
</fieldset>
${isNew ? "" : `<section class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
<h2 style="grid-column:1/-1">วันที่ (ระบบกรอกให้)</h2>
<div class="f">Start date<div class="ro" style="min-height:44px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:0 12px">${fd(c.startDate, true)}</div>
<span class="hint">บันทึกตอนเปิดเคส ${permsC.editStart ? `<button type="button" class="btn" id="btn-start" style="min-height:32px;padding:0 10px;margin-top:6px">แก้ Start date</button>` : "แก้ได้เฉพาะ Admin พร้อมระบุเหตุผล"}</span></div>
<div class="f">Target date (Due)<div class="ro" style="min-height:44px;display:flex;align-items:center;border:1px solid var(--line);border-radius:10px;padding:0 12px">${fd(c.dueDate, true)}</div><span class="hint">Start date + ${cfg.slaDays} วัน</span></div>
<div class="f">End date<div class="ro" style="min-height:44px;display:flex;align-items:center;border:1px solid var(--line);border-radius:10px;padding:0 12px">${c.endDate ? fd(c.endDate, true) : "ยังไม่ปิด"}</div><span class="hint">ใส่ให้อัตโนมัติเมื่อปิดเคส</span></div>
</section>`}
${data && data.changes.length ? `<section class="card"><h2>ประวัติแก้ไขของเคสนี้</h2>${changeRows(data.changes)}</section>` : ""}
</form>
<aside class="side">
${slaCard}
${isNew ? `<section class="card"><h2>ก่อนเปิดเคส</h2><p class="muted" style="margin:0;font-size:14px">กรอก Site, Task และ Status ให้ครบ ระบบจะส่ง email เตือน Owner ในวันที่ ${cfg.alert1Day}, ${cfg.alert2Day} และทุกวันหลังเกิน Due ถ้ายังไม่ปิดเคส</p></section>` : `
<section class="card"><div><h2>Activity / Detail</h2><div class="hint" style="margin-top:4px">ทุกบันทึกมีวันที่และชื่อผู้บันทึก แก้หรือลบย้อนหลังไม่ได้</div></div>
${permsC.edit ? `<form id="af" class="stack">
<div style="display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px">
<label class="f">วันที่ทำ<input type="date" name="date" value="${daysAgo(0)}" max="${daysAgo(0)}" required></label>
<label class="f">ประเภท<select name="kind">${KINDS.map((k) => `<option>${k}</option>`).join("")}</select></label></div>
<label class="f">รายละเอียด<textarea name="detail" rows="3" placeholder="วันนี้ทำอะไรไป ผลเป็นอย่างไร ขั้นต่อไปคืออะไร" required></textarea></label>
<div class="right"><button class="btn primary" type="submit">เพิ่ม Activity</button></div></form>` : ""}
${actsHtml(data.activities)}</section>`}
</aside></div>
<dialog id="dlg"></dialog>`;

    const f = document.getElementById("cf");
    bindCombo(f, "site", lk.site);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (ro) return;
      const body = {
        cs_number: f.cs_number.value.trim(),
        site: f.site.value.trim(),
        product: f.product.value,
        status: f.status.value,
        team: f.team.value,
        task: f.task.value.trim(),
        note: f.note.value.trim(),
      };
      if (f.owner_id) body.owner_id = Number(f.owner_id.value);
      if (!body.site) return toast("กรุณาระบุ Site / ลูกค้า");
      if (!body.task) return toast("กรุณาระบุ Task / Case");
      try {
        if (isNew) {
          body.detail = f.detail.value.trim();
          const r = await post("/case", body);
          toast(r.newSite ? `เปิดเคสแล้ว และเพิ่มลูกค้าใหม่ “${r.newSite}” เข้า dropdown` : "เปิดเคสแล้ว", 5000);
          location.hash = "#/case/" + r.id;
        } else {
          const r = await post("/case/" + id, body, "PUT");
          toast(r.changed.length ? (r.newSite ? `บันทึกแล้ว และเพิ่มลูกค้าใหม่ “${r.newSite}”` : "บันทึกแล้ว") : "ไม่มีอะไรเปลี่ยน", 4000);
          viewCase(id);
        }
      } catch (err) {
        toast("บันทึกไม่สำเร็จ: " + err.message, 6000);
      }
    };
    const af = document.getElementById("af");
    if (af)
      af.onsubmit = async (e) => {
        e.preventDefault();
        if (af.detail.value.trim().length < 3) return toast("กรุณาใส่รายละเอียด");
        try {
          await post(`/case/${id}/activity`, { date: af.date.value, kind: af.kind.value, detail: af.detail.value });
          toast("เพิ่ม Activity แล้ว");
          viewCase(id);
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const bc = document.getElementById("btn-close");
    if (bc)
      bc.onclick = async () => {
        const st = lk.status.find((s) => s.toLowerCase() === "success") || "Success";
        if (!confirm(`ปิดเคสนี้ด้วย Status “${st}”?`)) return;
        try {
          await post("/case/" + id, { status: st }, "PUT");
          toast("ปิดเคสแล้ว");
          viewCase(id);
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const bs = document.getElementById("btn-start");
    if (bs) bs.onclick = () => openStartDialog(id, c.startDate);
    const bd = document.getElementById("btn-del");
    if (bd)
      bd.onclick = async () => {
        const reason = prompt("เหตุผลที่ลบเคสนี้ (บันทึกในประวัติ)");
        if (!reason) return;
        try {
          await api("/case/" + id, { method: "DELETE", body: JSON.stringify({ reason }) });
          toast("ลบเคสแล้ว");
          location.hash = "#/mine";
        } catch (err) {
          toast(err.message, 6000);
        }
      };
  }

  function openStartDialog(id, current) {
    const dlg = document.getElementById("dlg");
    dlg.innerHTML = `<form class="card" method="dialog" id="sd">
<h2>แก้ Start date</h2>
<p class="muted" style="margin:0;font-size:14px">Due จะคำนวณใหม่ (Start date + ${cfg.slaDays} วัน) การแก้นี้บันทึกในประวัติพร้อมเหตุผล และแจ้งใน Telegram</p>
<label class="f">Start date ใหม่<input type="date" name="date" value="${esc(current || "")}" required></label>
<label class="f">เหตุผล<textarea name="reason" rows="2" required placeholder="เช่น ลูกค้าแจ้งปัญหาจริงตั้งแต่วันที่ … แต่เปิดเคสช้า"></textarea></label>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="save">บันทึก</button></div></form>`;
    const f = dlg.querySelector("#sd");
    dlg.onclose = async () => {
      if (dlg.returnValue !== "save") return;
      try {
        await post(`/case/${id}/start-date`, { date: f.date.value, reason: f.reason.value });
        toast("แก้ Start date แล้ว");
        viewCase(id);
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    dlg.showModal();
  }

  // ------------------------------------------------------------ owner page
  async function viewOwner(id) {
    setNav("owner");
    if (!id) {
      const ov = await api("/overview");
      if (ov.owners.length) return location.replace("#/owner/" + encodeURIComponent(ov.owners[0].id));
      $app.innerHTML = `<div class="empty">ยังไม่มีข้อมูล Owner</div>`;
      return;
    }
    const o = await api("/owner/" + encodeURIComponent(id));
    const k = o.kpis;
    const open = o.cases.filter((c) => c.stage !== "closed");
    const closed = o.cases.filter((c) => c.stage === "closed");
    const maxWeek = Math.max(1, ...o.weeks.map((w) => w.onTime + w.late));
    const byId = Object.fromEntries(o.cases.map((c) => [c.id, c]));
    const byCase = {};
    o.alerts.forEach((a) => (byCase[a.case_id] = byCase[a.case_id] || []).push(a));
    const historyHtml = Object.entries(byCase)
      .slice(0, 6)
      .map(([cid, list]) => {
        const c = byId[cid];
        return `<div><div style="font-weight:600;margin-bottom:8px"><a class="mono" href="#/case/${cid}">${esc(c?.csNumber || "#" + cid)}</a> · ${esc(c?.site || "")}</div><div class="timeline">${list
          .slice()
          .reverse()
          .map((a) => `<div class="it"><span class="dot d-${a.alert_type}" aria-hidden="true"></span><div><div class="t">${ALERT[a.alert_type]} · ${fdt(a.sent_at)}</div><div class="s">${a.ok ? `ถึง ${esc(a.to_list)}${a.cc_list ? " · CC " + esc(a.cc_list) : ""}` : "ส่งไม่สำเร็จ: " + esc(a.error)}</div></div></div>`)
          .join("")}</div></div>`;
      })
      .join("");
    $app.innerHTML = `
<div class="crumb"><a href="#/">ภาพรวม</a> / ${esc(o.owner)}</div>
<section class="card owner-head" style="flex-direction:row">
<div style="display:flex;align-items:center;gap:16px"><div class="avatar" aria-hidden="true">${esc((o.owner || "?").trim().charAt(0).toUpperCase())}</div>
<div><h1 style="font-size:24px">${esc(o.owner)}</h1><div class="muted" style="font-size:14px">${esc(o.email || "-")} · ${esc(o.sources.join(", "))}</div></div></div>
<div class="actions"><label class="f" style="flex:0 1 240px;flex-direction:row;align-items:center;gap:8px">เปลี่ยน Owner
<select id="pick">${o.owners.map((x) => `<option value="${esc(x.id)}" ${x.id === o.id ? "selected" : ""}>${esc(x.owner || x.id)}</option>`).join("")}</select></label>
${lvl("export") === "all" ? `<a class="btn" href="api/export?${qs({ from: daysAgo(29), to: daysAgo(0), owner: o.id })}">Export เคสของ Owner นี้</a>` : ""}</div>
</section>
<div class="kpis">
<div class="kpi k-all"><div class="l">ยังไม่ปิด</div><div class="v">${k.open}</div></div>
<div class="kpi k-normal"><div class="l">ปกติ</div><div class="v">${k.normal}</div></div>
<div class="kpi k-r1"><div class="l">แจ้งรอบ 1</div><div class="v">${k.r1}</div></div>
<div class="kpi k-r2"><div class="l">แจ้งรอบ 2</div><div class="v">${k.r2}</div></div>
<div class="kpi k-overdue"><div class="l">เกิน Due</div><div class="v">${k.overdue}</div></div>
<div class="kpi k-closed"><div class="l">ปิดทัน SLA (30 วัน)</div><div class="v">${k.sla.pct === null ? "-" : k.sla.pct + "%"}</div><div class="s">${k.sla.onTime} จาก ${k.sla.closed} เคส</div></div>
</div>
<section class="card"><div class="title"><h2>เคสที่ยังไม่ปิด</h2><span>เรียงจากเปิดนานสุด</span></div>${caseTable(open, { showOwner: false })}</section>
<div class="grid2">
<section class="card"><h2>ประวัติแจ้งเตือน (60 วัน)</h2>${historyHtml || `<div class="empty">ยังไม่มี email แจ้งเตือน</div>`}</section>
<section class="card"><h2>ปิดเคสย้อนหลัง 4 สัปดาห์</h2>
<div class="weeks">${o.weeks.map((w) => `<div class="w"><div>${w.onTime} / ${w.late}</div>
<div class="stack" style="gap:0;height:${((w.onTime + w.late) / maxWeek) * 100}%;min-height:${w.onTime + w.late ? 6 : 2}px;background:${w.onTime + w.late ? "transparent" : "var(--row)"};width:36px;border-radius:6px 6px 0 0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end">
${w.late ? `<div style="flex:${w.late};background:var(--over)"></div>` : ""}${w.onTime ? `<div style="flex:${w.onTime};background:var(--normal)"></div>` : ""}</div>
<div>สัปดาห์ ${fd(w.from)}</div></div>`).join("")}</div>
<div class="legend"><span><span class="dot d-normal" aria-hidden="true"></span>ปิดทัน SLA</span><span><span class="dot d-overdue" aria-hidden="true"></span>ปิดเกิน Due</span></div>
</section></div>
${o.changes.length && lvl("audit_view") !== "none" ? `<section class="card"><h2>การแก้ไขในเคสของ Owner นี้</h2>${changeRows(o.changes)}</section>` : ""}
${closed.length ? `<section class="card"><div class="title"><h2>ปิดแล้วใน 30 วัน</h2><span>${closed.length} เคส</span></div>${caseTable(closed, { showOwner: false })}</section>` : ""}`;
    document.getElementById("pick").onchange = (e) => (location.hash = "#/owner/" + encodeURIComponent(e.target.value));
    bindRowLinks();
  }

  // ------------------------------------------------------------ reports
  const DOW = ["", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
  const RANGE_TYPES = { prev_week: "สัปดาห์ก่อนหน้า (จ.–อา.)", last_7: "7 วันล่าสุด", prev_month: "เดือนก่อนหน้า", month_to_date: "ต้นเดือนถึงวันนี้", last_30: "30 วันล่าสุด", yesterday: "เมื่อวาน" };

  async function viewReports() {
    setNav("reports");
    const manage = lvl("reports_manage") !== "none";
    const exp = lvl("export");
    const [sch, hist, ov] = await Promise.all([
      manage ? api("/schedules") : { schedules: [] },
      manage ? api("/reports/history") : { reports: [] },
      api("/overview"),
    ]);
    const schedules = sch.schedules;
    const ownerOpts = ov.owners.map((o) => `<option value="${esc(o.id)}">${esc(o.owner)}</option>`).join("");
    $app.innerHTML = `
<div class="head"><div><h1>Report &amp; Export</h1><p>${manage ? "ตั้งรอบส่ง report ให้ Manager ทาง email หรือ export เองตามช่วงวันที่ที่ต้องการ" : "Export เคสตามช่วงวันที่ที่ต้องการ"}</p></div></div>
${manage ? `<section class="sched">
${schedules.map((s) => `<div class="card"><div class="title"><h2>${esc(s.name)}</h2>${s.enabled ? chip("ok", "เปิดใช้") : chip("closed", "ปิดอยู่")}</div>
<div class="meta">${esc(s.description)} · ${esc(RANGE_TYPES[s.range_type] || s.range_type)}<br>ถึง: ${esc(s.recipients)}${s.cc ? `<br>CC: ${esc(s.cc)}` : ""}<br>แนบ: ${s.attach_excel === false ? "ไม่แนบไฟล์" : "Excel"}</div>
<div class="muted" style="font-size:13px">ส่งล่าสุด: ${s.last_sent_at ? fdt(s.last_sent_at) : "ยังไม่เคยส่ง"} · รอบหน้าใช้ข้อมูล ${esc(s.nextRange)}</div>
<div class="actions"><button class="btn" type="button" data-edit="${s.id}">แก้ไข</button><button class="btn" type="button" data-test="${s.id}">ส่งทดสอบ</button><button class="btn danger" type="button" data-del="${s.id}">ลบ</button></div></div>`).join("")}
<button class="add" type="button" id="add-sched">เพิ่มรอบส่ง Report</button>
</section>` : ""}
${exp !== "none" || manage ? `<section class="card"><h2>${manage ? "ส่ง Report / Export แบบ Manual" : "Export"}</h2>
<form id="manual" class="formgrid" onsubmit="return false">
<label class="f">ตั้งแต่วันที่<input type="date" name="from" value="${daysAgo(29)}" required></label>
<label class="f">ถึงวันที่<input type="date" name="to" value="${daysAgo(0)}" required></label>
${exp === "own" ? "" : `<label class="f">Owner<select name="owner"><option value="">ทุกคน</option>${ownerOpts}</select></label>`}
<label class="f">รูปแบบไฟล์<select name="format"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label>
${manage ? `<label class="f" style="grid-column:1/-1">ส่งถึง (คั่นด้วย , ถ้ามีหลายคน)<input type="text" name="recipients" placeholder="manager@sinostech.co.th"></label>` : ""}
</form>
<div id="preview" class="muted" style="font-size:14px"></div>
<div class="right"><button class="btn" type="button" id="btn-preview">ดูตัวเลขก่อน</button>${manage ? `<button class="btn" type="button" id="btn-send">ส่งช่วงนี้ทาง Email ตอนนี้</button>` : ""}${exp !== "none" ? `<button class="btn primary" type="button" id="btn-dl">ดาวน์โหลด</button>` : ""}</div>
</section>` : ""}
${manage ? `<section class="card"><h2>ประวัติการส่ง Report</h2>
${hist.reports.length ? `<div class="tablewrap"><table style="min-width:680px"><thead><tr><th>ส่งเมื่อ</th><th>Report</th><th>ช่วงข้อมูล</th><th>ผู้รับ</th><th>ผล</th></tr></thead><tbody>
${hist.reports.map((r) => `<tr><td>${fdt(r.sent_at)}</td><td>${esc(r.title)}</td><td>${fd(r.range_from)} – ${fd(r.range_to)}</td><td>${esc(r.recipients)}</td><td>${r.ok && !r.error ? chip("ok", "ส่งแล้ว") : r.ok ? chip("r1", "ทดสอบ") : `<span class="chip c-fail" title="${esc(r.error)}">ไม่สำเร็จ</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีการส่ง report</div>`}
</section>` : ""}
<dialog id="dlg"></dialog>`;

    const m = document.getElementById("manual");
    if (m) {
      const params = () => ({ from: m.from.value, to: m.to.value, owner: m.owner ? m.owner.value : "" });
      const dl = document.getElementById("btn-dl");
      if (dl) dl.onclick = () => (location.href = "api/export?" + qs({ ...params(), format: m.format.value }));
      document.getElementById("btn-preview").onclick = async () => {
        try {
          const p = await api("/reports/preview?" + qs(params()));
          const k = p.kpis;
          document.getElementById("preview").innerHTML = `ช่วง ${esc(p.rangeLabel)}: เปิดใหม่ <strong>${k.opened}</strong> · ปิด <strong>${k.closed}</strong> (ทัน SLA ${k.slaPct === null ? "-" : k.slaPct + "%"}) · ยังเปิดอยู่ ${k.openNow} · เกิน Due ขณะนี้ <strong>${k.overdueNow}</strong>`;
        } catch (e) {
          toast(e.message, 6000);
        }
      };
      const bs = document.getElementById("btn-send");
      if (bs)
        bs.onclick = async () => {
          if (!m.recipients.value.trim()) return toast("กรุณาใส่อีเมลผู้รับ");
          bs.disabled = true;
          try {
            const r = await post("/reports/send", { ...params(), recipients: m.recipients.value, title: "รายงานสถานะเคส" });
            toast(r.dryRun ? "โหมดทดสอบ: บันทึกแล้วแต่ยังไม่ได้ส่ง email จริง" : `ส่ง report ถึง ${r.recipients.join(", ")} แล้ว`, 5000);
            viewReports();
          } catch (e) {
            toast("ส่งไม่สำเร็จ: " + e.message, 6000);
            bs.disabled = false;
          }
        };
    }
    if (!manage) return;
    document.getElementById("add-sched").onclick = () => openSchedule(null);
    $app.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openSchedule(schedules.find((s) => s.id == b.dataset.edit))));
    $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm("ลบรอบส่งนี้?")) return;
      await api("/schedules/" + b.dataset.del, { method: "DELETE" });
      viewReports();
    }));
    $app.querySelectorAll("[data-test]").forEach((b) => (b.onclick = async () => {
      const to = prompt("ส่งทดสอบไปที่อีเมล (เว้นว่าง = ส่งถึงผู้รับจริงของรอบนี้)", ME.user.email);
      if (to === null) return;
      b.disabled = true;
      try {
        const r = await post(`/schedules/${b.dataset.test}/test`, to ? { to } : {});
        toast(r.dryRun ? "โหมดทดสอบ: ยังไม่ได้ส่ง email จริง" : `ส่งทดสอบถึง ${r.recipients.join(", ")} แล้ว`, 5000);
        viewReports();
      } catch (e) {
        toast("ส่งไม่สำเร็จ: " + e.message, 6000);
        b.disabled = false;
      }
    }));
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
<label class="f">ความถี่<select name="frequency">${[["daily", "ทุกวัน"], ["weekly", "ทุกสัปดาห์"], ["monthly", "ทุกเดือน"]].map(([k, t]) => `<option value="${k}" ${v.frequency === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
<label class="f" data-for="weekly">วันที่ส่ง<select name="day_of_week">${DOW.slice(1).map((t, i) => `<option value="${i + 1}" ${Number(v.day_of_week) === i + 1 ? "selected" : ""}>วัน${t}</option>`).join("")}</select></label>
<label class="f" data-for="monthly">วันที่ของเดือน<input type="number" min="1" max="28" name="day_of_month" value="${esc(v.day_of_month || 1)}"></label>
<label class="f">เวลา<input type="time" name="send_time" value="${esc(v.send_time)}"></label>
<label class="f">ช่วงข้อมูล<select name="range_type">${Object.entries(RANGE_TYPES).map(([k, t]) => `<option value="${k}" ${v.range_type === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
</div>
<fieldset><legend>ตัวเลือก</legend>
<label class="chk"><input type="checkbox" name="enabled" ${v.enabled ? "checked" : ""}>เปิดใช้รอบส่งนี้</label>
<label class="chk"><input type="checkbox" name="attach_excel" ${v.attach_excel !== false ? "checked" : ""}>แนบไฟล์ Excel</label>
</fieldset>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="save">บันทึกรอบส่ง</button></div>
</form>`;
    const f = dlg.querySelector("#sf");
    const toggle = () => f.querySelectorAll("[data-for]").forEach((el) => (el.style.display = el.dataset.for === f.frequency.value ? "" : "none"));
    f.frequency.onchange = toggle;
    toggle();
    dlg.onclose = async () => {
      if (dlg.returnValue !== "save") return;
      const body = { name: f.name.value.trim(), recipients: f.recipients.value.trim(), cc: f.cc.value.trim(), frequency: f.frequency.value, day_of_week: Number(f.day_of_week.value), day_of_month: Number(f.day_of_month.value), send_time: f.send_time.value, range_type: f.range_type.value, enabled: f.enabled.checked, attach_excel: f.attach_excel.checked };
      try {
        await post(s ? `/schedules/${s.id}` : "/schedules", body, s ? "PUT" : "POST");
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
    const n = (f) => changes.filter((c) => c.field === f).length;
    $app.innerHTML = `<div class="head"><div><h1>ประวัติแก้ไข</h1>
<p>บันทึกทุกการเปลี่ยน Status, โอนเคส, แก้ Start date (พร้อมเหตุผล) และลบเคส ${lvl("audit_view") === "own" ? "· แสดงเฉพาะเคสของคุณ" : ""}</p></div>
<div class="actions"><label><span class="sr">ช่วงเวลา</span><select id="days" style="width:auto">${[7, 30, 90, 180, 365, 730].map((x) => `<option value="${x}" ${x === days ? "selected" : ""}>${x} วันล่าสุด</option>`).join("")}</select></label></div></div>
<div class="kpis"><div class="kpi k-r2"><div class="l">แก้ Start date</div><div class="v">${n("start_date")}</div></div>
<div class="kpi k-all"><div class="l">เปลี่ยน Status</div><div class="v">${n("status")}</div></div>
<div class="kpi k-r1"><div class="l">โอนเคส</div><div class="v">${n("owner")}</div></div>
<div class="kpi k-overdue"><div class="l">ลบเคส</div><div class="v">${n("deleted")}</div></div></div>
<section class="card">${changeRows(changes)}</section>`;
    document.getElementById("days").onchange = (e) => (location.hash = "#/audit?days=" + e.target.value);
  }

  // ------------------------------------------------------------ users (admin)
  async function viewUsers(params) {
    setNav("users");
    const { users } = await api("/users");
    const sel = params.id ? users.find((u) => String(u.id) === params.id) : null;
    let list = users;
    if (params.q) {
      const s = params.q.toLowerCase();
      list = list.filter((u) => (u.display_name + " " + u.email).toLowerCase().includes(s));
    }
    if (params.role) list = list.filter((u) => u.role === params.role);
    const teamChecks = (u) => ME.teams.map((t) => `<label class="chk"><input type="checkbox" name="teams" value="${t.key}" ${u && u.teams.includes(t.key) ? "checked" : ""}>${esc(t.label)}</label>`).join("");
    const panel = sel
      ? `<aside class="side"><form class="card" id="uf" style="border-color:var(--accent)">
<div style="display:flex;align-items:center;gap:12px"><div class="avatar" style="width:46px;height:46px;font-size:18px" aria-hidden="true">${esc(sel.display_name.charAt(0).toUpperCase())}</div>
<div><h2>${esc(sel.display_name)}</h2><div class="muted" style="font-size:13px">${esc(sel.email)} · ${sel.auth_type === "sso" ? "บัญชี Microsoft" : "บัญชีรหัสผ่าน"}</div></div></div>
<label class="f">ชื่อที่แสดง<input name="display_name" value="${esc(sel.display_name)}"></label>
<label class="f">บทบาท<select name="role" ${sel.id === ME.user.id ? "disabled" : ""}>${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === sel.role ? "selected" : ""}>${l}</option>`).join("")}</select></label>
<fieldset><legend>ทีมที่เห็นเคส</legend>${teamChecks(sel)}</fieldset>
<label class="chk" style="justify-content:space-between"><span>เปิดใช้งานบัญชี<span class="hint" style="display:block">ปิดแล้วเข้าระบบไม่ได้ แต่เคสเดิมยังอยู่ครบ</span></span><input type="checkbox" name="active" ${sel.active ? "checked" : ""} ${sel.id === ME.user.id ? "disabled" : ""}></label>
${sel.auth_type === "local" ? `<div style="border-top:1px solid var(--line);padding-top:14px" class="stack"><h2 style="font-size:15px">รีเซ็ตรหัสผ่าน</h2>
<button class="btn" type="button" id="rs-link">ส่งลิงก์ตั้งรหัสใหม่ทาง email</button>
<button class="btn" type="button" id="rs-temp">สร้างรหัสชั่วคราว (ต้องเปลี่ยนตอนเข้าครั้งแรก)</button>
<span class="hint">ลิงก์ใช้ได้ 24 ชั่วโมง ใช้ได้ครั้งเดียว</span></div>` : `<p class="hint" style="margin:0">บัญชี Microsoft ไม่ต้องรีเซ็ตรหัสผ่านที่นี่ ใช้รหัสผ่านของบริษัท</p>`}
<div class="right" style="border-top:1px solid var(--line);padding-top:14px">
<button class="btn" type="button" id="u-signout">บังคับออกจากระบบ</button>
${sel.id !== ME.user.id ? `<button class="btn danger" type="button" id="u-del">ลบผู้ใช้</button>` : ""}
<button class="btn primary" type="submit">บันทึก</button></div>
<span class="hint">เคสที่ยังเปิดอยู่: ${sel.open_cases} · เข้าใช้ล่าสุด: ${sel.last_login_at ? fdt(sel.last_login_at) : "ยังไม่เคย"}</span>
</form></aside>`
      : `<aside class="side"><section class="card"><h2>เลือกผู้ใช้จากตาราง</h2><p class="muted" style="margin:0;font-size:14px">คลิกชื่อเพื่อแก้บทบาท ทีม เปิด/ปิดใช้งาน หรือรีเซ็ตรหัสผ่าน</p></section></aside>`;

    $app.innerHTML = `
<div class="tabs2" role="tablist"><a role="tab" class="on" aria-selected="true" href="#/users">ผู้ใช้</a><a role="tab" aria-selected="false" href="#/roles">สิทธิ์ตามบทบาท</a></div>
<div class="head"><div><h1>จัดการผู้ใช้</h1><p>เพิ่มหรือปิดการใช้งานบัญชี กำหนดบทบาทและทีม รีเซ็ตรหัสผ่าน ทุกการเปลี่ยนแปลงถูกบันทึก</p></div>
<div class="actions"><button class="btn primary" type="button" id="u-add">เพิ่มผู้ใช้</button></div></div>
<div class="cols"><section class="card main">
<div class="filters" style="padding:0">
<label class="f" style="flex:2 1 220px"><span class="sr">ค้นหาผู้ใช้</span><input type="search" id="uq" value="${esc(params.q || "")}" placeholder="ค้นหาชื่อหรืออีเมล"></label>
<label class="f"><span class="sr">บทบาท</span><select id="ur"><option value="">ทุกบทบาท</option>${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${params.role === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
<div class="tablewrap"><table style="min-width:680px"><thead><tr><th>ผู้ใช้</th><th>บทบาท</th><th>ทีม</th><th>สถานะ</th><th class="n">เคสเปิด</th><th>เข้าใช้ล่าสุด</th></tr></thead><tbody>
${list.map((u) => `<tr class="click" data-href="#/users?id=${u.id}" style="${sel && sel.id === u.id ? "background:color-mix(in srgb, var(--accent) 8%, transparent)" : u.active ? "" : "opacity:.6"}">
<td><a href="#/users?id=${u.id}" style="font-weight:600">${esc(u.display_name)}</a><div class="hint">${esc(u.email)}${u.auth_type === "local" ? " · รหัสผ่าน" : ""}</div></td>
<td>${chip(ROLE_CHIP[u.role], ROLE[u.role])}</td>
<td style="font-size:13px">${u.role === "admin" ? "ทุกทีม" : esc(u.teams.map(teamLabel).join(", ") || "-")}</td>
<td>${u.active ? chip("ok", "ใช้งานอยู่") : chip("closed", "ปิดใช้งาน")}${u.must_change_password ? `<div class="hint">รอตั้งรหัสใหม่</div>` : ""}</td>
<td class="n">${u.open_cases}</td>
<td style="font-size:13px" class="muted">${u.last_login_at ? fdt(u.last_login_at) : "ยังไม่เคย"}</td></tr>`).join("")}</tbody></table></div>
</section>${panel}</div>
<dialog id="dlg"></dialog>`;
    bindRowLinks();
    const uq = document.getElementById("uq");
    uq.onkeydown = (e) => e.key === "Enter" && (location.hash = "#/users?" + qs({ q: uq.value, role: params.role }));
    document.getElementById("ur").onchange = (e) => (location.hash = "#/users?" + qs({ q: params.q, role: e.target.value }));
    document.getElementById("u-add").onclick = () => openAddUser();
    if (!sel) return;
    const f = document.getElementById("uf");
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { display_name: f.display_name.value, teams: [...f.querySelectorAll("input[name=teams]:checked")].map((x) => x.value) };
      if (!f.role.disabled) body.role = f.role.value;
      if (!f.active.disabled) body.active = f.active.checked;
      try {
        await post("/users/" + sel.id, body, "PUT");
        toast("บันทึกแล้ว");
        viewUsers(params);
      } catch (err) {
        toast(err.message, 6000);
      }
    };
    const showSecret = (title, temp) => {
      const dlg = document.getElementById("dlg");
      dlg.innerHTML = `<form class="card" method="dialog"><h2>${title}</h2><p class="muted" style="margin:0;font-size:14px">แจ้งรหัสนี้ให้ ${esc(sel.display_name)} ผ่านช่องทางที่ปลอดภัย ระบบจะบังคับให้ตั้งรหัสใหม่ตอนเข้าครั้งแรก รหัสนี้แสดงครั้งเดียว</p><div class="secret">${esc(temp)}</div><div class="right"><button class="btn primary" value="ok">ปิด</button></div></form>`;
      dlg.showModal();
    };
    const rl = document.getElementById("rs-link");
    if (rl)
      rl.onclick = async () => {
        try {
          const r = await post(`/users/${sel.id}/reset`, { method: "link" });
          toast(`ส่งลิงก์ไปที่ ${r.sentTo} แล้ว`, 5000);
        } catch (e) {
          toast(e.message, 6000);
        }
      };
    const rt = document.getElementById("rs-temp");
    if (rt)
      rt.onclick = async () => {
        if (!confirm("สร้างรหัสชั่วคราวใหม่? รหัสเดิมจะใช้ไม่ได้ทันที")) return;
        try {
          const r = await post(`/users/${sel.id}/reset`, { method: "temp" });
          showSecret("รหัสผ่านชั่วคราว", r.tempPassword);
        } catch (e) {
          toast(e.message, 6000);
        }
      };
    document.getElementById("u-signout").onclick = async () => {
      await post(`/users/${sel.id}/signout`);
      toast("บังคับออกจากระบบทุกเครื่องแล้ว");
    };
    const del = document.getElementById("u-del");
    if (del)
      del.onclick = async () => {
        if (!confirm(`ลบผู้ใช้ ${sel.display_name}? ถ้ายังมีเคสเปิดอยู่ ให้ปิดใช้งานแทน`)) return;
        try {
          await api("/users/" + sel.id, { method: "DELETE" });
          toast("ลบผู้ใช้แล้ว");
          location.hash = "#/users";
        } catch (e) {
          toast(e.message, 6000);
        }
      };
  }

  function openAddUser() {
    const dlg = document.getElementById("dlg");
    dlg.innerHTML = `<form class="card" method="dialog" id="nf">
<h2>เพิ่มผู้ใช้</h2>
<div class="formgrid">
<label class="f"><span class="req">อีเมล</span><input type="email" name="email" required placeholder="name@sinostech.co.th"></label>
<label class="f">ชื่อที่แสดง<input name="display_name" placeholder="ชื่อ นามสกุล"></label>
<label class="f">บทบาท<select name="role">${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === "engineer" ? "selected" : ""}>${l}</option>`).join("")}</select></label>
<label class="f">วิธีเข้าระบบ<select name="auth_type"><option value="sso">บัญชี Microsoft ของบริษัท</option><option value="local">อีเมลและรหัสผ่าน (คนนอกบริษัท)</option></select></label>
</div>
<fieldset><legend>ทีมที่เห็นเคส</legend>${ME.teams.map((t) => `<label class="chk"><input type="checkbox" name="teams" value="${t.key}">${esc(t.label)}</label>`).join("")}</fieldset>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="save">เพิ่มผู้ใช้</button></div></form>`;
    const f = dlg.querySelector("#nf");
    dlg.onclose = async () => {
      if (dlg.returnValue !== "save") return;
      try {
        const r = await post("/users", { email: f.email.value, display_name: f.display_name.value, role: f.role.value, auth_type: f.auth_type.value, teams: [...f.querySelectorAll("input[name=teams]:checked")].map((x) => x.value) });
        if (r.tempPassword) {
          dlg.innerHTML = `<form class="card" method="dialog"><h2>เพิ่มผู้ใช้แล้ว</h2><p class="muted" style="margin:0;font-size:14px">รหัสผ่านชั่วคราวของ ${esc(r.user.email)} แจ้งผ่านช่องทางที่ปลอดภัย รหัสนี้แสดงครั้งเดียว</p><div class="secret">${esc(r.tempPassword)}</div><div class="right"><button class="btn primary" value="ok">ปิด</button></div></form>`;
          dlg.onclose = () => (location.hash = "#/users?id=" + r.user.id);
          dlg.showModal();
        } else {
          toast("เพิ่มผู้ใช้แล้ว ให้เข้าระบบด้วยปุ่มบัญชี Microsoft ได้เลย", 5000);
          location.hash = "#/users?id=" + r.user.id;
        }
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    dlg.showModal();
  }

  async function viewRoles() {
    setNav("users");
    const data = await api("/permissions");
    const m = JSON.parse(JSON.stringify(data.matrix));
    const count = Object.fromEntries(data.counts.map((c) => [c.role, c.n]));
    const editable = lvl("users_manage") !== "none";
    const locked = (r, p) => r === "admin" && (p === "users_manage" || p === "settings_manage");
    const cell = (r, p) => {
      const v = m[r][p];
      const label = v === "all" ? "✓" : v === "own" ? "เฉพาะของตัวเอง" : "–";
      return `<button type="button" class="perm ${v}" data-r="${r}" data-p="${p}" ${!editable || locked(r, p) ? "disabled" : ""} aria-label="${ROLE[r]}: ${esc(label)}">${label}</button>`;
    };
    const render = () => {
      document.getElementById("pm").innerHTML = `<table style="min-width:820px"><thead><tr><th>สิทธิ์</th>${data.roles.map((r) => `<th style="text-align:center;width:150px">${chip(ROLE_CHIP[r], ROLE[r])}<div class="hint" style="margin-top:6px">${count[r] || 0} คน</div></th>`).join("")}</tr></thead><tbody>
${data.perms.map((p) => `<tr><td><div style="font-weight:500">${esc(p.label)}</div><div class="hint">${esc(p.hint)}</div></td>${data.roles.map((r) => `<td style="text-align:center">${cell(r, p.key)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      document.querySelectorAll(".perm[data-r]").forEach((b) => (b.onclick = () => {
        const order = ["none", "own", "all"];
        const cur = m[b.dataset.r][b.dataset.p];
        m[b.dataset.r][b.dataset.p] = order[(order.indexOf(cur) + 1) % 3];
        render();
        document.getElementById("save").disabled = false;
      }));
    };
    $app.innerHTML = `
<div class="tabs2" role="tablist"><a role="tab" aria-selected="false" href="#/users">ผู้ใช้</a><a role="tab" class="on" aria-selected="true" href="#/roles">สิทธิ์ตามบทบาท</a></div>
<div class="head"><div><h1>สิทธิ์ตามบทบาท</h1><p>ผู้ใช้แต่ละคนมี 1 บทบาท กดที่ช่องเพื่อสลับ ไม่มีสิทธิ์ → เฉพาะของตัวเอง → ทั้งหมด แล้วกดบันทึก</p></div>
<div class="actions">${editable ? `<button class="btn primary" id="save" type="button" disabled>บันทึกสิทธิ์</button>` : ""}</div></div>
<section class="card"><div class="tablewrap" id="pm"></div></section>
<p class="hint">ทุกคนเห็นเฉพาะเคสของทีมที่ได้รับสิทธิ์ (Admin เห็นทุกทีม) Admin มีสิทธิ์จัดการผู้ใช้และตั้งค่าเสมอ เพื่อไม่ให้ระบบล็อกตัวเอง</p>`;
    render();
    const sv = document.getElementById("save");
    if (sv)
      sv.onclick = async () => {
        try {
          await post("/permissions", { matrix: m }, "PUT");
          toast("บันทึกสิทธิ์แล้ว");
          ME = await api("/me");
          viewRoles();
        } catch (e) {
          toast(e.message, 6000);
        }
      };
  }

  // ------------------------------------------------------------ settings (admin)
  async function viewSettings() {
    setNav("settings");
    const s = await api("/settings");
    const byKind = (k) => s.lookups.filter((l) => l.kind === k);
    const newSites = s.lookups.filter((l) => l.is_new);
    const lkChips = (k) => byKind(k).map((l) => `<span class="lk ${l.is_new ? "new" : ""} ${l.active ? "" : "off"}" title="${l.is_new ? `เพิ่มโดย ${esc(l.created_by || "-")} ${fdt(l.created_at)}` : ""}">${esc(l.value)}${l.is_new ? ` <span class="chip c-r1">ใหม่</span>` : ""}
<button type="button" data-lk="${l.id}" aria-label="แก้ ${esc(l.value)}">แก้</button></span>`).join("");
    $app.innerHTML = `
<div class="head"><div><h1>ตั้งค่าระบบ</h1><p>แทน tab Settings ในไฟล์ Excel เดิม แก้ได้เฉพาะ Admin</p></div></div>
${newSites.length ? `<div class="banner warn">มีรายการที่ผู้ใช้เพิ่มใหม่ ${newSites.length} รายการ รอตรวจ (มีป้าย “ใหม่”) กด “แก้” เพื่อยืนยัน แก้ชื่อ หรือรวมกับรายการเดิม</div>` : ""}
<section class="card"><div class="title"><h2>นำเข้าเคสจาก Excel</h2><span>ใช้ช่วงเปลี่ยนจาก Excel มาเป็นหน้าเว็บ</span></div>
<p class="muted" style="margin:0;font-size:14px">อ่าน tab Case List ทั้ง 3 เอกสาร แล้วเพิ่มเคสที่ยังไม่มีในระบบ เคสที่มีอยู่แล้วจะไม่ถูกนำเข้าซ้ำ Owner ที่ยังไม่มีบัญชีจะถูกสร้างเป็น Engineer (บัญชี Microsoft) ให้อัตโนมัติ</p>
<div class="actions"><button class="btn" type="button" id="imp-new">นำเข้าเคสใหม่จาก Excel</button><button class="btn" type="button" id="imp-refresh">นำเข้า + อัปเดตเคสที่ยังไม่ถูกแก้บนเว็บ</button></div>
<div id="imp-out" class="hint"></div></section>
<div class="grid2">
<section class="card"><h2>รายการ dropdown</h2>
${[["site", "Site / ลูกค้า · Owner เพิ่มใหม่ได้จากฟอร์มเคส"], ["product", "Product"], ["status", "Status"]].map(([k, l]) => `<div class="stack" style="gap:8px"><div class="hint">${l} (${byKind(k).length})</div><div class="chips">${lkChips(k)}<button class="btn" type="button" data-add="${k}" style="min-height:32px;padding:0 10px">เพิ่ม</button></div></div>`).join("")}
</section>
<section class="card"><h2>การเก็บข้อมูล</h2>
<label class="f">เก็บเคสที่ปิดแล้วและประวัติต่างๆ ไว้<select id="ret">${[1, 2, 3, 5].map((y) => `<option value="${y}" ${y === s.retentionYears ? "selected" : ""}>${y} ปี</option>`).join("")}</select></label>
<div class="stat2"><div><div class="k">เคสทั้งหมดในระบบ</div><div class="v">${s.stats.cases.toLocaleString()}</div></div>
<div><div class="k">เคสเก่าสุด</div><div class="v">${s.stats.oldest ? fd(s.stats.oldest, true) : "-"}</div></div>
<div><div class="k">จะถูกลบในรอบถัดไป</div><div class="v">${s.stats.to_delete} เคส</div></div>
<div><div class="k">ขนาดฐานข้อมูล</div><div class="v">${esc(s.stats.dbSize)}</div></div></div>
<p class="hint" style="margin:0">ทุกคืน 02:00 ระบบลบเคสที่ปิดเกินกำหนดและ log ที่เก่ากว่ากำหนด ข้อมูลที่จะลบรวมอยู่ในรายงานรายปีแล้ว เคสที่ยังไม่ปิดไม่ถูกลบ ฐานข้อมูลมี backup ทุกคืนไปที่ SharePoint</p>
</section></div>
<section class="card"><div class="title"><h2>รายงานรายปี (สร้างอัตโนมัติ)</h2><span>ทุกวันที่ 1 ม.ค. 06:00 สร้างรายงานของปีที่ผ่านมา</span></div>
<div class="formgrid">
<label class="f">ส่ง email สรุปรายปีถึง (คั่นด้วย , ถ้ามีหลายคน)<input id="an-to" value="${esc(s.annual.recipients || "")}" placeholder="manager@sinostech.co.th"></label>
<label class="f">CC<input id="an-cc" value="${esc(s.annual.cc || "")}"></label></div>
<p class="hint" style="margin:0">email มีสรุปตัวเลขทั้งปีและแนบไฟล์ Excel (เคสทั้งหมด, ราย Owner, สรุปรายเดือน, ประวัติแก้ไข) ระบบเก็บสำเนาไว้ในคลังด้านล่างถาวร ไม่ถูกลบตามรอบเก็บข้อมูล</p>
${s.annualReports.length ? `<div class="tablewrap"><table style="min-width:620px"><thead><tr><th>ปี</th><th>สร้างเมื่อ</th><th>ส่งถึง</th><th>ผล</th><th>ไฟล์</th></tr></thead><tbody>
${s.annualReports.map((a) => `<tr><td style="font-weight:600">${a.year + 543} (${a.year})</td><td>${fdt(a.created_at)}</td><td>${esc(a.recipients || "-")}</td><td>${a.ok ? chip("ok", "ส่งแล้ว") : `<span class="chip c-fail" title="${esc(a.error)}">ไม่สำเร็จ</span>`}</td><td><a href="api/annual/${a.year}/file">${esc(a.file_name)}</a></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีรายงานรายปี รายงานแรกจะสร้างวันที่ 1 ม.ค. ${new Date().getFullYear() + 1 + 543}</div>`}
<div class="actions"><button class="btn primary" type="button" id="save-set">บันทึกการตั้งค่า</button><button class="btn" type="button" id="an-test">ส่งรายงานปีนี้ถึงวันนี้ (ทดสอบ)</button></div>
</section>
<dialog id="dlg"></dialog>`;

    document.getElementById("save-set").onclick = async () => {
      try {
        await post("/settings", { retentionYears: Number(document.getElementById("ret").value), annual: { recipients: document.getElementById("an-to").value, cc: document.getElementById("an-cc").value } }, "PUT");
        toast("บันทึกการตั้งค่าแล้ว");
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    document.getElementById("an-test").onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        const r = await post("/annual/test");
        toast(r.ok ? `ส่งรายงานทดสอบถึง ${r.recipients.join(", ")} แล้ว` : "ส่งไม่สำเร็จ: " + r.error, 6000);
      } catch (e) {
        toast(e.message, 6000);
      }
      ev.currentTarget.disabled = false;
    };
    const runImport = async (mode, btn) => {
      if (!confirm(mode === "refresh" ? "นำเข้าเคสใหม่ และอัปเดตเคสที่นำเข้าก่อนหน้าแต่ยังไม่ถูกแก้บนเว็บ?" : "นำเข้าเคสใหม่จาก Excel?")) return;
      btn.disabled = true;
      document.getElementById("imp-out").textContent = "กำลังอ่านไฟล์ Excel…";
      try {
        const r = await post("/import", { mode });
        document.getElementById("imp-out").textContent = `เพิ่ม ${r.added} เคส · อัปเดต ${r.updated} · มีอยู่แล้ว ${r.skippedExisting} · ข้ามเพราะไม่มี Start date ${r.skippedNoStart} · สร้างผู้ใช้ใหม่ ${r.usersCreated} คน`;
        LOOKUPS = null;
      } catch (e) {
        document.getElementById("imp-out").textContent = "นำเข้าไม่สำเร็จ: " + e.message;
      }
      btn.disabled = false;
    };
    document.getElementById("imp-new").onclick = (e) => runImport("new", e.currentTarget);
    document.getElementById("imp-refresh").onclick = (e) => runImport("refresh", e.currentTarget);
    $app.querySelectorAll("[data-add]").forEach((b) => (b.onclick = async () => {
      const v = prompt("ชื่อรายการใหม่");
      if (!v) return;
      try {
        await post("/lookups", { kind: b.dataset.add, value: v });
        LOOKUPS = null;
        viewSettings();
      } catch (e) {
        toast(e.message, 6000);
      }
    }));
    $app.querySelectorAll("[data-lk]").forEach((b) => (b.onclick = () => openLookup(s.lookups.find((l) => String(l.id) === b.dataset.lk), s.lookups)));
  }

  function openLookup(l, all) {
    const dlg = document.getElementById("dlg");
    const others = all.filter((x) => x.kind === l.kind && x.id !== l.id && !x.is_new);
    dlg.innerHTML = `<form class="card" method="dialog" id="lf">
<h2>${l.is_new ? "ตรวจรายการใหม่" : "แก้รายการ"}</h2>
${l.is_new ? `<p class="muted" style="margin:0;font-size:14px">เพิ่มโดย ${esc(l.created_by || "-")} เมื่อ ${fdt(l.created_at)}</p>` : ""}
<label class="f">ชื่อ<input name="value" value="${esc(l.value)}"></label>
<span class="hint">แก้ชื่อแล้ว เคสที่ใช้ชื่อเดิมจะเปลี่ยนตามให้อัตโนมัติ</span>
<label class="chk"><input type="checkbox" name="active" ${l.active ? "checked" : ""}>แสดงใน dropdown</label>
<fieldset><legend>หรือรวมเข้ากับรายการเดิม (กรณีชื่อซ้ำ)</legend>
<select name="into"><option value="">ไม่รวม</option>${others.map((o) => `<option value="${o.id}">${esc(o.value)}</option>`).join("")}</select></fieldset>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="save">${l.is_new ? "ยืนยัน" : "บันทึก"}</button></div></form>`;
    const f = dlg.querySelector("#lf");
    dlg.onclose = async () => {
      if (dlg.returnValue !== "save") return;
      try {
        if (f.into.value) {
          const r = await post(`/lookups/${l.id}/merge`, { into: Number(f.into.value) });
          toast(`รวมแล้ว ย้าย ${r.moved} เคส`);
        } else {
          await post(`/lookups/${l.id}`, { value: f.value.value, active: f.active.checked, is_new: false }, "PUT");
          toast("บันทึกแล้ว");
        }
        LOOKUPS = null;
        viewSettings();
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    dlg.showModal();
  }

  // ------------------------------------------------------------ change password (local accounts)
  function viewPassword() {
    setNav("");
    const forced = ME.user.must_change_password;
    $app.innerHTML = `<div class="head"><div><h1>${forced ? "ตั้งรหัสผ่านใหม่" : "เปลี่ยนรหัสผ่าน"}</h1>
<p>${forced ? "บัญชีนี้ใช้รหัสผ่านชั่วคราว ต้องตั้งรหัสผ่านใหม่ก่อนใช้งาน" : "รหัสผ่านต้องยาวอย่างน้อย 10 ตัว และมีทั้งตัวอักษรและตัวเลข"}</p></div></div>
<form class="card stack" id="pf" style="max-width:480px">
${forced ? "" : `<label class="f">รหัสผ่านปัจจุบัน<input type="password" name="current" autocomplete="current-password" required></label>`}
<label class="f">รหัสผ่านใหม่<input type="password" name="p1" autocomplete="new-password" minlength="10" required></label>
<label class="f">ยืนยันรหัสผ่านใหม่<input type="password" name="p2" autocomplete="new-password" required></label>
<div class="right"><button class="btn primary" type="submit">บันทึกรหัสผ่าน</button></div></form>`;
    const f = document.getElementById("pf");
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (f.p1.value !== f.p2.value) return toast("รหัสผ่านสองช่องไม่ตรงกัน");
      try {
        await fetch("/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ current: f.current ? f.current.value : "", password: f.p1.value }),
        }).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error);
        });
        toast("บันทึกรหัสผ่านใหม่แล้ว");
        ME = await api("/me");
        location.hash = "#/";
      } catch (err) {
        toast(err.message, 6000);
      }
    };
  }

  // ------------------------------------------------------------ router
  async function route() {
    const { parts, params } = (() => {
      const h = location.hash.replace(/^#/, "") || "/";
      const [path, query] = h.split("?");
      return { parts: path.split("/").filter(Boolean), params: Object.fromEntries(new URLSearchParams(query || "")) };
    })();
    window.scrollTo(0, 0);
    try {
      if (ME.user.must_change_password && parts[0] !== "password") return (location.hash = "#/password");
      switch (parts[0]) {
        case "mine": return await viewMine(params);
        case "case": return await viewCase(parts[1] || "new");
        case "owner": return await viewOwner(parts[1] ? decodeURIComponent(parts[1]) : null);
        case "reports": return await viewReports();
        case "audit": return await viewAudit(params);
        case "cases": return await viewCases(params);
        case "users": return await viewUsers(params);
        case "roles": return await viewRoles();
        case "settings": return await viewSettings();
        case "password": return viewPassword();
        default:
          if (ME.user.role === "engineer" && !location.hash && !sessionStorage.getItem("v3home")) {
            try { sessionStorage.setItem("v3home", "1"); } catch (e) {}
            return (location.hash = "#/mine");
          }
          return await viewOverview(params);
      }
    } catch (e) {
      $app.innerHTML = `<div class="banner err">โหลดข้อมูลไม่สำเร็จ: ${esc(e.message)}</div>`;
    }
  }

  (async function boot() {
    try {
      ME = await api("/me");
    } catch (e) {
      if (/MUST_CHANGE|ตั้งรหัสผ่าน/.test(e.message)) {
        // must change password: load a minimal profile so the form can render
        ME = { user: { must_change_password: true, display_name: "", email: "", role: "viewer", teams: [], auth_type: "local", id: 0 }, perms: {}, teams: [], config: {} };
      } else return;
    }
    cfg = { ...cfg, ...ME.config };
    buildChrome();
    window.addEventListener("hashchange", route);
    route();
  })();
})();
