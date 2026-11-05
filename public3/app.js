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
  const ROLE = { admin: "Admin", manager: "Manager", observer: "Observer", engineer: "Engineer", viewer: "Viewer" };
  const ROLE_HINT = { admin: "ทำได้ทุกอย่าง รวมถึงจัดการผู้ใช้และตั้งค่าระบบ", manager: "ดูและแก้เคสของทีม อนุมัติขยายเวลา ส่ง Report ปรับคะแนน KPI", observer: "ดูได้ทุกทีมทุกหน้า (ภาพรวม เคส ราย Owner KPI Report ประวัติแก้ไข) แก้ไขอะไรไม่ได้", engineer: "เปิด แก้ และปิดเคสของตัวเอง เห็น KPI ของตัวเอง", viewer: "ดูภาพรวมและเคสของทีมตัวเองอย่างเดียว" };
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.name === "role" && t.tagName === "SELECT") {
      const h = t.parentElement.querySelector("[data-role-hint]");
      if (h) h.textContent = ROLE_HINT[t.value] || "";
    }
  });
  const ROLE_CHIP = { admin: "overdue", manager: "r1", observer: "r2", engineer: "ok", viewer: "closed" };
  const KINDS = ["ดำเนินการ", "ติดต่อลูกค้า", "เปิดเคส Vendor", "Remote / Onsite", "รอข้อมูล"];
  const SEV_CHIP = { Critical: "overdue", High: "r2", Medium: "r1", Low: "normal", "Request information": "closed" };
  const SEV_SHORT = { "Request information": "Request info" };
  const sevChip = (v) => (v ? `<span class="chip c-${SEV_CHIP[v] || "closed"} sev" title="Severity: ${esc(v)}">${esc(SEV_SHORT[v] || v)}</span>` : "");
  // Case number CASE-2026-0001 (every case) with the vendor CS Number underneath.
  const caseRef = (c) => c.caseNo || c.case_no || c.csNumber || c.cs_number || "#" + (c.id || c.case_id);
  const csOf = (c) => c.csNumber || c.cs_number || "";
  const caseCell = (c, href, extra = "") =>
    `<a class="mono" href="${href}">${esc(caseRef(c))}</a><div class="muted" style="font-size:12px">${csOf(c) ? esc(csOf(c)) : "ยังไม่มี CS"}${extra ? " · " + extra : ""}</div>`;
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


  const statusTable = (list) => `<dl class="st-dl">${list.map((x) => `<dt>${esc(x)}</dt><dd>${esc(statusHelp(x) || "-")}</dd>`).join("")}</dl>`;
  const statusHelp = (st) => ((LOOKUPS && LOOKUPS.statusHelp) || {})[st] || "";
  const isClosedStatus = (st) => (LOOKUPS && LOOKUPS.closedStatuses ? LOOKUPS.closedStatuses : ["success", "cancel", "n/a", "resolved"]).includes(String(st || "").toLowerCase());
  /** Ask for status + Resolution before closing. Resolves to {status, resolution, root_cause} or null if cancelled. */
  async function askResolution(c, { status, edit = false } = {}) {
    const lk = await lookups();
    const min = lk.resolutionMin || 20;
    const closedOpts = lk.status.filter(isClosedStatus);
    const st0 = status && isClosedStatus(status) ? status : closedOpts.find((s) => s.toLowerCase() === "success") || closedOpts[0];
    const dlg = document.getElementById("dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dlg" }));
    const ageTxt = c.stage === "closed" ? "" : c.stage === "overdue" ? `เกิน Due ${c.daysOverdue} วัน` : `อายุเคส ${c.totalAge ?? c.age ?? 0} วัน (ทัน SLA)`;
    dlg.innerHTML = `<form class="card" method="dialog" id="rsf" style="min-width:min(560px,90vw)"><h2>${edit ? "แก้ Resolution" : "ปิดเคส"} ${esc(caseRef(c))}</h2>
<p class="muted" style="margin:0;font-size:14px">${esc(c.site || "")} · ${esc(c.task || "")}${ageTxt ? " · " + ageTxt : ""}</p>
${edit ? "" : `<fieldset class="f" style="border:0;padding:0;margin:0"><legend style="font-size:13px;font-weight:600;margin-bottom:6px">ปิดด้วย Status</legend>
<div class="fpills">${closedOpts.map((x) => `<label class="fpill" title="${esc(statusHelp(x))}"><input type="radio" name="st" value="${esc(x)}" ${x === st0 ? "checked" : ""}>${esc(x)}</label>`).join("")}</div>
<div class="st-help" id="st-help"></div>
<details class="st-all"><summary>Success กับ Resolved ต่างกันอย่างไร · ดูความหมายทุก Status</summary>${statusTable(closedOpts)}</details></fieldset>`}
<label class="f"><span class="req">Resolution: แก้ไขอย่างไร / ผลลัพธ์</span><textarea name="res" rows="4" required placeholder="เช่น SMTP relay ของลูกค้าเปลี่ยน IP แก้ค่า relay ใน Scheduler ทดสอบส่ง report 3 รอบ ลูกค้ายืนยันว่าได้รับแล้ว">${esc(edit ? c.resolution || "" : "")}</textarea></label>
<div class="hint" id="rs-count" style="text-align:right;margin-top:-6px"></div>
<label class="f">สาเหตุของปัญหา (ไม่บังคับ)<select name="rc"><option value="">-</option>${(lk.rootCauses || []).map((x) => `<option ${x === c.rootCause ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
<p class="hint" style="margin:0">Resolution บันทึกเป็น Activity ในไทม์ไลน์ แสดงในหน้าเคส ผลค้นหา และ Report Excel (ข้อมูลภายใน ไม่ส่งถึงลูกค้า)</p>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">${edit ? "บันทึก" : "ปิดเคส"}</button></div></form>`;
    const f = dlg.querySelector("#rsf");
    const cnt = dlg.querySelector("#rs-count");
    const upd = () => {
      const n = f.res.value.trim().length;
      cnt.textContent = `${n} ตัวอักษร · ต้องมีอย่างน้อย ${min} ตัวอักษร`;
      cnt.style.color = n >= min ? "" : "var(--r2-fg)";
    };
    f.res.addEventListener("input", upd);
    upd();
    const sh = dlg.querySelector("#st-help");
    const showHelp = () => {
      const p = f.querySelector("input[name=st]:checked");
      if (sh && p) sh.innerHTML = `<strong>${esc(p.value)}:</strong> ${esc(statusHelp(p.value) || "-")}`;
    };
    f.querySelectorAll("input[name=st]").forEach((r) => r.addEventListener("change", showHelp));
    showHelp();
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      f.onsubmit = (e) => {
        if (e.submitter && e.submitter.value === "cancel") return finish(null);
        e.preventDefault();
        const text = f.res.value.trim();
        if (text.length < min) {
          toast(`กรุณาใส่ Resolution อย่างน้อย ${min} ตัวอักษร`);
          f.res.focus();
          return;
        }
        const picked = f.querySelector("input[name=st]:checked");
        dlg.close();
        finish({ status: edit ? undefined : picked ? picked.value : st0, resolution: text, root_cause: f.rc.value });
      };
      dlg.addEventListener("close", () => finish(null), { once: true });
      dlg.showModal();
      setTimeout(() => f.res.focus(), 30);
    });
  }

  // ------------------------------------------------------------ chrome
  function buildChrome() {
    const tabs = [
      ["overview", "#/", "ภาพรวม", true],
      ["mine", "#/mine", "เคสของฉัน", lvl("case_create") !== "none" || lvl("case_edit") !== "none"],
      ["intake", "#/intake", "เคสจากลูกค้า", true],
      ["owner", "#/owner", "ราย Owner", true],
      ["kpi", "#/kpi", "KPI (ทดลองใช้)", ME.user.role !== "viewer"],
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
      u.role === "admin" || u.role === "observer" ? "ทุกทีม" : esc(u.teams.map((t) => teamLabel(t)).join(", ") || "ยังไม่มีทีม")
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

  function resLine(c, { missing = false } = {}) {
    if (c.stage !== "closed") return "";
    if (c.resolution) return `<div class="resol sm" title="${esc(c.resolution)}">${c.status && !["success", "resolved"].includes(c.status.toLowerCase()) ? `Resolution (${esc(c.status)}): ` : "Resolution: "}${esc(c.resolution)}</div>`;
    return missing ? `<div class="resol sm none">ไม่มี Resolution (ปิดก่อนเริ่มบังคับ)</div>` : "";
  }
  function caseTable(cases, { showOwner = true, missingRes = false, empty = "ไม่มีเคส" } = {}) {
    if (!cases.length) return `<div class="empty">${empty}</div>`;
    return `<div class="tablewrap"><table style="min-width:${showOwner ? 1080 : 980}px">
<thead><tr><th>เลขเคส</th><th>ลูกค้า</th><th>Severity</th><th>งาน</th>${showOwner ? "<th>Owner</th>" : ""}<th>ทีม</th><th>เปิดเคส</th><th>Due</th><th>อายุเคส</th><th>สถานะ</th></tr></thead>
<tbody>${cases
      .map(
        (c) => `<tr class="click" data-href="#/case/${c.id}">
<td>${caseCell(c, `#/case/${c.id}`)}</td>
<td style="font-weight:600">${esc(c.site || "-")}</td>
<td>${sevChip(c.severity)}</td>
<td style="font-size:13px">${esc(c.task || "")}${resLine(c, { missing: missingRes })}</td>
${showOwner ? `<td><a href="#/owner/${encodeURIComponent(c.ownerId)}">${esc(c.owner || "-")}</a></td>` : ""}
<td>${esc(c.sourceLabel)}</td>
<td>${fd(c.startDate)}</td>
<td>${c.extCount ? `<span class="muted" style="text-decoration:line-through">${fd(c.origDueDate)}</span>` : fd(c.dueDate)}</td>
<td>${c.extCount ? `<small class="muted">รวม ${c.totalAge} วัน · ขยายแล้ว</small>` : ageCell(c)}</td>
<td>${c.extCount ? "" : chip(c.stage)}${extTag(c)}<div class="muted" style="font-size:12px;margin-top:4px">${esc(c.status || "")}</div></td>
</tr>${extRow(c, { before: showOwner ? 6 : 5, after: 1 })}`
      )
      .join("")}</tbody></table></div>`;
  }

  const FIELD = { extension: "ขยายเวลา (Due)", severity: "Severity", start_date: "Start date", target_date: "Target date", status: "Status", owner: "Owner", deleted: "ลบเคส", resolution: "Resolution" };
  const DIR = { later: "เลื่อนออกไป", earlier: "เลื่อนเข้ามา", set: "ใส่ค่าใหม่", cleared: "ลบค่าออก" };
  function changeRows(changes, { empty = "ยังไม่มีประวัติการแก้ไข" } = {}) {
    if (!changes.length) return `<div class="empty">${empty}</div>`;
    const val = (c, v) => (c.field === "start_date" || c.field === "target_date" || c.field === "extension" ? fd(v, true) : esc(v || "-"));
    return `<div class="tablewrap"><table style="min-width:860px"><thead><tr><th>เมื่อ</th><th>เลขเคส</th><th>ลูกค้า</th><th>Owner</th><th>รายการ</th><th>เดิม → ใหม่</th><th>แก้โดย</th></tr></thead><tbody>${changes
      .map(
        (c) => `<tr>
<td>${fdt(c.detected_at)}</td>
<td>${c.case_id ? `<a class="mono" href="#/case/${c.case_id}">${esc(caseRef(c))}</a>` : `<span class="mono">${esc(c.case_no || c.cs_number || "-")}</span>`}<div class="muted" style="font-size:12px">${c.cs_number ? esc(c.cs_number) + " · " : ""}${esc(teamLabel(c.team || c.source))}</div></td>
<td style="font-weight:600">${esc(c.site || "-")}</td>
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
    const [data, ikHtml, extHtml, lk] = await Promise.all([api("/overview?" + qs({ source: params.source })), intakeSection(), extPendingSection(), lookups()]);
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
      `<a class="rw-dot c-${c.stage}" href="#/case/${c.id}" title="${esc(`${caseRef(c)} · ${c.site || "-"} · ${c.owner || "-"} · วันที่ ${c.age}${c.daysOverdue ? ` (เกิน ${c.daysOverdue} วัน)` : ""}`)}" aria-label="${esc(`${caseRef(c)} ${c.site || ""} ของ ${c.owner || "-"} วันที่ ${c.age}`)}"></a>`;
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
${extHtml}
${ikHtml}
<form class="ofilters" id="flt" onsubmit="return false">
<label class="f">ทีม<select name="source"><option value="">ทุกทีมที่เห็นได้ (${data.sources.length})</option>${teamOpts}</select></label>
<label class="f">ค้นหาเคส<input type="search" name="q" placeholder="เลขเคส, CS, งาน, Owner, Resolution"></label>
<div class="site-pick">${comboBox("site", "", lk.site, { allowNew: false, required: false, label: "ลูกค้า" })}</div>
<label class="f">สถานะเคส<select name="st"><option value="open">ยังไม่ปิด</option><option value="closed">ปิดแล้ว</option><option value="all">ทั้งหมด</option>
<optgroup label="ทีละ Status">${lk.status.map((x) => `<option value="s:${esc(x)}" title="${esc(statusHelp(x))}">${esc(x)}</option>`).join("")}</optgroup></select></label>
<button class="btn primary" type="submit" id="flt-go">ค้นหา</button>
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
<section class="card"><div class="title"><h2>Email แจ้งเตือนที่ส่งวันนี้</h2><span>${(() => { const r = cfg.alertRules || {}; const t = (r.ccTypes || []).map((x) => ALERT[x]); return r.cc && t.length ? `ถึง Owner · CC ${esc(r.cc)} เฉพาะ${esc(t.join(", "))}` : "ถึง Owner เท่านั้น"; })()}</span></div>
${data.alertsToday.length ? `<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>เวลา</th><th>เลขเคส</th><th>ลูกค้า</th><th>Owner</th><th>ประเภท</th><th>ผล</th></tr></thead><tbody>
${data.alertsToday.map((a) => `<tr><td>${fdt(a.sent_at)}</td><td>${caseCell(a, `#/case/${a.case_id}`)}</td><td style="font-weight:600">${esc(a.site || "-")}</td><td>${esc(a.owner || "-")}</td>
<td>${chip(a.alert_type, ALERT[a.alert_type])}</td><td>${a.ok ? chip("ok", "ส่งแล้ว") : `<span class="chip c-fail" title="${esc(a.error)}">ส่งไม่สำเร็จ</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">วันนี้ยังไม่มีการส่ง email แจ้งเตือน</div>`}
</section>
${lvl("audit_view") !== "none" ? `<section class="card"><div class="title"><h2>การแก้ไขล่าสุด (14 วัน)</h2><a href="#/audit">ดูทั้งหมด</a></div>${changeRows(data.changes.slice(0, 8))}</section>` : ""}`;

    const f = document.getElementById("flt");
    f.source.onchange = () => (location.hash = "#/?" + qs({ source: f.source.value }));
    const go = () => {
      const v = f.st.value;
      const st = v === "all" ? "" : v === "open" ? lk.status.filter((x) => !isClosedStatus(x)).join("|") : v === "closed" ? lk.status.filter(isClosedStatus).join("|") : v.slice(2);
      location.hash = "#/cases?" + qs({ q: f.q.value.trim(), site: f.site.value.trim(), source: f.source.value, st: st || (v === "all" ? "" : undefined) }) + (v === "all" ? "&st=" : "");
    };
    f.site.placeholder = "ทุกลูกค้า · พิมพ์เพื่อค้นหา";
    bindCombo(f, "site", lk.site, { allowNew: false });
    f.onsubmit = (e) => {
      e.preventDefault();
      go();
    };
    bindRowLinks();
    bindIntakeActions($app, () => route());
    bindExtPending($app);
  }

  // ------------------------------------------------------------ case lists
  async function viewCases(params) {
    setNav("overview");
    const [{ cases: allCases }, lk] = await Promise.all([api("/cases"), lookups()]);
    const closedSet = (lk.closedStatuses || []).map((x) => x.toLowerCase());
    const isCl = (st) => closedSet.includes(String(st || "").toLowerCase());
    const statuses = [...new Set([...lk.status, ...allCases.map((c) => c.status).filter(Boolean)])];
    const openSt = statuses.filter((x) => !isCl(x));
    const closedSt = statuses.filter(isCl);
    // Legacy links from the overview KPI cards: stage / open=1.
    const stage = ["normal", "r1", "r2", "overdue", "no_start"].includes(params.stage) ? params.stage : "";
    let st;
    if (params.st !== undefined) st = params.st ? params.st.split("|") : [];
    else if (params.stage === "closed") st = closedSt;
    else if (params.open || stage) st = openSt;
    else st = params.q || params.site ? [] : openSt;
    const flag = params.flag || "";
    const range = params.range || "";
    const since = { d30: daysAgo(29), d90: daysAgo(89), m12: daysAgo(364), year: `${new Date().getFullYear()}-01-01` }[range] || "";
    const q = (params.q || "").trim().toLowerCase();

    // base = everything except the status / flag selection (used for the counts on the status buttons)
    const base = allCases.filter((c) =>
      (!params.source || c.source === params.source) &&
      (!params.owner || c.ownerId === params.owner) &&
      (!params.site || c.site === params.site) &&
      (!since || (c.startDate || "") >= since) &&
      (!stage || c.stage === stage) &&
      (!params.closedDays || (c.stage === "closed" && (c.endDate || "") >= daysAgo(Number(params.closedDays) - 1))) &&
      (!q || [c.caseNo, c.csNumber, c.site, c.owner, c.task, c.product, c.note, c.resolution].some((v) => String(v || "").toLowerCase().includes(q)))
    );
    const stSet = new Set(st);
    const byStatus = base.filter((c) => !st.length || stSet.has(c.status));
    const isFlag = { overdue: (c) => c.stage === "overdue", ext: (c) => (c.extCount || 0) > 0 };
    const cases = flag && isFlag[flag] ? byStatus.filter(isFlag[flag]) : byStatus;
    cases.sort((x, y) => (x.stage === "closed") - (y.stage === "closed") || (x.stage === "closed" ? String(y.endDate || "").localeCompare(String(x.endDate || "")) : (y.totalAge ?? y.age ?? 0) - (x.totalAge ?? x.age ?? 0)));

    const cnt = (fn) => base.filter(fn).length;
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    const grp = !st.length || same(st, statuses) ? "all" : same(st, openSt) ? "open" : same(st, closedSt) ? "closed" : "";
    const link = (over) => "#/cases?" + qs({ q: params.q, site: params.site, source: params.source, owner: params.owner, range, stage, flag, st: st.join("|"), ...over });
    const pill = (on, href, label, n, title = "") => `<a class="fpill ${on ? "on" : ""}" href="${href}" aria-pressed="${on}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)} <span class="n">${n}</span></a>`;
    const toggle = (x) => (stSet.has(x) ? st.filter((y) => y !== x) : [...st, x]).join("|");

    const owners = [...new Map(allCases.map((c) => [c.ownerId, c.owner])).entries()].filter(([id]) => id).sort((x, y) => String(x[1]).localeCompare(String(y[1]), "th"));
    const teams = [...new Map(allCases.map((c) => [c.source, c.sourceLabel])).entries()];
    const sites = [...new Set(allCases.map((c) => c.site).filter(Boolean))].sort((x, y) => x.localeCompare(y, "th"));
    const siteCount = params.site ? allCases.filter((c) => c.site === params.site).length : 0;

    const parts = [];
    if (params.site) parts.push(`ลูกค้า ${params.site}`);
    if (grp === "open") parts.push("ยังไม่ปิด");
    else if (grp === "closed") parts.push("ปิดแล้ว");
    else if (grp === "") parts.push(st.join(", ") || "ไม่ได้เลือก Status");
    if (stage) parts.push(STAGE[stage]);
    if (flag === "overdue") parts.push("เกิน Due");
    if (flag === "ext") parts.push("มีการขยายเวลา");
    if (params.q) parts.push(`“${params.q}”`);
    const showRes = cases.some((c) => c.stage === "closed");

    $app.innerHTML = `<div class="crumb"><a href="#/">ภาพรวม</a> / ค้นหาเคส</div>
<div class="head"><div><h1>ค้นหาเคส</h1><p>พบ ${cases.length} เคส</p></div>
<div class="actions">${lvl("export") === "all" && cases.length ? `<button class="btn" type="button" id="cs-export">Export ผลค้นหาเป็น Excel</button>` : ""}</div></div>
<section class="card" style="gap:16px">
<form class="sfilters" id="sf" onsubmit="return false">
<label class="f">คำค้น<input type="search" name="q" value="${esc(params.q || "")}" placeholder="เลขเคส, CS, งาน, Owner, Resolution"></label>
<div class="site-pick">${comboBox("site", params.site || "", sites, { allowNew: false, required: false, label: "ลูกค้า" })}${params.site ? `<button type="button" class="clear" id="site-clear" aria-label="ล้างลูกค้า">×</button>` : ""}</div>
<label class="f">ทีม<select name="source"><option value="">ทุกทีม</option>${teams.map(([k, l]) => `<option value="${esc(k)}" ${k === params.source ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
<label class="f">Owner<select name="owner"><option value="">ทุกคน</option>${owners.map(([id, n]) => `<option value="${esc(id)}" ${id === params.owner ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
<label class="f">เปิดเคสในช่วง<select name="range">${[["", "ทั้งหมด"], ["d30", "30 วันล่าสุด"], ["d90", "90 วันล่าสุด"], ["m12", "12 เดือนล่าสุด"], ["year", "ปีนี้"]].map(([v, l]) => `<option value="${v}" ${v === range ? "selected" : ""}>${l}</option>`).join("")}</select></label>
</form>
<div class="stack" style="gap:6px"><span style="font-size:13px;font-weight:600">สถานะเคส${stage ? ` · ระดับ ${esc(STAGE[stage])} <a href="${link({ stage: "" })}" style="font-weight:500">ล้าง</a>` : ""}</span>
<div class="fpills">
${pill(grp === "all", link({ st: "" }), "ทั้งหมด", base.length)}
${pill(grp === "open", link({ st: openSt.join("|") }), "ยังไม่ปิด", cnt((c) => !isCl(c.status)))}
${pill(grp === "closed", link({ st: closedSt.join("|") }), "ปิดแล้ว", cnt((c) => isCl(c.status)))}
<span class="psep" aria-hidden="true"></span>
${statuses.map((x) => pill(stSet.has(x) && grp !== "all", link({ st: grp === "all" ? x : toggle(x) }), x, cnt((c) => c.status === x), statusHelp(x))).join("")}
<span class="psep" aria-hidden="true"></span>
${pill(flag === "overdue", link({ flag: flag === "overdue" ? "" : "overdue" }), "เกิน Due", byStatus.filter(isFlag.overdue).length)}
${pill(flag === "ext", link({ flag: flag === "ext" ? "" : "ext" }), "มีการขยายเวลา", byStatus.filter(isFlag.ext).length)}
</div>
<span class="hint">“ยังไม่ปิด” = ${esc(openSt.join(", "))} · “ปิดแล้ว” = ${esc(closedSt.join(", "))} · กด Status ทีละตัวเพื่อเลือกหลายตัว · ตัวเลข = จำนวนเคสตามคำค้น ลูกค้า ทีม Owner และช่วงวันที่ที่เลือก</span>
<details class="st-all"><summary>ความหมายของแต่ละ Status</summary>${statusTable(statuses)}</details></div>
</section>
<section class="card"><div class="title"><h2>ผลค้นหา: ${esc(parts.join(" · ") || "ทุกเคส")}</h2><span>${cases.length} เคส${params.site ? ` · ลูกค้านี้มีทั้งหมด ${siteCount} เคส` : ""}</span></div>
${caseTable(cases, { missingRes: showRes, empty: "ไม่พบเคสตามเงื่อนไขนี้" })}</section>`;
    bindRowLinks();
    const sf = document.getElementById("sf");
    const go = (over = {}) => {
      location.hash = link({ q: sf.q.value.trim(), site: sf.site.value.trim(), source: sf.source.value, owner: sf.owner.value, range: sf.range.value, ...over });
    };
    sf.site.placeholder = "ทุกลูกค้า · พิมพ์เพื่อค้นหา";
    bindCombo(sf, "site", sites, { allowNew: false, onPick: (v) => go({ site: sites.includes(v) ? v : sites.find((x) => x.toLowerCase().includes(v.toLowerCase())) || "" }) });
    sf.q.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
    ["source", "owner", "range"].forEach((n) => (sf[n].onchange = () => go()));
    const sc = document.getElementById("site-clear");
    if (sc) sc.onclick = () => go({ site: "" });
    const ex = document.getElementById("cs-export");
    if (ex)
      ex.onclick = async () => {
        try {
          const r = await fetch("api/export/cases", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" }, body: JSON.stringify({ ids: cases.map((c) => c.id), title: parts.join(" · ") }) });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
          const blob = await r.blob();
          const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `cases-search-${daysAgo(0)}.xlsx` });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } catch (err) {
          toast("Export ไม่สำเร็จ: " + err.message, 6000);
        }
      };
  }

  async function viewMine(params) {
    setNav("mine");
    const [{ cases }, lk, ikHtml, extHtml] = await Promise.all([api("/cases?mine=1"), lookups(), intakeSection(), extPendingSection()]);
    const tab = params.tab || "open";
    const open = cases.filter((c) => c.stage !== "closed");
    const closed30 = cases.filter((c) => c.stage === "closed" && (c.endDate || "") >= daysAgo(30));
    let list = tab === "open" ? open : tab === "closed" ? closed30 : cases;
    if (params.q) {
      const s = params.q.toLowerCase();
      list = list.filter((c) => [c.caseNo, c.csNumber, c.site, c.task, c.product, c.severity, c.resolution].some((v) => String(v || "").toLowerCase().includes(s)));
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
      const opts = lk.status.map((s) => `<option ${s === c.status ? "selected" : ""} title="${esc(statusHelp(s))}">${esc(s)}</option>`).join("");
      return `<label><span class="sr">Status ของ ${esc(c.csNumber || c.id)}</span><select class="inline" data-status="${c.id}" data-prev="${esc(c.status)}">${opts}</select></label>`;
    };
    $app.innerHTML = `
<div class="head"><div><h1>เคสของฉัน</h1><p>เปิดเคสใหม่ อัปเดตความคืบหน้า และปิดเคสได้จากหน้านี้</p></div>
<div class="actions">${lvl("export") !== "none" ? `<a class="btn" href="api/export?${qs({ from: daysAgo(89), to: daysAgo(0), owner: ME.user.email })}">Export เคสของฉัน</a>` : ""}
${can("case_create") ? `<a class="btn primary" href="#/case/new">เปิดเคสใหม่</a>` : ""}</div></div>
${extHtml}
${ikHtml}
${soon.length ? `<div class="banner warn" role="status">${soon.map((c) => `<a href="#/case/${c.id}">${esc(caseRef(c))}</a> ${esc(c.site || "")} ${c.stage === "overdue" ? `เกิน Due มาแล้ว ${c.daysOverdue} วัน` : c.daysLeft === 0 ? "ครบกำหนดวันนี้" : `เหลือ ${c.daysLeft} วัน`}`).join(" · ")}</div>` : ""}
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
<label style="flex:0 1 280px"><span class="sr">ค้นหาเคส</span><input type="search" id="q" value="${esc(params.q || "")}" placeholder="ค้นหาเลขเคส, CS, ลูกค้า, งาน"></label></div>
${list.length ? `<div class="tablewrap"><table style="min-width:1080px"><thead><tr><th>เลขเคส</th><th>ลูกค้า</th><th>Severity</th><th>งาน</th><th>Product</th><th>เปิดเคส</th><th style="width:150px">อายุเคส</th><th style="width:170px">Status</th><th>อัปเดตล่าสุด</th><th></th></tr></thead><tbody>
${list.map((c) => `<tr class="click" data-href="#/case/${c.id}">
<td>${caseCell(c, `#/case/${c.id}`, esc(c.sourceLabel))}</td>
<td style="font-weight:600">${esc(c.site)}</td>
<td>${sevChip(c.severity)}</td>
<td style="font-size:13px">${esc(c.task)}${resLine(c, { missing: tab === "closed" })}</td>
<td>${esc(c.product || "-")}</td>
<td>${fd(c.startDate)}<div class="hint">Due ${c.extCount ? `<s>${fd(c.origDueDate)}</s> ${fd(c.dueDate)}` : fd(c.dueDate)}</div></td>
<td>${c.extCount ? `<small class="muted">รวม ${c.totalAge} วัน · ขยาย ${c.extCount} ครั้ง</small>` : ageCell(c)}${c.pendingExtId ? `<div><span class="chip c-r1">รออนุมัติขยาย</span></div>` : ""}</td>
<td>${statusSel(c)}</td>
<td style="font-size:13px" class="muted">${fdt(c.updatedAt)}</td>
<td style="text-align:right"><a href="#/case/${c.id}" style="font-weight:600">แก้ไข</a></td></tr>${extRow(c, { before: 5, after: 3 })}`).join("")}</tbody></table></div>` : `<div class="empty">${tab === "open" ? "ไม่มีเคสที่เปิดอยู่ กด “เปิดเคสใหม่” เพื่อเริ่ม" : "ไม่มีเคส"}</div>`}
</section>
<p class="hint">เปลี่ยน Status ในตารางแล้วบันทึกทันที ถ้าเลือก Success, Resolved, Cancel หรือ N/A ระบบจะให้กรอก Resolution ก่อนปิด แล้วใส่ End date ให้และหยุดแจ้งเตือน</p>`;
    bindRowLinks();
    bindIntakeActions($app, () => route());
    bindExtPending($app);
    const q = document.getElementById("q");
    q.onkeydown = (e) => {
      if (e.key === "Enter") location.hash = "#/mine?" + qs({ tab, q: q.value });
    };
    $app.querySelectorAll("select[data-status]").forEach((sel) => {
      sel.onchange = async () => {
        try {
          let body = { status: sel.value };
          if (isClosedStatus(sel.value) && !isClosedStatus(sel.dataset.prev)) {
            const kase = cases.find((x) => String(x.id) === sel.dataset.status);
            const r = await askResolution(kase, { status: sel.value });
            if (!r) {
              sel.value = sel.dataset.prev;
              return;
            }
            body = r;
          }
          await post(`/case/${sel.dataset.status}`, body, "PUT");
          toast(isClosedStatus(body.status) && !isClosedStatus(sel.dataset.prev) ? `ปิดเคสด้วย Status ${body.status} แล้ว` : `บันทึก Status เป็น ${body.status} แล้ว`);
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
  function bindCombo(root, name, options, { allowNew = true, onPick = null } = {}) {
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
        onPick && onPick(input.value);
      } else if (e.key === "Enter" && onPick) {
        e.preventDefault();
        close();
        onPick(input.value.trim());
      } else if (e.key === "Escape") close();
    });
    list.addEventListener("mousedown", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      e.preventDefault();
      input.value = b.dataset.v;
      close();
      onPick && onPick(input.value);
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
    const [extData, custFiles] = isNew
      ? [{ extensions: [] }, { files: [] }]
      : await Promise.all([api(`/case/${Number(id)}/extensions`).catch(() => ({ extensions: [] })), api(`/case/${Number(id)}/customer-files`).catch(() => ({ files: [] }))]);
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
<span class="muted">${c.extCount && !closed ? `ช่วงขยายครั้งที่ ${c.extCount} · ` : ""}${closed ? (c.closedOnTime ? "ทัน SLA" : c.extCount ? (c.closedInExtension ? "ไม่ทัน SLA เดิม · ปิดทันเวลาที่ขยาย" : "เกิน Due") : "เกิน Due") : c.stage === "overdue" ? `เกิน Due ${c.daysOverdue} วัน` : c.daysLeft === 0 ? "ครบกำหนดวันนี้" : `เหลือ ${c.daysLeft} วัน`}</span></div>
<div class="daybar" aria-hidden="true">${days.join("")}</div>
<div class="hint">${data.alerts.length ? data.alerts.slice(0, 4).map((a) => `${ALERT[a.alert_type]} ${fdt(a.sent_at)}${a.ok ? "" : " (ไม่สำเร็จ)"}`).join(" · ") : "ยังไม่มี email แจ้งเตือนสำหรับเคสนี้"}</div>
</section>`
      : "";

    $app.innerHTML = `
<div class="crumb">${lvl("case_edit") === "none" && lvl("case_create") === "none" ? `<a href="#/">ภาพรวม</a>` : `<a href="#/mine">เคสของฉัน</a>`} / ${isNew ? "เปิดเคสใหม่" : esc(caseRef(c))}</div>
<div class="head"><div><h1>${isNew ? "เปิดเคสใหม่" : `เคส <span class="mono" style="font-size:26px">${esc(caseRef(c))}</span> <span class="muted" style="font-size:16px;font-weight:500">${esc(c.site || "")}${csOf(c) ? " · " + esc(csOf(c)) : ""}</span>`}</h1>
<p>${isNew ? "Start date จะบันทึกเป็นวันนี้อัตโนมัติ และ Due = Start date + " + cfg.slaDays + " วัน" : `${esc(c.sourceLabel)} · Owner ${esc(c.owner || "-")} · ${chip(c.stage)} ${sevChip(c.severity)}`}</p></div>
<div class="actions">
${!isNew && c.site && lvl("export") === "all" ? `<a class="btn" href="#/reports?site=${encodeURIComponent(c.site)}">Export เคสของ ${esc(c.site)}</a>` : ""}
${!isNew && permsC.delete ? `<button class="btn danger" type="button" id="btn-del">ลบเคส</button>` : ""}
${!isNew && !closed && permsC.close ? `<button class="btn" type="button" id="btn-close" style="color:var(--normal-fg)">ปิดเคส</button>` : ""}
${!ro ? `<button class="btn primary" type="submit" form="cf">${isNew ? "เปิดเคส" : "บันทึก"}</button>` : ""}</div></div>
${ro ? `<div class="banner warn">คุณดูเคสนี้ได้อย่างเดียว ไม่มีสิทธิ์แก้ไข</div>` : ""}
<div class="cols">
<form id="cf" class="main" novalidate>
<fieldset class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px" ${ro ? "disabled" : ""}>
<legend style="font-size:15px;font-weight:600">ข้อมูลเคส</legend>
<label class="f">CS Number<input type="text" name="cs_number" value="${esc(c.csNumber || "")}" class="mono" placeholder="เช่น CS5056186"></label>
${comboBox("site", c.site, lk.site, { label: "Site / ลูกค้า", allowNew: !ro })}
<label class="f"><span class="req">Severity</span><select name="severity" required>${isNew ? `<option value="">เลือก Severity</option>` : ""}${(lk.severity || []).map((x) => `<option ${x === c.severity ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
<label class="f">Product<select name="product">${productOpts}</select></label>
<label class="f"><span class="req">Status</span><select name="status">${statusOpts}</select><span class="hint" id="st-hint">${esc(statusHelp(c.status))}</span></label>
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
<div class="f">Target date (Due)<div class="ro" style="min-height:44px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;padding:0 12px">${c.extCount ? `<span class="muted" style="text-decoration:line-through">${fd(c.origDueDate, true)}</span> ` : ""}${fd(c.dueDate, true)}</div><span class="hint">${c.extCount ? `ขยายแล้ว ${c.extCount} ครั้ง (ครั้งละ ${cfg.slaDays} วัน)` : `Start date + ${cfg.slaDays} วัน`}</span></div>
<div class="f">End date<div class="ro" style="min-height:44px;display:flex;align-items:center;border:1px solid var(--line);border-radius:10px;padding:0 12px">${c.endDate ? fd(c.endDate, true) : "ยังไม่ปิด"}</div><span class="hint">ใส่ให้อัตโนมัติเมื่อปิดเคส</span></div>
</section>`}
${data && data.changes.length ? `<section class="card"><h2>ประวัติแก้ไขของเคสนี้</h2>${changeRows(data.changes)}</section>` : ""}
</form>
<aside class="side">
${slaCard}
${closed ? `<section class="card"><div class="title"><h2>Resolution</h2>${permsC.edit && c.resolution ? `<button class="btn" type="button" id="btn-res" style="min-height:34px">แก้ไข</button>` : ""}</div>
${c.resolution ? `<div class="resol">${esc(c.resolution)}</div>
<p class="muted" style="margin:0;font-size:13px">ปิดโดย ${esc(c.resolvedBy || "-")}${c.resolvedAt ? " · " + fdt(c.resolvedAt) : ""} · Status ${esc(c.status)}${c.rootCause ? " · สาเหตุ: " + esc(c.rootCause) : ""}</p>` : `<div class="resol none">ไม่มี Resolution (ปิดก่อนเริ่มบังคับ)</div>${permsC.edit ? `<button class="btn" type="button" id="btn-res" style="align-self:flex-start">เพิ่ม Resolution</button>` : ""}`}</section>` : ""}
${custFiles.files.length ? `<section class="card"><div class="title"><h2>รูปและไฟล์จากลูกค้า (${custFiles.files.length})</h2><span>จาก email และฟอร์มเพิ่มข้อมูล</span></div>
<div class="cf-grid">${custFiles.files.map((f) => {
      const u = `api/intake/${f.intake_id}/files/${f.id}`;
      const img = /^image\/(png|jpe?g|gif|webp)$/.test(f.mime);
      return `<a class="cf" href="${u}" target="_blank" rel="noopener" title="${esc(f.file_name)}">${img ? `<img src="${u}" alt="${esc(f.file_name)}" loading="lazy">` : `<span class="cf-ext">${esc((f.file_name.split(".").pop() || "").toUpperCase())}</span>`}<span class="cf-n">${esc(f.file_name)}</span><span class="cf-d">${fdt(f.created_at)} · ${f.source === "form" ? "ฟอร์ม" : "email"}</span></a>`;
    }).join("")}</div></section>` : ""}
${isNew ? "" : extCard(c, extData.extensions, closed, permsC)}
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

    if (!isNew) bindExtCard(c, extData.extensions);
    const f = document.getElementById("cf");
    bindCombo(f, "site", lk.site);
    f.status.addEventListener("change", () => (document.getElementById("st-hint").textContent = statusHelp(f.status.value)));
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (ro) return;
      const body = {
        cs_number: f.cs_number.value.trim(),
        site: f.site.value.trim(),
        product: f.product.value,
        severity: f.severity.value,
        status: f.status.value,
        team: f.team.value,
        task: f.task.value.trim(),
        note: f.note.value.trim(),
      };
      if (f.owner_id) body.owner_id = Number(f.owner_id.value);
      if (!body.site) return toast("กรุณาระบุ Site / ลูกค้า");
      if (!body.task) return toast("กรุณาระบุ Task / Case");
      if (!body.severity) return toast("กรุณาเลือก Severity");
      if (isClosedStatus(body.status) && (isNew || !closed)) {
        const r = await askResolution(isNew ? { ...c, ...body, stage: "normal", age: 0 } : c, { status: body.status });
        if (!r) {
          if (!isNew) f.status.value = c.status;
          return;
        }
        Object.assign(body, r);
      }
      try {
        if (isNew) {
          body.detail = f.detail.value.trim();
          const r = await post("/case", body);
          toast(r.newSite ? `เปิดเคสแล้ว และเพิ่มลูกค้าใหม่ “${r.newSite}” เข้า dropdown` : "เปิดเคสแล้ว", 5000);
          location.hash = "#/case/" + r.id;
        } else {
          const r = await post("/case/" + id, body, "PUT");
          toast(r.changed.length ? (body.resolution && !closed ? "ปิดเคสแล้ว" : r.newSite ? `บันทึกแล้ว และเพิ่มลูกค้าใหม่ “${r.newSite}”` : "บันทึกแล้ว") : "ไม่มีอะไรเปลี่ยน", 4000);
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
        const r = await askResolution(c);
        if (!r) return;
        try {
          await post("/case/" + id, r, "PUT");
          toast("ปิดเคสแล้ว");
          viewCase(id);
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const br = document.getElementById("btn-res");
    if (br)
      br.onclick = async () => {
        const r = await askResolution(c, { edit: true });
        if (!r) return;
        try {
          await post("/case/" + id, { resolution: r.resolution, root_cause: r.root_cause }, "PUT");
          toast("บันทึก Resolution แล้ว");
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
        return `<div><div style="font-weight:600;margin-bottom:8px"><a class="mono" href="#/case/${cid}">${esc(c ? caseRef(c) : "#" + cid)}</a> · ${esc(c?.site || "")}${c && csOf(c) ? ` <span class="muted">${esc(csOf(c))}</span>` : ""}</div><div class="timeline">${list
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
<a class="btn primary" href="#/owner/${encodeURIComponent(o.id)}/meeting">มุมมองประชุม</a>
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
${extTable(o.extensions || [], `${esc(o.owner)} · การขอขยายเวลา`)}
${o.changes.length && lvl("audit_view") !== "none" ? `<section class="card"><h2>การแก้ไขในเคสของ Owner นี้</h2>${changeRows(o.changes)}</section>` : ""}
${closed.length ? `<section class="card"><div class="title"><h2>ปิดแล้วใน 30 วัน</h2><span>${closed.length} เคส</span></div>${caseTable(closed, { showOwner: false })}</section>` : ""}`;
    document.getElementById("pick").onchange = (e) => (location.hash = "#/owner/" + encodeURIComponent(e.target.value));
    bindRowLinks();
  }


  // ------------------------------------------------------------ meeting view (one page per owner)
  async function viewMeeting(id, params) {
    setNav("owner");
    const closed = params.closed ?? "7";
    const showSys = params.sys === "1";
    const limit = params.n === "all" ? Infinity : Number(params.n || 0) || Infinity;
    const m = await api(`/owner/${encodeURIComponent(id)}/meeting?closed=${closed}`);
    const k = m.kpis;
    const gen = new Date(m.generatedAt);
    const open = m.cases.filter((c) => c.stage !== "closed");
    const done = m.cases.filter((c) => c.stage === "closed");
    const ageText = (c) =>
      c.stage === "closed"
        ? `ปิดแล้ว ${fd(c.endDate)}${c.closedOnTime === true ? " · ทัน SLA" : c.closedOnTime === false ? " · เกิน Due" : ""}`
        : c.age == null ? "ไม่มี Start date" : c.stage === "overdue" ? `วันที่ ${c.age} · เกิน Due ${c.daysOverdue} วัน` : `วันที่ ${c.age} · ${c.daysLeft === 0 ? "ครบกำหนดวันนี้" : `เหลือ ${c.daysLeft} วัน`}`;
    const alertText = (c) => {
      const t = Object.fromEntries((c.alerts || []).map((a) => [a.alert_type, a.n]));
      const parts = [t.r1 && "รอบ 1", t.r2 && "รอบ 2", t.overdue && `เกิน Due ${t.overdue} ครั้ง`].filter(Boolean);
      return parts.length ? parts.join(" · ") : "-";
    };
    const lastAct = (c) => (c.activities || []).find((a) => !a.is_system);
    const actRows = (c) => {
      let list = (c.activities || []).filter((a) => showSys || !a.is_system);
      const total = list.length;
      list = list.slice(0, limit);
      if (!list.length) return `<div class="mt-empty">ยังไม่มี Activity</div>`;
      return `<table class="mt-acts"><tbody>${list
        .map((a) => `<tr class="${a.is_system ? "sys" : ""}"><td class="d">${fd(a.activity_date, true)}</td><td class="k">${esc(a.kind)}</td><td class="x">${esc(a.detail)}</td><td class="b">${esc(a.by || (a.is_system ? "ระบบ" : "-"))}</td></tr>`)
        .join("")}</tbody></table>${total > list.length ? `<div class="mt-more">และอีก ${total - list.length} รายการก่อนหน้า</div>` : ""}`;
    };
    const card = (c, i) => `<article class="mt-case ${c.stage}" id="mc-${c.id}">
<header><div class="mt-no">${i + 1}</div>
<div class="mt-title"><div><span class="mono">${esc(caseRef(c))}</span>${csOf(c) ? ` <span class="muted">${esc(csOf(c))}</span>` : ""} ${sevChip(c.severity)} ${chip(c.stage)}</div>
<h3>${esc(c.site || "-")} — ${esc(c.task || "-")}</h3></div>
<a class="mt-open noprint" href="#/case/${c.id}">เปิดเคส</a></header>
<dl class="mt-meta">
<div><dt>Product</dt><dd>${esc(c.product || "-")}</dd></div>
<div><dt>Status</dt><dd>${esc(c.status || "-")}</dd></div>
<div><dt>ทีม</dt><dd>${esc(c.sourceLabel)}</dd></div>
<div><dt>Start date</dt><dd>${fd(c.startDate, true)}</dd></div>
<div><dt>Due</dt><dd>${c.extCount ? `<s class="muted">${fd(c.origDueDate)}</s> ` : ""}${fd(c.dueDate, true)}${c.extCount ? ` <span class="chip c-normal">ขยาย ${c.extCount} ครั้ง</span>` : ""}</dd></div>
<div><dt>อายุเคส</dt><dd class="${c.stage === "overdue" ? "t-over" : c.stage === "r2" ? "t-r2" : ""}">${ageText(c)}</dd></div>
<div><dt>Email แจ้งเตือน</dt><dd>${alertText(c)}</dd></div>
</dl>
${c.note ? `<div class="mt-note"><strong>Note:</strong> ${esc(c.note)}</div>` : ""}
${(c.extensions || []).filter((e) => e.status !== "cancelled").map((e) => `<div class="mt-note"><strong>คำขอขยายครั้งที่ ${e.seq}</strong> (${fd(e.requested_at.slice(0, 10))}) ${EXT_ST[e.status][1]}${e.approver_name ? " โดย " + esc(e.approver_name) : ""}${e.status === "approved" ? ` · Due ${fd(e.old_due)} → ${fd(e.new_due)}` : ""} · เหตุผล: ${esc(e.reason)}${e.decision_note ? ` · ความเห็น: ${esc(e.decision_note)}` : ""}</div>`).join("")}
<div class="mt-acth">Activity / Detail <span>${(c.activities || []).filter((a) => !a.is_system).length} รายการ</span></div>
${actRows(c)}
</article>`;
    const sel = (name, cur, opts) => `<select data-p="${name}">${opts.map(([v, l]) => `<option value="${v}" ${String(cur) === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    $app.innerHTML = `
<div class="crumb noprint"><a href="#/">ภาพรวม</a> / <a href="#/owner/${encodeURIComponent(m.id)}">${esc(m.owner)}</a> / มุมมองประชุม</div>
<div class="mt-bar noprint">
<label>เคสที่ปิดแล้ว ${sel("closed", closed, [["0", "ไม่แสดง"], ["7", "7 วันล่าสุด"], ["14", "14 วันล่าสุด"], ["30", "30 วันล่าสุด"]])}</label>
<label>Activity ต่อเคส ${sel("n", params.n || "all", [["all", "ทั้งหมด"], ["3", "3 ล่าสุด"], ["5", "5 ล่าสุด"]])}</label>
<label class="chk"><input type="checkbox" data-p="sys" ${showSys ? "checked" : ""}>แสดงรายการของระบบ</label>
<span style="flex:1"></span>
<button class="btn primary" type="button" id="mt-print">พิมพ์ / บันทึก PDF</button></div>
<section class="mt-sheet">
<div class="mt-head"><div><div class="mt-kicker">สรุปเคสสำหรับประชุม</div><h1>${esc(m.owner)}</h1>
<div class="muted">${esc(m.email || "")} · ${esc(m.teams.join(", "))}</div></div>
<div class="mt-when">ข้อมูล ณ ${gen.getDate()} ${TH_MONTHS[gen.getMonth()]} ${gen.getFullYear() + 543} เวลา ${String(gen.getHours()).padStart(2, "0")}:${String(gen.getMinutes()).padStart(2, "0")} น.</div></div>
<div class="mt-kpis">
<div><b>${k.open}</b>ยังไม่ปิด</div><div class="k-normal"><b>${k.normal}</b>ปกติ</div><div class="k-r1"><b>${k.r1}</b>แจ้งรอบ 1</div>
<div class="k-r2"><b>${k.r2}</b>แจ้งรอบ 2</div><div class="k-overdue"><b>${k.overdue}</b>เกิน Due</div>
<div><b>${k.sla.pct === null ? "-" : k.sla.pct + "%"}</b>ปิดทัน SLA (30 วัน)</div></div>
${m.cases.length ? `<table class="mt-index"><thead><tr><th>#</th><th>เลขเคส</th><th>ลูกค้า</th><th>Severity</th><th>งาน</th><th>Status</th><th>อายุเคส</th><th>อัปเดตล่าสุด</th></tr></thead><tbody>
${m.cases.map((c, i) => { const la = lastAct(c); return `<tr class="${c.stage === "closed" ? "done" : ""}"><td>${i + 1}</td><td class="mono"><a href="#mc-${c.id}" data-jump="${c.id}">${esc(caseRef(c))}</a>${csOf(c) ? `<div class="muted" style="font-size:11px">${esc(csOf(c))}</div>` : ""}</td><td><strong>${esc(c.site || "-")}</strong></td><td>${sevChip(c.severity)}</td>
<td class="muted">${esc(c.task || "")}</td><td>${esc(c.status || "-")}</td>
<td>${chip(c.stage)} <span class="muted">${esc(ageText(c))}</span></td><td class="muted">${la ? `${fd(la.activity_date)} · ${esc(la.detail.length > 70 ? la.detail.slice(0, 70) + "…" : la.detail)}` : "-"}</td></tr>`; }).join("")}
</tbody></table>` : `<div class="empty">ไม่มีเคสที่ต้องแสดง</div>`}
${open.length ? `<h2 class="mt-sec">เคสที่ยังไม่ปิด (${open.length})</h2>${open.map((c, i) => card(c, i)).join("")}` : ""}
${done.length ? `<h2 class="mt-sec">ปิดแล้วใน ${m.closedDays} วันล่าสุด (${done.length})</h2>${done.map((c, i) => card(c, open.length + i)).join("")}` : ""}
</section>`;
    const go = (patch) => {
      const p = { closed, n: params.n, sys: showSys ? "1" : "", ...patch };
      location.hash = `#/owner/${encodeURIComponent(id)}/meeting?` + qs(p);
    };
    $app.querySelectorAll("select[data-p]").forEach((el) => (el.onchange = () => go({ [el.dataset.p]: el.value })));
    $app.querySelector("input[data-p=sys]").onchange = (e) => go({ sys: e.target.checked ? "1" : "" });
    $app.querySelectorAll("[data-jump]").forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      document.getElementById("mc-" + a.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    document.getElementById("mt-print").onclick = () => window.print();
    // Print in the light theme even when the screen uses the dark one.
    window.onbeforeprint = () => {
      document.documentElement.dataset.printTheme = document.documentElement.dataset.theme || "";
      document.documentElement.dataset.theme = "light";
    };
    window.onafterprint = () => {
      const t = document.documentElement.dataset.printTheme;
      if (t) document.documentElement.dataset.theme = t;
      delete document.documentElement.dataset.printTheme;
    };
  }

  // ------------------------------------------------------------ reports
  const DOW = ["", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
  const RANGE_TYPES = { prev_week: "สัปดาห์ก่อนหน้า (จ.–อา.)", last_7: "7 วันล่าสุด", prev_month: "เดือนก่อนหน้า", month_to_date: "ต้นเดือนถึงวันนี้", last_30: "30 วันล่าสุด", yesterday: "เมื่อวาน" };

  async function viewReports(params = {}) {
    setNav("reports");
    const manage = lvl("reports_manage") !== "none";
    const exp = lvl("export");
    const [sch, hist, ov, lk] = await Promise.all([
      manage ? api("/schedules") : { schedules: [] },
      manage ? api("/reports/history") : { reports: [] },
      api("/overview"),
      lookups(),
    ]);
    const picked = (params && params.site ? String(params.site).split("|") : []).filter(Boolean);
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
<div class="f" style="grid-column:1/-1"><label for="site-in">ลูกค้า / Site <span class="hint">(เว้นว่าง = ทุกลูกค้า เลือกได้หลายราย)</span></label>
<div style="display:flex;gap:8px;flex-wrap:wrap"><input id="site-in" list="site-dl" placeholder="พิมพ์ชื่อลูกค้าแล้วกด Enter" style="flex:1 1 240px" autocomplete="off">
<button class="btn" type="button" id="site-add">เพิ่ม</button></div>
<datalist id="site-dl">${lk.site.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
<div class="chips" id="site-chips" style="margin-top:4px"></div></div>
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
      const sites = [...picked];
      const chips = document.getElementById("site-chips");
      const sin = document.getElementById("site-in");
      const drawChips = () => {
        chips.innerHTML = sites.length
          ? sites.map((x, i) => `<span class="lk">${esc(x)} <button type="button" data-rm="${i}" aria-label="เอา ${esc(x)} ออก">×</button></span>`).join("") + `<button class="btn" type="button" id="site-clear" style="min-height:30px;padding:0 10px">ล้าง</button>`
          : `<span class="hint">ทุกลูกค้า</span>`;
        chips.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { sites.splice(Number(b.dataset.rm), 1); drawChips(); }));
        const cl = document.getElementById("site-clear");
        if (cl) cl.onclick = () => { sites.length = 0; drawChips(); };
        document.getElementById("preview").innerHTML = "";
      };
      const addSite = () => {
        const v = sin.value.trim();
        if (!v) return;
        const match = lk.site.find((x) => x.toLowerCase() === v.toLowerCase());
        if (!match) return toast(`ไม่พบลูกค้า “${v}” ในรายการ เลือกจากรายการที่ขึ้นมา`);
        if (!sites.includes(match)) sites.push(match);
        sin.value = "";
        drawChips();
      };
      sin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSite(); } });
      sin.addEventListener("change", () => { if (lk.site.some((x) => x.toLowerCase() === sin.value.trim().toLowerCase())) addSite(); });
      document.getElementById("site-add").onclick = addSite;
      drawChips();
      const params = () => ({ from: m.from.value, to: m.to.value, owner: m.owner ? m.owner.value : "" });
      const siteQs = () => sites.map((x) => "&site=" + encodeURIComponent(x)).join("");
      const dl = document.getElementById("btn-dl");
      if (dl) dl.onclick = () => (location.href = "api/export?" + qs({ ...params(), format: m.format.value }) + siteQs());
      document.getElementById("btn-preview").onclick = async () => {
        try {
          const p = await api("/reports/preview?" + qs(params()) + siteQs());
          const k = p.kpis;
          document.getElementById("preview").innerHTML = `${sites.length ? `ลูกค้า ${esc(sites.join(", "))} · ` : `ทุกลูกค้า (${p.customers} ราย) · `}ช่วง ${esc(p.rangeLabel)}: เปิดใหม่ <strong>${k.opened}</strong> · ปิด <strong>${k.closed}</strong> (ทัน SLA ${k.slaPct === null ? "-" : k.slaPct + "%"}) · ยังเปิดอยู่ ${k.openNow} · เกิน Due ขณะนี้ <strong>${k.overdueNow}</strong>${k.extCount ? ` · ขอขยายเวลา <strong>${k.extCases}</strong> เคส ${k.extCount} ครั้ง` : ""}
<div class="tablewrap" style="margin-top:12px"><table style="min-width:860px"><thead><tr><th>Owner</th><th class="n">เปิดใหม่</th><th class="n">ปิด</th><th class="n">ปิดทัน SLA เดิม</th><th class="n">ยังเปิดอยู่</th><th class="n">เกิน Due</th><th class="n">ขอขยาย (เคส)</th><th class="n">ขอขยาย (ครั้ง)</th><th class="n">อนุมัติ / ไม่อนุมัติ</th></tr></thead><tbody>
${p.owners.map((o) => `<tr><td style="font-weight:600">${esc(o.owner)}</td><td class="n">${o.opened}</td><td class="n">${o.closed}</td><td class="n">${o.closedOnTime}</td><td class="n">${o.open}</td><td class="n t-over">${o.overdue || 0}</td><td class="n" style="font-weight:700">${o.extCases || 0}</td><td class="n" style="font-weight:700">${o.extCount || 0}</td><td class="n">${o.extCount ? `${o.extApproved} / ${o.extRejected}` : "-"}</td></tr>`).join("")}</tbody></table></div>
${extTable(p.extensions || [], "การขอขยายเวลาในช่วงนี้ พร้อมเหตุผล")}`;
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
            const r = await post("/reports/send", { ...params(), sites, recipients: m.recipients.value, title: "รายงานสถานะเคส" });
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
<label class="f">บทบาท<select name="role" ${sel.id === ME.user.id ? "disabled" : ""}>${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === sel.role ? "selected" : ""}>${l}</option>`).join("")}</select><span class="hint" data-role-hint>${esc(ROLE_HINT[sel.role] || "")}</span></label>
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
<div class="tabs2" role="tablist"><a role="tab" class="on" aria-selected="true" href="#/users">ผู้ใช้</a><a role="tab" aria-selected="false" href="#/roles">สิทธิ์ตามบทบาท</a><a role="tab" aria-selected="false" href="#/audit-log">Audit log</a></div>
<div class="head"><div><h1>จัดการผู้ใช้</h1><p>เพิ่มหรือปิดการใช้งานบัญชี กำหนดบทบาทและทีม รีเซ็ตรหัสผ่าน ทุกการเปลี่ยนแปลงถูกบันทึก</p></div>
<div class="actions"><a class="btn" href="api/users/template">ดาวน์โหลดแม่แบบ Excel</a><button class="btn" type="button" id="u-import">นำเข้าจาก Excel</button><button class="btn primary" type="button" id="u-add">เพิ่มผู้ใช้</button></div></div>
<div class="cols"><section class="card main">
<div class="filters" style="padding:0">
<label class="f" style="flex:2 1 220px"><span class="sr">ค้นหาผู้ใช้</span><input type="search" id="uq" value="${esc(params.q || "")}" placeholder="ค้นหาชื่อหรืออีเมล"></label>
<label class="f"><span class="sr">บทบาท</span><select id="ur"><option value="">ทุกบทบาท</option>${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${params.role === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
<div class="tablewrap"><table style="min-width:680px"><thead><tr><th>ผู้ใช้</th><th>บทบาท</th><th>ทีม</th><th>สถานะ</th><th class="n">เคสเปิด</th><th>เข้าใช้ล่าสุด</th></tr></thead><tbody>
${list.map((u) => `<tr class="click" data-href="#/users?id=${u.id}" style="${sel && sel.id === u.id ? "background:color-mix(in srgb, var(--accent) 8%, transparent)" : u.active ? "" : "opacity:.6"}">
<td><a href="#/users?id=${u.id}" style="font-weight:600">${esc(u.display_name)}</a><div class="hint">${esc(u.email)}${u.auth_type === "local" ? " · รหัสผ่าน" : ""}</div></td>
<td>${chip(ROLE_CHIP[u.role], ROLE[u.role])}</td>
<td style="font-size:13px">${u.role === "admin" || u.role === "observer" ? "ทุกทีม" : esc(u.teams.map(teamLabel).join(", ") || "-")}</td>
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
    document.getElementById("u-import").onclick = () => openImportUsers();
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


  const AUTH_LABEL = { sso: "Microsoft", local: "รหัสผ่าน" };
  const IMPORT_ACT = { create: ["ok", "เพิ่มใหม่"], update: ["r1", "อัปเดต"], same: ["closed", "ไม่เปลี่ยน"], error: ["overdue", "ผิดพลาด"] };
  function openImportUsers() {
    const dlg = document.getElementById("dlg");
    let fileB64 = null;
    const step1 = () => {
      dlg.innerHTML = `<form class="card" method="dialog" id="imf">
<h2>นำเข้าผู้ใช้จาก Excel</h2>
<p class="muted" style="margin:0;font-size:14px">ใช้ไฟล์ตามแม่แบบ (Email, ชื่อที่แสดง, บทบาท, ทีม, วิธีเข้าระบบ) ระบบจะแสดงตัวอย่างก่อน ยังไม่บันทึกจนกว่าจะกดยืนยัน ผู้ใช้ที่มีอยู่แล้วจะถูกอัปเดต ไม่มีการลบหรือปิดใช้งานจากไฟล์นี้</p>
<label class="f">ไฟล์ .xlsx<input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
<div id="im-out"></div>
<div class="right"><a class="btn" href="api/users/template">ดาวน์โหลดแม่แบบ</a><button class="btn" value="cancel" formnovalidate>ปิด</button><button class="btn primary" type="button" id="im-go" disabled>ยืนยันนำเข้า</button></div></form>`;
      const f = dlg.querySelector("#imf");
      const out = dlg.querySelector("#im-out");
      const go = dlg.querySelector("#im-go");
      f.file.onchange = async () => {
        go.disabled = true;
        const file = f.file.files[0];
        if (!file) return;
        if (file.size > 2.5 * 1024 * 1024) return (out.innerHTML = `<div class="banner err">ไฟล์ใหญ่เกิน 2.5 MB</div>`);
        out.innerHTML = `<div class="hint">กำลังอ่านไฟล์…</div>`;
        fileB64 = await new Promise((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(",")[1]);
          r.onerror = no;
          r.readAsDataURL(file);
        });
        try {
          const p = await post("/users/import", { file: fileB64 });
          const sm = p.summary;
          out.innerHTML = `<div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
<div class="kpi k-normal"><div class="l">เพิ่มใหม่</div><div class="v">${sm.create}</div></div>
<div class="kpi k-r1"><div class="l">อัปเดต</div><div class="v">${sm.update}</div></div>
<div class="kpi k-closed"><div class="l">ไม่เปลี่ยน</div><div class="v">${sm.same}</div></div>
<div class="kpi k-overdue"><div class="l">ผิดพลาด</div><div class="v">${sm.error}</div></div></div>
${sm.error ? `<div class="banner err">มีแถวที่ผิด ${sm.error} แถว แก้ในไฟล์แล้วเลือกไฟล์ใหม่ (ยังไม่มีอะไรถูกบันทึก)</div>` : ""}
<div class="tablewrap" style="max-height:46vh;overflow:auto"><table style="min-width:820px"><thead><tr><th class="n">แถว</th><th>ผู้ใช้</th><th>บทบาท</th><th>ทีม</th><th>เข้าระบบ</th><th>ผล</th></tr></thead><tbody>
${p.rows.map((r) => `<tr><td class="n">${r.row}</td><td><div style="font-weight:600">${esc(r.final ? r.final.display_name : r.name || "-")}</div><div class="hint">${esc(r.email || "-")}</div></td>
<td>${r.final ? esc(ROLE[r.final.role]) : esc(r.role || "-")}</td>
<td style="font-size:13px">${r.final ? esc(r.final.teams.map(teamLabel).join(", ") || "-") : esc(r.teams || "-")}</td>
<td>${r.final ? AUTH_LABEL[r.final.auth_type] : esc(r.auth || "-")}</td>
<td>${chip(IMPORT_ACT[r.action][0], IMPORT_ACT[r.action][1])}${r.changes && r.changes.length ? `<div class="hint">เปลี่ยน: ${esc(r.changes.join(", "))}</div>` : ""}${r.errors.map((e) => `<div class="hint t-over">${esc(e)}</div>`).join("")}${r.notes.map((e) => `<div class="hint">${esc(e)}</div>`).join("")}</td></tr>`).join("")}
</tbody></table></div>`;
          go.disabled = !!sm.error || !(sm.create + sm.update);
          go.textContent = sm.create + sm.update ? `ยืนยันนำเข้า (เพิ่ม ${sm.create} · อัปเดต ${sm.update})` : "ไม่มีอะไรต้องนำเข้า";
        } catch (e) {
          out.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
        }
      };
      go.onclick = async () => {
        go.disabled = true;
        try {
          const r = await post("/users/import", { file: fileB64, apply: true });
          const temps = r.created.filter((c) => c.tempPassword);
          dlg.innerHTML = `<form class="card" method="dialog"><h2>นำเข้าผู้ใช้แล้ว</h2>
<p style="margin:0">เพิ่มใหม่ ${r.created.length} คน · อัปเดต ${r.updated} คน</p>
<p class="muted" style="margin:0;font-size:14px">ผู้ใช้บัญชี Microsoft เข้าระบบด้วยปุ่ม "เข้าด้วยบัญชี Microsoft ของบริษัท" ได้ทันที</p>
${temps.length ? `<div class="banner warn">รหัสผ่านชั่วคราวของบัญชีรหัสผ่าน ${temps.length} คน แสดงครั้งเดียว คัดลอกเก็บไว้แล้วแจ้งแต่ละคนผ่านช่องทางที่ปลอดภัย ระบบบังคับให้เปลี่ยนรหัสตอนเข้าครั้งแรก</div>
<div class="tablewrap"><table><thead><tr><th>ผู้ใช้</th><th>รหัสชั่วคราว</th></tr></thead><tbody>${temps.map((t) => `<tr><td>${esc(t.display_name)}<div class="hint">${esc(t.email)}</div></td><td class="mono">${esc(t.tempPassword)}</td></tr>`).join("")}</tbody></table></div>
<div class="right"><button class="btn" type="button" id="im-copy">คัดลอกทั้งหมด</button></div>` : ""}
<div class="right"><button class="btn primary" value="ok">ปิด</button></div></form>`;
          const cp = dlg.querySelector("#im-copy");
          if (cp) cp.onclick = async () => {
            try {
              await navigator.clipboard.writeText(temps.map((t) => `${t.email}\t${t.tempPassword}`).join("\n"));
              toast("คัดลอกแล้ว");
            } catch (e) {
              toast("คัดลอกไม่ได้ ให้เลือกข้อความในตารางแทน");
            }
          };
          dlg.onclose = () => { dlg.classList.remove("wide"); viewUsers({}); };
        } catch (e) {
          toast("นำเข้าไม่สำเร็จ: " + e.message, 6000);
          go.disabled = false;
        }
      };
    };
    dlg.onclose = () => dlg.classList.remove("wide");
    dlg.classList.add("wide");
    step1();
    dlg.showModal();
  }

  function openAddUser() {
    const dlg = document.getElementById("dlg");
    dlg.innerHTML = `<form class="card" method="dialog" id="nf">
<h2>เพิ่มผู้ใช้</h2>
<div class="formgrid">
<label class="f"><span class="req">อีเมล</span><input type="email" name="email" required placeholder="name@sinostech.co.th"></label>
<label class="f">ชื่อที่แสดง<input name="display_name" placeholder="ชื่อ นามสกุล"></label>
<label class="f">บทบาท<select name="role">${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === "engineer" ? "selected" : ""}>${l}</option>`).join("")}</select><span class="hint" data-role-hint>${esc(ROLE_HINT.engineer)}</span></label>
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
    const locked = (r, p) => (r === "admin" && (p === "users_manage" || p === "settings_manage")) || (r === "observer" && (data.observerLocked || []).includes(p));
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
<div class="tabs2" role="tablist"><a role="tab" aria-selected="false" href="#/users">ผู้ใช้</a><a role="tab" class="on" aria-selected="true" href="#/roles">สิทธิ์ตามบทบาท</a><a role="tab" aria-selected="false" href="#/audit-log">Audit log</a></div>
<div class="head"><div><h1>สิทธิ์ตามบทบาท</h1><p>ผู้ใช้แต่ละคนมี 1 บทบาท กดที่ช่องเพื่อสลับ ไม่มีสิทธิ์ → เฉพาะของตัวเอง → ทั้งหมด แล้วกดบันทึก</p></div>
<div class="actions">${editable ? `<button class="btn primary" id="save" type="button" disabled>บันทึกสิทธิ์</button>` : ""}</div></div>
<section class="card"><div class="tablewrap" id="pm"></div></section>
<p class="hint">ทุกคนเห็นเฉพาะเคสของทีมที่ได้รับสิทธิ์ (Admin และ Observer เห็นทุกทีม) · Observer ดูได้ทุกหน้ารวมถึง KPI ของทุกคน แต่แก้ไขข้อมูลไม่ได้ ช่องที่ล็อกไว้เปิดไม่ได้ Admin มีสิทธิ์จัดการผู้ใช้และตั้งค่าเสมอ เพื่อไม่ให้ระบบล็อกตัวเอง</p>`;
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


  // ------------------------------------------------------------ audit log (admin)
  const ACTION = {
    login: ["ok", "เข้าสู่ระบบ"], logout: ["closed", "ออกจากระบบ"], login_failed: ["overdue", "เข้าสู่ระบบไม่สำเร็จ"], login_locked: ["overdue", "ถูกล็อกชั่วคราว"], login_denied: ["overdue", "ไม่มีสิทธิ์ใช้งาน"],
    bootstrap_admin: ["r2", "สร้าง Admin คนแรก"], user_create: ["r1", "เพิ่มผู้ใช้"], user_update: ["r1", "แก้ไขผู้ใช้"], user_delete: ["overdue", "ลบผู้ใช้"], user_import: ["r1", "นำเข้าผู้ใช้จาก Excel"], user_signout: ["r1", "บังคับออกจากระบบ"],
    password_temp: ["r2", "สร้างรหัสชั่วคราว"], password_link: ["r2", "ส่งลิงก์ตั้งรหัสใหม่"], password_changed: ["closed", "เปลี่ยนรหัสผ่าน"], password_reset_done: ["closed", "ตั้งรหัสใหม่จากลิงก์"], permissions_update: ["r2", "แก้สิทธิ์ตามบทบาท"],
    case_create: ["all", "เปิดเคส"], case_update: ["all", "แก้ข้อมูลเคส"], case_status: ["all", "เปลี่ยน Status"], case_owner: ["r1", "โอนเคส"], case_start_date: ["r2", "แก้ Start date"], case_delete: ["overdue", "ลบเคส"], case_deleted: ["overdue", "ลบเคส"], case_target_date: ["r2", "แก้ Target date"], case_severity: ["r1", "เปลี่ยน Severity"], import_excel: ["r1", "นำเข้าเคสจาก Excel"],
    export: ["all", "Export"], report_send: ["all", "ส่ง Report"], schedule_create: ["all", "เพิ่มรอบส่ง Report"], schedule_update: ["all", "แก้รอบส่ง Report"], schedule_delete: ["r1", "ลบรอบส่ง Report"], schedule_test: ["closed", "ส่ง Report ทดสอบ"], annual_download: ["all", "ดาวน์โหลดรายงานรายปี"],
    settings_update: ["r2", "แก้ตั้งค่าระบบ"], lookup_add: ["closed", "เพิ่มรายการ dropdown"], lookup_update: ["closed", "แก้รายการ dropdown"], lookup_merge: ["r1", "รวมรายการ dropdown"], annual_test: ["closed", "ส่งรายงานรายปีทดสอบ"], alert_email_test: ["closed", "ส่ง email แจ้งเตือนทดสอบ"],
  };
  const GROUP = { login: "เข้าสู่ระบบ", users: "ผู้ใช้และสิทธิ์", cases: "เคส", data: "Export และ Report", settings: "ตั้งค่าระบบ" };
  const REASON = { wrong_password: "รหัสผ่านผิด", unknown_email: "ไม่พบอีเมลนี้", disabled: "บัญชีถูกปิดใช้งาน", sso_account: "บัญชีนี้ต้องใช้ปุ่ม Microsoft", not_registered: "ยังไม่ได้เพิ่มเป็นผู้ใช้" };
  function auditDetail(r) {
    const x = r.detail || {};
    const parts = [];
    if (x.method) parts.push(x.method === "sso" ? "บัญชี Microsoft" : "รหัสผ่าน");
    if (x.reason && REASON[x.reason]) parts.push(REASON[x.reason]);
    else if (x.reason) parts.push("เหตุผล: " + x.reason);
    if (x.old !== undefined || x.new !== undefined) parts.push(`${x.old ?? "-"} → ${x.new ?? "-"}`);
    if (x.fields) parts.push("แก้: " + x.fields.join(", "));
    if (x.format) parts.push(String(x.format).toUpperCase());
    if (x.sites && x.sites.length) parts.push("ลูกค้า " + x.sites.join(", "));
    if (x.cases !== undefined && r.action === "export") parts.push(`${x.cases} เคส`);
    if (x.rows !== undefined) parts.push(`${x.rows} แถว`);
    if (x.role) parts.push("บทบาท " + (ROLE[x.role] || x.role));
    if (x.teams && x.teams.length) parts.push("ทีม " + x.teams.join(", "));
    if (x.active === false) parts.push("ปิดใช้งาน");
    if (x.created !== undefined) parts.push(`เพิ่ม ${x.created} · อัปเดต ${x.updated}`);
    if (x.added !== undefined) parts.push(`เพิ่ม ${x.added} เคส · สร้างผู้ใช้ ${x.usersCreated || 0}`);
    if (x.from && x.to) parts.push(`${x.from} – ${x.to}`);
    if (x.to && !x.from) parts.push("ถึง " + x.to);
    return parts.join(" · ");
  }
  const browser = (ua) => {
    if (!ua) return "";
    const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "อื่นๆ";
    const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
    return b + (os ? " · " + os : "");
  };
  async function viewAuditLog(params) {
    setNav("users");
    const days = Number(params.days || 30);
    const query = { days, group: params.group, q: params.q };
    const { audit } = await api("/audit?" + qs(query));
    const fails = audit.filter((r) => r.action === "login_failed" || r.action === "login_locked").length;
    const logins = audit.filter((r) => r.action === "login").length;
    const users = new Set(audit.filter((r) => r.action === "login").map((r) => r.actor_id)).size;
    const exports = audit.filter((r) => r.action === "export" || r.action === "report_send").length;
    $app.innerHTML = `
<div class="tabs2" role="tablist"><a role="tab" aria-selected="false" href="#/users">ผู้ใช้</a><a role="tab" aria-selected="false" href="#/roles">สิทธิ์ตามบทบาท</a><a role="tab" class="on" aria-selected="true" href="#/audit-log">Audit log</a></div>
<div class="head"><div><h1>Audit log</h1><p>บันทึกการเข้าสู่ระบบ การจัดการผู้ใช้และสิทธิ์ การแก้ไขเคส Export และการตั้งค่าทั้งหมด พร้อม IP และเบราว์เซอร์ แก้หรือลบไม่ได้</p></div>
<div class="actions"><a class="btn" href="api/audit?${qs({ ...query, format: "csv" })}">Export CSV</a></div></div>
<form class="filters" id="af2" onsubmit="return false">
<label class="f">ช่วงเวลา<select name="days">${[1, 7, 30, 90, 365, 730].map((x) => `<option value="${x}" ${x === days ? "selected" : ""}>${x === 1 ? "24 ชั่วโมง" : x + " วันล่าสุด"}</option>`).join("")}</select></label>
<label class="f">ประเภท<select name="group"><option value="">ทั้งหมด</option>${Object.entries(GROUP).map(([k, l]) => `<option value="${k}" ${params.group === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
<label class="f" style="flex:2 1 260px">ค้นหา<input type="search" name="q" value="${esc(params.q || "")}" placeholder="ชื่อผู้ใช้, อีเมล, เลขเคส, IP"></label>
</form>
<div class="kpis">
<div class="kpi k-normal"><div class="l">เข้าสู่ระบบสำเร็จ</div><div class="v">${logins}</div><div class="s">${users} คน</div></div>
<div class="kpi k-overdue"><div class="l">เข้าสู่ระบบไม่สำเร็จ</div><div class="v">${fails}</div><div class="s">รวมการถูกล็อกชั่วคราว</div></div>
<div class="kpi k-all"><div class="l">Export / ส่ง Report</div><div class="v">${exports}</div></div>
<div class="kpi k-closed"><div class="l">รายการทั้งหมด</div><div class="v">${audit.length}</div><div class="s">${audit.length >= 2000 ? "แสดง 2,000 รายการล่าสุด" : "ในช่วงที่เลือก"}</div></div>
</div>
<section class="card">${audit.length ? `<div class="tablewrap"><table style="min-width:960px"><thead><tr><th style="width:120px">เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เป้าหมาย</th><th>รายละเอียด</th><th>IP / เบราว์เซอร์</th></tr></thead><tbody>
${audit.map((r) => { const a = ACTION[r.action] || ["closed", r.action]; return `<tr>
<td style="white-space:nowrap">${fdt(r.at)}</td>
<td>${r.actor_id ? `<a href="#/users?id=${r.actor_id}">${esc(r.actor || "-")}</a>` : esc(r.actor || "-")}</td>
<td>${chip(a[0], a[1])}</td>
<td style="font-size:13px">${r.detail && r.detail.case_id ? `<a href="#/case/${r.detail.case_id}">${esc(r.target || "-")}</a>` : esc(r.target || "-")}</td>
<td style="font-size:13px">${esc(auditDetail(r))}</td>
<td style="font-size:12px" class="muted">${esc(r.ip || "-")}${r.user_agent ? `<div>${esc(browser(r.user_agent))}</div>` : ""}</td></tr>`; }).join("")}
</tbody></table></div>` : `<div class="empty">ไม่มีรายการในช่วงนี้</div>`}</section>
<p class="hint">ระบบเก็บ Audit log ตามระยะเวลาเก็บข้อมูลในหน้าตั้งค่า (ปัจจุบัน 2 ปี) การเปลี่ยน Status โอนเคส และแก้ Start date ดูรายละเอียดเพิ่มได้ที่เมนูประวัติแก้ไข</p>`;
    const f = document.getElementById("af2");
    const go = () => (location.hash = "#/audit-log?" + qs({ days: f.days.value, group: f.group.value, q: f.q.value }));
    f.days.onchange = go;
    f.group.onchange = go;
    f.q.onkeydown = (e) => e.key === "Enter" && go();
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
<div class="head"><div><h1>ตั้งค่าระบบ</h1><p>แทน tab Settings ในไฟล์ Excel เดิม แก้ได้เฉพาะ Admin</p></div><div class="actions"><a class="btn" href="#/intake-admin">รับแจ้งเคสจากลูกค้า: LINE OA, Email และ API</a></div></div>
${s.cert && !s.cert.error ? `<div class="banner ${s.cert.daysLeft <= 21 ? "warn" : "ok"}">ใบรับรอง HTTPS ${esc(s.cert.issuer)} ใช้ได้ถึง ${fd(s.cert.validTo, true)} (อีก ${s.cert.daysLeft} วัน)${s.cert.daysLeft <= 21 ? " ต้องต่ออายุ ระบบแจ้งทาง Telegram และ email ทุกวันจนกว่าจะต่ออายุ" : ""}</div>` : ""}
${(() => {
      const w = s.webRisk || {};
      if (!w.configured) return `<div class="banner">ตรวจคำเตือน “Dangerous” ของ Chrome อัตโนมัติ: ยังไม่ได้ตั้ง API key (WEB_RISK_API_KEY หรือ SAFE_BROWSING_API_KEY ใน .env)</div>`;
      const bad = (w.flagged || []).length;
      return `<div class="banner ${w.error ? "warn" : bad ? "err" : "ok"}" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1">${w.error ? `ตรวจคำเตือนของ Chrome ไม่สำเร็จ: ${esc(w.error)}` : bad ? `Google ติดธงเว็บนี้ว่าไม่ปลอดภัย (${bad} URL) ผู้ใช้ Chrome จะเห็นคำเตือน · แก้ที่ Google Search Console → Security issues → Request review` : w.at ? `Google ไม่ติดธงเว็บนี้ (ตรวจล่าสุด ${fdt(w.at)} ด้วย ${esc(w.api || "")})` : "ยังไม่เคยตรวจ"}</span><button class="btn" type="button" id="wr-check" style="min-height:34px">ตรวจตอนนี้</button></div>`;
    })()}
${newSites.length ? `<div class="banner warn">มีรายการที่ผู้ใช้เพิ่มใหม่ ${newSites.length} รายการ รอตรวจ (มีป้าย “ใหม่”) กด “แก้” เพื่อยืนยัน แก้ชื่อ หรือรวมกับรายการเดิม</div>` : ""}
<section class="card" id="ae"><div class="title"><h2>Email แจ้งเตือน Owner</h2><span>ผู้รับ email แจ้งเตือนแต่ละรอบ</span></div>
<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>รอบ</th><th>ส่งเมื่อ</th><th>ถึง</th><th style="text-align:center">CC รายชื่อด้านล่าง</th><th></th></tr></thead><tbody>
${[["r1", `วันที่ ${cfg.alert1Day} (ครั้งเดียว)`], ["r2", `วันที่ ${cfg.alert2Day} (ครั้งเดียว)`], ["overdue", `ทุกวันหลังเกิน Due (วันที่ ${cfg.slaDays + 1} ขึ้นไป)`]].map(([t, when]) => `<tr>
<td>${chip(t, ALERT[t])}</td><td>${when}</td><td>Owner ของเคส</td>
<td style="text-align:center"><label class="chk" style="justify-content:center"><input type="checkbox" name="cct" value="${t}" ${(s.alertEmail.ccTypes || []).includes(t) ? "checked" : ""}><span class="sr">CC ใน${ALERT[t]}</span></label></td>
<td style="text-align:right;white-space:nowrap"><button class="btn" type="button" data-prev="${t}" style="min-height:34px">ดูตัวอย่าง</button> <button class="btn" type="button" data-testmail="${t}" style="min-height:34px">ส่งทดสอบถึงฉัน</button></td></tr>`).join("")}
</tbody></table></div>
<div class="formgrid">
<label class="f">CC (คั่นด้วย , ถ้ามีหลายคน)<input id="ae-cc" value="${esc(s.alertEmail.cc || "")}" placeholder="engineer@sinostech.co.th"></label>
<label class="f">ส่งถึงใครเมื่อเคสไม่มีอีเมล Owner<input id="ae-fb" value="${esc(s.alertEmail.fallback || "")}" placeholder="engineer@sinostech.co.th"></label></div>
<p class="hint" style="margin:0">ติ๊กช่อง CC เฉพาะรอบที่ต้องการให้หัวหน้าหรือทีมเห็นด้วย ไม่ติ๊ก = ส่งถึง Owner คนเดียว Owner ไม่ถูก CC ซ้ำถ้าอีเมลอยู่ในรายชื่อ CC มีผลตั้งแต่รอบส่งถัดไป</p>
<div class="actions"><button class="btn primary" type="button" id="ae-save">บันทึกผู้รับ email</button></div></section>
<section class="card"><div class="title"><h2>นำเข้าเคสจาก Excel</h2><span>ใช้ช่วงเปลี่ยนจาก Excel มาเป็นหน้าเว็บ</span></div>
<p class="muted" style="margin:0;font-size:14px">อ่าน tab Case List ทั้ง 3 เอกสาร แล้วเพิ่มเคสที่ยังไม่มีในระบบ เคสที่มีอยู่แล้วจะไม่ถูกนำเข้าซ้ำ Owner ที่ยังไม่มีบัญชีจะถูกสร้างเป็น Engineer (บัญชี Microsoft) ให้อัตโนมัติ</p>
<div class="actions"><button class="btn" type="button" id="imp-new">นำเข้าเคสใหม่จาก Excel</button><button class="btn" type="button" id="imp-refresh">นำเข้า + อัปเดตเคสที่ยังไม่ถูกแก้บนเว็บ</button></div>
<div id="imp-out" class="hint"></div></section>
<div class="grid2">
<section class="card"><h2>รายการ dropdown</h2>
${[["site", "Site / ลูกค้า · Owner เพิ่มใหม่ได้จากฟอร์มเคส"], ["product", "Product"], ["status", "Status"]].map(([k, l]) => `<div class="stack" style="gap:8px"><div class="hint">${l} (${byKind(k).length})</div><div class="chips">${lkChips(k)}<button class="btn" type="button" data-add="${k}" style="min-height:32px;padding:0 10px">เพิ่ม</button></div></div>`).join("")}
</section>
<section class="card" id="sh-card"><div class="title"><h2>คำอธิบาย Status</h2><span>แสดงตอนเลือก Status ปิดเคส และหน้าค้นหา</span></div>
${byKind("status").filter((l) => l.active).map((l) => `<label class="f">${esc(l.value)}<textarea rows="2" data-sh="${esc(l.value)}" maxlength="300">${esc((s.statusHelp || {})[l.value] || "")}</textarea></label>`).join("")}
<div class="right"><button class="btn primary" type="button" id="sh-save">บันทึกคำอธิบาย</button></div></section>
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

    const shs = document.getElementById("sh-save");
    if (shs)
      shs.onclick = async () => {
        const statusHelp = {};
        document.querySelectorAll("[data-sh]").forEach((t) => (statusHelp[t.dataset.sh] = t.value));
        try {
          await post("/settings", { statusHelp }, "PUT");
          LOOKUPS = null;
          toast("บันทึกคำอธิบาย Status แล้ว");
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const wr = document.getElementById("wr-check");
    if (wr) wr.onclick = async () => {
      wr.disabled = true;
      try {
        const r = await post("/settings/web-risk/check");
        toast(r.ok ? (r.flagged.length ? `Google ยังติดธงอยู่ ${r.flagged.length} URL` : "Google ไม่ติดธงเว็บนี้") : r.skipped || "ตรวจไม่สำเร็จ: " + r.error, 6000);
        viewSettings();
      } catch (e) {
        toast(e.message, 6000);
        wr.disabled = false;
      }
    };
    document.getElementById("ae-save").onclick = async () => {
      const ccTypes = [...document.querySelectorAll("input[name=cct]:checked")].map((x) => x.value);
      try {
        await post("/settings", { alertEmail: { cc: document.getElementById("ae-cc").value, fallback: document.getElementById("ae-fb").value, ccTypes } }, "PUT");
        toast(ccTypes.length ? `บันทึกแล้ว · CC เฉพาะ${ccTypes.map((t) => ALERT[t]).join(", ")}` : "บันทึกแล้ว · ทุกรอบส่งถึง Owner คนเดียว", 5000);
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    $app.querySelectorAll("[data-prev]").forEach((b) => (b.onclick = async () => {
      try {
        const p = await api("/alert-email/preview?type=" + b.dataset.prev);
        const dlg = document.getElementById("dlg");
        dlg.classList.add("wide");
        dlg.innerHTML = `<form class="card" method="dialog"><h2>ตัวอย่าง email ${ALERT[p.type]}</h2>
<div class="stat2" style="grid-template-columns:1fr"><div><div class="k">หัวเรื่อง</div><div style="font-weight:600">${esc(p.subject)}</div></div>
<div><div class="k">ถึง</div><div>${esc(p.to.join(", ") || "-")}</div></div><div><div class="k">CC</div><div>${esc(p.cc.join(", ") || "ไม่มี")}</div></div></div>
<p class="hint" style="margin:0">${p.sample ? "ใช้ข้อมูลตัวอย่าง เพราะตอนนี้ไม่มีเคสที่อยู่ในรอบนี้" : `ใช้ข้อมูลจริงของเคส ${esc(p.case || "")}`} · ผู้รับแสดงตามค่าที่บันทึกไว้แล้ว</p>
<iframe title="ตัวอย่าง email" sandbox="" style="width:100%;height:56vh;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>
<div class="right"><button class="btn primary" value="ok">ปิด</button></div></form>`;
        dlg.querySelector("iframe").srcdoc = p.html;
        dlg.onclose = () => dlg.classList.remove("wide");
        dlg.showModal();
      } catch (e) {
        toast(e.message, 6000);
      }
    }));
    $app.querySelectorAll("[data-testmail]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await post("/alert-email/test", { type: b.dataset.testmail });
        toast(r.dryRun ? "โหมดทดสอบ: ยังไม่ได้ส่ง email จริง" : `ส่งตัวอย่างถึง ${r.to} แล้ว`, 5000);
      } catch (e) {
        toast("ส่งไม่สำเร็จ: " + e.message, 6000);
      }
      b.disabled = false;
    }));
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


  // ------------------------------------------------------------ case extensions (ขอขยายเวลา)
  const EXT_ST = { pending: ["r1", "รออนุมัติ"], approved: ["ok", "อนุมัติ"], rejected: ["fail", "ไม่อนุมัติ"], cancelled: ["closed", "ยกเลิก"] };
  function canRequestExt(c) {
    return c.stage !== "closed" && !c.pendingExtId && (c.ownerUserId === ME.user.id || lvl("case_edit") === "all");
  }
  function extCard(c, list, closed) {
    const pending = list.find((e) => e.status === "pending");
    const hist = list.filter((e) => e.status !== "pending").slice().reverse();
    return `<section class="card" id="ext-card"><div class="title"><h2>ขยายเวลา</h2><span>${c.extCount ? `ขยายแล้ว ${c.extCount} ครั้ง` : "ยังไม่เคยขยาย"}</span></div>
${pending ? `<div class="banner warn" style="display:flex;flex-direction:column;gap:8px">
<div><strong>รออนุมัติคำขอขยายครั้งที่ ${pending.seq}</strong> · ส่งให้ ${esc(pending.approver_name || "-")} · ${fdt(pending.requested_at)}</div>
<div>Due ${fd(pending.old_due)} → <strong>${fd(pending.new_due)}</strong> · เหตุผล: ${esc(pending.reason)}</div>
${pending.approver_id === ME.user.id || ME.user.role === "admin" ? `<label class="f">ความเห็น (บังคับเมื่อไม่อนุมัติ)<input id="ext-note" placeholder="เช่น อนุมัติ ติดตาม Vendor ทุกวัน"></label>
<div class="actions" style="justify-content:flex-start"><button class="btn primary" type="button" data-extdec="1" data-id="${pending.id}">อนุมัติ ขยาย ${pending.days} วัน</button><button class="btn" type="button" data-extdec="0" data-id="${pending.id}">ไม่อนุมัติ</button></div>` : ""}
${pending.requested_by === ME.user.id ? `<div><button class="btn" type="button" id="ext-cancel" data-id="${pending.id}" style="min-height:34px">ยกเลิกคำขอ</button></div>` : ""}</div>` : ""}
${!closed && canRequestExt(c) ? `<button class="btn primary" type="button" id="ext-req">ขอขยายเวลา ${cfg.slaDays} วัน</button>` : ""}
${hist.length ? `<ul class="ext-hist">${hist.map((e) => `<li>${chip(EXT_ST[e.status][0], EXT_ST[e.status][1])} <strong>คำขอครั้งที่ ${e.seq}</strong> · ${fdt(e.requested_at)} · โดย ${esc(e.requested_by_name || "-")}
<div>${e.status === "approved" ? `Due ${fd(e.old_due)} → <strong>${fd(e.new_due)}</strong> · ` : ""}เหตุผล: ${esc(e.reason)}</div>
${e.approver_name && e.status !== "cancelled" ? `<div class="muted">${esc(e.approver_name)}${e.decision_note ? ` · “${esc(e.decision_note)}”` : ""}</div>` : ""}</li>`).join("")}</ul>` : ""}
${!pending && !hist.length && closed ? `<div class="hint">เคสปิดแล้ว</div>` : ""}</section>`;
  }
  function bindExtCard(c, list) {
    const card = document.getElementById("ext-card");
    if (!card) return;
    const reload = () => viewCase(c.id);
    const req = document.getElementById("ext-req");
    if (req) req.onclick = () => openExtRequest(c, list, reload);
    const cn = document.getElementById("ext-cancel");
    if (cn) cn.onclick = async () => {
      try {
        await post(`/extensions/${cn.dataset.id}/cancel`);
        toast("ยกเลิกคำขอแล้ว");
        reload();
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    card.querySelectorAll("[data-extdec]").forEach((b) => (b.onclick = () => decideExt(b, document.getElementById("ext-note"), reload)));
  }
  async function decideExt(b, noteEl, after) {
    b.disabled = true;
    try {
      const r = await post(`/extensions/${b.dataset.id}/decide`, { approve: b.dataset.extdec === "1", note: noteEl ? noteEl.value : "" });
      toast(r.status === "approved" ? `อนุมัติแล้ว Due ใหม่ ${fd(r.newDue, true)} ระบบแจ้ง Owner ทาง email` : "ไม่อนุมัติ ระบบแจ้ง Owner ทาง email แล้ว", 6000);
      after && after();
    } catch (e) {
      b.disabled = false;
      toast(e.message, 6000);
    }
  }
  async function openExtRequest(c, list, after) {
    const { approvers } = await api("/extensions/approvers");
    const dlg = document.getElementById("dlg");
    const newDue = (() => {
      const t = new Date(c.dueDate + "T00:00:00");
      t.setDate(t.getDate() + cfg.slaDays);
      return isoDay(t);
    })();
    const lastApprover = (list.filter((e) => e.status === "approved").pop() || {}).approver_id;
    dlg.innerHTML = `<form class="card" method="dialog" id="xf"><h2>ขอขยายเวลา ${esc(caseRef(c))}</h2>
<div class="stat2" style="grid-template-columns:repeat(3,1fr)"><div><div class="k">Due ปัจจุบัน</div><div class="v" style="font-size:20px">${fd(c.dueDate)}</div></div>
<div><div class="k">Due ใหม่ถ้าอนุมัติ</div><div class="v" style="font-size:20px;color:var(--accent)">${fd(newDue)}</div></div>
<div><div class="k">ขยายไปแล้ว</div><div class="v" style="font-size:20px">${c.extCount || 0} ครั้ง</div></div></div>
<label class="f">ส่งให้ Manager อนุมัติ<select name="ap" required><option value="">เลือก Manager</option>${approvers.filter((u) => u.id !== ME.user.id).map((u) => `<option value="${u.id}" ${u.id === lastApprover ? "selected" : ""}>${esc(u.display_name)} · ${ROLE[u.role]}</option>`).join("")}</select></label>
<label class="f">เหตุผลที่ต้องขยาย<textarea name="reason" rows="3" required minlength="5" placeholder="เช่น รอ Vendor ส่ง patch คาดว่าได้รับภายใน 10 พ.ย. เปิดเคส Vendor ไว้แล้ว #00912345"></textarea></label>
<p class="hint" style="margin:0">ถ้าอนุมัติ ระบบนับช่วงใหม่ ${cfg.slaDays} วันต่อจาก Due เดิม และแจ้งเตือนวันที่ ${cfg.alert1Day}, ${cfg.alert2Day} และเมื่อเกิน Due เหมือนเคสปกติ</p>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">ส่งคำขอ</button></div></form>`;
    const f = dlg.querySelector("#xf");
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      if (!f.ap.value) return toast("เลือก Manager ที่จะอนุมัติ");
      if (f.reason.value.trim().length < 5) return toast("ใส่เหตุผลที่ต้องขยาย");
      try {
        await post(`/case/${c.id}/extensions`, { approverId: Number(f.ap.value), reason: f.reason.value });
        dlg.close();
        toast("ส่งคำขอแล้ว ระบบแจ้ง Manager ทาง email", 5000);
        after && after();
      } catch (err) {
        toast(err.message, 6000);
      }
    };
    dlg.showModal();
  }
  /** Box on the overview / my cases: extension requests waiting for me, and mine waiting for a manager. */
  async function extPendingSection() {
    let d;
    try {
      d = await api("/extensions/pending");
    } catch (e) {
      return "";
    }
    const row = (e, forMe) => `<div class="ext-item"><div><a class="mono" href="#/case/${e.case_id}">${esc(e.case_no)}</a> · <strong>${esc(e.site || "-")}</strong> · ${esc(e.task || "")} <span class="chip c-r1">คำขอครั้งที่ ${e.seq}</span>${e.ext_done ? "" : ""}</div>
<div class="muted" style="font-size:13px">${forMe ? `ขอโดย ${esc(e.requested_by_name || "-")}` : `ส่งให้ ${esc(e.approver_name || "-")}`} · ${fdt(e.requested_at)} · Due ${fd(e.old_due)} → <strong>${fd(e.new_due)}</strong></div>
<div class="ext-reason">${esc(e.reason)}</div>
${forMe ? `<div class="formgrid" style="align-items:end"><label class="f">ความเห็น (บังคับเมื่อไม่อนุมัติ)<input data-note="${e.id}"></label><div class="actions" style="justify-content:flex-start"><button class="btn primary" type="button" data-extdec="1" data-id="${e.id}">อนุมัติ ขยาย ${e.days} วัน</button><button class="btn" type="button" data-extdec="0" data-id="${e.id}">ไม่อนุมัติ</button></div></div>` : ""}</div>`;
    return `${d.forMe.length ? `<section class="card ext-wrap"><div class="title"><h2>คำขอขยายเวลา รออนุมัติจากคุณ (${d.forMe.length})</h2></div>${d.forMe.map((e) => row(e, true)).join("")}</section>` : ""}
${d.mine.length ? `<section class="card"><div class="title"><h2>คำขอขยายเวลาของคุณ รออนุมัติ (${d.mine.length})</h2></div>${d.mine.map((e) => row(e, false)).join("")}</section>` : ""}`;
  }
  function bindExtPending(root) {
    root.querySelectorAll(".ext-wrap [data-extdec]").forEach((b) => (b.onclick = () => decideExt(b, root.querySelector(`[data-note="${b.dataset.id}"]`), () => route())));
  }
  /** Extra table row under a case that has been extended. cols: cells before / after the age cell. */
  function extRow(c, { before, after }) {
    if (!c.extCount) return "";
    const e = c.lastExt || {};
    const notYet = c.periodStart && c.periodStart > daysAgo(0) && c.stage !== "closed";
    return `<tr class="ext-row click" data-href="#/case/${c.id}"><td>↳ <span class="mono">${esc(caseRef(c))}</span> <span class="chip c-normal">ขยายครั้งที่ ${c.extCount}</span><div class="muted" style="font-size:12px">อนุมัติโดย ${esc(e.approver || "-")}</div></td>
<td colspan="${before}" style="font-size:13px">${fd(c.periodStart)} – <strong>${fd(c.dueDate)}</strong> · เหตุผล: ${esc(e.reason || "-")}</td>
<td>${c.stage === "closed" ? (c.closedInExtension ? "ปิดทันเวลาที่ขยาย" : "ปิดเกิน Due") : notYet ? `<small>เริ่มช่วงขยาย ${fd(c.periodStart)}</small>` : ageCell(c)}</td>
${after ? `<td colspan="${after}">${c.stage === "closed" ? "" : chip(c.stage)}</td>` : ""}</tr>`;
  }
  /** Table of extension requests (owner page, reports): one row per request with reason and decision. */
  function extTable(list, title) {
    if (!list.length) return "";
    const live = list.filter((e) => e.status !== "cancelled");
    const nCases = new Set(live.map((e) => e.case_id)).size;
    const n = (st) => live.filter((e) => e.status === st).length;
    return `<section class="card"><div class="title"><h2>${title}</h2><span>${nCases} เคส · ${live.length} ครั้ง (อนุมัติ ${n("approved")} · ไม่อนุมัติ ${n("rejected")}${n("pending") ? ` · รออนุมัติ ${n("pending")}` : ""})</span></div>
<div class="tablewrap"><table style="min-width:1000px"><thead><tr><th>เลขเคส</th><th>ลูกค้า</th><th>คำขอครั้งที่</th><th>ขอเมื่อ</th><th>เหตุผลที่ขอ</th><th>Due เดิม → ใหม่</th><th>ผล / ผู้พิจารณา</th></tr></thead><tbody>
${live.map((e) => `<tr><td><a class="mono" href="#/case/${e.case_id}">${esc(e.case_no)}</a><div class="muted" style="font-size:12px">${esc(e.cs_number || "ยังไม่มี CS")}</div></td><td style="font-weight:600">${esc(e.site || "-")}</td><td>${e.seq}</td><td>${fdt(e.requested_at)}</td>
<td style="max-width:360px">${esc(e.reason)}</td><td>${fd(e.old_due)} → ${e.status === "rejected" ? "-" : `<strong>${fd(e.new_due)}</strong>`}</td>
<td>${chip(EXT_ST[e.status][0], EXT_ST[e.status][1])}<div class="muted" style="font-size:12px">${esc(e.approver_name || "-")}${e.decision_note ? ` · “${esc(e.decision_note)}”` : ""}</div></td></tr>`).join("")}</tbody></table></div></section>`;
  }
  const extTag = (c) => (c.pendingExtId ? ` <span class="chip c-r1">รออนุมัติขยาย</span>` : c.extCount ? ` <span class="chip c-normal">ขยาย ${c.extCount} ครั้ง</span>` : "");

  // ------------------------------------------------------------ customer intake (requests from LINE OA / links)
  const IK_STATUS = { pending: "รอรับเคส", claiming: "กำลังรับ", claimed: "รับแล้ว", rejected: "ปฏิเสธ", duplicate: "ซ้ำ" };
  function waitedText(ts) {
    const m = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000));
    if (m < 60) return `${m} นาที`;
    if (m < 1440) return `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
    return `${Math.floor(m / 1440)} วัน ${Math.floor((m % 1440) / 60)} ชม.`;
  }
  const ikCustomer = (i) => (i.site ? esc(i.site) : `${esc(i.customer_text || "ไม่ระบุ")} <span class="chip c-r1">${i.channel === "email" ? "โดเมนยังไม่ผูกลูกค้า" : "ลูกค้าใหม่ รอยืนยัน"}</span>`);
  const ikContact = (i) => (i.channel === "email" ? `${esc(i.contact_email || "")}${i.contact_phone ? " · " + esc(i.contact_phone) : ""}` : esc(i.contact_phone || "-"));
  const IK_CHANNEL = { email: "Email", line: "LINE OA", link: "ลิงก์ฟอร์ม" };
  function ikTags(i) {
    const t = [];
    if (i.is_test) t.push(`<span class="chip c-closed">ทดสอบ</span>`);
    if (i.channel === "email") t.push(`<span class="chip c-normal">Email</span>`);
    if (i.after_hours) t.push(`<span class="chip c-closed" title="แจ้งเข้ามานอกเวลาทำการ ลูกค้าได้เบอร์ Hotline ใน email ตอบรับ">นอกเวลา</span>`);
    if (i.held) t.push(`<span class="chip c-overdue" title="${esc(i.hold_reason || "")}">พักไว้ให้ Admin / Manager ตรวจ</span>${i.hold_reason ? `<div class="hint" style="margin-top:4px">${esc(i.hold_reason)}</div>` : ""}`);
    if (i.new_line) t.push(`<span class="chip c-r1" title="เคสแรกจากบัญชี LINE นี้ โทรยืนยันกับลูกค้าตอนรับเคส">LINE ใหม่</span>`);
    return t.join(" ");
  }
  function ikOwnerNote(i) {
    const late = Date.now() - new Date(i.created_at).getTime() > 3600000;
    const tail = late ? `<br><strong>ยังไม่มีคนรับเกิน 1 ชม.</strong> ใครในทีมรับได้` : "";
    if (i.recent_owner_id && i.recent_owner_id === ME.user.id) return `<div class="ik-note mine">คุณดูแลเคสล่าสุดของลูกค้ารายนี้ (${fd(i.recent_owner_date, true)})${tail}</div>`;
    if (i.recent_owner_name) return `<div class="ik-note ${late ? "late" : ""}">ดูแลเคสล่าสุดของลูกค้ารายนี้: ${esc(i.recent_owner_name)} (${fd(i.recent_owner_date, true)})${tail}</div>`;
    return `<div class="ik-note ${late ? "late" : ""}">ยังไม่เคยมีเคสของลูกค้ารายนี้ · ใครในทีมรับได้${late ? " · ยังไม่มีคนรับเกิน 1 ชม." : ""}</div>`;
  }
  function ikCard(i) {
    const canClaim = can("case_create") && i.status === "pending" && !i.held;
    const mineSite = i.recent_owner_id === ME.user.id;
    return `<article class="ik-card ${mineSite ? "mine" : ""}">
<div class="ik-top"><a class="mono" href="#/intake/${i.id}">${esc(i.req_no)}</a>${sevChip(i.severity)}</div>
<div><div class="ik-cust">${ikCustomer(i)}</div><div class="ik-subj">${esc(i.subject)}</div></div>
<div class="muted ik-meta">${esc(i.contact_name)} · ${ikContact(i)}<br>แจ้งเมื่อ ${fdt(i.created_at)} · <span class="${Date.now() - new Date(i.created_at).getTime() > 3600000 ? "t-over" : ""}">รอมาแล้ว ${waitedText(i.created_at)}</span>${i.files ? ` · ไฟล์แนบ ${i.files}` : ""}</div>
${ikTags(i) ? `<div>${ikTags(i)}</div>` : ""}
${ikOwnerNote(i)}
<div class="ik-actions">${canClaim ? `<button class="btn primary" type="button" data-claim="${i.id}">รับเคสเอง</button><button class="btn" type="button" data-transfer="${i.id}">โอนให้ Owner</button>` : ""}<a class="btn" href="#/intake/${i.id}">ดูรายละเอียด</a></div>
</article>`;
  }
  /** Section shown at the top of the overview and "my cases" while requests wait to be claimed. */
  async function intakeSection() {
    let d;
    try {
      d = await api("/intake?status=pending");
    } catch (e) {
      return "";
    }
    setIntakeBadge(d.counts.pending);
    if (!d.items.length) return "";
    const items = d.items.slice().sort((a, b) => (b.recent_owner_id === ME.user.id) - (a.recent_owner_id === ME.user.id));
    INTAKE_CACHE = Object.fromEntries(d.items.map((i) => [i.id, i]));
    return `<section class="card ik-wrap"><div class="title"><h2>เคสใหม่จากลูกค้า รอรับเคส (${d.items.length})</h2><span>ทุกคนในทีมเห็นและรับเคสได้ · SLA ${cfg.slaDays} วันเริ่มนับเมื่อรับเคส · <a href="#/intake">ดูทั้งหมด</a></span></div>
<div class="ik-grid">${items.slice(0, 6).map(ikCard).join("")}</div>${items.length > 6 ? `<div class="hint"><a href="#/intake">ดูอีก ${items.length - 6} เคส</a></div>` : ""}</section>`;
  }
  let INTAKE_CACHE = {};
  function bindIntakeActions(root, after) {
    root.querySelectorAll("[data-claim]").forEach((b) => (b.onclick = () => openClaimDialog(INTAKE_CACHE[b.dataset.claim], "self", after)));
    root.querySelectorAll("[data-transfer]").forEach((b) => (b.onclick = () => openClaimDialog(INTAKE_CACHE[b.dataset.transfer], "transfer", after)));
  }
  function setIntakeBadge(n) {
    const a = document.querySelector('#tabs a[data-nav="intake"]');
    if (!a) return;
    let s = a.querySelector(".badge");
    if (!s) {
      s = document.createElement("span");
      s.className = "badge";
      a.appendChild(s);
    }
    s.textContent = n || "";
    s.hidden = !n;
  }
  async function refreshIntakeBadge() {
    try {
      setIntakeBadge((await api("/intake/count")).pending);
    } catch (e) {}
  }

  let USERS_CACHE = null;
  async function userOptions() {
    if (!USERS_CACHE) USERS_CACHE = (await api("/users/options")).users;
    return USERS_CACHE;
  }

  async function openClaimDialog(i, mode, after) {
    if (!i) return;
    const [users, lk] = await Promise.all([userOptions(), lookups()]);
    const dlg = document.getElementById("dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dlg" }));
    const meTeam = (ME.user.teams || [])[0] || "";
    const others = users.filter((u) => u.id !== ME.user.id);
    const defTeam = i.site_team || meTeam || (ME.teams[0] || {}).key;
    dlg.innerHTML = `<form class="card" method="dialog" id="cf">
<div class="title"><h2>รับเคส ${esc(i.req_no)}</h2>${sevChip(i.severity)}</div>
<div class="banner" style="line-height:1.6"><strong>${ikCustomer(i)}</strong> · ${esc(i.subject)}<br>${esc(i.contact_name)} · ${esc(i.contact_phone)} · แจ้งเมื่อ ${fdt(i.created_at)}</div>
${i.new_line ? `<div class="banner warn">เคสแรกจากบัญชี LINE นี้ กรุณาโทรยืนยันกับลูกค้าว่าเป็นผู้ติดต่อของบริษัทจริง</div>` : ""}
<fieldset class="stack" style="border:0;margin:0;padding:0;gap:8px"><legend style="font-weight:700;margin-bottom:6px">ใครเป็น Owner ของเคสนี้</legend>
<label class="chk ik-opt"><input type="radio" name="who" value="self" ${mode !== "transfer" ? "checked" : ""}> <span><strong>รับเคสเอง</strong><br><span class="muted">${esc(ME.user.display_name)} (คุณ) เป็น Owner</span></span></label>
<label class="chk ik-opt"><input type="radio" name="who" value="transfer" ${mode === "transfer" ? "checked" : ""}> <span style="flex:1"><strong>โอนให้ Owner คนอื่น</strong><br><span class="muted">ระบบแจ้งเขาทาง email ทันที</span>
${others.length ? `<select name="owner" aria-label="เลือก Owner" style="margin-top:6px">${others.map((u) => `<option value="${u.id}" ${u.id === i.recent_owner_id ? "selected" : ""}>${esc(u.display_name)}${u.teams && u.teams.length ? " · " + esc(u.teams.map(teamLabel).join(", ")) : ""}</option>`).join("")}</select>` : `<span class="hint">ยังไม่มีผู้ใช้อื่นในระบบ</span><input type="hidden" name="owner" value="">`}</span></label>
</fieldset>
<div class="formgrid">
${i.site ? "" : `<label class="f">ลูกค้า (Site)<select name="site" required><option value="">เลือกลูกค้า</option>${lk.site.map((s) => `<option>${esc(s)}</option>`).join("")}</select><span class="hint">ลูกค้าพิมพ์ว่า “${esc(i.customer_text || "-")}”</span></label>`}
<label class="f">ทีม<select name="team">${ME.teams.map((t) => `<option value="${esc(t.key)}" ${t.key === defTeam ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
<label class="f">CS Number (ถ้ามี)<input name="cs" placeholder="เช่น CS5056901"></label>
<label class="f">Severity<select name="sev">${lk.severity.map((s) => `<option ${s === i.severity ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label></div>
<label class="f">ข้อความถึง Owner / บันทึกแรก (ไม่บังคับ)<textarea name="note" rows="2" placeholder="เช่น ลูกค้าเคยเจออาการเดียวกันเมื่อเดือนก่อน ดูเคส CS5056401 ประกอบ"></textarea></label>
<p class="hint" style="margin:0">เมื่อยืนยัน คำขอนี้กลายเป็นเคสปกติ เริ่มนับ SLA ${cfg.slaDays} วันวันนี้ และระบบแจ้งลูกค้าทาง LINE ว่าใครรับเคส</p>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">ยืนยันรับเคส</button></div></form>`;
    const f = dlg.querySelector("#cf");
    const sync = () => {
      f.owner.disabled = f.who.value !== "transfer";
      f.querySelector("button[value=ok]").textContent = f.who.value === "transfer" ? "ยืนยันโอนเคส" : "ยืนยันรับเคส";
    };
    f.querySelectorAll("input[name=who]").forEach((r) => (r.onchange = sync));
    sync();
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      const btn = f.querySelector("button[value=ok]");
      if (f.who.value === "transfer" && !f.owner.value) return toast("เลือก Owner ที่จะโอนให้");
      btn.disabled = true;
      try {
        const r = await post(`/intake/${i.id}/claim`, {
          ownerId: f.who.value === "transfer" ? Number(f.owner.value) : ME.user.id,
          site: f.site ? f.site.value : undefined, team: f.team.value, csNumber: f.cs.value, severity: f.sev.value, note: f.note.value,
        });
        dlg.close();
        toast(`${r.reqNo} เป็นเคส ${r.caseNo} ของ ${r.owner} แล้ว เริ่มนับ SLA วันนี้`, 5000);
        if (after) after(r);
        else location.hash = `#/case/${r.caseId}`;
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 6000);
        if (/มีคนรับ/.test(err.message)) {
          dlg.close();
          route();
        }
      }
    };
    dlg.showModal();
  }

  function openRejectDialog(i) {
    const dlg = document.getElementById("dlg");
    dlg.innerHTML = `<form class="card" method="dialog" id="rf"><h2>ปิดคำขอ ${esc(i.req_no)} โดยไม่เปิดเคส</h2>
<label class="chk"><input type="radio" name="kind" value="dup" checked> ซ้ำกับเคสหรือคำขอที่มีอยู่แล้ว</label>
<label class="f">ซ้ำกับ (เลข REQ หรือ CS)<input name="dup" placeholder="เช่น REQ-2026-0011 หรือ CS5056901"></label>
<label class="chk"><input type="radio" name="kind" value="reject"> ไม่ใช่เคส / ข้อมูลไม่ถูกต้อง / สแปม</label>
<label class="f">เหตุผล<textarea name="reason" rows="2" placeholder="เช่น ลูกค้าแจ้งผิดระบบ ไม่ใช่สินค้าที่เราดูแล"></textarea></label>
<label class="chk"><input type="checkbox" name="tell"> ${i.channel === "email" ? "ตอบ email แจ้งลูกค้าด้วย (ในเรื่องเดิม)" : "แจ้งลูกค้าทาง LINE ด้วย"}</label>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">ปิดคำขอ</button></div></form>`;
    const f = dlg.querySelector("#rf");
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      try {
        await post(`/intake/${i.id}/reject`, f.kind.value === "dup" ? { duplicateOf: f.dup.value, reason: f.reason.value, notifyCustomer: f.tell.checked } : { reason: f.reason.value, notifyCustomer: f.tell.checked });
        dlg.close();
        toast("ปิดคำขอแล้ว");
        route();
      } catch (err) {
        toast(err.message, 6000);
      }
    };
    dlg.showModal();
  }

  function openManualLinkDialog() {
    const dlg = document.getElementById("dlg");
    lookups().then((lk) => {
      dlg.innerHTML = `<form class="card" method="dialog" id="ml"><h2>สร้างลิงก์แจ้งเคสส่งให้ลูกค้าเอง</h2>
<p class="muted" style="margin:0;font-size:14px">ใช้กับลูกค้าที่ไม่ได้ใช้ LINE หรือทดลองก่อน LINE OA พร้อม ลิงก์ใช้ได้ครั้งเดียว ระบบส่งอีเมลให้ลูกค้า (CC ถึงคุณ) หรือคัดลอกไปส่งทางแชทเองก็ได้</p>
<div class="formgrid"><label class="f">ลูกค้า (Site)<select name="customer" required><option value="">เลือกลูกค้า</option>${lk.site.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
<label class="f">ชื่อผู้ติดต่อ (ไม่บังคับ)<input name="name"></label><label class="f">เบอร์โทร (ไม่บังคับ)<input name="phone"></label><label class="f">อีเมลลูกค้า<input name="email" type="email" placeholder="เช่น somying@company.co.th"></label></div>
<label class="chk"><input type="checkbox" name="send" checked> ส่งลิงก์ทางอีเมลถึงลูกค้า (CC ถึงคุณ)</label>
<label class="f">ข้อความเพิ่มเติมในอีเมล (ไม่บังคับ)<textarea name="msg" rows="2" placeholder="เช่น ตามที่คุยทางโทรศัพท์ รบกวนแนบภาพหน้าจอ error มาด้วยครับ"></textarea></label>
<label class="chk"><input type="checkbox" name="test"> ลิงก์ทดสอบ (แจ้งเตือนเฉพาะผู้รับทดสอบ ไม่ถึงทั้งทีม)</label>
<div id="ml-out"></div>
<div class="right"><button class="btn" value="cancel" formnovalidate>ปิด</button><button class="btn primary" value="ok">สร้างลิงก์</button></div></form>`;
      const f = dlg.querySelector("#ml");
      f.onsubmit = async (e) => {
        if (e.submitter && e.submitter.value === "cancel") return;
        e.preventDefault();
        try {
          if (f.send.checked && !f.email.value.trim()) return toast("ใส่อีเมลลูกค้า หรือเอาติ๊ก “ส่งลิงก์ทางอีเมล” ออกเพื่อคัดลอกไปส่งเอง", 6000);
          const r = await post("/intake/manual-link", { customer: f.customer.value, contactName: f.name.value, contactPhone: f.phone.value, contactEmail: f.email.value.trim(), test: f.test.checked, sendEmail: f.send.checked, message: f.msg.value });
          if (r.emailed) toast(r.emailed.dryRun ? "โหมดทดสอบ: ยังไม่ได้ส่งอีเมลจริง" : `ส่งลิงก์ถึง ${r.emailed.to} แล้ว${r.emailed.cc ? " (CC ถึงคุณ)" : ""}`, 6000);
          document.getElementById("ml-out").innerHTML = `${r.emailed ? `<div class="banner ok">ส่งอีเมลถึง ${esc(r.emailed.to)} แล้ว</div>` : ""}<div class="banner ok" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="mono" style="word-break:break-all;flex:1">${esc(r.url)}</span><button class="btn" type="button" id="ml-copy">คัดลอก</button></div><p class="hint">หมดอายุ ${fdt(r.expiresAt)}</p>`;
          document.getElementById("ml-copy").onclick = () => navigator.clipboard.writeText(r.url).then(() => toast("คัดลอกลิงก์แล้ว"));
        } catch (err) {
          toast(err.message, 6000);
        }
      };
      dlg.showModal();
    });
  }

  async function viewIntake(params) {
    setNav("intake");
    const status = params.status || "pending";
    const [d, hl] = await Promise.all([api("/intake?status=" + status), api("/hotline").catch(() => null)]);
    setIntakeBadge(d.counts.pending);
    INTAKE_CACHE = Object.fromEntries(d.items.map((i) => [i.id, i]));
    const tab = (k, l, n) => `<a class="btn ${status === k ? "primary" : ""}" href="#/intake?status=${k}">${l} (${n})</a>`;
    const rows = d.items.map((i) => `<tr class="click" data-href="#/intake/${i.id}"><td><a class="mono" href="#/intake/${i.id}">${esc(i.req_no)}</a></td><td>${sevChip(i.severity)}</td>
<td><strong>${ikCustomer(i)}</strong><div class="muted" style="font-size:13px">${esc(i.subject)}</div>${ikTags(i) ? `<div style="margin-top:4px">${ikTags(i)}</div>` : ""}</td>
<td>${esc(i.contact_name)}<div class="muted" style="font-size:13px">${ikContact(i)}</div></td>
${status === "pending" || status === "held" ? `<td class="${Date.now() - new Date(i.created_at).getTime() > 3600000 ? "t-over" : ""}">${waitedText(i.created_at)}</td><td>${esc(i.recent_owner_name || "-")}</td>`
      : status === "claimed" ? `<td>${fdt(i.claimed_at)}</td><td>${esc(i.owner_name || "-")}${i.case_id ? `<div><a href="#/case/${i.case_id}">${esc(i.case_no || i.cs_number || "เคส #" + i.case_id)}</a></div>` : ""}</td>`
      : `<td>${fdt(i.claimed_at)}</td><td>${esc(i.duplicate_of ? "ซ้ำกับ " + i.duplicate_of : i.closed_reason || "-")}</td>`}</tr>`).join("");
    const heads = status === "pending" || status === "held" ? "<th>รอมาแล้ว</th><th>ดูแลเคสล่าสุด</th>" : status === "claimed" ? "<th>รับเมื่อ</th><th>Owner / เคส</th>" : "<th>ปิดเมื่อ</th><th>เหตุผล</th>";
    $app.innerHTML = `<div class="head"><div><h1>เคสจากลูกค้า</h1><p>ลูกค้าแจ้งผ่าน LINE OA, Email หรือลิงก์ ทุกคนในทีมรับได้ · SLA ${cfg.slaDays} วันเริ่มนับเมื่อรับเคส · ยังไม่มีคนรับเกิน 1 ชม. ระบบเตือนทีมทุกชั่วโมง 06:00–22:00</p></div>
<div class="actions">${can("case_create") ? `<button class="btn" type="button" id="ml-btn">สร้างลิงก์ส่งให้ลูกค้าเอง</button>` : ""}${lvl("settings_manage") === "all" ? `<a class="btn" href="#/intake-admin">ตั้งค่า LINE OA, Email และ API</a>` : ""}</div></div>
${hl ? hotlineCard(hl) : ""}
<div class="chips" style="gap:8px">${tab("pending", "รอรับเคส", d.counts.pending)}${d.counts.held ? tab("held", "พักไว้ตรวจ", d.counts.held) : ""}${tab("claimed", "รับแล้ว 30 วัน", d.counts.claimed)}${tab("closed", "ปฏิเสธ / ซ้ำ 90 วัน", d.counts.closed)}</div>
${status === "pending" && d.items.length ? `<div class="ik-grid">${d.items.map(ikCard).join("")}</div>` : `<section class="card">${d.items.length ? `<div class="tablewrap"><table style="min-width:820px"><thead><tr><th>เลขรับแจ้ง</th><th>Severity</th><th>ลูกค้า / หัวข้อ</th><th>ผู้ติดต่อ</th>${heads}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${status === "pending" ? "ไม่มีเคสรอรับ" : "ไม่มีรายการ"}</div>`}</section>`}
<dialog id="dlg"></dialog>`;
    bindRowLinks();
    bindIntakeActions($app);
    const mb = document.getElementById("ml-btn");
    if (mb) mb.onclick = openManualLinkDialog;
    bindHotline(() => viewIntake(params));
  }

  /** After-hours hotline: everyone sees the numbers; people with "แก้เบอร์ Hotline" edit them here. */
  function hotlineCard({ hotline: h, hours }) {
    const set = h.lines.filter((l) => l.phone);
    const edit = can("hotline_edit");
    return `<section class="card hl-card"><div class="title"><h2>Hotline นอกเวลาทำการ</h2><span>ใส่ใน email ตอบลูกค้าที่แจ้งเคส ${esc(hours.end)}–${esc(hours.start)} · โทรตามลำดับ รอสาย ${h.waitMinutes} นาทีก่อนโทรเบอร์ถัดไป</span></div>
<div class="hl-view">${set.length ? set.map((l, n) => `<span><b>${n + 1})</b> <span class="mono">${esc(l.phone)}</span> <span class="muted">${esc(l.label)}</span></span>`).join("") : `<span class="muted">ยังไม่ตั้งเบอร์ · email นอกเวลาจะบอกลูกค้าเพียงว่า Engineer จะติดต่อกลับในวันถัดไป</span>`}
${h.note ? `<span class="muted">· ${esc(h.note)}</span>` : ""}${edit ? `<button class="btn" type="button" id="hl-edit" style="min-height:34px;margin-left:auto">แก้เบอร์</button>` : ""}</div>
${h.updatedBy ? `<div class="hint">แก้ล่าสุด: ${esc(h.updatedBy)} · ${fdt(h.updatedAt)}</div>` : ""}
${edit ? `<form id="hl-form" class="stack" hidden>
<div class="hl-grid"><b>ลำดับ</b><b>เบอร์</b><b>ชื่อที่ลูกค้าเห็น (ภาษาอังกฤษ)</b>
${h.lines.map((l, n) => `<span>${n + 1}</span><input name="p${n}" value="${esc(l.phone)}" placeholder="เช่น 08-1234-5678" inputmode="tel"><input name="l${n}" value="${esc(l.label)}">`).join("")}</div>
<div class="formgrid"><label class="f">รอสายก่อนโทรเบอร์ถัดไป (นาที)<input name="wait" type="number" min="1" max="120" value="${h.waitMinutes}"></label>
<label class="f">หมายเหตุสำหรับทีม (ไม่ส่งถึงลูกค้า)<input name="note" value="${esc(h.note || "")}" placeholder="เช่น สัปดาห์นี้: ภาณุวัฒน์"></label></div>
<p class="hint" style="margin:0">เว้นเบอร์ว่าง = ไม่แสดงลำดับนั้น · ทุกการแก้บันทึกในประวัติการใช้งาน (ใคร เมื่อไร เบอร์เดิม → เบอร์ใหม่)</p>
<div class="right"><button class="btn" type="button" id="hl-cancel">ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div></form>` : ""}</section>`;
  }
  function bindHotline(after) {
    const b = document.getElementById("hl-edit");
    const f = document.getElementById("hl-form");
    if (!b || !f) return;
    b.onclick = () => {
      f.hidden = false;
      b.hidden = true;
    };
    document.getElementById("hl-cancel").onclick = () => {
      f.hidden = true;
      b.hidden = false;
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await post("/hotline", { lines: [0, 1, 2].map((n) => ({ phone: f["p" + n].value.trim(), label: f["l" + n].value.trim() })), waitMinutes: f.wait.value, note: f.note.value }, "PUT");
        toast("บันทึกเบอร์ Hotline แล้ว");
        after();
      } catch (err) {
        toast(err.message, 6000);
      }
    };
  }

  async function viewIntakeItem(id) {
    setNav("intake");
    const { item: i, files, prior, updateUrl } = await api("/intake/" + Number(id));
    INTAKE_CACHE[i.id] = i;
    const row = (k, v) => `<div><div class="k">${k}</div><div>${v}</div></div>`;
    $app.innerHTML = `<div class="crumb"><a href="#/intake">เคสจากลูกค้า</a> / ${esc(i.req_no)}</div>
<div class="head"><div><h1>${esc(i.req_no)} ${sevChip(i.severity)}</h1><p>${ikCustomer(i)} · ${esc(i.subject)}</p></div>
<div class="actions">${i.status === "pending" && !i.held && can("case_create") ? `<button class="btn primary" type="button" data-claim="${i.id}">รับเคสเอง</button><button class="btn" type="button" data-transfer="${i.id}">โอนให้ Owner</button><button class="btn" type="button" id="rej">ปิดคำขอ (ซ้ำ / ไม่ใช่เคส)</button>` : ""}
${i.held && (lvl("case_reassign") === "all" || lvl("settings_manage") === "all") ? `<button class="btn primary" type="button" id="rel">ยืนยันว่าเป็นเคสจริง</button><button class="btn" type="button" id="rej">ปิดคำขอ (ไม่ใช่เคส)</button>` : ""}
${i.case_id ? `<a class="btn primary" href="#/case/${i.case_id}">เปิดเคส ${esc(i.case_no || i.cs_number || "#" + i.case_id)}</a>` : ""}</div></div>
${ikTags(i) ? `<div>${ikTags(i)}</div>` : ""}
${i.held ? `<div class="banner warn">พักไว้ให้ Admin / Manager ตรวจ${i.hold_reason ? `: <strong>${esc(i.hold_reason)}</strong>` : ""} · ถ้าเป็นเคสจริง กด “ยืนยันว่าเป็นเคสจริง”${i.channel === "email" ? " ระบบจะส่ง email ตอบรับให้ลูกค้าตอนนั้น" : ""} ถ้าไม่ใช่ กด “ปิดคำขอ”</div>` : ""}
<div class="grid2"><section class="card"><h2>ข้อมูลที่ลูกค้าแจ้ง</h2>
<div class="stat2" style="grid-template-columns:1fr 1fr">
${row("สถานะ", `${chip(i.status === "pending" ? "r1" : i.status === "claimed" ? "ok" : "closed", IK_STATUS[i.status])}${i.status === "pending" ? ` · รอมาแล้ว ${waitedText(i.created_at)}` : ""}`)}
${row("แจ้งเมื่อ", fdt(i.created_at))}
${row("ผู้ติดต่อ", `${esc(i.contact_name)}${i.position ? ` (${esc(i.position)})` : ""}`)}
${row("เบอร์ / อีเมล", `${i.contact_phone ? `<a href="tel:${esc(i.contact_phone)}">${esc(i.contact_phone)}</a>` : `<span class="muted">ไม่มีเบอร์</span>`}${i.contact_email ? `<br><a href="mailto:${esc(i.contact_email)}">${esc(i.contact_email)}</a>` : ""}`)}
${row("ระบบ", esc(i.product || "-"))}
${row("เริ่มพบปัญหา", esc([i.started_text, i.affected ? "กระทบ " + i.affected : ""].filter(Boolean).join(" · ") || "-"))}
${row("เลขอ้างอิงลูกค้า", esc(i.customer_ref || "-"))}
${row("ดูแลเคสล่าสุดของลูกค้ารายนี้", i.recent_owner_name ? `${esc(i.recent_owner_name)} (${fd(i.recent_owner_date, true)})` : "ยังไม่เคยมีเคส")}</div>
<div class="k" style="margin-top:6px">รายละเอียด</div><div class="ik-detail">${esc(i.detail)}</div>
${files.length ? `<div class="k">ไฟล์แนบ</div><div class="chips">${files.map((f) => `<a class="lk" href="api/intake/${i.id}/files/${f.id}" target="_blank" rel="noopener">${esc(f.file_name)} <span class="muted">${Math.ceil(f.size / 1024)} KB</span></a>`).join("")}</div>` : ""}
</section>
<section class="card"><h2>ที่มา</h2><div class="stat2" style="grid-template-columns:1fr">
${row("ช่องทาง", i.channel === "email" ? "Email ถึงกล่องรับแจ้งเคส · ตอบกลับลูกค้าในเรื่องเดิมอัตโนมัติ" : i.line_user_id ? "LINE OA" : "ลิงก์ที่ทีมสร้างส่งให้")}
${i.channel === "email" ? row("ระบบเดา Severity / ระบบ", `${esc(i.severity)} / ${esc(i.product || "-")} · ตรวจและแก้ได้ตอนรับเคส`) : ""}
${row("ชื่อบริษัทที่ลูกค้าพิมพ์", esc(i.customer_text || "-"))}
${updateUrl ? row("ลิงก์ให้ลูกค้าเพิ่มข้อมูล / แนบรูป (Add details)", `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><a class="mono" href="${esc(updateUrl)}" target="_blank" rel="noopener" style="word-break:break-all;font-size:13px">${esc(updateUrl)}</a><button class="btn" type="button" id="upd-copy" style="min-height:32px">คัดลอก</button></div><div class="hint">ระบบใส่ลิงก์นี้ใน email ถึงลูกค้าอยู่แล้ว ส่งเองทาง LINE หรือแชทได้ ใช้ได้จนเคสปิด + 7 วัน</div>`) : ""}
${i.claimed_at ? row(i.status === "claimed" ? "รับเคสโดย" : "ปิดโดย", `${esc(i.claimed_by_name || "-")} · ${fdt(i.claimed_at)}${i.owner_name && i.owner_name !== i.claimed_by_name ? ` · Owner: ${esc(i.owner_name)}` : ""}`) : ""}
${i.closed_reason || i.duplicate_of ? row("เหตุผล", esc(i.duplicate_of ? "ซ้ำกับ " + i.duplicate_of : i.closed_reason)) : ""}
${i.reminder_count ? row("เตือนทีมแล้ว", `${i.reminder_count} ครั้ง`) : ""}</div>
${prior.length ? `<div class="k">คำขอก่อนหน้าจาก LINE นี้</div><ul style="margin:0;padding-left:18px">${prior.map((p) => `<li><a href="#/intake/${p.id}">${esc(p.req_no)}</a> ${esc(p.subject)} <span class="muted">${IK_STATUS[p.status]}</span></li>`).join("")}</ul>` : ""}
</section></div>
<dialog id="dlg"></dialog>`;
    bindIntakeActions($app, (r) => (location.hash = `#/case/${r.caseId}`));
    const uc = document.getElementById("upd-copy");
    if (uc) uc.onclick = () => navigator.clipboard.writeText(updateUrl).then(() => toast("คัดลอกลิงก์แล้ว"));
    const rj = document.getElementById("rej");
    if (rj) rj.onclick = () => openRejectDialog(i);
    const rl = document.getElementById("rel");
    if (rl) rl.onclick = async () => {
      await post(`/intake/${i.id}/release`);
      toast("ยืนยันแล้ว ระบบแจ้งทีมให้รับเคส และตอบ email ลูกค้า (ถ้ามาทาง email)", 5000);
      viewIntakeItem(i.id);
    };
  }

  async function viewIntakeAdmin() {
    setNav("settings");
    const [d, users] = await Promise.all([api("/intake-admin"), userOptions()]);
    const s = d.settings;
    const ST_OB = { pending: ["r1", "รอส่ง"], sent: ["ok", "ส่งแล้ว"], failed: ["fail", "ส่งไม่สำเร็จ"], no_url: ["closed", "ยังไม่ตั้ง URL"] };
    const pendingLine = d.lineUsers.filter((u) => !u.site && !u.blocked);
    const em = d.email;
    const es = em.settings;
    const est = em.status || {};
    const MAIL_DEC = { created: ["ok", "สร้างคำขอ"], appended: ["normal", "เพิ่มในเรื่องเดิม"], held: ["r1", "พักให้ Admin ตรวจ"], ignored: ["closed", "ข้าม"], error: ["fail", "ผิดพลาด"] };
    $app.innerHTML = `<div class="crumb"><a href="#/settings">ตั้งค่า</a> / LINE OA, Email และ API</div>
<div class="head"><div><h1>รับแจ้งเคสจากลูกค้า: LINE OA, Email และ API</h1><p>ลูกค้าแจ้งได้ 3 ทาง: LINE OA (แชทบอทขอลิงก์ฟอร์มผ่าน API), ส่ง email ถึงกล่องรับแจ้งเคส และลิงก์ที่ทีมสร้างส่งให้ ทุกทางได้เลข REQ และเข้า “เคสจากลูกค้า” ให้ทีมรับเหมือนกัน</p></div>
<div class="actions"><a class="btn" href="#/intake">เคสจากลูกค้า</a></div></div>

<section class="card" id="em-card"><div class="title"><h2>รับแจ้งเคสทาง Email</h2><span>${es.enabled ? `เปิดใช้ · ${esc(es.mailbox)}` : "ยังไม่เปิดใช้"}</span></div>
${em.mock ? `<div class="banner warn">โหมดข้อมูลจำลอง: ระบบไม่อ่านกล่องจริง ใช้ “จำลอง email เข้า” ด้านล่างทดสอบได้</div>` : es.enabled ? `<div class="banner ${est.error ? "err" : "ok"}">${est.error ? `อ่านกล่องไม่สำเร็จ (${fdt(est.at)}): ${esc(est.error)}` : est.okAt ? `อ่านกล่องล่าสุด ${fdt(est.okAt)} · รอบล่าสุดอ่าน ${est.last ? est.last.read : 0} ฉบับ` : "ยังไม่ได้อ่านรอบแรก (ระบบอ่านทุก 2 นาที)"}</div>` : ""}
<div class="stat2" style="grid-template-columns:repeat(5,1fr)"><div><div class="k">สร้างคำขอ (30 วัน)</div><div class="v">${em.counts.created}</div></div><div><div class="k">เพิ่มในเรื่องเดิม</div><div class="v">${em.counts.appended}</div></div><div><div class="k">พักให้ Admin ตรวจ</div><div class="v">${em.counts.held}</div></div><div><div class="k">ข้าม</div><div class="v">${em.counts.ignored}</div></div><div><div class="k">ผิดพลาด</div><div class="v">${em.counts.errors}</div></div></div>
<div class="formgrid">
<label class="f">กล่องจดหมาย (shared mailbox)<input id="em-mb" value="${esc(es.mailbox)}" placeholder="service@sinostech.co.th"></label>
<label class="f">email จากโดเมนที่ยังไม่ผูกกับลูกค้า<select id="em-unk"><option value="hold" ${es.unknownDomain === "hold" ? "selected" : ""}>สร้างคำขอแต่พักไว้ให้ Admin / Manager ตรวจ (ไม่ตอบลูกค้า)</option><option value="ignore" ${es.unknownDomain === "ignore" ? "selected" : ""}>ข้าม ไม่สร้างคำขอ</option></select></label>
<label class="f">ข้าม email จากโดเมน (ภายในบริษัท)<input id="em-ign" value="${esc(es.ignoreDomains.join(", "))}" placeholder="sinostech.co.th"></label>
<label class="f">ผู้ส่งรายเดียวส่งเรื่องใหม่ได้ต่อชั่วโมง (เกินนี้พักไว้)<input id="em-rate" type="number" min="1" max="100" value="${es.perSenderPerHour}"></label>
<label class="f">ลบ email ที่ประมวลผลแล้วออกจากกล่องเมื่อเก่ากว่า (วัน)<input id="em-keep" type="number" min="30" max="3650" value="${es.keepDays}"></label></div>
<label class="chk"><input type="checkbox" id="em-ack" ${es.autoReply ? "checked" : ""}> ตอบกลับลูกค้าอัตโนมัติในเรื่องเดิม พร้อมเลข REQ (และแจ้งอีกครั้งเมื่อมี Engineer รับเคส)</label>
<label class="chk"><input type="checkbox" id="em-on" ${es.enabled ? "checked" : ""}> เปิดใช้ (อ่านกล่องทุก 2 นาที เฉพาะ email ที่เข้ามาหลังเปิดใช้)</label>
<div class="actions"><button class="btn primary" type="button" id="em-save">บันทึก</button>${es.enabled && !em.mock ? `<button class="btn" type="button" id="em-poll">อ่านกล่องตอนนี้</button>` : ""}</div>
<details><summary style="cursor:pointer;color:var(--accent)">กฎที่ระบบใช้ และการตั้งสิทธิ์กล่องจดหมาย</summary>
<ul style="margin:8px 0 0;padding-left:18px;line-height:1.8;font-size:14px">
<li>รู้จักลูกค้าจากโดเมนผู้ส่ง ตั้งโดเมนของแต่ละลูกค้าในตาราง “ลูกค้า” ด้านล่าง (email ส่วนตัวอย่าง gmail.com ผูกไม่ได้)</li>
<li>ข้าม: โดเมนภายใน, ตอบกลับอัตโนมัติ / out-of-office, noreply / mailer-daemon, จดหมายข่าว, email ที่เข้ามาก่อนเปิดใช้</li>
<li>หัวเรื่องมี [REQ-…] หรือหัวเรื่องเดิมจากผู้ส่งเดิมภายใน 3 วัน: เพิ่มเข้าเรื่องเดิม ถ้ารับเคสแล้วบันทึกเป็น Activity ของเคสและแจ้ง Owner</li>
<li>พักให้ Admin ตรวจ: โดเมนที่ยังไม่ผูกลูกค้า, ตอบกลับ email เก่าที่ไม่มีเลข REQ, ผู้ส่งส่งถี่เกินกำหนด, คำขอเข้ามาผิดปกติ</li>
<li>ระบบเดา Severity และระบบจากเนื้อหา ทีมแก้ได้ตอนรับเคส · เก็บไฟล์แนบตามชนิดและขนาดที่ตั้งไว้</li>
<li>อ่านแล้วย้ายไปโฟลเดอร์ “${esc(es.folder)}” ในกล่อง · ลบออกจากกล่องเมื่อเก่ากว่าที่ตั้งไว้ (คำขอในระบบยังเก็บเนื้อหาและไฟล์)</li>
<li>แอปของระบบต้องได้สิทธิ์ <span class="mono">Application Mail.ReadWrite</span> และ <span class="mono">Application Mail.Send</span> ผ่าน Exchange RBAC for Applications จำกัดเฉพาะกล่องนี้ ห้ามให้ Mail.Read ใน Entra ตรงๆ เพราะจะอ่านได้ทุกกล่อง</li></ul></details>
<h3 style="margin:8px 0 0;font-size:15px">จำลอง email เข้า (ไม่อ่าน/ไม่ส่งถึงกล่องจริง)</h3>
<div class="formgrid">
<label class="f">จาก (email ผู้ส่ง)<input id="es-from" value="somying@${esc((d.sites.find((x) => (x.domains || []).length) || { domains: ["ktb.co.th"] }).domains[0])}"></label>
<label class="f">ชื่อผู้ส่ง<input id="es-name" value="สมหญิง ใจดี"></label>
<label class="f">เวลาที่ได้รับ (ว่าง = ตอนนี้ · ใส่ 23:30 เพื่อลองนอกเวลา)<input id="es-at" type="time"></label>
<label class="f" style="grid-column:1/-1">หัวเรื่อง<input id="es-subj" value="Agent login ไม่ได้ ตั้งแต่เช้า"></label>
<label class="f" style="grid-column:1/-1">เนื้อหา<textarea id="es-body" rows="3">Agent ประมาณ 20 คน login ไม่ได้ ขึ้น error 401 ตั้งแต่ 8:30 รบกวนตรวจสอบด่วนค่ะ</textarea></label></div>
<div style="display:flex;gap:16px;flex-wrap:wrap"><label class="chk"><input type="checkbox" id="es-test" checked> เคสทดสอบ</label><label class="chk"><input type="checkbox" id="es-file"> มีไฟล์แนบ</label><label class="chk"><input type="checkbox" id="es-reply"> เป็นการตอบกลับ email เก่า</label><label class="chk"><input type="checkbox" id="es-auto"> เป็น out-of-office</label></div>
<div class="actions"><button class="btn primary" type="button" id="es-go">จำลอง email เข้า</button></div><div id="es-out"></div>
<h3 style="margin:8px 0 0;font-size:15px">email ล่าสุดที่ระบบอ่าน</h3>
${em.recent.length ? `<div class="tablewrap"><table style="min-width:900px"><thead><tr><th>เวลา</th><th>จาก</th><th>หัวเรื่อง</th><th>ผล</th><th>รายละเอียด</th><th></th></tr></thead><tbody>
${em.recent.map((m) => `<tr><td>${fdt(m.created_at)}</td><td>${esc(m.from_name || "")}<div class="muted" style="font-size:12px">${esc(m.from_email || "")}</div></td><td style="font-size:13px">${esc(m.subject || "")}${m.is_test ? ` <span class="chip c-closed">ทดสอบ</span>` : ""}</td>
<td>${chip(MAIL_DEC[m.decision][0], MAIL_DEC[m.decision][1])}${m.replied ? `<div class="muted" style="font-size:12px">ตอบลูกค้าแล้ว</div>` : ""}</td>
<td style="font-size:13px">${m.req_no ? `<a href="#/intake/${m.intake_id}">${esc(m.req_no)}</a>` : ""}${m.case_no ? ` · <a href="#/case/${m.case_id}">${esc(m.case_no)}</a>` : ""}${m.reason ? `<div class="muted">${esc(m.reason)}</div>` : ""}</td>
<td>${m.decision === "error" ? `<button class="btn" type="button" data-emretry="${m.id}" style="min-height:34px">ลองใหม่</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มี email</div>`}
</section>

<section class="card"><div class="title"><h2>ทดสอบแบบไม่ต้องมี LINE OA</h2><span>เรียก API เดียวกับที่แชทบอทจะเรียก</span></div>
<div class="formgrid">
<label class="f">ชื่อบริษัทที่ลูกค้าพิมพ์<input id="sim-cust" placeholder="เช่น กรุงไทย" list="sim-sites"><datalist id="sim-sites">${d.sites.map((x) => `<option value="${esc(x.site)}">`).join("")}</datalist></label>
<label class="f">LINE userId (สมมติ)<input id="sim-line" value="Utest${Math.random().toString(36).slice(2, 8)}"></label>
<label class="f">ชื่อผู้ติดต่อ<input id="sim-name" value="ทดสอบ ระบบ"></label>
<label class="f">เบอร์โทร<input id="sim-phone" value="080-000-0000"></label></div>
<label class="chk"><input type="checkbox" id="sim-test" checked> เคสทดสอบ (แจ้งเตือนเฉพาะผู้รับทดสอบ ไม่ส่ง Telegram ลบทิ้งได้ทีเดียว)</label>
<div class="actions"><button class="btn primary" type="button" id="sim-go">ขอลิงก์ (จำลองแชทบอท)</button><button class="btn" type="button" id="rem-run">ส่งเตือนเคสค้างตอนนี้</button><button class="btn" type="button" id="test-clean">ลบเคสทดสอบที่ยังไม่ถูกรับ</button></div>
<div id="sim-out"></div></section>

<section class="card"><div class="title"><h2>ระบบที่เรียก API</h2><span>API: <span class="mono">${esc(d.apiBase)}/intake/links</span></span></div>
${d.keys.length ? `<div class="tablewrap"><table style="min-width:760px"><thead><tr><th>ระบบ</th><th>API key</th><th>IP ที่อนุญาต</th><th>ลิงก์ 24 ชม.</th><th>ใช้ล่าสุด</th><th></th></tr></thead><tbody>
${d.keys.map((k) => `<tr class="${k.revoked_at ? "muted" : ""}"><td style="font-weight:600">${esc(k.name)} ${k.is_test ? `<span class="chip c-closed">ทดสอบ</span>` : ""}</td><td class="mono">${k.is_test ? "sk_test" : "sk_live"}_••••${esc(k.key_last4)}</td>
<td>${k.allowed_ips.length ? esc(k.allowed_ips.join(", ")) : `<span class="muted">ทุก IP</span>`}</td><td>${k.links_today}</td><td>${k.last_used_at ? fdt(k.last_used_at) : "-"}</td>
<td style="text-align:right;white-space:nowrap">${k.revoked_at ? `ยกเลิก ${fdt(k.revoked_at)}` : `<button class="btn" type="button" data-kip="${k.id}" data-ips="${esc(k.allowed_ips.join(", "))}" style="min-height:34px">IP</button> <button class="btn" type="button" data-krev="${k.id}" style="min-height:34px">ยกเลิก</button>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มี API key</div>`}
<div class="formgrid"><label class="f">ชื่อระบบ<input id="k-name" value="LINE OA Chatbot"></label><label class="f">IP ที่อนุญาต (ว่าง = ทุก IP)<input id="k-ips" placeholder="เช่น 203.0.113.24"></label></div>
<label class="chk"><input type="checkbox" id="k-test"> key ทดสอบ (เคสที่สร้างติดป้าย “ทดสอบ”)</label>
<div class="actions"><button class="btn primary" type="button" id="k-new">สร้าง API key</button></div><div id="k-out"></div></section>

<section class="card"><div class="title"><h2>ลูกค้า: ชื่อเรียก โดเมน email ทีม และไฟล์แนบ</h2><span>ชื่อที่ลูกค้าพิมพ์ใน LINE หรือโดเมนของผู้ส่ง email ตรงกับลูกค้ารายไหน เคสเข้าลูกค้ารายนั้นทันที</span></div>
<div class="tablewrap"><table style="min-width:1100px"><thead><tr><th>Site</th><th>ชื่อเรียกอื่น (คั่นด้วย ,)</th><th>โดเมน email (คั่นด้วย ,)</th><th>ทีมของเคส</th><th>แนบไฟล์</th><th class="n">เคสเปิด</th><th></th></tr></thead><tbody>
${d.sites.map((x, n) => `<tr data-site="${n}"><td style="font-weight:600">${esc(x.site)}</td>
<td><input class="sx-al" value="${esc(x.aliases.join(", "))}" placeholder="เช่น กรุงไทย, Krungthai" style="width:100%"></td>
<td><input class="sx-dom" value="${esc((x.domains || []).join(", "))}" placeholder="เช่น ktb.co.th" style="width:100%"></td>

<td><select class="sx-team"><option value="">ตามทีมของผู้รับ</option>${ME.teams.map((t) => `<option value="${esc(t.key)}" ${t.key === x.team ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></td>
<td><label class="chk" style="min-height:0"><input type="checkbox" class="sx-att" ${x.attachments ? "checked" : ""}><span class="sr">แนบไฟล์</span></label></td><td class="n">${x.open}</td>
<td><button class="btn" type="button" data-sxsave="${n}" style="min-height:34px">บันทึก</button></td></tr>`).join("")}</tbody></table></div>
<p class="hint" style="margin:0">ระบบตัดคำว่า บริษัท, จำกัด, มหาชน, ธนาคาร, Co., Ltd. และช่องว่างออกก่อนเทียบ เช่น “ธนาคารกรุงไทย จำกัด (มหาชน)” ตรงกับชื่อเรียก “กรุงไทย” · ลูกค้าใหม่ เพิ่มใน <a href="#/settings">รายการ dropdown → Site</a> ก่อน</p></section>

<section class="card"><div class="title"><h2>บัญชี LINE ของลูกค้า</h2><span>${pendingLine.length ? `รอ Admin ยืนยัน ${pendingLine.length} บัญชี` : "ไม่มีบัญชีรอยืนยัน"}</span></div>
${d.lineUsers.length ? `<div class="tablewrap"><table style="min-width:860px"><thead><tr><th>ชื่อใน LINE</th><th>บริษัทที่พิมพ์</th><th>ผูกกับลูกค้า</th><th>ผู้ติดต่อ</th><th>คำขอ</th><th></th></tr></thead><tbody>
${d.lineUsers.map((u) => `<tr><td>${esc(u.display_name || "-")}<div class="muted mono" style="font-size:11px">${esc(u.line_user_id)}</div></td><td>${esc(u.customer_text || "-")}</td>
<td><select data-lsite="${esc(u.line_user_id)}"><option value="">${u.site ? "" : "รอยืนยัน: เลือกลูกค้า"}</option>${d.sites.map((x) => `<option ${x.site === u.site ? "selected" : ""}>${esc(x.site)}</option>`).join("")}</select></td>
<td>${esc(u.contact_name || "-")}<div class="muted" style="font-size:13px">${esc(u.contact_phone || "")}</div></td><td>${u.requests}${u.last_req ? ` · ล่าสุด ${esc(u.last_req)}` : ""}</td>
<td style="text-align:right"><button class="btn" type="button" data-lblock="${esc(u.line_user_id)}" data-v="${u.blocked ? 0 : 1}" style="min-height:34px">${u.blocked ? "เลิกบล็อก" : "บล็อก"}</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีลูกค้าทักผ่าน LINE OA</div>`}</section>

<section class="card"><div class="title"><h2>การแจ้งเตือนและลิงก์</h2></div>
<div class="formgrid">
<label class="f">ส่ง email เคสใหม่ถึง (ว่าง = รายชื่อ CC ของ email แจ้งเตือน)<input id="st-to" value="${esc(s.notifyTo)}" placeholder="engineer@sinostech.co.th"></label>
<label class="f">ผู้รับแจ้งเตือนของเคสทดสอบ (ว่าง = Admin หลัก)<input id="st-test" value="${esc(s.testNotifyTo)}"></label>
<label class="f">ลิงก์จาก LINE หมดอายุใน (นาที)<input id="st-exp" type="number" min="10" max="1440" value="${s.linkMinutes}"></label>
<label class="f">ลิงก์ที่ทีมส่งทางอีเมล หมดอายุใน (ชั่วโมง)<input id="st-mexp" type="number" min="1" max="168" value="${s.manualLinkHours}"></label>
<label class="f">ขอลิงก์ได้ต่อ LINE ต่อชั่วโมง<input id="st-rate" type="number" min="1" max="50" value="${s.linksPerLinePerHour}"></label>
<label class="f">เตือนครั้งแรกเมื่อไม่มีคนรับเกิน (นาที)<input id="st-after" type="number" min="15" value="${s.reminder.afterMinutes}"></label>
<label class="f">เตือนซ้ำทุก (นาที)<input id="st-every" type="number" min="15" value="${s.reminder.everyMinutes}"></label>
<label class="f">ช่วงเวลาที่เตือน เริ่ม<input id="st-start" type="time" value="${esc(s.reminder.start)}"></label>
<label class="f">ถึง<input id="st-end" type="time" value="${esc(s.reminder.end)}"></label>
<label class="f">พักคำขอเมื่อเข้ามาเกิน (เคส)<input id="st-bc" type="number" min="2" value="${s.burst.count}"></label>
<label class="f">ภายใน (นาที)<input id="st-bm" type="number" min="1" value="${s.burst.minutes}"></label>
<label class="f">แนบไฟล์ได้สูงสุด (ไฟล์)<input id="st-af" type="number" min="1" max="10" value="${s.attachMaxFiles}"></label>
<label class="f">ขนาดไฟล์สูงสุด (MB)<input id="st-am" type="number" min="1" max="20" value="${s.attachMaxMb}"></label></div>
<label class="chk"><input type="checkbox" id="st-tg" ${s.telegram ? "checked" : ""}> ส่งแจ้งเตือนเข้า Telegram กลุ่มทีมด้วย</label>
<div class="formgrid"><label class="f">Webhook เมื่อมีคนรับเคส (URL ของแชทบอท, https)<input id="st-wh" value="${esc(s.webhookUrl)}" placeholder="https://chatbot.example.co.th/hooks/sino-case"></label>
<label class="f">Webhook secret (ใช้ตรวจลายเซ็น X-Sino-Signature)<input class="mono" readonly value="${esc(s.webhookSecret)}"></label></div>
<div class="actions"><button class="btn primary" type="button" id="st-save">บันทึกการตั้งค่า</button><button class="btn" type="button" id="st-rot">สร้าง secret ใหม่</button></div></section>

<section class="card"><div class="title"><h2>เหตุการณ์ที่ส่งให้แชทบอท (webhook)</h2><span>ยังไม่ตั้ง URL ก็ดูได้ว่าระบบจะส่งอะไร</span></div>
${d.outbox.length ? `<div class="tablewrap"><table style="min-width:860px"><thead><tr><th>เวลา</th><th>เหตุการณ์</th><th>คำขอ</th><th>ข้อความที่แชทบอทจะส่งให้ลูกค้า</th><th>ผล</th><th></th></tr></thead><tbody>
${d.outbox.map((o) => `<tr><td>${fdt(o.created_at)}</td><td class="mono">${esc(o.event)}${o.is_test ? ` <span class="chip c-closed">ทดสอบ</span>` : ""}</td><td>${esc(o.req_no || "-")}</td><td style="white-space:pre-wrap;font-size:13px">${esc(o.payload.message || "")}</td>
<td>${chip(ST_OB[o.status][0], ST_OB[o.status][1])}${o.last_error ? `<div class="muted" style="font-size:12px">${esc(o.last_error)} · ${o.attempts} ครั้ง</div>` : ""}</td>
<td>${o.status !== "sent" && s.webhookUrl ? `<button class="btn" type="button" data-obretry="${o.id}" style="min-height:34px">ส่งใหม่</button>` : ""} <button class="btn" type="button" data-obview="${o.id}" style="min-height:34px">JSON</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีเหตุการณ์</div>`}</section>
<dialog id="dlg"></dialog>`;

    const $ = (id) => document.getElementById(id);
    const reload = () => viewIntakeAdmin();
    const act = (fn) => async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await fn(b);
      } catch (err) {
        toast(err.message, 6000);
      }
      b.disabled = false;
    };
    $("em-save").onclick = act(async () => {
      await post("/intake-admin/email", { enabled: $("em-on").checked, mailbox: $("em-mb").value.trim(), autoReply: $("em-ack").checked, unknownDomain: $("em-unk").value, ignoreDomains: $("em-ign").value, perSenderPerHour: $("em-rate").value, keepDays: $("em-keep").value }, "PUT");
      toast($("em-on").checked ? "บันทึกแล้ว ระบบเริ่มอ่านกล่องภายใน 2 นาที" : "บันทึกแล้ว", 5000);
      reload();
    });
    if ($("em-poll"))
      $("em-poll").onclick = act(async () => {
        const r = await post("/intake-admin/email/poll");
        toast(r.skipped ? `ไม่ได้อ่าน: ${r.skipped}` : r.busy ? "กำลังอ่านอยู่" : `อ่าน ${r.read || 0} ฉบับ · สร้าง ${r.created || 0} · เพิ่มในเรื่องเดิม ${r.appended || 0} · พัก ${r.held || 0} · ข้าม ${r.ignored || 0}${r.errors ? ` · ผิดพลาด ${r.errors}` : ""}`, 6000);
        reload();
      });
    $("es-go").onclick = act(async () => {
      const r = await post("/intake-admin/email/simulate", { from: $("es-from").value, name: $("es-name").value, subject: $("es-subj").value, body: $("es-body").value, at: $("es-at").value, test: $("es-test").checked, withFile: $("es-file").checked, inReplyTo: $("es-reply").checked, auto: $("es-auto").checked });
      const MSG = { created: ["ok", "สร้างคำขอ"], appended: ["ok", "เพิ่มเข้าเรื่องเดิม"], held: ["warn", "สร้างคำขอแต่พักไว้ให้ Admin / Manager ตรวจ"], ignored: ["", "ข้าม ไม่สร้างคำขอ"] };
      const [cls, label] = MSG[r.decision] || ["", r.decision];
      $("es-out").innerHTML = `<div class="banner ${cls}">${label}${r.reqNo ? ` <a href="#/intake/${r.intakeId}">${esc(r.reqNo)}</a>` : ""}${r.reason ? ` · ${esc(r.reason)}` : ""}${r.decision === "created" ? " · ลูกค้าจะได้ email ตอบกลับพร้อมเลข REQ (ในโหมดจำลองไม่ได้ส่งจริง)" : ""}</div>`;
    });
    $app.querySelectorAll("[data-emretry]").forEach((b) => (b.onclick = act(async () => {
      await post(`/intake-admin/email/${b.dataset.emretry}/retry`);
      toast("อ่านใหม่แล้ว");
      reload();
    })));
    $("sim-go").onclick = act(async () => {
      const r = await post("/intake-admin/simulate", { customer: $("sim-cust").value, lineUserId: $("sim-line").value, contactName: $("sim-name").value, contactPhone: $("sim-phone").value, test: $("sim-test").checked });
      $("sim-out").innerHTML = `<div class="banner ${r.customer.matched ? "ok" : "warn"}" style="display:flex;flex-direction:column;gap:8px">
<div>${r.customer.matched ? `จับคู่ลูกค้าได้: <strong>${esc(r.customer.site)}</strong> เคสเข้าลูกค้ารายนี้ทันที` : `ไม่พบลูกค้าชื่อ “${esc(r.customer.text || "")}” เคสจะติดป้าย “ลูกค้าใหม่ รอยืนยัน”`}</div>
<div><a class="mono" href="${esc(r.url)}" target="_blank" rel="noopener" style="word-break:break-all">${esc(r.url)}</a></div><div class="hint">หมดอายุ ${fdt(r.expiresAt)} · เปิดลิงก์เพื่อกรอกฟอร์มแบบที่ลูกค้าเห็น</div></div>`;
    });
    $("rem-run").onclick = act(async () => {
      const r = await post("/intake-admin/reminders/run");
      toast(r.skipped ? `ไม่ได้ส่ง: ${r.skipped}` : r.sent || r.test ? `ส่งเตือนแล้ว ${r.sent || 0} เคส${r.test ? ` · ทดสอบ ${r.test} เคส` : ""}` : "ไม่มีเคสที่ถึงรอบเตือน", 5000);
    });
    $("test-clean").onclick = act(async () => {
      const r = await api("/intake-admin/test-data", { method: "DELETE" });
      toast(`ลบเคสทดสอบ ${r.removed} รายการ`);
      reload();
    });
    $("k-new").onclick = act(async () => {
      const r = await post("/intake-admin/keys", { name: $("k-name").value, allowedIps: $("k-ips").value, isTest: $("k-test").checked });
      $("k-out").innerHTML = `<div class="banner warn" style="display:flex;flex-direction:column;gap:8px"><strong>คัดลอก API key นี้ไปใส่ในแชทบอทตอนนี้ ระบบจะไม่แสดงอีก</strong>
<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="mono" style="word-break:break-all;flex:1">${esc(r.key)}</span><button class="btn" type="button" id="k-copy">คัดลอก</button></div></div>`;
      $("k-copy").onclick = () => navigator.clipboard.writeText(r.key).then(() => toast("คัดลอกแล้ว"));
    });
    $app.querySelectorAll("[data-krev]").forEach((b) => (b.onclick = act(async () => {
      if (!confirmInline(b, "ยืนยันยกเลิก")) return;
      await api("/intake-admin/keys/" + b.dataset.krev, { method: "DELETE" });
      toast("ยกเลิก API key แล้ว ระบบที่ใช้ key นี้เรียกไม่ได้ทันที");
      reload();
    })));
    $app.querySelectorAll("[data-kip]").forEach((b) => (b.onclick = act(async () => {
      const dlg = $("dlg");
      dlg.innerHTML = `<form class="card" method="dialog" id="ipf"><h2>IP ที่อนุญาตให้ใช้ key นี้</h2><label class="f">คั่นด้วย , (ว่าง = ทุก IP)<input name="ips" value="${esc(b.dataset.ips)}"></label>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">บันทึก</button></div></form>`;
      const f = dlg.querySelector("#ipf");
      dlg.onclose = async () => {
        if (dlg.returnValue !== "ok") return;
        try {
          await post("/intake-admin/keys/" + b.dataset.kip, { allowedIps: f.ips.value }, "PUT");
          toast("บันทึกแล้ว");
          reload();
        } catch (err) {
          toast(err.message, 6000);
        }
      };
      dlg.showModal();
    })));
    $app.querySelectorAll("[data-sxsave]").forEach((b) => (b.onclick = act(async () => {
      const tr = b.closest("tr");
      const x = d.sites[Number(b.dataset.sxsave)];
      await post("/intake-admin/sites", { site: x.site, aliases: tr.querySelector(".sx-al").value, domains: tr.querySelector(".sx-dom").value, team: tr.querySelector(".sx-team").value, attachments: tr.querySelector(".sx-att").checked }, "PUT");
      toast(`บันทึก ${x.site} แล้ว`);
    })));
    $app.querySelectorAll("[data-lsite]").forEach((sel) => (sel.onchange = async () => {
      if (!sel.value) return;
      try {
        await post("/intake-admin/line-users/" + encodeURIComponent(sel.dataset.lsite), { site: sel.value }, "PUT");
        toast(`ผูกกับ ${sel.value} แล้ว คำขอที่รออยู่ของบัญชีนี้ย้ายไปลูกค้ารายนี้ด้วย`, 5000);
      } catch (err) {
        toast(err.message, 6000);
      }
    }));
    $app.querySelectorAll("[data-lblock]").forEach((b) => (b.onclick = act(async () => {
      await post("/intake-admin/line-users/" + encodeURIComponent(b.dataset.lblock), { blocked: b.dataset.v === "1" }, "PUT");
      toast(b.dataset.v === "1" ? "บล็อกแล้ว บัญชีนี้ขอลิงก์แจ้งเคสไม่ได้" : "เลิกบล็อกแล้ว");
      reload();
    })));
    const saveSettings = async (rotate) => {
      await post("/intake-admin/settings", {
        notifyTo: $("st-to").value, testNotifyTo: $("st-test").value, linkMinutes: $("st-exp").value, manualLinkHours: $("st-mexp").value, linksPerLinePerHour: $("st-rate").value,
        reminder: { afterMinutes: $("st-after").value, everyMinutes: $("st-every").value, start: $("st-start").value, end: $("st-end").value },
        burst: { count: $("st-bc").value, minutes: $("st-bm").value }, attachMaxFiles: $("st-af").value, attachMaxMb: $("st-am").value,
        telegram: $("st-tg").checked, webhookUrl: $("st-wh").value.trim(), rotateSecret: rotate,
      }, "PUT");
      toast(rotate ? "สร้าง secret ใหม่แล้ว อัปเดตในแชทบอทด้วย" : "บันทึกการตั้งค่าแล้ว", 5000);
      reload();
    };
    $("st-save").onclick = act(() => saveSettings(false));
    $("st-rot").onclick = act(async (b) => {
      if (!confirmInline(b, "ยืนยันสร้าง secret ใหม่")) return;
      await saveSettings(true);
    });
    $app.querySelectorAll("[data-obretry]").forEach((b) => (b.onclick = act(async () => {
      const r = await post(`/intake-admin/outbox/${b.dataset.obretry}/retry`);
      toast(r.sent ? "ส่งสำเร็จ" : "ยังส่งไม่สำเร็จ ดูข้อผิดพลาดในตาราง", 5000);
      reload();
    })));
    $app.querySelectorAll("[data-obview]").forEach((b) => (b.onclick = () => {
      const o = d.outbox.find((x) => String(x.id) === b.dataset.obview);
      const dlg = $("dlg");
      dlg.classList.add("wide");
      dlg.innerHTML = `<form class="card" method="dialog"><h2>${esc(o.event)} · ${esc(o.req_no || "")}</h2><pre class="mono" style="white-space:pre-wrap;max-height:60vh;overflow:auto;margin:0">${esc(JSON.stringify({ id: o.id, ...o.payload }, null, 2))}</pre>
<p class="hint" style="margin:0">ส่งแบบ POST JSON พร้อม header X-Sino-Event, X-Sino-Timestamp และ X-Sino-Signature = sha256 HMAC ของ “timestamp.body” ด้วย webhook secret</p><div class="right"><button class="btn primary" value="ok">ปิด</button></div></form>`;
      dlg.onclose = () => dlg.classList.remove("wide");
      dlg.showModal();
    }));
  }
  /** Two-click confirm on a button without a browser dialog. */
  function confirmInline(b, text) {
    if (b.dataset.armed) return true;
    const old = b.textContent;
    b.dataset.armed = "1";
    b.textContent = text;
    setTimeout(() => {
      delete b.dataset.armed;
      b.textContent = old;
    }, 4000);
    return false;
  }

  // ------------------------------------------------------------ KPI per owner (monthly)
  const KPI_PARTS = [
    ["sla", "1. ปิดทัน SLA", 30],
    ["resp", "2. ความเร็วตอบสนอง", 15],
    ["work", "3. ปริมาณงานถ่วงน้ำหนัก", 15],
    ["hard", "4. ความยากของเคส", 10],
    ["div", "5. ความหลากหลาย / Skill", 10],
    ["back", "6. งานค้างและการขยายเวลา", 10],
    ["doc", "7. คุณภาพการบันทึก", 10],
  ];
  const TH_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const ymLabel = (ym, full) => {
    const [y, m] = ym.split("-").map(Number);
    return `${full ? TH_FULL[m - 1] : TH_MONTHS[m - 1]} ${y + 543}`;
  };
  const kpiColor = (v, max) => (v == null ? "#9AA3AF" : v / max >= 0.8 ? "#1C6B45" : v / max >= 0.6 ? "#1764D8" : v / max >= 0.4 ? "#B07800" : "#9A1B30");
  async function viewKpi(params) {
    setNav("kpi");
    const months = [];
    for (let i = 0; i < 12; i++) {
      const t = new Date();
      t.setDate(1);
      t.setMonth(t.getMonth() - i);
      months.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`);
    }
    const month = params.month || months[1];
    const r = await api("/kpi?month=" + month);
    const owners = r.owners;
    const sel = owners.find((o) => String(o.id) === String(params.owner)) || owners.find((o) => o.id === ME.user.id) || owners[0];
    const current = month === months[0];
    const head = `<div class="banner warn kp-trial"><strong>ทดลองใช้</strong> · เกณฑ์และคะแนนอยู่ระหว่างทดลอง ยังไม่ใช้ประเมินผลงานจริง ถ้าเห็นตัวเลขที่ไม่ตรงกับงานจริง แจ้ง Admin เพื่อปรับเกณฑ์</div>
<div class="head"><div><h1>KPI ราย Owner · ${ymLabel(month, true)} <span class="kp-beta">ทดลองใช้</span></h1><p>คำนวณจากข้อมูลเคสในระบบ${current ? " · <strong>เดือนนี้ยังไม่จบ ตัวเลขยังเปลี่ยนได้</strong>" : ""} · Manager ปรับคะแนนได้ ±10 พร้อมเหตุผล</p></div>
<div class="actions" style="flex-direction:row;align-items:center">
${r.canAll && owners.length ? `<select id="kp-owner" aria-label="Owner" style="width:auto">${owners.map((o) => `<option value="${o.id}" ${sel && o.id === sel.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>` : ""}
<select id="kp-month" aria-label="เดือน" style="width:auto">${months.map((m) => `<option value="${m}" ${m === month ? "selected" : ""}>${ymLabel(m)}</option>`).join("")}</select>
<button class="btn" type="button" onclick="window.print()">พิมพ์ / PDF</button></div></div>`;
    if (!sel) {
      $app.innerHTML = head + `<div class="empty">ไม่มีเคสในเดือนนี้</div>`;
      bindKpiNav();
      return;
    }
    const m = sel.metrics;
    const bars = KPI_PARTS.map(([k, label, max]) => {
      const v = sel.parts[k];
      return `<div class="kp-bar"><span>${label} (${max})</span><div class="t"><div style="width:${v == null ? 0 : Math.min(100, (v / max) * 100)}%;background:${kpiColor(v, max)}"></div></div><b>${v == null ? "-" : Math.round(v)} / ${max}</b></div>`;
    }).join("");
    const listBars = (obj, total) => {
      const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      const mx = Math.max(1, ...e.map((x) => x[1]));
      return e.length ? e.map(([k, v]) => `<div class="kp-mini"><span>${esc(k)}</span><div class="t"><div style="width:${(v / mx) * 100}%"></div></div><span>${v}</span></div>`).join("") : `<div class="hint">ไม่มีข้อมูล</div>`;
    };
    const tags = (obj, cls = "") => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="kp-tag ${cls}">${esc(k)} · ${v}</span>`).join("") || `<span class="hint">-</span>`;
    const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $app.innerHTML = `${head}
${sel.insufficient ? `<div class="banner warn">${esc(sel.name)} ปิดเคสในเดือนนี้ ${m.closed} เคส น้อยกว่า 3 เคส คะแนนจึงยังไม่ให้เกรด ใช้ดูแนวโน้มเท่านั้น</div>` : ""}
<div class="kp-g3">
<section class="card"><h2>คะแนนรวม</h2>
<div><span class="kp-score">${sel.score}</span>${sel.grade ? `<span class="kp-grade">${sel.grade}</span>` : `<span class="kp-grade na">ข้อมูลไม่พอ</span>`}</div>
<p class="muted" style="margin:6px 0 0">จาก 100 (+ โบนัส 5)${r.team.avgScore != null ? ` · ทีมเฉลี่ย ${r.team.avgScore}` : ""}</p>
<div class="kp-trend" id="kp-trend"><div class="hint">กำลังโหลดแนวโน้ม…</div></div></section>
<section class="card"><h2>คะแนนแยกตามเกณฑ์</h2>${bars}
<div class="kp-bar"><span>+ โบนัส รับเคสจากลูกค้า</span><div class="t"><div style="width:${(sel.parts.bonus / 5) * 100}%;background:#7A4FBF"></div></div><b>+${sel.parts.bonus}</b></div>
<p class="hint" style="margin:6px 0 0">รวม ${Math.round(sel.base)} + โบนัส ${sel.parts.bonus}${sel.adjust ? ` ${sel.adjust.points > 0 ? "+" : ""}${sel.adjust.points} (ปรับโดย ${esc(sel.adjust.by || "-")}: ${esc(sel.adjust.reason)})` : ""} = ${sel.score}</p></section>
<section class="card"><h2>ตัวเลขของเดือน</h2><div class="stat2" style="grid-template-columns:1fr 1fr">
${stat("ดูแล / ปิดเคส", `${sel.handled} / ${m.closed}`)}
${stat("ปิดทัน SLA เดิม", m.slaPct == null ? "-" : `${m.onTime} <span class="muted" style="font-size:14px">(${m.slaPct}%)</span>`)}
${stat("ตอบสนองครั้งแรก (มัธยฐาน)", m.firstResponseHrs == null ? "-" : `${m.firstResponseHrs} ชม.`)}
${stat("อัปเดตเคสทุก", m.updateEveryDays == null ? "-" : `${m.updateEveryDays} วัน`)}
${stat("ขยายเวลา (อนุมัติ)", `${m.extensions} ครั้ง`)}
${stat("เกิน Due สิ้นเดือน", `<span class="${m.overdueAtEnd ? "t-over" : ""}">${m.overdueAtEnd}</span>`)}
${stat("Critical", m.critical)}
${stat("รับเคสลูกค้าใน 1 ชม.", m.fastClaims)}</div></section></div>

<div class="kp-g3" style="grid-template-columns:repeat(3,minmax(0,1fr))">
<section class="card"><h2>ประเภทงานที่ทำ</h2><p class="hint" style="margin:0 0 6px">จัดกลุ่มจากหัวข้อเคสและ Activity ด้วยคำสำคัญ</p>${listBars(sel.types)}</section>
<section class="card"><h2>Skill ที่ใช้</h2><div class="hint" style="margin-bottom:4px">Product</div><div>${tags(sel.products)}</div>
<div class="hint" style="margin:10px 0 4px">ลักษณะงาน (จาก Activity)</div><div>${tags(sel.kinds, "lo")}</div>
${m.newSkills.length ? `<p style="margin:10px 0 0;font-size:14px">Skill ใหม่เดือนนี้: <strong>${esc(m.newSkills.join(", "))}</strong></p>` : ""}</section>
<section class="card"><h2>ความหลากหลายของงาน</h2>
<div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:44px;font-weight:700">${m.diversity.toFixed(2)}</span><span class="muted">${m.diversity >= 0.7 ? "สูง" : m.diversity >= 0.4 ? "ปานกลาง" : "ต่ำ"}${r.team.avgDiversity != null ? ` · ทีม ${r.team.avgDiversity.toFixed(2)}` : ""}</span></div>
<div class="kp-mini"><span>ลูกค้า</span><div class="t"><div style="width:${Math.min(100, Object.keys(sel.sites).length * 10)}%"></div></div><span>${Object.keys(sel.sites).length} ราย</span></div>
<div class="kp-mini"><span>Product</span><div class="t"><div style="width:${Math.min(100, Object.keys(sel.products).length * 16)}%"></div></div><span>${Object.keys(sel.products).length}</span></div>
<div class="kp-mini"><span>ประเภทงาน</span><div class="t"><div style="width:${Math.min(100, Object.keys(sel.types).length * 10)}%"></div></div><span>${Object.keys(sel.types).length}</span></div>
<p class="hint" style="margin:6px 0 0">0 = ทำงานแบบเดิมซ้ำๆ · 1 = กระจายเท่าๆ กันหลายแบบ</p></section></div>

<section class="card"><h2>สรุปการทำงาน</h2><div class="kp-ai">${esc(sel.summary).replace(/\n/g, "<br>")}</div></section>

${r.canAdjust ? `<section class="card noprint"><h2>ปรับคะแนนโดย Manager</h2><p class="hint" style="margin:0">ใช้กรณีที่ข้อมูลในระบบไม่สะท้อนงานจริง เช่น เคสช้าเพราะรอลูกค้าหรือ Vendor · บันทึกในประวัติการใช้งาน</p>
<div class="formgrid" style="align-items:end"><label class="f">คะแนน (−10 ถึง +10)<input type="number" id="kp-pts" min="-10" max="10" value="${sel.adjust ? sel.adjust.points : 0}"></label>
<label class="f" style="grid-column:span 2">เหตุผล<input id="kp-why" value="${esc(sel.adjust ? sel.adjust.reason : "")}" placeholder="เช่น CASE-2026-0012 ช้าเพราะรอ Vendor ไม่ใช่ความผิดของ Owner"></label>
<div class="actions"><button class="btn primary" type="button" id="kp-save">บันทึก</button></div></div></section>` : ""}

${r.canAll ? `<section class="card"><div class="title"><h2>เทียบทั้งทีม · ${ymLabel(month)}</h2><span>คลิกชื่อเพื่อดูรายละเอียด</span></div>
<div class="tablewrap"><table style="min-width:900px"><thead><tr><th>Owner</th><th class="n">คะแนน</th><th class="n">ดูแล / ปิด</th><th class="n">ทัน SLA</th><th class="n">ตอบสนอง</th><th class="n">อัปเดตทุก</th><th class="n">หลากหลาย</th><th>Skill หลัก</th></tr></thead><tbody>
${owners.map((o) => `<tr class="click" data-href="#/kpi?${qs({ month, owner: o.id })}"><td style="font-weight:600">${esc(o.name)}</td><td class="n" style="font-weight:700">${o.score} ${o.grade || `<span class="muted" style="font-weight:400">ข้อมูลไม่พอ</span>`}</td>
<td class="n">${o.handled} / ${o.metrics.closed}</td><td class="n">${o.metrics.slaPct == null ? "-" : o.metrics.slaPct + "%"}</td><td class="n">${o.metrics.firstResponseHrs == null ? "-" : o.metrics.firstResponseHrs + " ชม."}</td>
<td class="n">${o.metrics.updateEveryDays == null ? "-" : o.metrics.updateEveryDays + " วัน"}</td><td class="n">${o.metrics.diversity.toFixed(2)}</td><td>${esc(Object.entries(o.products).sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]).join(", ") || "-")}</td></tr>`).join("")}</tbody></table></div></section>` : ""}

<section class="card noprint"><details><summary style="cursor:pointer;font-weight:600">เกณฑ์การให้คะแนน</summary>
<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>เกณฑ์</th><th class="n">คะแนน</th><th>วิธีคิด</th></tr></thead><tbody>
<tr><td>1. ปิดทัน SLA</td><td class="n">30</td><td>% เคสที่ปิดทัน Due เดิม (ก่อนขยาย) · ปิดทันเวลาที่ขยายได้ครึ่งหนึ่ง · Critical นับ 2 เท่า</td></tr>
<tr><td>2. ความเร็วตอบสนอง</td><td class="n">15</td><td>Activity แรกหลังเปิดเคส ≤4 ชม. 8 · ≤8 ชม. 6 · ≤24 ชม. 4 · ≤48 ชม. 2 และอัปเดตเคสที่เปิดอยู่ทุก ≤2 วัน 7 · ≤3 วัน 5 · ≤5 วัน 3</td></tr>
<tr><td>3. ปริมาณงานถ่วงน้ำหนัก</td><td class="n">15</td><td>เคสที่ปิด × น้ำหนัก Severity (Critical 3, High 2, Medium 1.5, Low 1, ขอข้อมูล 0.5) เทียบมัธยฐานทีม · เท่ามัธยฐาน 10 · 1.5 เท่าขึ้นไป 15</td></tr>
<tr><td>4. ความยากของเคส</td><td class="n">10</td><td>สัดส่วนเคส Critical/High หรือที่ต้องเปิด Vendor / Remote / Onsite เทียบค่าเฉลี่ยทีม (เท่าทีม = 5)</td></tr>
<tr><td>5. ความหลากหลาย / Skill</td><td class="n">10</td><td>ความกระจายของประเภทงาน Product และลูกค้า (0–1) × 7 + Product ที่ทำครั้งแรก 1.5 ต่อ Product (สูงสุด 3)</td></tr>
<tr><td>6. งานค้างและการขยายเวลา</td><td class="n">10</td><td>เริ่ม 10 · หัก 2 ต่อเคสเกิน Due สิ้นเดือน · หัก 1 ต่อการขยายที่อนุมัติ (สูงสุด 3)</td></tr>
<tr><td>7. คุณภาพการบันทึก</td><td class="n">10</td><td>เคสที่ปิดมีบันทึกสุดท้าย ≥20 ตัวอักษร 5 · Activity ที่มีเนื้อหาเฉลี่ย ≥3 ต่อเคส 5</td></tr>
<tr><td>+ โบนัส</td><td class="n">5</td><td>รับเคสจากลูกค้าภายใน 1 ชม. ทุก 2 เคสได้ 1 (สูงสุด 5)</td></tr></tbody></table></div>
<p class="hint">เกรด A ≥85 · A- 80–84 · B+ 75–79 · B 70–74 · C 60–69 · D ต่ำกว่า 60 · ปิดเคสน้อยกว่า 3 เคสไม่ให้เกรด</p></details></section>

${r.canEditCategories ? `<section class="card noprint"><details><summary style="cursor:pointer;font-weight:600">ตั้งค่าประเภทงาน (คำสำคัญ)</summary>
<p class="hint">1 บรรทัดต่อ 1 ประเภท รูปแบบ <span class="mono">ชื่อประเภท: คำ1, คำ2, คำ3</span> · ระบบเลือกประเภทที่เจอคำมากที่สุดในหัวข้อเคสและ Activity · ไม่เจอเลย = อื่นๆ</p>
<textarea id="kp-cats" rows="12" style="width:100%;font-family:var(--mono, monospace);font-size:13px">${esc(r.categories.map((c) => `${c.name}: ${c.keywords}`).join("\n"))}</textarea>
<div class="actions"><button class="btn primary" type="button" id="kp-cats-save">บันทึกประเภทงาน</button></div></details></section>` : ""}`;
    bindKpiNav();
    bindRowLinks();
    const sv = document.getElementById("kp-save");
    if (sv) sv.onclick = async () => {
      try {
        await post("/kpi/adjust", { month, userId: sel.id, points: Number(document.getElementById("kp-pts").value), reason: document.getElementById("kp-why").value }, "PUT");
        toast("บันทึกการปรับคะแนนแล้ว");
        viewKpi({ month, owner: sel.id });
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    const cs = document.getElementById("kp-cats-save");
    if (cs) cs.onclick = async () => {
      const categories = document.getElementById("kp-cats").value.split("\n").map((l) => {
        const i = l.indexOf(":");
        return i > 0 ? { name: l.slice(0, i).trim(), keywords: l.slice(i + 1).trim() } : null;
      }).filter(Boolean);
      try {
        await post("/kpi/categories", { categories }, "PUT");
        toast("บันทึกประเภทงานแล้ว คำนวณใหม่ทันที");
        viewKpi({ month, owner: sel.id });
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    api(`/kpi/trend/${sel.id}?month=${month}`).then(({ trend }) => {
      const el = document.getElementById("kp-trend");
      if (!el) return;
      el.innerHTML = trend.map((t) => `<div class="${t.month === month ? "now" : ""}"><span class="c" style="height:${t.score == null ? 2 : Math.max(4, t.score)}%;${t.insufficient ? "opacity:.45" : ""}"></span>${ymLabel(t.month).split(" ")[0]}<br>${t.score == null ? "-" : t.score}</div>`).join("");
    }).catch(() => {});
  }
  function bindKpiNav() {
    const o = document.getElementById("kp-owner");
    const mo = document.getElementById("kp-month");
    const go = () => (location.hash = "#/kpi?" + qs({ month: mo.value, owner: o ? o.value : "" }));
    if (o) o.onchange = go;
    if (mo) mo.onchange = go;
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
        case "owner":
          if (parts[2] === "meeting") return await viewMeeting(decodeURIComponent(parts[1]), params);
          return await viewOwner(parts[1] ? decodeURIComponent(parts[1]) : null);
        case "reports": return await viewReports(params);
        case "audit": return await viewAudit(params);
        case "cases": return await viewCases(params);
        case "users": return await viewUsers(params);
        case "roles": return await viewRoles();
        case "audit-log": return await viewAuditLog(params);
        case "settings": return await viewSettings();
        case "password": return viewPassword();
        case "intake": return parts[1] ? await viewIntakeItem(parts[1]) : await viewIntake(params);
        case "intake-admin": return await viewIntakeAdmin();
        case "kpi": return await viewKpi(params);
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
    refreshIntakeBadge();
    setInterval(() => document.visibilityState === "visible" && refreshIntakeBadge(), 120000);
    window.addEventListener("hashchange", route);
    route();
  })();
})();
