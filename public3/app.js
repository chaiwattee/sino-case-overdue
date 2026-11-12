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
  const ROLE = { admin: "Admin", manager: "Manager", observer: "Observer", engineer: "User", viewer: "Viewer", requester: "ผู้ขอบริการ" };
  const ROLE_HINT = { admin: "ทำได้ทุกอย่าง รวมถึงจัดการผู้ใช้และตั้งค่าระบบ", manager: "ดูและแก้เคสของทีม อนุมัติขยายเวลา ส่ง Report ปรับคะแนน KPI เห็นและมอบงานได้เฉพาะคนในทีมตัวเอง", observer: "ดูได้ทุกทีมทุกหน้า (ภาพรวม เคส ราย User KPI Report ประวัติแก้ไข) แก้ไขอะไรไม่ได้", engineer: "เปิด แก้ และปิดเคสของตัวเอง เห็น KPI ของตัวเอง", viewer: "ดูภาพรวม เคส ราย ทีม ราย User และราย ลูกค้า ของทุกทีม และ Export ส่งลูกค้าได้ แก้ไขอะไรไม่ได้ ไม่เห็น KPI", requester: "พนักงานทีมอื่น ส่งคำขอบริการและดูได้เฉพาะคำขอของตัวเอง ไม่เห็นเคสลูกค้า (ระบบสร้างให้อัตโนมัติเมื่อ login ด้วยบัญชี Microsoft ของบริษัท)" };
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t && t.name === "role" && t.tagName === "SELECT") {
      const h = t.parentElement.querySelector("[data-role-hint]");
      if (h) h.textContent = ROLE_HINT[t.value] || "";
    }
  });
  const ROLE_CHIP = { admin: "overdue", manager: "r1", observer: "r2", engineer: "ok", viewer: "closed" };
  const MEETINGS = ["Meeting Onsite กับลูกค้า", "Meeting Online กับลูกค้า"];
  const DEPLOYS = ["Deploy Product Patch", "Deploy MS Patch"];
  const KINDS = ["ดำเนินการ", "ติดต่อลูกค้า", ...MEETINGS, ...DEPLOYS, "เปิดเคส Vendor", "Remote / Onsite", "รอข้อมูล"];
  const SEV_CHIP = { Critical: "overdue", High: "r2", Medium: "r1", Low: "normal", "Request information": "closed", "Deploy Product Patch": "deploy", "Deploy MS Patch": "deploy" };
  const SEV_SHORT = { "Request information": "Request info" };
  const sevChip = (v) => (v ? `<span class="chip c-${SEV_CHIP[v] || "closed"} sev" title="Severity: ${esc(v)}">${esc(SEV_SHORT[v] || v)}</span>` : "");
  // Case number CASE-2026-11-0001 (every case) with the vendor CS Number underneath.
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
  // ---- RCA from NICE: a case with a CS Number needs the vendor RCA before it can close (not for Cancel / N/A).
  const needsRca = (cs, status, lk) => !!String(cs || "").trim() && !((lk.rca && lk.rca.exempt) || ["cancel", "n/a"]).includes(String(status || "").toLowerCase());
  function rcaFieldsHtml(lk, cur = {}) {
    const R = lk.rca || { min: 30, categories: [] };
    return `<label class="f"><span class="req">สรุป RCA ตามที่ NICE ส่งมา</span><textarea name="rca_text" rows="4" placeholder="สาเหตุที่แท้จริง (root cause) ตามรายงานของ NICE และสิ่งที่ NICE แนะนำเพื่อไม่ให้เกิดซ้ำ">${esc(cur.rcaText || "")}</textarea><span class="hint" data-rca-count></span></label>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px">
<label class="f"><span class="req">หมวดสาเหตุ</span><select name="rca_cat"><option value="">เลือกหมวด</option>${R.categories.map((x) => `<option ${x === cur.rcaCategory ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
<label class="f"><span class="req">วันที่ NICE ส่ง RCA</span><input type="date" name="rca_date" value="${esc(cur.rcaDate || "")}" max="${daysAgo(0)}"></label></div>
<label class="f">ไฟล์ RCA จาก NICE (ไม่บังคับ · PDF, รูป, .msg/.eml, .docx ไม่เกิน 10 MB)${cur.rcaFileName ? `<span class="hint">ไฟล์เดิม: ${esc(cur.rcaFileName)} (เลือกไฟล์ใหม่เพื่อแทนที่)</span>` : ""}<input type="file" name="rca_file" accept=".pdf,.png,.jpg,.jpeg,.webp,.msg,.eml,.docx"></label>`;
  }
  function bindRcaCount(root, lk) {
    const t = root.querySelector("[name=rca_text]");
    const cnt = root.querySelector("[data-rca-count]");
    if (!t || !cnt) return;
    const min = (lk.rca && lk.rca.min) || 30;
    const upd = () => {
      const n = t.value.trim().length;
      cnt.textContent = `${n} ตัวอักษร · ต้องมีอย่างน้อย ${min} ตัวอักษร`;
      cnt.style.color = n >= min ? "" : "var(--r2-fg)";
    };
    t.addEventListener("input", upd);
    upd();
  }
  /** Read the RCA fields; returns {rca, file} or a string with what is missing. */
  async function readRca(root, lk) {
    const min = (lk.rca && lk.rca.min) || 30;
    const text = root.querySelector("[name=rca_text]").value.trim();
    const category = root.querySelector("[name=rca_cat]").value;
    const date = root.querySelector("[name=rca_date]").value;
    if (text.length < min) return `ใส่สรุป RCA จาก NICE อย่างน้อย ${min} ตัวอักษร`;
    if (!category) return "เลือกหมวดสาเหตุของ RCA";
    if (!date) return "ใส่วันที่ NICE ส่ง RCA";
    const fi = root.querySelector("[name=rca_file]");
    let file = null;
    if (fi && fi.files[0]) {
      const f = fi.files[0];
      if (f.size > 10 * 1024 * 1024) return "ไฟล์ RCA ต้องไม่เกิน 10 MB";
      const data = await new Promise((ok, no) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
        r.onerror = () => no(new Error("อ่านไฟล์ไม่ได้"));
        r.readAsDataURL(f);
      });
      file = { name: f.name, data };
    }
    return { rca: { text, category, date }, file };
  }
  /** Save the RCA (and file) first, then send the case update without it. Used by every close path. */
  async function saveCaseWithRca(id, body) {
    const b = { ...body };
    if (b.rca) {
      await post(`/case/${id}/rca`, { ...b.rca, file: b.rcaFile || undefined }, "PUT");
      delete b.rca;
    }
    delete b.rcaFile;
    return post("/case/" + id, b, "PUT");
  }
  async function askRca(c) {
    const lk = await lookups();
    const dlg = document.getElementById("dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dlg" }));
    dlg.innerHTML = `<form class="card" method="dialog" id="rcaf" style="min-width:min(560px,90vw)"><h2>${c.rcaText ? "แก้" : "บันทึก"} RCA จาก NICE · ${esc(caseRef(c))}</h2>
<p class="muted" style="margin:0;font-size:14px">CS Number <span class="mono">${esc(csOf(c))}</span> · ${esc(c.site || "")}</p>
${rcaFieldsHtml(lk, c)}
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">บันทึก RCA</button></div></form>`;
    const f = dlg.querySelector("#rcaf");
    bindRcaCount(f, lk);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      f.onsubmit = async (e) => {
        if (e.submitter && e.submitter.value === "cancel") return finish(null);
        e.preventDefault();
        const r = await readRca(f, lk).catch((err) => err.message);
        if (typeof r === "string") return toast(r);
        try {
          await post(`/case/${c.id}/rca`, { ...r.rca, file: r.file || undefined }, "PUT");
          dlg.close();
          finish(true);
        } catch (err) {
          toast("บันทึก RCA ไม่สำเร็จ: " + err.message, 6000);
        }
      };
      dlg.addEventListener("close", () => finish(null), { once: true });
      dlg.showModal();
    });
  }

  // ---- New customer waiting for a manager (approve / rename / merge)
  async function bindSitePending(c, reload) {
    const rb = document.getElementById("btn-site-remind");
    if (rb)
      rb.onclick = async () => {
        try {
          await post(`/customers/${c.sitePendingId}/remind`, {});
          toast("ส่งเตือน Manager แล้ว");
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const { pending: p } = await api("/customers/pending/by-name?" + qs({ site: c.site }));
    const db = document.getElementById("btn-site-decide");
    if (!p || !p.canDecide || !db) return;
    db.hidden = false;
    db.onclick = () => {
      const dlg = document.getElementById("dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dlg" }));
      dlg.innerHTML = `<form class="card" method="dialog" id="spf" style="min-width:min(560px,90vw)"><h2>ตรวจชื่อลูกค้าใหม่</h2>
<p class="muted" style="margin:0;font-size:14px"><strong>${esc(p.value)}</strong> · เพิ่มเมื่อ ${fdt(p.created_at)}${p.similar.length ? ` · ชื่อใกล้เคียง: ${esc(p.similar.map((x) => x.value).join(", "))}` : ""}</p>
<label class="chk ik-opt"><input type="radio" name="act" value="approve" checked> <span><strong>อนุมัติเป็นลูกค้าใหม่</strong><br><span class="muted">เพิ่มเข้ารายการ ทุกคนเลือกได้</span></span></label>
<label class="chk ik-opt"><input type="radio" name="act" value="merge"> <span style="flex:1"><strong>รวมกับลูกค้าที่มีอยู่</strong><br><span class="muted">เคสที่ใช้ชื่อนี้เปลี่ยนเป็นชื่อเดิม</span>
<select name="into" style="margin-top:6px"><option value="">เลือกลูกค้า</option>${p.similar.length ? `<optgroup label="ชื่อใกล้เคียง">${p.similar.map((x) => `<option value="${x.id}">${esc(x.value)}</option>`).join("")}</optgroup>` : ""}<optgroup label="ทั้งหมด">${p.all.map((x) => `<option value="${x.id}">${esc(x.value)}</option>`).join("")}</optgroup></select></span></label>
<label class="chk ik-opt"><input type="radio" name="act" value="rename"> <span style="flex:1"><strong>แก้ชื่อแล้วอนุมัติ</strong><br><input name="value" value="${esc(p.value)}" maxlength="120" style="margin-top:6px" aria-label="ชื่อที่ถูกต้อง"></span></label>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">ยืนยัน</button></div></form>`;
      const f = dlg.querySelector("#spf");
      f.into.onchange = () => (f.querySelector("input[value=merge]").checked = true);
      f.value.oninput = () => (f.querySelector("input[value=rename]").checked = true);
      f.onsubmit = async (e) => {
        if (e.submitter && e.submitter.value === "cancel") return;
        e.preventDefault();
        const act = f.querySelector("input[name=act]:checked").value;
        if (act === "merge" && !f.into.value) return toast("เลือกลูกค้าที่จะรวม");
        try {
          const r = await post(`/customers/${p.id}/decide`, { action: act, into: f.into.value, value: f.value.value });
          dlg.close();
          toast(act === "merge" ? `รวมเข้ากับ “${r.site}” แล้ว` : `อนุมัติลูกค้า “${r.site}” แล้ว`);
          LOOKUPS = null;
          reload();
        } catch (err) {
          toast(err.message, 6000);
        }
      };
      dlg.showModal();
    };
  }

  async function askResolution(c, { status, edit = false } = {}) {
    if (!edit && c.sitePendingId) {
      toast(`ปิดเคสไม่ได้: ลูกค้า “${c.site}” ยังรอ Manager อนุมัติ`, 6000);
      return null;
    }
    const lk = await lookups();
    const min = lk.resolutionMin || 20;
    const closedOpts = lk.status.filter(isClosedStatus);
    // "อื่นๆ: <text>" is stored as one value: split it for the form.
    const rcBase = String(c.rootCause || "").startsWith("อื่นๆ") ? "อื่นๆ" : c.rootCause || "";
    const rcNote = rcBase === "อื่นๆ" ? String(c.rootCause).replace(/^อื่นๆ\s*:?\s*/, "") : "";
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
<label class="f">สาเหตุของปัญหา (ไม่บังคับ)<select name="rc"><option value="">-</option>${(lk.rootCauses || []).map((x) => `<option ${x === rcBase ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
<label class="f" id="rc-other" ${rcBase === "อื่นๆ" ? "" : "hidden"}><span class="req">ระบุสาเหตุ</span><input name="rc_note" maxlength="200" value="${esc(rcNote)}" placeholder="เช่น ไฟดับที่ Data Center ของลูกค้า ระบบ restart เอง"></label>
${edit || !csOf(c) ? "" : `<div class="rca-sec" id="rca-sec"></div>`}
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
    const rcOther = dlg.querySelector("#rc-other");
    const syncRc = () => {
      rcOther.hidden = f.rc.value !== "อื่นๆ";
      f.rc_note.required = !rcOther.hidden;
      if (!rcOther.hidden && !f.rc_note.value) f.rc_note.focus();
    };
    f.rc.addEventListener("change", syncRc);
    syncRc();
    const sh = dlg.querySelector("#st-help");
    const showHelp = () => {
      const p = f.querySelector("input[name=st]:checked");
      if (sh && p) sh.innerHTML = `<strong>${esc(p.value)}:</strong> ${esc(statusHelp(p.value) || "-")}`;
    };
    f.querySelectorAll("input[name=st]").forEach((r) => r.addEventListener("change", showHelp));
    showHelp();
    // RCA section: only when the case has a CS Number, the chosen status needs it, and no RCA is saved yet.
    const rs = dlg.querySelector("#rca-sec");
    const curSt = () => { const p = f.querySelector("input[name=st]:checked"); return p ? p.value : st0; };
    const rcaNeeded = () => rs && needsRca(csOf(c), curSt(), lk);
    const keep = {};
    const drawRca = () => {
      if (!rs) return;
      ["rca_text", "rca_cat", "rca_date"].forEach((n) => { const el = rs.querySelector(`[name=${n}]`); if (el) keep[n] = el.value; });
      if (!rcaNeeded()) {
        rs.className = "rca-sec skip";
        rs.innerHTML = `<div class="rca-h"><h3>RCA จาก NICE</h3><span class="chip c-normal">ไม่บังคับเมื่อปิดเป็น ${esc(curSt())}</span></div><p class="hint" style="margin:0">ระบุเหตุผลที่ยกเลิก / ไม่ใช่เคสใน Resolution แทน</p>`;
      } else if (c.rcaText) {
        rs.className = "rca-sec ok";
        rs.innerHTML = `<div class="rca-h"><h3>RCA จาก NICE</h3><span class="chip c-normal">ใช้ RCA ที่บันทึกไว้</span></div><div class="resol sm">${esc(c.rcaText)}</div><p class="hint" style="margin:0">${esc(c.rcaCategory)} · NICE ส่ง ${fd(c.rcaDate)}${c.rcaFileName ? " · ไฟล์ " + esc(c.rcaFileName) : ""}</p>`;
      } else {
        rs.className = "rca-sec";
        rs.innerHTML = `<div class="rca-h"><h3>RCA จาก NICE <span class="mono muted" style="font-size:13px;font-weight:500">${esc(csOf(c))}</span></h3><span class="chip c-r2">จำเป็น</span></div>
<p class="hint" style="margin:0">เคสนี้มี CS Number ต้องใส่ RCA ที่ NICE สรุปมาก่อนจึงจะปิดได้</p>${rcaFieldsHtml(lk, { rcaText: keep.rca_text, rcaCategory: keep.rca_cat, rcaDate: keep.rca_date })}`;
        bindRcaCount(rs, lk);
      }
    };
    f.querySelectorAll("input[name=st]").forEach((r) => r.addEventListener("change", drawRca));
    drawRca();
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      f.onsubmit = async (e) => {
        if (e.submitter && e.submitter.value === "cancel") return finish(null);
        e.preventDefault();
        const text = f.res.value.trim();
        if (text.length < min) {
          toast(`กรุณาใส่ Resolution อย่างน้อย ${min} ตัวอักษร`);
          f.res.focus();
          return;
        }
        if (f.rc.value === "อื่นๆ" && f.rc_note.value.trim().length < 3) {
          toast("ระบุสาเหตุ เมื่อเลือก “อื่นๆ”");
          f.rc_note.focus();
          return;
        }
        const picked = f.querySelector("input[name=st]:checked");
        let rcaOut = null;
        if (!edit && rcaNeeded() && !c.rcaText) {
          rcaOut = await readRca(rs, lk).catch((err) => err.message);
          if (typeof rcaOut === "string") {
            toast(rcaOut);
            return;
          }
        }
        dlg.close();
        finish({ status: edit ? undefined : picked ? picked.value : st0, resolution: text, root_cause: f.rc.value, root_cause_note: f.rc.value === "อื่นๆ" ? f.rc_note.value.trim() : undefined, ...(rcaOut ? { rca: rcaOut.rca, rcaFile: rcaOut.file } : {}) });
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
      ["owner", "#/owner", "ราย User", true],
      ["customer", "#/customer", "ราย ลูกค้า", true],
      ["team", "#/team", "ราย ทีม", ["admin", "manager", "observer", "viewer"].includes(ME.user.role)],
      ["pm", "#/pm", "งาน PM", ME.user.role !== "viewer"],
      ["skills", "#/skills", "Skill Map", ["admin", "manager", "observer"].includes(ME.user.role)],
      ["kpi", "#/kpi", "KPI (ทดลองใช้)", ME.user.role !== "viewer" && ME.user.role !== "requester" && (!["response", "none"].includes(ME.kpiProfile) || ["admin", "manager", "observer"].includes(ME.user.role))],
      ["response", "#/response", "การตอบกลับ", ME.kpiProfile === "response" || !!ME.responseTeams],
      ["rank", "#/rank", "อันดับ KPI", !!(ME.leaderboard && ME.leaderboard.visible)],
      ["reports", "#/reports", "Report &amp; Export", lvl("export") !== "none" || lvl("reports_manage") !== "none"],
      ["audit", "#/audit", "ประวัติแก้ไข", lvl("audit_view") !== "none"],
      ["users", "#/users", "จัดการผู้ใช้", lvl("users_manage") !== "none"],
      ["settings", "#/settings", "ตั้งค่า", lvl("settings_manage") !== "none"],
    ];
    tabs.splice(3, 0, ["sr", "#/sr", "คำขอบริการ", ME.user.role !== "viewer"]);
    const shown = tabs.filter((t) => t[3] && (ME.user.role !== "requester" || t[0] === "sr" || t[0] === "response"));
    const link = ([k, h, l]) => `<a href="${h}" data-nav="${k}">${l}</a>`;
    // Pages are grouped into a few dropdowns; a group with one page is a plain link.
    const html = NAV_GROUPS.map(([gk, gl, keys]) => {
      const items = keys.map((k) => shown.find((t) => t[0] === k)).filter(Boolean);
      if (!items.length) return "";
      if (items.length === 1) return `<div class="ngrp solo" data-grp="${gk}">${link(items[0])}</div>`;
      return `<div class="ngrp" data-grp="${gk}"><button type="button" class="ngrp-btn" aria-expanded="false" aria-haspopup="true"><span class="ngrp-l">${gl}</span><span class="badge gbadge" hidden></span><svg class="ngrp-car" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<div class="ngrp-menu">${items.map(link).join("")}</div></div>`;
    }).join("");
    document.getElementById("tabs").innerHTML = html;
    bindNavBtn();
    bindNavGroups();
    const u = ME.user;
    paintMeAvatar();
    document.getElementById("me-name").innerHTML = `${esc(u.display_name.split(" ")[0])} <span class="muted">· ${ROLE[u.role]}</span>`;
    document.getElementById("me-head").innerHTML = `<strong>${esc(u.display_name)}</strong>${esc(u.email)}<br>${ROLE[u.role]} · ${
      ["admin", "observer", "viewer"].includes(u.role) ? "ทุกทีม" : esc(u.teams.map((t) => teamLabel(t)).join(", ") || "ยังไม่มีทีม")
    }`;
    document.getElementById("menu-pw").hidden = u.auth_type !== "local";
    const mp = document.getElementById("menu-profile");
    if (mp) mp.hidden = false;
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
  // Top menu groups: [key, label, page keys]. Pages a user can't open are left out.
  const NAV_GROUPS = [
    ["work", "งานของฉัน", ["mine", "intake", "sr", "pm"]],
    ["view", "ภาพรวม", ["overview", "team", "owner", "customer"]],
    ["team", "ทีมและผลงาน", ["kpi", "response", "rank", "skills"]],
    ["report", "Report", ["reports"]],
    ["admin", "ผู้ดูแลระบบ", ["users", "settings", "audit"]],
  ];
  function closeGroups(except) {
    document.querySelectorAll("#tabs .ngrp.open").forEach((g) => {
      if (g === except) return;
      g.classList.remove("open");
      const b = g.querySelector(".ngrp-btn");
      if (b) b.setAttribute("aria-expanded", "false");
    });
  }
  function bindNavGroups() {
    const t = document.getElementById("tabs");
    t.querySelectorAll(".ngrp-btn").forEach((b) => {
      const g = b.parentElement;
      b.onclick = (e) => {
        e.stopPropagation();
        const open = !g.classList.contains("open");
        closeGroups(g);
        g.classList.toggle("open", open);
        b.setAttribute("aria-expanded", String(open));
        if (open && e.detail === 0) {
          const first = g.querySelector(".ngrp-menu a");
          if (first) first.focus();
        }
      };
      g.addEventListener("keydown", (e) => {
        if (!["ArrowDown", "ArrowUp"].includes(e.key) || !g.classList.contains("open")) return;
        const links = [...g.querySelectorAll(".ngrp-menu a")];
        const i = links.indexOf(document.activeElement);
        const n = e.key === "ArrowDown" ? (i + 1) % links.length : (i - 1 + links.length) % links.length;
        e.preventDefault();
        links[n].focus();
      });
    });
    document.addEventListener("click", (e) => !e.target.closest("#tabs .ngrp") && closeGroups());
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const g = document.querySelector("#tabs .ngrp.open");
      closeGroups();
      if (g) g.querySelector(".ngrp-btn").focus();
    });
    // A group's badge is the sum of the waiting counts of the pages inside it.
    const sumBadges = () =>
      t.querySelectorAll(".ngrp:not(.solo)").forEach((g) => {
        const n = [...g.querySelectorAll(".ngrp-menu .badge:not([hidden])")].reduce((s, b) => s + (parseInt(b.textContent, 10) || 0), 0);
        const gb = g.querySelector(".gbadge");
        if (String(n || "") !== gb.textContent) gb.textContent = n || "";
        if (gb.hidden !== !n) gb.hidden = !n;
      });
    new MutationObserver(sumBadges).observe(t, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
    sumBadges();
  }
  function setNav(name) {
    let cur = null;
    document.querySelectorAll("#tabs a[data-nav]").forEach((a) => {
      a.classList.toggle("active", a.dataset.nav === name);
      if (a.dataset.nav === name) cur = a;
    });
    document.querySelectorAll("#tabs .ngrp").forEach((g) => g.classList.toggle("on", !!(cur && g.contains(cur))));
    closeGroups();
    // Phone: the menu button shows the current page; the menu closes after choosing.
    const lbl = document.getElementById("nav-cur");
    if (lbl) lbl.textContent = cur ? cur.firstChild.textContent.trim() : "เมนู";
    closeNav();
  }
  function closeNav() {
    const t = document.getElementById("tabs");
    const b = document.getElementById("nav-btn");
    if (t) t.classList.remove("open");
    if (b) b.setAttribute("aria-expanded", "false");
  }
  function bindNavBtn() {
    const b = document.getElementById("nav-btn");
    const t = document.getElementById("tabs");
    if (!b || !t) return;
    b.onclick = (e) => {
      e.stopPropagation();
      const open = !t.classList.contains("open");
      t.classList.toggle("open", open);
      b.setAttribute("aria-expanded", String(open));
    };
    t.addEventListener("click", (e) => e.target.closest("a") && closeNav());
    document.addEventListener("click", (e) => !t.contains(e.target) && closeNav());
    document.addEventListener("keydown", (e) => e.key === "Escape" && closeNav());
    // A red dot on the menu button when any tab has a waiting-count badge.
    const dot = document.getElementById("nav-dot");
    const sync = () => {
      const on = !!t.querySelector(".badge:not([hidden]), .nbadge:not([hidden]), .count:not([hidden])");
      if (dot.hidden === on) dot.hidden = !on;
    };
    new MutationObserver(sync).observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    sync();
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

  function rcaCard(c, permsC) {
    const closed = c.stage === "closed";
    const btn = permsC.edit ? `<button class="btn" type="button" id="btn-rca" style="min-height:34px">${c.rcaText ? "แก้ไข" : "บันทึก RCA"}</button>` : "";
    if (c.rcaText)
      return `<section class="card"><div class="title"><h2>RCA จาก NICE</h2>${btn}</div><div class="resol">${esc(c.rcaText)}</div>
<p class="muted" style="margin:0;font-size:13px">${esc(c.rcaCategory)} · NICE ส่ง ${fd(c.rcaDate, true)}${c.rcaFileName ? ` · <a href="api/case/${c.id}/rca/file" target="_blank" rel="noopener">📎 ${esc(c.rcaFileName)}</a>` : ""}<br>บันทึกโดย ${esc(c.rcaBy || "-")}${c.rcaAt ? " · " + fdt(c.rcaAt) : ""}</p></section>`;
    if (closed) return `<section class="card"><div class="title"><h2>RCA จาก NICE</h2>${btn}</div><div class="resol none">ไม่มี RCA ${["cancel", "n/a"].includes(String(c.status).toLowerCase()) ? `(ปิดเป็น ${esc(c.status)})` : "(ปิดก่อนเริ่มบังคับ)"}</div></section>`;
    return `<section class="card rca-wait"><div class="title"><h2>RCA จาก NICE</h2><span class="chip c-r1">รอ RCA จาก NICE</span></div>
<p style="margin:0;font-size:14px">เคสนี้มี CS Number <span class="mono">${esc(csOf(c))}</span> ต้องมี RCA จาก NICE ก่อนจึงจะปิดเคสได้ (ยกเว้นปิดเป็น Cancel หรือ N/A) ถ้า NICE ส่งมาแล้วบันทึกไว้ก่อนได้ ตอนปิดเคสไม่ต้องกรอกซ้ำ</p>${btn ? `<div>${btn}</div>` : ""}</section>`;
  }
  const rcaTag = (c) => (c.rcaPending ? ` <span class="chip c-r1" title="มี CS Number ต้องมี RCA จาก NICE ก่อนปิด">รอ RCA</span>` : "") + (c.sitePendingId && c.stage !== "closed" ? ` <span class="chip c-r1" title="ลูกค้าใหม่ รอ Manager อนุมัติชื่อก่อนปิดเคส">ลูกค้ารออนุมัติ</span>` : "");
  function resLine(c, { missing = false } = {}) {
    if (c.stage !== "closed") return "";
    if (c.resolution) return `<div class="resol sm" title="${esc(c.resolution)}">${c.status && !["success", "resolved"].includes(c.status.toLowerCase()) ? `Resolution (${esc(c.status)}): ` : "Resolution: "}${esc(c.resolution)}</div>`;
    return missing ? `<div class="resol sm none">ไม่มี Resolution (ปิดก่อนเริ่มบังคับ)</div>` : "";
  }
  function caseTable(cases, { showOwner = true, missingRes = false, empty = "ไม่มีเคส" } = {}) {
    if (!cases.length) return `<div class="empty">${empty}</div>`;
    return `<div class="tablewrap"><table style="min-width:${showOwner ? 1080 : 980}px">
<thead><tr><th>เลขเคส</th><th>ลูกค้า</th><th>Severity</th><th>งาน</th>${showOwner ? "<th>User</th>" : ""}<th>ทีม</th><th>เปิดเคส</th><th>Due</th><th>อายุเคส</th><th>สถานะ</th></tr></thead>
<tbody>${cases
      .map(
        (c) => `<tr class="click" data-href="#/case/${c.id}">
<td>${caseCell(c, `#/case/${c.id}`)}</td>
<td style="font-weight:600">${c.customerUnconfirmed ? `<span class="chip c-r1">ยังไม่ยืนยัน</span> <span class="muted" style="font-weight:500">${esc(c.customerUnconfirmed)}</span>` : esc(c.site || "-")}</td>
<td>${sevChip(c.severity)}</td>
<td style="font-size:13px">${esc(c.task || "")}${resLine(c, { missing: missingRes })}</td>
${showOwner ? `<td><a href="#/owner/${encodeURIComponent(c.ownerId)}">${esc(c.owner || "-")}</a></td>` : ""}
<td>${esc(c.sourceLabel)}</td>
<td>${fd(c.startDate)}</td>
<td>${c.extCount ? `<span class="muted" style="text-decoration:line-through">${fd(c.origDueDate)}</span>` : fd(c.dueDate)}</td>
<td>${c.extCount ? `<small class="muted">รวม ${c.totalAge} วัน · ขยายแล้ว</small>` : ageCell(c)}</td>
<td>${c.extCount ? "" : chip(c.stage)}${extTag(c)}${rcaTag(c)}<div class="muted" style="font-size:12px;margin-top:4px">${esc(c.status || "")}</div></td>
</tr>${extRow(c, { before: showOwner ? 6 : 5, after: 1 })}`
      )
      .join("")}</tbody></table></div>`;
  }

  const FIELD = { extension: "ขยายเวลา (Due)", severity: "Severity", start_date: "Start date", target_date: "Target date", status: "Status", owner: "User", deleted: "ลบเคส", resolution: "Resolution", team: "ทีม" };
  const DIR = { later: "เลื่อนออกไป", earlier: "เลื่อนเข้ามา", set: "ใส่ค่าใหม่", cleared: "ลบค่าออก" };
  function changeRows(changes, { empty = "ยังไม่มีประวัติการแก้ไข" } = {}) {
    if (!changes.length) return `<div class="empty">${empty}</div>`;
    const val = (c, v) => (c.field === "start_date" || c.field === "target_date" || c.field === "extension" ? fd(v, true) : esc(v || "-"));
    return `<div class="tablewrap"><table style="min-width:860px"><thead><tr><th>เมื่อ</th><th>เลขเคส</th><th>ลูกค้า</th><th>User</th><th>รายการ</th><th>เดิม → ใหม่</th><th>แก้โดย</th></tr></thead><tbody>${changes
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
    const [data, ikHtml, extHtml, lk, srAll, cp] = await Promise.all([api("/overview?" + qs({ source: params.source })), intakeSection(), Promise.all([extPendingSection(), transferPendingSection()]).then((a) => a.join("")), lookups(), srList("team"), api("/customers/pending").catch(() => ({ list: [] }))]);
    const cpHtml = cp.list.length
      ? `<section class="card" style="border-color:var(--r1)"><div class="title"><h2>ลูกค้าใหม่รออนุมัติ (${cp.list.length})</h2><span>เคสปิดไม่ได้จนกว่าจะตรวจชื่อ</span></div>
<div class="stack" style="gap:8px">${cp.list.map((x) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><span><strong>${esc(x.value)}</strong> <span class="muted">· เพิ่มโดย ${esc(x.created_by || "-")} ${fdt(x.created_at)}${x.similar.length ? ` · ใกล้เคียง: ${esc(x.similar.map((v) => v.value).join(", "))}` : ""}</span></span>${x.cases[0] ? `<a class="btn" href="#/case/${x.cases[0].id}" style="min-height:32px">${x.canDecide ? "ตรวจชื่อ" : "ดูเคส"} · ${esc(x.cases[0].caseNo || "#" + x.cases[0].id)}</a>` : ""}</div>`).join("")}</div></section>`
      : "";
    const srTeam = srAll.filter((r) => !params.source || r.team === params.source);
    const srCount = (st) => srTeam.filter((r) => (st === "pending" ? ["pending", "info"].includes(r.status) : r.status === st)).length;
    const srLate = srTeam.filter((r) => r.status === "overdue").sort((a, b) => b.overdueDays - a.overdueDays);
    const srHtml = srCount("pending") + srCount("in_progress") + srCount("overdue")
      ? `<section class="card srsum"><div class="title"><h2>คำขอบริการภายใน</h2><a href="#/sr?scope=team">ดูทั้งหมด</a></div>
<div class="kpis">
<a class="kpi k-r1" href="#/sr?scope=team&status=pending"><div class="l">รออนุมัติ</div><div class="v">${srCount("pending")}</div></a>
<a class="kpi k-normal" href="#/sr?scope=team&status=in_progress"><div class="l">กำลังดำเนินการ</div><div class="v">${srCount("in_progress")}</div></a>
<a class="kpi k-overdue" href="#/sr?scope=team&status=overdue"><div class="l">เลย Target</div><div class="v">${srCount("overdue")}</div></a>
</div>${srLate.length ? srWorkTable(srLate.slice(0, 5), { showAssignee: true }) : ""}</section>`
      : "";
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
<p>ทุกเคสต้องปิดภายใน ${cfg.slaDays} วันนับจาก Start date ระบบส่ง email ถึง User ในวันที่ ${cfg.alert1Day} วันที่ ${cfg.alert2Day} และทุกวันหลังเกิน Due</p></div>
<div class="actions">
${lvl("export") === "all" ? `<a class="btn" href="api/export?${qs({ from: daysAgo(29), to: daysAgo(0), source: params.source })}">Export Excel (30 วัน)</a>` : ""}
${can("case_create") ? `<a class="btn primary" href="#/case/new">เปิดเคสใหม่</a>` : ""}</div></div>
${cpHtml}
${extHtml}
${ikHtml}
${srHtml}
<form class="ofilters" id="flt" onsubmit="return false">
<label class="f">ทีม<select name="source"><option value="">ทุกทีมที่เห็นได้ (${data.sources.length})</option>${teamOpts}</select></label>
<label class="f">ค้นหาเคส<input type="search" name="q" placeholder="เลขเคส, CS, งาน, User, Resolution"></label>
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
<section class="card"><div class="title"><h2>สถานะแยกตาม User</h2><span>คลิกแถวเพื่อดูรายเคส</span></div>
${data.owners.length ? `<div class="tablewrap"><table style="min-width:820px"><thead><tr><th>User</th><th class="n">เปิดอยู่</th><th class="n">ปกติ</th><th class="n">แจ้งรอบ 1</th><th class="n">แจ้งรอบ 2</th><th class="n">เกิน Due</th><th class="n">ปิดทัน SLA (30 วัน)</th></tr></thead><tbody>
${data.owners.map((o) => `<tr class="click" data-href="#/owner/${encodeURIComponent(o.id)}">
<td><a href="#/owner/${encodeURIComponent(o.id)}" style="font-weight:600">${esc(o.owner)}</a><div class="muted" style="font-size:12px">${esc(o.email || "-")}</div></td>
<td class="n" style="font-weight:600">${o.open}</td><td class="n">${o.normal}</td><td class="n t-r1">${o.r1}</td><td class="n t-r2">${o.r2}</td><td class="n t-over">${o.overdue}</td>
<td class="n">${o.sla.pct === null ? "-" : `${o.sla.pct}% <span class="muted">(${o.sla.onTime}/${o.sla.closed})</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีเคส</div>`}
</section>
${data.topCases.length ? `<section class="card"><div class="title"><h2>เคสที่ต้องตามด่วน</h2><span>แจ้งรอบ 2 และเกิน Due · 10 อันดับแรก</span></div>${caseTable(data.topCases)}</section>` : ""}
<section class="card"><div class="title"><h2>Email แจ้งเตือนที่ส่งวันนี้</h2><span>${(() => { const r = cfg.alertRules || {}; const t = (r.ccTypes || []).map((x) => ALERT[x]); return r.cc && t.length ? `ถึง User · CC ${esc(r.cc)} เฉพาะ${esc(t.join(", "))}` : "ถึง User เท่านั้น"; })()}</span></div>
${data.alertsToday.length ? `<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>เวลา</th><th>เลขเคส</th><th>ลูกค้า</th><th>User</th><th>ประเภท</th><th>ผล</th></tr></thead><tbody>
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
    bindTransferPending($app);
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
      (!q || [c.caseNo, c.caseNoOld, c.csNumber, c.site, c.owner, c.task, c.product, c.note, c.resolution].some((v) => String(v || "").toLowerCase().includes(q)))
    );
    const stSet = new Set(st);
    const byStatus = base.filter((c) => !st.length || stSet.has(c.status));
    const isFlag = { overdue: (c) => c.stage === "overdue", ext: (c) => (c.extCount || 0) > 0, unconf: (c) => !!c.customerUnconfirmed };
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
    const sites = [...new Set(allCases.filter((c) => !c.customerUnconfirmed).map((c) => c.site).filter(Boolean))].sort((x, y) => x.localeCompare(y, "th"));
    const siteCount = params.site ? allCases.filter((c) => c.site === params.site).length : 0;

    const parts = [];
    if (params.site) parts.push(`ลูกค้า ${params.site}`);
    if (grp === "open") parts.push("ยังไม่ปิด");
    else if (grp === "closed") parts.push("ปิดแล้ว");
    else if (grp === "") parts.push(st.join(", ") || "ไม่ได้เลือก Status");
    if (stage) parts.push(STAGE[stage]);
    if (flag === "overdue") parts.push("เกิน Due");
    if (flag === "ext") parts.push("มีการขยายเวลา");
    if (flag === "unconf") parts.push("ลูกค้ายังไม่ยืนยัน");
    if (params.q) parts.push(`“${params.q}”`);
    const showRes = cases.some((c) => c.stage === "closed");

    $app.innerHTML = `<div class="crumb"><a href="#/">ภาพรวม</a> / ค้นหาเคส</div>
<div class="head"><div><h1>ค้นหาเคส</h1><p>พบ ${cases.length} เคส</p></div>
<div class="actions">${lvl("export") === "all" && cases.length ? `<button class="btn" type="button" id="cs-export">Export ผลค้นหาเป็น Excel</button>` : ""}</div></div>
<section class="card" style="gap:16px">
<form class="sfilters" id="sf" onsubmit="return false">
<label class="f">คำค้น<input type="search" name="q" value="${esc(params.q || "")}" placeholder="เลขเคส, CS, งาน, User, Resolution"></label>
<div class="site-pick">${comboBox("site", params.site || "", sites, { allowNew: false, required: false, label: "ลูกค้า" })}${params.site ? `<button type="button" class="clear" id="site-clear" aria-label="ล้างลูกค้า">×</button>` : ""}</div>
<label class="f">ทีม<select name="source"><option value="">ทุกทีม</option>${teams.map(([k, l]) => `<option value="${esc(k)}" ${k === params.source ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
<label class="f">User<select name="owner"><option value="">ทุกคน</option>${owners.map(([id, n]) => `<option value="${esc(id)}" ${id === params.owner ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
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
${flag === "unconf" || byStatus.some(isFlag.unconf) ? pill(flag === "unconf", link({ flag: flag === "unconf" ? "" : "unconf" }), "ลูกค้ายังไม่ยืนยัน", byStatus.filter(isFlag.unconf).length, "เคสจาก email ที่โดเมนยังไม่ผูกกับลูกค้า รอ User ยืนยันว่าเป็นลูกค้ารายไหน") : ""}
</div>
<span class="hint">“ยังไม่ปิด” = ${esc(openSt.join(", "))} · “ปิดแล้ว” = ${esc(closedSt.join(", "))} · กด Status ทีละตัวเพื่อเลือกหลายตัว · ตัวเลข = จำนวนเคสตามคำค้น ลูกค้า ทีม User และช่วงวันที่ที่เลือก</span>
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
    const [{ cases }, lk, ikHtml, extHtml, srAll] = await Promise.all([api("/cases?mine=1"), lookups(), intakeSection(), Promise.all([extPendingSection(), transferPendingSection()]).then((a) => a.join("")), srList("assigned")]);
    const srMine = srAll.filter(srOpen).sort(srByTarget);
    const srLate = srMine.filter((r) => r.status === "overdue" || r.daysLeft === 0 || r.daysLeft === 1);
    const tab = params.tab || "open";
    const open = cases.filter((c) => c.stage !== "closed");
    const closed30 = cases.filter((c) => c.stage === "closed" && (c.endDate || "") >= daysAgo(30));
    const rcaWait = open.filter((c) => c.rcaPending);
    let list = tab === "open" ? open : tab === "closed" ? closed30 : tab === "rca" ? rcaWait : cases;
    if (params.q) {
      const s = params.q.toLowerCase();
      list = list.filter((c) => [c.caseNo, c.caseNoOld, c.csNumber, c.site, c.task, c.product, c.severity, c.resolution].some((v) => String(v || "").toLowerCase().includes(s)));
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
${srMine.length ? `<a class="kpi k-sr" href="#mine-sr"><div class="l">คำขอบริการค้าง</div><div class="v">${srMine.length}</div><div class="s">${srMine.filter((r) => r.status === "overdue").length ? `เลย Target ${srMine.filter((r) => r.status === "overdue").length}` : "ไม่มีที่เลย Target"}</div></a>` : ""}
</div>
${srLate.length ? `<div class="banner warn" role="status">คำขอบริการ: ${srLate.map((r) => `<a href="#/sr/${r.id}">${esc(r.srNo)}</a> ${esc(r.title)} ${r.status === "overdue" ? `เลย Target ${r.overdueDays} วันทำการ` : r.daysLeft === 0 ? "ครบ Target วันนี้" : "ครบ Target วันทำการถัดไป"}`).join(" · ")}</div>` : ""}
<section class="card">
<div class="title"><div class="tabs2" role="tablist">
<a role="tab" href="#/mine?tab=open" class="${tab === "open" ? "on" : ""}" aria-selected="${tab === "open"}">ยังเปิดอยู่ (${open.length})</a>
<a role="tab" href="#/mine?tab=closed" class="${tab === "closed" ? "on" : ""}" aria-selected="${tab === "closed"}">ปิดแล้ว 30 วัน (${closed30.length})</a>
<a role="tab" href="#/mine?tab=all" class="${tab === "all" ? "on" : ""}" aria-selected="${tab === "all"}">ทั้งหมด (${cases.length})</a>
${rcaWait.length || tab === "rca" ? `<a role="tab" href="#/mine?tab=rca" class="${tab === "rca" ? "on" : ""}" aria-selected="${tab === "rca"}">รอ RCA จาก NICE (${rcaWait.length})</a>` : ""}</div>
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
<td>${statusSel(c)}${c.rcaPending ? `<div style="margin-top:4px">${rcaTag(c)}</div>` : ""}</td>
<td style="font-size:13px" class="muted">${fdt(c.updatedAt)}</td>
<td style="text-align:right"><a href="#/case/${c.id}" style="font-weight:600">แก้ไข</a></td></tr>${extRow(c, { before: 5, after: 3 })}`).join("")}</tbody></table></div>` : `<div class="empty">${tab === "open" ? "ไม่มีเคสที่เปิดอยู่ กด “เปิดเคสใหม่” เพื่อเริ่ม" : "ไม่มีเคส"}</div>`}
</section>
<section class="card" id="mine-sr"><div class="title"><h2>คำขอบริการที่ได้รับมอบหมาย (${srMine.length})</h2><span>งานภายในจากทีมอื่น นับตาม Target date ที่ Manager ตั้ง ไม่ใช่ SLA ${cfg.slaDays} วัน · <a href="#/sr?scope=assigned">ดูทั้งหมด</a></span></div>
${srWorkTable(srMine)}</section>
<p class="hint">เปลี่ยน Status ในตารางแล้วบันทึกทันที ถ้าเลือก Success, Resolved, Cancel หรือ N/A ระบบจะให้กรอก Resolution ก่อนปิด แล้วใส่ End date ให้และหยุดแจ้งเตือน เคสที่มี CS Number ต้องใส่ RCA จาก NICE ด้วย (ยกเว้น Cancel / N/A)</p>`;
    bindRowLinks();
    bindIntakeActions($app, () => route());
    bindExtPending($app);
    bindTransferPending($app);
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
          await saveCaseWithRca(sel.dataset.status, body);
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
  function comboBox(name, value, options, { allowNew = true, required = true, label = "", newHint = "พิมพ์ชื่อใหม่ได้ ระบบจะเพิ่มเข้า dropdown ให้ทุกคนใช้ต่อ และแจ้ง Admin ตรวจชื่อซ้ำ" } = {}) {
    return `<div class="combo" data-combo="${name}">
<label class="f"><span class="${required ? "req" : ""}">${label}</span>
<input type="text" name="${name}" value="${esc(value || "")}" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" ${required ? "required" : ""}></label>
<div class="combo-list" role="listbox" hidden></div>
${allowNew ? `<span class="hint">${newHint}</span>` : ""}</div>`;
  }
  function bindCombo(root, name, options, { allowNew = true, onPick = null, newLabel = (v) => `+ เพิ่ม “${esc(v)}” เป็นรายการใหม่` } = {}) {
    const wrap = root.querySelector(`[data-combo="${name}"]`);
    const input = wrap.querySelector("input");
    const list = wrap.querySelector(".combo-list");
    let hl = -1;
    const render = () => {
      const v = input.value.trim().toLowerCase();
      // Also suggest names sharing a word (3+ letters), so a new name shows look-alikes before it is added.
      const words = v.split(/[\s.,()\-/]+/).filter((w) => w.length >= 3);
      const matches = options.filter((o) => !v || o.toLowerCase().includes(v) || words.some((w) => o.toLowerCase().includes(w))).slice(0, 12);
      const exact = options.some((o) => o.toLowerCase() === v);
      const items = matches.map((o) => `<button type="button" role="option" data-v="${esc(o)}">${esc(o)}</button>`);
      if (allowNew && v && !exact) items.push(`<button type="button" role="option" class="add-new" data-v="${esc(input.value.trim())}">${newLabel(input.value.trim())}</button>`);
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
      .join("") + (c.status && !lk.status.includes(c.status) ? `<option selected>${esc(c.status)}</option>` : ""); // e.g. Transferred, set only by a transfer
    const productOpts = [`<option value="">-</option>`, ...lk.product.map((p) => `<option ${p === c.product ? "selected" : ""}>${esc(p)}</option>`)].join("");
    const ownerField = permsC.reassign
      ? `<label class="f">User<select name="owner_id">${usersRes.users
          .filter((u) => u.teams.includes(c.team) || u.id === c.ownerUserId)
          .map((u) => `<option value="${u.id}" ${u.id === c.ownerUserId ? "selected" : ""}>${esc(u.display_name)}</option>`)
          .join("")}</select></label>`
      : `<label class="f">User<input type="text" value="${esc(c.owner || "-")}" readonly></label>`;

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
<div class="head"><div><h1>${isNew ? "เปิดเคสใหม่" : `เคส <span class="mono" style="font-size:26px">${esc(caseRef(c))}</span> <span class="muted" style="font-size:16px;font-weight:500">${c.site && !c.customerUnconfirmed ? `<a href="#/customer?site=${encodeURIComponent(c.site)}" title="ดูภาพรวมลูกค้า">${esc(c.site)}</a>` : esc(c.site || "")}${csOf(c) ? " · " + esc(csOf(c)) : ""}</span>`}</h1>
<p>${isNew ? "Start date จะบันทึกเป็นวันนี้อัตโนมัติ และ Due = Start date + " + cfg.slaDays + " วัน" : `${esc(c.sourceLabel)} · User ${esc(c.owner || "-")} · ${chip(c.stage)} ${sevChip(c.severity)}`}</p></div>
<div class="actions">
${!isNew && c.site && !c.customerUnconfirmed && lvl("export") === "all" ? `<a class="btn" href="#/reports?site=${encodeURIComponent(c.site)}">Export เคสของ ${esc(c.site)}</a>` : ""}
${!isNew && permsC.delete ? `<button class="btn danger" type="button" id="btn-del">ลบเคส</button>` : ""}
${!isNew && !closed && permsC.close ? `<button class="btn" type="button" id="btn-close" style="color:var(--normal-fg)">ปิดเคส</button>` : ""}
${!ro ? `<button class="btn primary" type="submit" form="cf">${isNew ? "เปิดเคส" : "บันทึก"}</button>` : ""}</div></div>
${ro && !c.transferredTo ? `<div class="banner warn">คุณดูเคสนี้ได้อย่างเดียว ไม่มีสิทธิ์แก้ไข</div>` : ""}
${!isNew && c.sitePendingId ? `<div class="banner warn unconf" id="site-pending"><div><strong>ลูกค้าใหม่รอ Manager อนุมัติ</strong> · ${esc(c.site)}<br><span style="font-size:13px">ทำงานต่อได้ตามปกติ แต่ปิดเคสได้หลัง Manager ของทีมอนุมัติชื่อ แก้ชื่อ หรือรวมกับลูกค้าที่มีอยู่</span></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" id="btn-site-remind">เตือน Manager อีกครั้ง</button><button class="btn primary" type="button" id="btn-site-decide" hidden>ตรวจชื่อลูกค้า</button></div></div>` : ""}
${!isNew ? transferBanner(c, data.transfer) : ""}
${!isNew && c.customerUnconfirmed ? `<div class="banner warn unconf"><div><strong>ลูกค้ายังไม่ยืนยัน</strong> · ${esc(c.customerUnconfirmed)}${data.intake ? `<br><span style="font-size:14px">ผู้แจ้ง ${esc(data.intake.contact_name || "-")}${data.intake.contact_phone ? ` · <a href="tel:${esc(data.intake.contact_phone.replace(/[^+0-9]/g, ""))}">${esc(data.intake.contact_phone)}</a>` : ""}${data.intake.contact_email ? ` · ${esc(data.intake.contact_email)}` : ""} · ${esc(data.intake.req_no)}</span>` : ""}<br><span style="font-size:13px">โทรถามลูกค้าว่าเป็นบริษัทไหน แล้วกด “ยืนยันลูกค้า” เคสนี้จะเข้ารายงานและ KPI ของลูกค้ารายนั้น</span></div>${permsC.edit ? `<button class="btn primary" type="button" id="btn-confirm-cust">ยืนยันลูกค้า</button>` : ""}</div>` : ""}
<div class="cols">
<form id="cf" class="main" novalidate>
<fieldset class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px" ${ro ? "disabled" : ""}>
<legend style="font-size:15px;font-weight:600">ข้อมูลเคส</legend>
<label class="f">CS Number<input type="text" name="cs_number" value="${esc(c.csNumber || "")}" class="mono" placeholder="เช่น CS5056186"></label>
${comboBox("site", c.site, lk.site, { label: "Site / ลูกค้า", allowNew: !ro, newHint: "ไม่มีในรายการ พิมพ์ชื่อใหม่ได้ เคสเริ่มงานได้ทันที แต่ต้องให้ Manager ของทีมอนุมัติชื่อก่อนปิดเคส" })}
<label class="f"><span class="req">Severity</span><select name="severity" required>${isNew ? `<option value="">เลือก Severity</option>` : ""}${(lk.severity || []).map((x) => `<option ${x === c.severity ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
<label class="f">Product<select name="product">${productOpts}</select></label>
<label class="f"><span class="req">Status</span><select name="status">${statusOpts}</select><span class="hint" id="st-hint">${esc(statusHelp(c.status))}</span></label>
<label class="f"><span class="req">ทีม</span><select name="team" ${!isNew && !(permsC.reassign && ME.user.role === "admin") ? "disabled" : ""}>${teamOpts}</select>${!isNew && !closed ? `<span class="hint">ย้ายไปทีมอื่นใช้ “ขอโอนข้ามทีม” ให้ Manager ทั้ง 2 ทีมยืนยัน</span>` : ""}</label>
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
${isNew ? "" : transferCard(c, data.transfer, closed)}
${closed ? "" : `<section class="card sim-card" id="sim-card" hidden></section>`}
${data ? checklistCard(data.checklist, c, permsC, data.ma, data.files || []) : ""}
${data && data.csat ? csatCard(data.csat) : ""}
${closed ? `<section class="card"><div class="title"><h2>Resolution</h2>${permsC.edit && c.resolution ? `<button class="btn" type="button" id="btn-res" style="min-height:34px">แก้ไข</button>` : ""}</div>
${c.resolution ? `<div class="resol">${esc(c.resolution)}</div>
<p class="muted" style="margin:0;font-size:13px">ปิดโดย ${esc(c.resolvedBy || "-")}${c.resolvedAt ? " · " + fdt(c.resolvedAt) : ""} · Status ${esc(c.status)}${c.rootCause ? " · สาเหตุ: " + esc(c.rootCause) : ""}</p>` : `<div class="resol none">ไม่มี Resolution (ปิดก่อนเริ่มบังคับ)</div>${permsC.edit ? `<button class="btn" type="button" id="btn-res" style="align-self:flex-start">เพิ่ม Resolution</button>` : ""}`}</section>` : ""}
${!isNew && (csOf(c) || c.rcaText) ? rcaCard(c, permsC) : ""}
${!isNew && (ME.user.role === "admin" || (ME.user.role === "manager" && (ME.user.teams || []).includes(c.team))) ? `<section class="card"><div class="title"><h2>ความยากของเคส</h2><span>ใช้คิดแต้มงานใน KPI</span></div>
<label class="f">ระดับความยาก<select id="cx-sel">${[["", "อัตโนมัติ (จาก Severity, ส่ง NICE, Onsite, เปิดนาน)"], ["0.8", "ง่ายกว่าปกติ ×0.8"], ["1.2", "ยาก ×1.2"], ["1.5", "ยากมาก ×1.5"]].map(([v, l]) => `<option value="${v}" ${String(c.complexity ?? "") === v ? "selected" : ""}>${l}</option>`).join("")}</select><span class="hint">ใช้กับเคสที่ระบบดูไม่ออก เช่น ต้องเขียน script เอง บันทึกในประวัติของเคส</span></label></section>` : ""}
${custFiles.files.length ? `<section class="card"><div class="title"><h2>รูปและไฟล์จากลูกค้า (${custFiles.files.length})</h2><span>จาก email และฟอร์มเพิ่มข้อมูล</span></div>
<div class="cf-grid">${custFiles.files.map((f) => {
      const u = `api/intake/${f.intake_id}/files/${f.id}`;
      const img = /^image\/(png|jpe?g|gif|webp)$/.test(f.mime);
      return `<a class="cf" href="${u}" target="_blank" rel="noopener" title="${esc(f.file_name)}">${img ? `<img src="${u}" alt="${esc(f.file_name)}" loading="lazy">` : `<span class="cf-ext">${esc((f.file_name.split(".").pop() || "").toUpperCase())}</span>`}<span class="cf-n">${esc(f.file_name)}</span><span class="cf-d">${fdt(f.created_at)} · ${f.source === "form" ? "ฟอร์ม" : "email"}</span></a>`;
    }).join("")}</div></section>` : ""}
${data ? teamFilesCard(data.files || [], c, permsC) : ""}
${isNew ? "" : extCard(c, extData.extensions, closed, permsC)}
${isNew ? `<section class="card"><h2>ก่อนเปิดเคส</h2><p class="muted" style="margin:0;font-size:14px">กรอก Site, Task และ Status ให้ครบ ระบบจะส่ง email เตือน User ในวันที่ ${cfg.alert1Day}, ${cfg.alert2Day} และทุกวันหลังเกิน Due ถ้ายังไม่ปิดเคส</p></section>` : `
<section class="card"><div><h2>Activity / Detail</h2><div class="hint" style="margin-top:4px">ทุกบันทึกมีวันที่และชื่อผู้บันทึก แก้หรือลบย้อนหลังไม่ได้</div></div>
${permsC.edit ? `<form id="af" class="stack">
<div style="display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px">
<label class="f">วันที่ทำ<input type="date" name="date" value="${daysAgo(0)}" max="${daysAgo(0)}" required></label>
<label class="f">ประเภท<select name="kind">${KINDS.map((k) => `<option>${k}</option>`).join("")}</select></label></div>
<label class="f">รายละเอียด<textarea name="detail" rows="3" placeholder="วันนี้ทำอะไรไป ผลเป็นอย่างไร ขั้นต่อไปคืออะไร" required></textarea></label>
<p class="hint" id="af-deploy" hidden style="margin:-4px 0 0">สรุป Deploy: Patch / เวอร์ชัน ระบบหรือเครื่องที่ลง ผลการทดสอบ และแผน rollback อย่างน้อย 30 ตัวอักษร จึงนับเป็นงานใน KPI (นับ 1 ครั้งต่อเคส · Product Patch นับมากกว่า MS Patch)</p>
<p class="hint" id="af-meet" hidden style="margin:-4px 0 0">สรุป Meeting: ผู้เข้าร่วมฝั่งลูกค้า หัวข้อ ข้อตกลง และขั้นต่อไป อย่างน้อย 30 ตัวอักษร จึงนับเป็นงานใน KPI · Onsite (ไปที่ลูกค้า) นับมากกว่า Online · นับสูงสุด 2 ครั้งต่อเคส</p>
<div class="right"><button class="btn primary" type="submit">เพิ่ม Activity</button></div></form>` : ""}
${actsHtml(data.activities)}</section>`}
</aside></div>
<dialog id="dlg"></dialog>`;

    if (!isNew) {
      bindExtCard(c, extData.extensions);
      bindTransferCard(c, data.transfer);
      bindChecklist(c);
      bindTeamFiles(c);
    }
    const f = document.getElementById("cf");
    bindCombo(f, "site", lk.site, { newLabel: (v) => `+ ใช้ชื่อใหม่ “${esc(v)}” (ต้องให้ Manager อนุมัติ)` });
    f.status.addEventListener("change", () => (document.getElementById("st-hint").textContent = statusHelp(f.status.value)));
    if (!closed) bindSimilar(f, isNew ? null : c);
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
        const r = await askResolution(isNew ? { ...c, ...body, csNumber: body.cs_number, stage: "normal", age: 0 } : { ...c, csNumber: body.cs_number }, { status: body.status });
        if (!r) {
          if (!isNew) f.status.value = c.status;
          return;
        }
        Object.assign(body, r);
      }
      try {
        if (isNew) {
          body.detail = f.detail.value.trim();
          const rcaFile = body.rcaFile;
          delete body.rcaFile;
          const r = await post("/case", body);
          if (rcaFile) await post(`/case/${r.id}/rca`, { ...body.rca, file: rcaFile }, "PUT").catch((err) => toast("เปิดเคสแล้ว แต่แนบไฟล์ RCA ไม่สำเร็จ: " + err.message, 6000));
          toast(r.newSite ? `เปิดเคสแล้ว และเพิ่มลูกค้าใหม่ “${r.newSite}” เข้า dropdown` : "เปิดเคสแล้ว", 5000);
          location.hash = "#/case/" + r.id;
        } else {
          const r = await saveCaseWithRca(id, body);
          toast(r.changed.length ? (body.resolution && !closed ? "ปิดเคสแล้ว" : r.newSite ? `บันทึกแล้ว และเพิ่มลูกค้าใหม่ “${r.newSite}”` : "บันทึกแล้ว") : "ไม่มีอะไรเปลี่ยน", 4000);
          viewCase(id);
        }
      } catch (err) {
        toast("บันทึกไม่สำเร็จ: " + err.message, 6000);
      }
    };
    const af = document.getElementById("af");
    if (af) {
      const meetHint = document.getElementById("af-meet");
      const syncMeet = () => {
        const m = MEETINGS.includes(af.kind.value);
        const dp = DEPLOYS.includes(af.kind.value);
        meetHint.hidden = !m;
        document.getElementById("af-deploy").hidden = !dp;
        af.detail.placeholder = dp ? "เช่น ลง Hotfix 7.2.3 ที่ Logger 2 เครื่อง (LOG01, LOG02) ทดสอบอัดเสียงและเล่นกลับ 5 สาย ผ่าน · rollback: snapshot VM ก่อนลง" : m ? "เช่น ประชุมกับคุณสมศรี (IT Manager) และทีม QA ของลูกค้า สรุปแผน upgrade เป็นเวอร์ชันใหม่ เลือกทำวันที่ 20 ลูกค้าขอ test plan ก่อน 15" : "วันนี้ทำอะไรไป ผลเป็นอย่างไร ขั้นต่อไปคืออะไร";
      };
      af.kind.addEventListener("change", syncMeet);
      syncMeet();
    }
    if (af)
      af.onsubmit = async (e) => {
        e.preventDefault();
        if (af.detail.value.trim().length < 3) return toast("กรุณาใส่รายละเอียด");
        if (MEETINGS.includes(af.kind.value) && af.detail.value.trim().length < 30 && !confirm("สรุป Meeting สั้นกว่า 30 ตัวอักษร จะไม่นับใน KPI บันทึกต่อไหม?")) return;
        if (DEPLOYS.includes(af.kind.value) && af.detail.value.trim().length < 30 && !confirm("สรุป Deploy สั้นกว่า 30 ตัวอักษร จะไม่นับใน KPI บันทึกต่อไหม?")) return;
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
          await saveCaseWithRca(id, r);
          toast("ปิดเคสแล้ว");
          viewCase(id);
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const brca = document.getElementById("btn-rca");
    if (brca)
      brca.onclick = async () => {
        if (await askRca(c)) {
          toast("บันทึก RCA จาก NICE แล้ว");
          viewCase(id);
        }
      };
    if (c.sitePendingId) bindSitePending(c, () => viewCase(id));
    const cx = document.getElementById("cx-sel");
    if (cx)
      cx.onchange = async () => {
        try {
          await post(`/case/${c.id}/complexity`, { complexity: cx.value || null }, "PUT");
          toast("บันทึกความยากของเคสแล้ว");
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    const bcc = document.getElementById("btn-confirm-cust");
    if (bcc) bcc.onclick = () => openConfirmCustomer(c, data.intake, lk, () => viewCase(id));
    const br = document.getElementById("btn-res");
    if (br)
      br.onclick = async () => {
        const r = await askResolution(c, { edit: true });
        if (!r) return;
        try {
          await post("/case/" + id, { resolution: r.resolution, root_cause: r.root_cause, root_cause_note: r.root_cause_note }, "PUT");
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
  /** Search box on the "by User" page: type part of a name or email, pick with the mouse or arrow keys + Enter. */
  function bindUserSearch(month) {
    const inp = document.getElementById("us-q");
    const box = document.getElementById("us-list");
    if (!inp) return;
    const wrap = inp.closest(".us-wrap");
    let items = [];
    let cur = -1;
    let timer = null;
    let seq = 0;
    const hi = (txt, qv) => {
      const i = qv ? txt.toLowerCase().indexOf(qv) : -1;
      return i < 0 ? esc(txt) : esc(txt.slice(0, i)) + "<mark>" + esc(txt.slice(i, i + qv.length)) + "</mark>" + esc(txt.slice(i + qv.length));
    };
    const close = () => {
      box.hidden = true;
      wrap.setAttribute("aria-expanded", "false");
    };
    const go = (it) => (location.hash = "#/owner/" + encodeURIComponent(it.id) + (month ? "?month=" + month : ""));
    const draw = (qv) => {
      box.innerHTML = items.length
        ? items.map((it, i) => `<a role="option" id="us-o${i}" aria-selected="${i === cur}" class="${i === cur ? "on" : ""}" href="#/owner/${encodeURIComponent(it.id)}${month ? "?month=" + month : ""}"><span>${hi(it.name, qv)}</span><small>${ROLE[it.role] || it.role}${it.teams.length ? " · " + esc(it.teams.join(", ")) : ""}</small></a>`).join("")
        : `<div class="hint" style="padding:10px">ไม่พบ User ที่ตรงกับ “${esc(qv)}”</div>`;
      box.hidden = false;
      wrap.setAttribute("aria-expanded", "true");
      inp.setAttribute("aria-activedescendant", cur >= 0 ? "us-o" + cur : "");
    };
    const search = async () => {
      const qv = inp.value.trim().toLowerCase();
      const mine = ++seq;
      try {
        const r = await api("/owners/search?q=" + encodeURIComponent(qv));
        if (mine !== seq) return;
        items = r.items;
        cur = items.length ? 0 : -1;
        draw(qv);
      } catch (e) {
        toast(e.message, 5000);
      }
    };
    inp.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(search, 180);
    };
    inp.onfocus = () => !box.innerHTML && search();
    inp.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (box.hidden || !items.length) return;
        e.preventDefault();
        cur = (cur + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        draw(inp.value.trim().toLowerCase());
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[cur]) go(items[cur]);
      } else if (e.key === "Escape") close();
    };
    document.addEventListener("click", (e) => !wrap.contains(e.target) && close());
  }

  async function viewOwner(id, params = {}) {
    setNav("owner");
    if (!id) {
      const ov = await api("/overview");
      if (ov.owners.length) return location.replace("#/owner/" + encodeURIComponent(ov.owners[0].id));
      $app.innerHTML = `<div class="empty">ยังไม่มีข้อมูล User</div>`;
      return;
    }
    const [o, srAll] = await Promise.all([api("/owner/" + encodeURIComponent(id) + (params.month ? "?month=" + encodeURIComponent(params.month) : "")), srList("team")]);
    const M = o.month;
    const mLabel = (ym) => ymLabel(ym, true);
    const srOwner = srAll.filter((r) => srOpen(r) && r.assignee && r.assignee.email && o.email && r.assignee.email.toLowerCase() === String(o.email).toLowerCase()).sort(srByTarget);
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
<div style="display:flex;align-items:center;gap:16px">${avHtml({ id: o.user ? o.user.id : 0, name: o.owner, avatar: o.user && o.user.avatar }, "lg")}
<div><h1 style="font-size:24px">${esc(o.owner)}</h1><div class="muted" style="font-size:14px">${esc(o.email || "-")} · ${esc(o.sources.join(", "))}</div></div></div>
<div class="actions"><div class="us-wrap" role="combobox" aria-expanded="false" aria-haspopup="listbox"><svg class="us-ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
<input id="us-q" type="search" placeholder="ค้นหา User ด้วยชื่อหรือ email" aria-label="ค้นหา User" autocomplete="off" aria-controls="us-list"><div class="us-list" id="us-list" role="listbox" hidden></div></div>
<span class="seg2" role="group" aria-label="เดือน">${o.months.map((ym) => `<button type="button" data-month="${ym}" aria-pressed="${ym === M.ym}">${esc(mLabel(ym))}</button>`).join("")}</span>
<a class="btn primary" href="#/owner/${encodeURIComponent(o.id)}/meeting">มุมมองประชุม</a>
${lvl("export") === "all" ? `<a class="btn" href="api/export?${qs({ from: daysAgo(29), to: daysAgo(0), owner: o.id })}">Export เคสของ User นี้</a>` : ""}</div>
</section>
<div class="kpis">
<div class="kpi k-all"><div class="l">ยังไม่ปิด</div><div class="v">${k.open}</div></div>
<div class="kpi k-normal"><div class="l">ปกติ</div><div class="v">${k.normal}</div></div>
<div class="kpi k-r1"><div class="l">แจ้งรอบ 1</div><div class="v">${k.r1}</div></div>
<div class="kpi k-r2"><div class="l">แจ้งรอบ 2</div><div class="v">${k.r2}</div></div>
<div class="kpi k-overdue"><div class="l">เกิน Due</div><div class="v">${k.overdue}</div></div>
<div class="kpi k-closed"><div class="l">ปิดทัน SLA · ${esc(mLabel(M.ym))}</div><div class="v">${M.slaPct === null ? "-" : M.slaPct + "%"}</div><div class="s">${M.onTime} จาก ${M.closed} เคส · เปิดใหม่ ${M.opened}</div></div>
<div class="kpi k-sr"><div class="l">คำขอบริการค้าง</div><div class="v">${srOwner.length}</div><div class="s">เลย Target ${srOwner.filter((r) => r.status === "overdue").length}</div></div>
</div>
<section class="card"><div class="title"><h2>เคสที่ยังไม่ปิด</h2><span>เรียงจากเปิดนานสุด</span></div>${caseTable(open, { showOwner: false })}</section>
<section class="card"><div class="title"><h2>คำขอบริการที่ยังไม่ปิด (${srOwner.length})</h2><span>งานภายในที่ได้รับมอบหมาย · เรียงตาม Target date</span></div>${srWorkTable(srOwner)}</section>
<div class="grid2">
<section class="card"><h2>ประวัติแจ้งเตือน (60 วัน)</h2>${historyHtml || `<div class="empty">ยังไม่มี email แจ้งเตือน</div>`}</section>
<section class="card"><div class="title"><h2>ปิดเคสรายสัปดาห์</h2><span>9 สัปดาห์ถึง${M.current ? "สัปดาห์นี้" : "สิ้น " + esc(mLabel(M.ym))}</span></div>
<div class="weeks">${o.weeks.map((w) => `<div class="w ${w.inMonth ? "" : "out"}"><div>${w.onTime} / ${w.late}</div>
<div class="stack" style="gap:0;height:${((w.onTime + w.late) / maxWeek) * 100}%;min-height:${w.onTime + w.late ? 6 : 2}px;background:${w.onTime + w.late ? "transparent" : "var(--row)"};width:36px;border-radius:6px 6px 0 0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end">
${w.late ? `<div style="flex:${w.late};background:var(--over)"></div>` : ""}${w.onTime ? `<div style="flex:${w.onTime};background:var(--normal)"></div>` : ""}</div>
<div>สัปดาห์ ${fd(w.from)}</div></div>`).join("")}</div>
<div class="legend"><span><span class="dot d-normal" aria-hidden="true"></span>ปิดทัน SLA</span><span><span class="dot d-overdue" aria-hidden="true"></span>ปิดเกิน Due</span><span>สัปดาห์ที่จางอยู่นอกเดือนที่เลือก</span></div>
</section></div>
${extTable(o.extensions || [], `${esc(o.owner)} · การขอขยายเวลา`)}
${o.changes.length && lvl("audit_view") !== "none" ? `<section class="card"><h2>การแก้ไขในเคสของ User นี้</h2>${changeRows(o.changes)}</section>` : ""}
<section class="card"><div class="title"><h2>ปิดแล้วใน ${esc(mLabel(M.ym))}</h2><span>${closed.length} เคส</span></div>${closed.length ? caseTable(closed, { showOwner: false }) : `<div class="empty">ไม่มีเคสที่ปิดในเดือนนี้</div>`}</section>`;
    document.querySelectorAll("[data-month]").forEach((b) => (b.onclick = () => (location.hash = `#/owner/${encodeURIComponent(o.id)}?month=${b.dataset.month}`)));
    bindUserSearch(params.month);
    bindRowLinks();
  }


  // ------------------------------------------------------------ meeting view (one page per owner)
  async function viewMeeting(id, params) {
    setNav("owner");
    const closed = params.closed ?? "7";
    const showSys = params.sys === "1";
    const limit = params.n === "all" ? Infinity : Number(params.n || 0) || Infinity;
    const [m, srAll] = await Promise.all([api(`/owner/${encodeURIComponent(id)}/meeting?closed=${closed}`), srList("team")]);
    const srOwner = srAll.filter((r) => srOpen(r) && r.assignee && m.email && r.assignee.email.toLowerCase() === String(m.email).toLowerCase()).sort(srByTarget);
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
<div><b>${k.sla.pct === null ? "-" : k.sla.pct + "%"}</b>ปิดทัน SLA (30 วัน)</div>
<div class="k-sr"><b>${srOwner.length}</b>คำขอบริการค้าง</div></div>
${m.cases.length ? `<table class="mt-index"><thead><tr><th>#</th><th>เลขเคส</th><th>ลูกค้า</th><th>Severity</th><th>งาน</th><th>Status</th><th>อายุเคส</th><th>อัปเดตล่าสุด</th></tr></thead><tbody>
${m.cases.map((c, i) => { const la = lastAct(c); return `<tr class="${c.stage === "closed" ? "done" : ""}"><td>${i + 1}</td><td class="mono"><a href="#mc-${c.id}" data-jump="${c.id}">${esc(caseRef(c))}</a>${csOf(c) ? `<div class="muted" style="font-size:11px">${esc(csOf(c))}</div>` : ""}</td><td><strong>${esc(c.site || "-")}</strong></td><td>${sevChip(c.severity)}</td>
<td class="muted">${esc(c.task || "")}</td><td>${esc(c.status || "-")}</td>
<td>${chip(c.stage)} <span class="muted">${esc(ageText(c))}</span></td><td class="muted">${la ? `${fd(la.activity_date)} · ${esc(la.detail.length > 70 ? la.detail.slice(0, 70) + "…" : la.detail)}` : "-"}</td></tr>`; }).join("")}
</tbody></table>` : `<div class="empty">ไม่มีเคสที่ต้องแสดง</div>`}
${open.length ? `<h2 class="mt-sec">เคสที่ยังไม่ปิด (${open.length})</h2>${open.map((c, i) => card(c, i)).join("")}` : ""}
${done.length ? `<h2 class="mt-sec">ปิดแล้วใน ${m.closedDays} วันล่าสุด (${done.length})</h2>${done.map((c, i) => card(c, open.length + i)).join("")}` : ""}
${srOwner.length ? `<h2 class="mt-sec">คำขอบริการภายในที่ยังไม่ปิด (${srOwner.length})</h2>${srWorkTable(srOwner, { print: true })}` : ""}
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
${exp === "own" ? "" : `<label class="f">User<select name="owner"><option value="">ทุกคน</option>${ownerOpts}</select></label>`}
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
<div class="tablewrap" style="margin-top:12px"><table style="min-width:860px"><thead><tr><th>User</th><th class="n">เปิดใหม่</th><th class="n">ปิด</th><th class="n">ปิดทัน SLA เดิม</th><th class="n">ยังเปิดอยู่</th><th class="n">เกิน Due</th><th class="n">ขอขยาย (เคส)</th><th class="n">ขอขยาย (ครั้ง)</th><th class="n">อนุมัติ / ไม่อนุมัติ</th></tr></thead><tbody>
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
    const [{ users }, { list: deptList }] = await Promise.all([api("/users"), api("/departments")]);
    const deptNames = deptList.filter((x) => x.active).map((x) => x.name);
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
<div><h2>${esc(sel.display_name)}</h2><div class="muted" style="font-size:13px">${esc(sel.email)} · ${sel.auth_type === "sso" ? "บัญชี Microsoft" : sel.auth_type === "email" ? "เข้าด้วยลิงก์ทาง email" : "บัญชีรหัสผ่าน"}</div></div></div>
<label class="f">ชื่อที่แสดง<input name="display_name" value="${esc(sel.display_name)}"></label>
<label class="f">เบอร์โทร<input name="phone" value="${esc(sel.phone || "")}" placeholder="081-234-5678"><span class="hint">แสดงใน email ถึงลูกค้าเมื่อรับเคส</span></label>
<div class="formgrid" style="grid-template-columns:1fr 1fr;gap:10px"><label class="f">หน่วยงาน${deptSelect(deptNames, sel.department || "", { other: false })}</label><label class="f">ตำแหน่ง<input name="job_title" value="${esc(sel.job_title || "")}"></label></div>
<label class="f">บทบาท<select name="role" ${sel.id === ME.user.id ? "disabled" : ""}>${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === sel.role ? "selected" : ""}>${l}</option>`).join("")}</select><span class="hint" data-role-hint>${esc(ROLE_HINT[sel.role] || "")}</span></label>
<fieldset><legend>ทีมที่เห็นเคส</legend>${teamChecks(sel)}</fieldset>
<label class="chk" style="justify-content:space-between"><span>ดูแลลูกค้าประจำ<span class="hint" style="display:block">ได้รับมอบให้ดูแลลูกค้ารายเดียว KPI จะไม่นับความหลากหลายของลูกค้า</span></span><input type="checkbox" name="dedicated_customer" ${sel.dedicated_customer ? "checked" : ""}></label>
<label class="chk" style="justify-content:space-between"><span>เปิดใช้งานบัญชี<span class="hint" style="display:block">ปิดแล้วเข้าระบบไม่ได้ แต่เคสเดิมยังอยู่ครบ</span></span><input type="checkbox" name="active" ${sel.active ? "checked" : ""} ${sel.id === ME.user.id ? "disabled" : ""}></label>
${sel.auth_type === "local" ? `<div style="border-top:1px solid var(--line);padding-top:14px" class="stack"><h2 style="font-size:15px">รีเซ็ตรหัสผ่าน</h2>
<button class="btn" type="button" id="rs-link">ส่งลิงก์ตั้งรหัสใหม่ทาง email</button>
<button class="btn" type="button" id="rs-temp">สร้างรหัสชั่วคราว (ต้องเปลี่ยนตอนเข้าครั้งแรก)</button>
<span class="hint">ลิงก์ใช้ได้ 24 ชั่วโมง ใช้ได้ครั้งเดียว</span></div>` : sel.auth_type === "email" ? `<p class="hint" style="margin:0">ไม่มีรหัสผ่าน ผู้ใช้ขอลิงก์เข้าระบบทาง email เองที่หน้า login</p>` : `<p class="hint" style="margin:0">บัญชี Microsoft ไม่ต้องรีเซ็ตรหัสผ่านที่นี่ ใช้รหัสผ่านของบริษัท</p>`}
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
<td style="font-size:13px">${["admin", "observer", "viewer"].includes(u.role) ? "ทุกทีม" : esc(u.teams.map(teamLabel).join(", ") || "-")}</td>
<td>${u.active ? chip("ok", "ใช้งานอยู่") : chip("closed", "ปิดใช้งาน")}${u.must_change_password ? `<div class="hint">รอตั้งรหัสใหม่</div>` : ""}</td>
<td class="n">${u.open_cases}</td>
<td style="font-size:13px" class="muted">${u.last_login_at ? fdt(u.last_login_at) : "ยังไม่เคย"}</td></tr>`).join("")}</tbody></table></div>
</section>${panel}</div>
<dialog id="dlg"></dialog>`;
    bindRowLinks();
    const uq = document.getElementById("uq");
    uq.onkeydown = (e) => {
      if (e.key === "Enter") location.hash = "#/users?" + qs({ q: uq.value, role: params.role });
    };
    document.getElementById("ur").onchange = (e) => (location.hash = "#/users?" + qs({ q: params.q, role: e.target.value }));
    document.getElementById("u-add").onclick = () => openAddUser();
    document.getElementById("u-import").onclick = () => openImportUsers();
    if (!sel) return;
    const f = document.getElementById("uf");
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { display_name: f.display_name.value, phone: f.phone.value, department: f.department.value, job_title: f.job_title.value, dedicated_customer: f.dedicated_customer.checked, teams: [...f.querySelectorAll("input[name=teams]:checked")].map((x) => x.value) };
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
    const g = JSON.parse(JSON.stringify(data.grants || {}));
    const uname = Object.fromEntries((data.users || []).map((u) => [u.id, u]));
    const count = Object.fromEntries(data.counts.map((c) => [c.role, c.n]));
    const editable = lvl("users_manage") !== "none";
    const locked = (r, p) => (r === "admin" && (p === "users_manage" || p === "settings_manage")) || (r === "observer" && (data.observerLocked || []).includes(p));
    const cell = (r, p) => {
      const v = m[r][p];
      const label = v === "all" ? "✓" : v === "own" ? "เฉพาะของตัวเอง" : "–";
      return `<button type="button" class="perm ${v}" data-r="${r}" data-p="${p}" ${!editable || locked(r, p) ? "disabled" : ""} aria-label="${ROLE[r]}: ${esc(label)}">${label}</button>`;
    };
    // Named users who get this permission on top of their role (roles with ✓ keep it anyway).
    const userGrantRow = (p) => {
      const ids = (g[p.key] || []).filter((id) => uname[id]);
      const hasByRole = (u) => m[u.role] && m[u.role][p.key] === "all";
      const options = (data.users || []).filter((u) => u.role !== "observer" && !ids.includes(u.id) && !hasByRole(u));
      return `<tr class="grant-row"><td colspan="${data.roles.length + 1}"><div class="grant">
<span class="hint" style="margin:0">ผู้ใช้ที่ได้สิทธิ์ “${esc(p.label)}” เพิ่มจากบทบาท:</span>
${ids.length ? ids.map((id) => `<span class="gchip">${esc(uname[id].display_name)} <span class="muted">· ${esc(ROLE[uname[id].role] || uname[id].role)}</span>${editable ? `<button type="button" data-ungrant="${p.key}:${id}" aria-label="เอาสิทธิ์ของ ${esc(uname[id].display_name)} ออก">×</button>` : ""}</span>`).join("") : `<span class="muted">ยังไม่มี</span>`}
${editable ? `<select data-grant="${p.key}" aria-label="เพิ่มผู้ใช้"><option value="">+ เพิ่มผู้ใช้</option>${options.map((u) => `<option value="${u.id}">${esc(u.display_name)} · ${esc(ROLE[u.role] || u.role)}</option>`).join("")}</select>` : ""}
</div></td></tr>`;
    };
    const render = () => {
      document.getElementById("pm").innerHTML = `<table style="min-width:820px"><thead><tr><th>สิทธิ์</th>${data.roles.map((r) => `<th style="text-align:center;width:150px">${chip(ROLE_CHIP[r], ROLE[r])}<div class="hint" style="margin-top:6px">${count[r] || 0} คน</div></th>`).join("")}</tr></thead><tbody>
${data.perms.map((p) => `<tr><td><div style="font-weight:500">${esc(p.label)}</div><div class="hint">${esc(p.hint)}</div></td>${data.roles.map((r) => `<td style="text-align:center">${cell(r, p.key)}</td>`).join("")}</tr>${p.perUser ? userGrantRow(p) : ""}`).join("")}</tbody></table>`;
      document.querySelectorAll("[data-ungrant]").forEach((b) => (b.onclick = () => {
        const [k, id] = b.dataset.ungrant.split(":");
        g[k] = (g[k] || []).filter((x) => x !== Number(id));
        render();
        document.getElementById("save").disabled = false;
      }));
      document.querySelectorAll("select[data-grant]").forEach((s) => (s.onchange = () => {
        if (!s.value) return;
        const k = s.dataset.grant;
        g[k] = [...new Set([...(g[k] || []), Number(s.value)])];
        render();
        document.getElementById("save").disabled = false;
      }));
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
          await post("/permissions", { matrix: m, grants: g }, "PUT");
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
    f.q.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  }

  // ------------------------------------------------------------ settings (admin)
  // ------------------------------------------------------------ backup card (settings page)
  async function loadBackupCard() {
    const el = document.getElementById("bk-card");
    if (!el) return;
    let b;
    try {
      b = await api("/backup");
    } catch (e) {
      el.innerHTML = `<h2>Backup และทดสอบ restore</h2><div class="banner err">${esc(e.message)}</div>`;
      return;
    }
    const s = b.settings;
    const bk = b.backup;
    const t = b.test;
    const ago = (iso) => {
      const h = (Date.now() - new Date(iso).getTime()) / 3600000;
      return h < 1 ? `${Math.max(1, Math.round(h * 60))} นาทีที่แล้ว` : h < 48 ? `${Math.round(h)} ชม. ที่แล้ว` : `${Math.round(h / 24)} วันที่แล้ว`;
    };
    const stale = bk && bk.ok && (Date.now() - new Date(bk.at).getTime()) / 3600000 > 36;
    const bkBanner = !b.keySet
      ? `<div class="banner err">ยังไม่ได้ตั้ง BACKUP_KEY ใน .env ระบบจึงยังไม่สร้าง backup ดูวิธีตั้งใน docs/backup.md</div>`
      : !bk ? `<div class="banner warn">ยังไม่เคยสร้าง backup ระบบสร้างทุกคืน 01:30 หรือกด “Backup ตอนนี้”</div>`
      : !bk.ok && !bk.name ? `<div class="banner err">Backup ล่าสุดไม่สำเร็จ (${fdt(bk.at)}): ${esc(bk.error)}</div>`
      : `<div class="banner ${!bk.ok || stale ? "warn" : "ok"}">Backup ล่าสุด ${fdt(bk.at)} (${ago(bk.at)}) · ${esc(bk.sizeText || "")} · ${bk.cases.toLocaleString()} เคส · ไฟล์แนบ ${bk.files.toLocaleString()} ไฟล์${bk.error ? `<br>${esc(bk.error)}` : ""}${stale ? "<br>เก่าเกิน 36 ชั่วโมง ตรวจว่างาน backup ทุกคืนยังทำงานอยู่" : ""}</div>`;
    const testBanner = !t ? `<div class="banner">ยังไม่เคยทดสอบ restore ระบบทดสอบทุกวันอาทิตย์ 03:15 หรือกด “ทดสอบ restore ตอนนี้”</div>`
      : !t.ok ? `<div class="banner err">ทดสอบ restore ไม่ผ่าน (${fdt(t.at)}): ${esc(t.error)}</div>`
      : `<div class="banner ${t.level === "full" && !t.warning ? "ok" : "warn"}">ทดสอบ restore ${t.level === "full" ? "ผ่าน" : "ผ่านบางส่วน"} ${fdt(t.at)} · ไฟล์ ${esc(t.name)} · ${t.tables} ตาราง ${t.cases.toLocaleString()} เคส ไฟล์แนบ ${t.files.toLocaleString()} ไฟล์ ครบ · ใช้เวลา ${t.seconds} วินาที${t.note ? `<br>${esc(t.note)} (วิธีให้สิทธิ์ใน docs/backup.md)` : ""}${t.warning ? `<br>${esc(t.warning)}` : ""}</div>`;
    el.innerHTML = `<div class="title"><h2>Backup และทดสอบ restore</h2><span>backup ทุกคืน 01:30 · ทดสอบ restore ทุกวันอาทิตย์ 03:15 · ล้มเหลวแจ้ง Admin ทาง Telegram และ email</span></div>
${b.busy ? `<div class="banner">กำลัง${esc(b.busy)}… หน้านี้อัปเดตเองเมื่อเสร็จ</div>` : ""}
${bkBanner}${testBanner}
<div class="formgrid">
<label class="f">เก็บบน server ย้อนหลัง (วัน)<input id="bk-keep" type="number" min="3" max="365" value="${s.keepDays}"><span class="hint">เก็บอย่างน้อย 3 ไฟล์ล่าสุดเสมอ</span></label>
<label class="f">คัดลอกไปโฟลเดอร์นอกเครื่องด้วย (ไม่บังคับ)<input id="bk-copy" value="${esc(s.copyDir || "")}" placeholder="/mnt/nas/case-backup"><span class="hint">เช่น โฟลเดอร์ NAS ที่ mount ไว้ เว้นว่าง = ไม่คัดลอก</span></label>
<label class="f">เก็บบน NAS / SharePoint ย้อนหลัง (วัน)<input id="bk-ckeep" type="number" min="3" max="3650" value="${s.copyKeepDays}"><span class="hint">สำเนารายวันนอกเครื่อง</span></label>
<label class="f">เก็บสำเนารายเดือนบน NAS / SharePoint (เดือน)<input id="bk-cmon" type="number" min="0" max="120" value="${s.copyMonthly}"><span class="hint">เก็บ backup แรกของแต่ละเดือนไว้นานขึ้น 0 = ไม่เก็บ</span></label>
<label class="f">SharePoint Site ID (ไม่บังคับ)<input id="bk-site" value="${esc(s.sharepoint.siteId || "")}" placeholder="contoso.sharepoint.com,xxxx,yyyy"><span class="hint">ต้องให้สิทธิ์ Sites.Selected เฉพาะ site นี้ก่อน ดู docs/backup.md</span></label>
<label class="f">โฟลเดอร์ใน SharePoint<input id="bk-folder" value="${esc(s.sharepoint.folder || "")}"></label></div>
<label class="chk"><input type="checkbox" id="bk-sp" ${s.sharepoint.enabled ? "checked" : ""}> ส่งสำเนาขึ้น SharePoint ด้วย</label>
<label class="chk"><input type="checkbox" id="bk-on" ${s.enabled ? "checked" : ""}> เปิด backup อัตโนมัติทุกคืน</label>
<div class="actions"><button class="btn primary" type="button" id="bk-save">บันทึก</button><button class="btn" type="button" id="bk-run" ${b.busy || !b.keySet ? "disabled" : ""}>Backup ตอนนี้</button><button class="btn" type="button" id="bk-test" ${b.busy || !b.files.length ? "disabled" : ""}>ทดสอบ restore ตอนนี้</button></div>
<details><summary style="cursor:pointer;color:var(--accent)">ไฟล์ backup ในเครื่อง (${b.files.length}) และประวัติ</summary>
<p class="hint">เก็บที่ ${esc(s.dir)} · ไฟล์แนบลูกค้าอยู่ที่ ${esc(b.fileDir)} · ไฟล์เข้ารหัสด้วย BACKUP_KEY ไม่มี .env อยู่ในไฟล์</p>
<div class="tablewrap"><table><thead><tr><th>ไฟล์</th><th>ขนาด</th><th>เวลา</th></tr></thead><tbody>${b.files.map((f) => `<tr><td style="font-family:var(--mono,monospace)">${esc(f.name)}</td><td>${(f.size / 1048576).toFixed(1)} MB</td><td>${fdt(f.at)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">ยังไม่มี</td></tr>`}</tbody></table></div>
<div class="tablewrap"><table><thead><tr><th>เวลา</th><th>งาน</th><th>ผล</th><th>โดย</th></tr></thead><tbody>${b.history.map((h) => `<tr><td>${fdt(h.at)}</td><td>${h.kind === "backup" ? "Backup" : "ทดสอบ restore"}</td><td>${h.ok ? `<span class="chip ${h.kind === "test" && h.level !== "full" ? "c-r1" : "c-ok"}">${h.kind === "test" && h.level !== "full" ? "ผ่านบางส่วน" : "สำเร็จ"}</span> ${h.kind === "backup" ? esc(h.sizeText || "") : ""}` : `<span class="chip c-overdue">ไม่สำเร็จ</span> <span style="font-size:13px">${esc(h.error || "")}</span>`}</td><td style="font-size:13px">${h.by === "schedule" ? "อัตโนมัติ" : esc(h.by)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">ยังไม่มี</td></tr>`}</tbody></table></div>
</details>`;
    const $ = (id) => document.getElementById(id);
    $("bk-save").onclick = async () => {
      try {
        await post("/backup", { enabled: $("bk-on").checked, keepDays: $("bk-keep").value, copyDir: $("bk-copy").value.trim(), copyKeepDays: $("bk-ckeep").value, copyMonthly: $("bk-cmon").value, sharepoint: { enabled: $("bk-sp").checked, siteId: $("bk-site").value.trim(), folder: $("bk-folder").value.trim() } }, "PUT");
        toast("บันทึกการตั้งค่า backup แล้ว");
        loadBackupCard();
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    const start = (url, msg) => async () => {
      try {
        await post(url, {});
        toast(msg, 5000);
        loadBackupCard();
      } catch (e) {
        toast(e.message, 6000);
      }
    };
    $("bk-run").onclick = start("/backup/run", "เริ่ม backup แล้ว");
    $("bk-test").onclick = start("/backup/test", "เริ่มทดสอบ restore แล้ว");
    if (b.busy) setTimeout(() => document.getElementById("bk-card") && loadBackupCard(), 3000);
  }

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
<section class="card" id="tn-card"><div class="title"><h2>แจ้งเตือนผ่าน Microsoft Teams</h2><span>แต่ละทีมส่งเข้าช่อง Teams ของตัวเอง</span></div><div id="tn-body">กำลังโหลด…</div></section>
<section class="card" id="team-card"><div class="title"><h2>ทีม</h2><span>เพิ่ม เปลี่ยนชื่อ และเรียงลำดับทีม</span></div><div id="team-body">กำลังโหลด…</div></section>
<section class="card" id="kpf-card"><div class="title"><h2>เกณฑ์ KPI ราย ทีม</h2><span>เลือกชุดเกณฑ์ของแต่ละทีม และน้ำหนักคะแนน</span></div><div id="kpf-body">กำลังโหลด…</div></section>
<section class="card" id="dept-card"><div class="title"><h2>หน่วยงาน</h2><span>รายการให้ผู้ใช้เลือกในบัญชีของฉัน</span></div><div id="dept-body">กำลังโหลด…</div></section>
<section class="card" id="lb-card"><div class="title"><h2>อันดับ KPI</h2><span>กำลังโหลด…</span></div></section>
<section class="card" id="hol-card"><div class="title"><h2>วันหยุดบริษัท</h2><span>กำลังโหลด…</span></div></section>
<section class="card" id="bk-card"><div class="title"><h2>Backup และทดสอบ restore</h2><span>กำลังโหลด…</span></div></section>
<section class="card" id="ae"><div class="title"><h2>Email แจ้งเตือน User</h2><span>ผู้รับ email แจ้งเตือนแต่ละรอบ</span></div>
<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>รอบ</th><th>ส่งเมื่อ</th><th>ถึง</th><th style="text-align:center">CC รายชื่อด้านล่าง</th><th></th></tr></thead><tbody>
${[["r1", `วันที่ ${cfg.alert1Day} (ครั้งเดียว)`], ["r2", `วันที่ ${cfg.alert2Day} (ครั้งเดียว)`], ["overdue", `ทุกวันหลังเกิน Due (วันที่ ${cfg.slaDays + 1} ขึ้นไป)`]].map(([t, when]) => `<tr>
<td>${chip(t, ALERT[t])}</td><td>${when}</td><td>User ของเคส</td>
<td style="text-align:center"><label class="chk" style="justify-content:center"><input type="checkbox" name="cct" value="${t}" ${(s.alertEmail.ccTypes || []).includes(t) ? "checked" : ""}><span class="sr">CC ใน${ALERT[t]}</span></label></td>
<td style="text-align:right;white-space:nowrap"><button class="btn" type="button" data-prev="${t}" style="min-height:34px">ดูตัวอย่าง</button> <button class="btn" type="button" data-testmail="${t}" style="min-height:34px">ส่งทดสอบถึงฉัน</button></td></tr>`).join("")}
</tbody></table></div>
<div class="formgrid">
<label class="f">CC (คั่นด้วย , ถ้ามีหลายคน)<input id="ae-cc" value="${esc(s.alertEmail.cc || "")}" placeholder="engineer@sinostech.co.th"></label>
<label class="f">ส่งถึงใครเมื่อเคสไม่มีอีเมล User<input id="ae-fb" value="${esc(s.alertEmail.fallback || "")}" placeholder="engineer@sinostech.co.th"></label></div>
<p class="hint" style="margin:0">ติ๊กช่อง CC เฉพาะรอบที่ต้องการให้หัวหน้าหรือทีมเห็นด้วย ไม่ติ๊ก = ส่งถึง User คนเดียว User ไม่ถูก CC ซ้ำถ้าอีเมลอยู่ในรายชื่อ CC มีผลตั้งแต่รอบส่งถัดไป</p>
<div class="actions"><button class="btn primary" type="button" id="ae-save">บันทึกผู้รับ email</button></div></section>
<section class="card"><div class="title"><h2>นำเข้าเคสจาก Excel</h2><span>ใช้ช่วงเปลี่ยนจาก Excel มาเป็นหน้าเว็บ</span></div>
<p class="muted" style="margin:0;font-size:14px">อ่าน tab Case List ทั้ง 3 เอกสาร แล้วเพิ่มเคสที่ยังไม่มีในระบบ เคสที่มีอยู่แล้วจะไม่ถูกนำเข้าซ้ำ User ที่ยังไม่มีบัญชีจะถูกสร้างเป็น Engineer (บัญชี Microsoft) ให้อัตโนมัติ</p>
<div class="actions"><button class="btn" type="button" id="imp-new">นำเข้าเคสใหม่จาก Excel</button><button class="btn" type="button" id="imp-refresh">นำเข้า + อัปเดตเคสที่ยังไม่ถูกแก้บนเว็บ</button></div>
<div id="imp-out" class="hint"></div></section>
<div class="grid2">
<section class="card"><h2>รายการ dropdown</h2>
${[["site", "Site / ลูกค้า · User เพิ่มใหม่ได้จากฟอร์มเคส"], ["product", "Product"], ["status", "Status"]].map(([k, l]) => `<div class="stack" style="gap:8px"><div class="hint">${l} (${byKind(k).length})</div><div class="chips">${lkChips(k)}<button class="btn" type="button" data-add="${k}" style="min-height:32px;padding:0 10px">เพิ่ม</button></div></div>`).join("")}
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
<p class="hint" style="margin:0">email มีสรุปตัวเลขทั้งปีและแนบไฟล์ Excel (เคสทั้งหมด, ราย User, สรุปรายเดือน, ประวัติแก้ไข) ระบบเก็บสำเนาไว้ในคลังด้านล่างถาวร ไม่ถูกลบตามรอบเก็บข้อมูล</p>
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
    loadBackupCard();
    bindHolidays();
    bindLeaderboardSettings();
    bindDepartments();
    bindTeamsNotify();
    bindTeamAdmin();
    bindKpiProfiles();
    document.getElementById("ae-save").onclick = async () => {
      const ccTypes = [...document.querySelectorAll("input[name=cct]:checked")].map((x) => x.value);
      try {
        await post("/settings", { alertEmail: { cc: document.getElementById("ae-cc").value, fallback: document.getElementById("ae-fb").value, ccTypes } }, "PUT");
        toast(ccTypes.length ? `บันทึกแล้ว · CC เฉพาะ${ccTypes.map((t) => ALERT[t]).join(", ")}` : "บันทึกแล้ว · ทุกรอบส่งถึง User คนเดียว", 5000);
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
      toast(r.status === "approved" ? `อนุมัติแล้ว Due ใหม่ ${fd(r.newDue, true)} ระบบแจ้ง User ทาง email` : "ไม่อนุมัติ ระบบแจ้ง User ทาง email แล้ว", 6000);
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

  // ------------------------------------------------------------ cross-team transfer (โอนเคสข้ามทีม)
  const TR_ST = { source: ["r1", "รอ Manager ทีมเดิม"], target: ["r1", "รอทีมใหม่รับเคส"], accepted: ["ok", "โอนสำเร็จ"], rejected: ["fail", "ไม่อนุมัติ"], cancelled: ["closed", "ยกเลิก"] };
  function transferBanner(c, t) {
    if (!t) return "";
    if (t.to) return `<div class="banner info tr-banner"><strong>เคสนี้โอนไปทีมอื่นแล้ว: ${esc(t.to.teamLabel)}</strong> · ทำงานต่อที่เคสใหม่ <a class="mono" href="#/case/${t.to.id}">${esc(t.to.caseNo)}</a><br><span style="font-size:13px">เคสนี้ปิดด้วยสถานะ Transferred เก็บไว้เป็นประวัติ SLA ของทีมเดิมนับตาม Due เดิม</span></div>`;
    const p = t.pending;
    const top = p ? `<div class="banner warn tr-banner"><strong>มีคำขอโอนเคสไปทีม ${esc(p.toLabel)}</strong> · ${TR_ST[p.status][1]}${p.can.act ? ` · <a href="#tr-card" data-trjump>รอคุณ${p.status === "source" ? "อนุมัติ" : "รับเคส"}</a>` : ""}</div>` : "";
    if (t.from) return top + `<div class="banner info tr-banner"><strong>รับโอนจากทีม ${esc(t.from.teamLabel)}</strong> · เคสเดิม <a class="mono" href="#/case/${t.from.id}">${esc(t.from.caseNo)}</a> (ดูประวัติงานเดิมได้ที่เคสเดิม) · SLA ของเคสนี้นับจากวันที่รับโอน</div>`;
    return top;
  }
  function transferSteps(p) {
    const st = (done, cur, label, sub) => `<li class="${done ? "done" : cur ? "cur" : ""}"><b>${label}</b>${sub ? `<span>${sub}</span>` : ""}</li>`;
    return `<ol class="tr-steps">
${st(true, false, "ขอโอน", `${esc(p.requestedBy || "-")} · ${fdt(p.requestedAt)}`)}
${st(p.status !== "source", p.status === "source", `Manager ${esc(p.fromLabel)} อนุมัติ`, p.sourceBy ? `${esc(p.sourceBy)} · ${fdt(p.sourceAt)}` : "รออนุมัติ")}
${st(p.status === "accepted", p.status === "target", `Manager ${esc(p.toLabel)} รับเคส`, p.status === "target" ? "รอรับเคส" : p.targetBy ? `${esc(p.targetBy)} · ${fdt(p.targetAt)}` : "")}</ol>`;
  }
  function transferCard(c, t, closed) {
    if (!t) return "";
    const p = t.pending;
    if (!p && !t.history.length && (closed || !t.canRequest)) return "";
    const hist = t.history.filter((h) => h.caseId === c.id);
    return `<section class="card" id="tr-card"><div class="title"><h2>โอนข้ามทีม</h2><span>Manager ทั้ง 2 ทีมยืนยัน</span></div>
${p ? `<div class="banner warn" style="display:flex;flex-direction:column;gap:10px">
<div><strong>ขอโอนไปทีม ${esc(p.toLabel)}</strong> · ${chip(TR_ST[p.status][0], TR_ST[p.status][1])}</div>
<div style="font-size:14px">เหตุผล: ${esc(p.reason)}</div>
${transferSteps(p)}
<div class="hint" style="margin:0">ระหว่างรอ เคสยังอยู่กับทีม ${esc(p.fromLabel)} และ SLA ยังนับต่อ</div>
${p.can.act ? `<div class="stack" style="gap:8px">
${p.status === "target" ? `<label class="f">User ในทีม ${esc(p.toLabel)} ที่จะรับเคส<select id="tr-owner"><option value="">เลือก User</option>${(p.owners || []).map((u) => `<option value="${u.id}">${esc(u.display_name)} · ${ROLE[u.role] || u.role}</option>`).join("")}</select></label>` : ""}
<label class="f">ความเห็น ${p.status === "target" ? "(ถึง User คนใหม่)" : ""} · บังคับเมื่อไม่อนุมัติ<input id="tr-note" maxlength="1000"></label>
<div class="actions" style="justify-content:flex-start"><button class="btn primary" type="button" data-tract="${p.status === "source" ? "approve" : "accept"}" data-id="${p.id}">${p.status === "source" ? "อนุมัติให้โอนออก" : "รับเคสเข้าทีม"}</button><button class="btn" type="button" data-tract="reject" data-id="${p.id}">ไม่อนุมัติ</button></div></div>` : ""}
${p.can.cancel ? `<div><button class="btn" type="button" data-tract="cancel" data-id="${p.id}" style="min-height:34px">ยกเลิกคำขอ</button></div>` : ""}</div>` : ""}
${!p && !closed && t.canRequest ? `<button class="btn" type="button" id="tr-req">ขอโอนข้ามทีม</button><div class="hint">เมื่อทีมใหม่รับ ระบบปิดเคสนี้ด้วยการโอน และเปิดเคสใหม่ให้ทีมใหม่ SLA เริ่มนับใหม่</div>` : ""}
${hist.length ? `<ul class="ext-hist">${hist.map((h) => `<li>${chip(TR_ST[h.status][0], TR_ST[h.status][1])} <strong>→ ${esc(h.toLabel)}</strong> · ${fdt(h.requestedAt)} · โดย ${esc(h.requestedBy || "-")}
<div>เหตุผล: ${esc(h.reason)}</div>
${h.status === "accepted" ? `<div class="muted">รับโดย ${esc(h.targetBy || "-")} · เคสใหม่ <a class="mono" href="#/case/${h.newCaseId}">${esc(h.newCaseNo || "")}</a> · User ${esc(h.newOwner || "-")}</div>` : h.decidedBy ? `<div class="muted">${esc(h.decidedBy)}${h.decisionNote ? ` · “${esc(h.decisionNote)}”` : ""}</div>` : ""}</li>`).join("")}</ul>` : ""}</section>`;
  }
  async function actTransfer(b, root, after) {
    const id = b.dataset.id;
    const act = b.dataset.tract;
    const noteEl = root.querySelector(`[data-trnote="${id}"]`) || document.getElementById("tr-note");
    const ownerEl = root.querySelector(`[data-trowner="${id}"]`) || document.getElementById("tr-owner");
    const note = noteEl ? noteEl.value : "";
    if (act === "reject" && note.trim().length < 3) return toast("ใส่เหตุผลที่ไม่อนุมัติในช่องความเห็น");
    if (act === "accept" && !(ownerEl && ownerEl.value)) return toast("เลือก User ที่จะรับเคส");
    if (act === "cancel" && !confirm("ยกเลิกคำขอโอนนี้?")) return;
    b.disabled = true;
    try {
      const r = await post(`/transfers/${id}/${act}`, { note, ownerId: ownerEl ? Number(ownerEl.value) : undefined });
      if (act === "accept") {
        toast(`รับเคสแล้ว เคสใหม่ ${r.newCaseNo} ระบบแจ้งทุกฝ่ายทาง email`, 6000);
        location.hash = `#/case/${r.newCaseId}`;
        return;
      }
      toast(act === "approve" ? "อนุมัติแล้ว ระบบแจ้ง Manager ทีมใหม่" : act === "reject" ? "ไม่อนุมัติ ระบบแจ้งผู้ขอแล้ว" : "ยกเลิกคำขอแล้ว", 5000);
      after && after();
    } catch (e) {
      b.disabled = false;
      toast(e.message, 6000);
    }
  }
  function bindTransferCard(c, t) {
    const card = document.getElementById("tr-card");
    if (!card) return;
    const req = document.getElementById("tr-req");
    if (req) req.onclick = () => openTransferRequest(c);
    const jump = document.querySelector("[data-trjump]");
    if (jump) jump.onclick = (e) => {
      e.preventDefault();
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    card.querySelectorAll("[data-tract]").forEach((b) => (b.onclick = () => actTransfer(b, card, () => viewCase(c.id))));
  }
  function openTransferRequest(c) {
    const dlg = document.getElementById("dlg");
    const iAmManager = ME.user.role === "admin" || (ME.user.role === "manager" && (ME.user.teams || []).includes(c.team));
    dlg.innerHTML = `<form class="card" method="dialog" id="trf"><h2>ขอโอนเคส ${esc(caseRef(c))} ข้ามทีม</h2>
<div class="stat2" style="grid-template-columns:repeat(3,1fr)"><div><div class="k">ทีมปัจจุบัน</div><div class="v" style="font-size:18px">${esc(c.sourceLabel)}</div></div>
<div><div class="k">Due ทีมเดิม</div><div class="v" style="font-size:18px">${fd(c.dueDate)}</div></div>
<div><div class="k">สถานะ</div><div class="v" style="font-size:18px">${c.stage === "overdue" ? `เกิน Due ${c.daysOverdue} วัน` : `เหลือ ${c.daysLeft} วัน`}</div></div></div>
<label class="f">โอนไปทีม<select name="to" required><option value="">เลือกทีม</option>${ME.teams.filter((t) => t.key !== c.team).map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join("")}</select></label>
<label class="f">เหตุผล และสิ่งที่ทีมใหม่ต้องรู้<textarea name="reason" rows="4" required minlength="10" placeholder="เช่น ปัญหาอยู่ที่ระบบ WFM ไม่ใช่ CXone ตรวจ log แล้วพบ ... ลูกค้าติดต่อคุณ ... ที่เบอร์ ..."></textarea></label>
<ol class="tr-steps" style="margin:0">${iAmManager ? `<li class="done"><b>คุณเป็น Manager ของทีมนี้</b><span>ถือว่าอนุมัติฝั่งทีมเดิมแล้ว</span></li>` : `<li class="cur"><b>Manager ทีม ${esc(c.sourceLabel)} อนุมัติ</b></li>`}<li><b>Manager ทีมใหม่รับเคส และเลือก User</b></li><li><b>ปิดเคสนี้ด้วยการโอน · เปิดเคสใหม่ให้ทีมใหม่</b><span>SLA ทีมใหม่เริ่มนับจากวันที่รับ</span></li></ol>
<p class="hint" style="margin:0">ระหว่างรอ เคสยังอยู่กับทีมเดิม SLA ยังนับต่อ ถ้าเคสเกิน Due ไปแล้ว ทีมเดิมยังนับเป็นไม่ทัน SLA</p>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">ส่งคำขอ</button></div></form>`;
    const f = dlg.querySelector("#trf");
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      if (!f.to.value) return toast("เลือกทีมที่จะโอนไป");
      if (f.reason.value.trim().length < 10) return toast("ใส่เหตุผลอย่างน้อย 10 ตัวอักษร");
      try {
        const r = await post(`/case/${c.id}/transfer`, { toTeam: f.to.value, reason: f.reason.value });
        dlg.close();
        toast(r.status === "target" ? "ส่งคำขอแล้ว ระบบแจ้ง Manager ทีมใหม่" : "ส่งคำขอแล้ว ระบบแจ้ง Manager ของทีมนี้ให้อนุมัติ", 6000);
        viewCase(c.id);
      } catch (err) {
        toast(err.message, 6000);
      }
    };
    dlg.showModal();
  }
  /** Box on the overview / my cases: transfer requests waiting for me, and mine still waiting. */
  async function transferPendingSection() {
    let d;
    try {
      d = await api("/transfers/pending");
    } catch (e) {
      return "";
    }
    const row = (p, forMe) => `<div class="ext-item"><div><a class="mono" href="#/case/${p.caseId}">${esc(p.caseNo)}</a> · <strong>${esc(p.site || "-")}</strong> · ${esc(p.task || "")} <span class="chip c-r1">${esc(p.fromLabel)} → ${esc(p.toLabel)}</span></div>
<div class="muted" style="font-size:13px">ขอโดย ${esc(p.requestedBy || "-")} · ${fdt(p.requestedAt)} · User ${esc(p.ownerName || "-")} · ${TR_ST[p.status][1]}</div>
<div class="ext-reason">${esc(p.reason)}</div>
${forMe ? `<div class="formgrid" style="align-items:end">${p.status === "target" ? `<div class="actions" style="justify-content:flex-start"><a class="btn primary" href="#/case/${p.caseId}">เปิดเคสเพื่อรับและเลือก User</a></div>` : `<label class="f">ความเห็น (บังคับเมื่อไม่อนุมัติ)<input data-trnote="${p.id}"></label><div class="actions" style="justify-content:flex-start"><button class="btn primary" type="button" data-tract="approve" data-id="${p.id}">อนุมัติให้โอนออก</button><button class="btn" type="button" data-tract="reject" data-id="${p.id}">ไม่อนุมัติ</button></div>`}</div>` : ""}</div>`;
    return `${d.forMe.length ? `<section class="card ext-wrap tr-wrap"><div class="title"><h2>คำขอโอนเคสข้ามทีม รอคุณ (${d.forMe.length})</h2></div>${d.forMe.map((p) => row(p, true)).join("")}</section>` : ""}
${d.mine.length ? `<section class="card"><div class="title"><h2>คำขอโอนเคสของคุณ รอดำเนินการ (${d.mine.length})</h2></div>${d.mine.map((p) => row(p, false)).join("")}</section>` : ""}`;
  }
  function bindTransferPending(root) {
    root.querySelectorAll(".tr-wrap [data-tract]").forEach((b) => (b.onclick = () => actTransfer(b, root, () => route())));
  }

  // ------------------------------------------------------------ customer intake (requests from LINE OA / links)
  const IK_STATUS = { pending: "รอรับเคส", claiming: "กำลังรับ", claimed: "รับแล้ว", rejected: "ปฏิเสธ", duplicate: "ซ้ำ" };
  function waitedText(ts) {
    const m = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000));
    if (m < 60) return `${m} นาที`;
    if (m < 1440) return `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
    return `${Math.floor(m / 1440)} วัน ${Math.floor((m % 1440) / 60)} ชม.`;
  }
  const ikCustomer = (i) => (i.site ? esc(i.site) : `${esc(i.customer_text || "ไม่ระบุ")} <span class="chip c-r1">ลูกค้ายังไม่ยืนยัน</span>`);
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
<div class="ik-actions">${canClaim ? `<button class="btn primary" type="button" data-claim="${i.id}">รับเคสเอง</button><button class="btn" type="button" data-transfer="${i.id}">โอนให้ User</button>` : ""}<a class="btn" href="#/intake/${i.id}">ดูรายละเอียด</a></div>
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

  function openConfirmCustomer(c, ik, lk, after) {
    const dlg = document.getElementById("dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dlg" }));
    const email = (ik && ik.contact_email) || "";
    const dom = (email.split("@")[1] || "").toLowerCase();
    const canRemember = dom && !(ME.config.publicDomains || []).includes(dom) && ["admin", "manager"].includes(ME.user.role);
    dlg.innerHTML = `<form class="card" method="dialog" id="ccf" style="min-width:min(520px,90vw)">
<h2>ยืนยันลูกค้า ${esc(caseRef(c))}</h2>
<p class="muted" style="margin:0">ผู้แจ้ง ${esc((ik && ik.contact_name) || "-")}${email ? ` · ${esc(email)}` : ""}</p>
${canRemember ? `<label class="chk"><input type="checkbox" name="remember" checked> <span>จำโดเมน <strong>@${esc(dom)}</strong> ไว้กับลูกค้ารายนี้<br><span class="muted" style="font-size:13px">email ครั้งต่อไปจากโดเมนนี้จะเข้าลูกค้ารายนี้ทันที</span></span></label>`
      : dom && !(ME.config.publicDomains || []).includes(dom) ? `<p class="hint" style="margin:0">ถ้าโดเมน @${esc(dom)} เป็นของลูกค้ารายนี้ แจ้ง Manager หรือ Admin ให้ผูกโดเมนในหน้าตั้งค่า</p>`
      : dom ? `<p class="hint" style="margin:0">@${esc(dom)} เป็น email ส่วนตัว ผูกโดเมนกับลูกค้าไม่ได้</p>` : ""}
${comboBox("site", "", lk.site, { label: "ลูกค้า (Site)", allowNew: true })}
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">ยืนยัน</button></div></form>`;
    const f = dlg.querySelector("#ccf");
    bindCombo(f, "site", lk.site);
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      const site = f.site.value.trim();
      if (!site) return toast("เลือกหรือพิมพ์ชื่อลูกค้า");
      const btn = f.querySelector("button[value=ok]");
      btn.disabled = true;
      try {
        const r = await post(`/case/${c.id}/confirm-customer`, { site, rememberDomain: f.remember && f.remember.checked ? dom : "" });
        dlg.close();
        toast(`ยืนยันลูกค้า ${r.site} แล้ว${r.remembered ? ` · จำโดเมน @${r.remembered} แล้ว` : ""}`, 5000);
        after();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 6000);
      }
    };
    dlg.showModal();
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
<fieldset class="stack" style="border:0;margin:0;padding:0;gap:8px"><legend style="font-weight:700;margin-bottom:6px">ใครเป็น User ของเคสนี้</legend>
<label class="chk ik-opt"><input type="radio" name="who" value="self" ${mode !== "transfer" ? "checked" : ""}> <span><strong>รับเคสเอง</strong><br><span class="muted">${esc(ME.user.display_name)} (คุณ) เป็น User</span></span></label>
<label class="chk ik-opt"><input type="radio" name="who" value="transfer" ${mode === "transfer" ? "checked" : ""}> <span style="flex:1"><strong>โอนให้ User คนอื่น</strong><br><span class="muted">ระบบแจ้งเขาทาง email ทันที</span>
${others.length ? `<select name="owner" aria-label="เลือก User" style="margin-top:6px">${others.map((u) => `<option value="${u.id}" ${u.id === i.recent_owner_id ? "selected" : ""}>${esc(u.display_name)}${u.teams && u.teams.length ? " · " + esc(u.teams.map(teamLabel).join(", ")) : ""}</option>`).join("")}</select>` : `<span class="hint">ยังไม่มีผู้ใช้อื่นในระบบ</span><input type="hidden" name="owner" value="">`}</span></label>
</fieldset>
<div class="formgrid">
${i.site ? "" : `<label class="f">ลูกค้า (Site)<select name="site"><option value="">ยังไม่ทราบ ยืนยันภายหลังบนหน้าเคส</option>${lk.site.map((s) => `<option>${esc(s)}</option>`).join("")}</select><span class="hint">${i.channel === "email" ? `ส่งจาก ${esc(i.contact_email || "-")}` : `ลูกค้าพิมพ์ว่า “${esc(i.customer_text || "-")}”`} · ไม่เลือกก็ได้ โทรถามลูกค้าแล้วกด “ยืนยันลูกค้า” บนหน้าเคส</span></label>`}
<label class="f">ทีม<select name="team">${ME.teams.map((t) => `<option value="${esc(t.key)}" ${t.key === defTeam ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
<label class="f">CS Number (ถ้ามี)<input name="cs" placeholder="เช่น CS5056901"></label>
<label class="f">Severity<select name="sev">${lk.severity.map((s) => `<option ${s === i.severity ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label></div>
<label class="f">ข้อความถึง User / บันทึกแรก (ไม่บังคับ)<textarea name="note" rows="2" placeholder="เช่น ลูกค้าเคยเจออาการเดียวกันเมื่อเดือนก่อน ดูเคส CS5056401 ประกอบ"></textarea></label>
<p class="hint" style="margin:0">เมื่อยืนยัน คำขอนี้กลายเป็นเคสปกติ เริ่มนับ SLA ${cfg.slaDays} วันวันนี้ และระบบแจ้งลูกค้า${i.channel === "email" ? "ทาง email " : i.channel === "line" ? "ทาง LINE " : ""}ว่าใครรับเคส${!ME.user.phone ? ` <span style="color:var(--warn,#B4530A)">· คุณยังไม่ได้ใส่เบอร์โทร ลูกค้าจะไม่เห็นเบอร์ของคุณ <a href="#/profile">ใส่เบอร์</a></span>` : ""}</p>
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
      if (f.who.value === "transfer" && !f.owner.value) return toast("เลือก User ที่จะโอนให้");
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
    const heads = status === "pending" || status === "held" ? "<th>รอมาแล้ว</th><th>ดูแลเคสล่าสุด</th>" : status === "claimed" ? "<th>รับเมื่อ</th><th>User / เคส</th>" : "<th>ปิดเมื่อ</th><th>เหตุผล</th>";
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
<div class="actions">${i.status === "pending" && !i.held && can("case_create") ? `<button class="btn primary" type="button" data-claim="${i.id}">รับเคสเอง</button><button class="btn" type="button" data-transfer="${i.id}">โอนให้ User</button><button class="btn" type="button" id="rej">ปิดคำขอ (ซ้ำ / ไม่ใช่เคส)</button>` : ""}
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
${i.claimed_at ? row(i.status === "claimed" ? "รับเคสโดย" : "ปิดโดย", `${esc(i.claimed_by_name || "-")} · ${fdt(i.claimed_at)}${i.owner_name && i.owner_name !== i.claimed_by_name ? ` · User: ${esc(i.owner_name)}` : ""}`) : ""}
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
<label class="f">แจ้งทีมเมื่อมีเคสใหม่ทาง email ที่<input id="em-team" value="${esc(es.teamNotifyTo || "")}" placeholder="support@sinostech.co.th"><span class="hint">ใส่ได้หลาย email คั่นด้วยจุลภาค เว้นว่าง = ใช้รายชื่อแจ้งทีมเดียวกับ LINE OA / ลิงก์ฟอร์ม · User เคสล่าสุดของลูกค้ารายนั้นได้ CC เหมือนเดิม</span></label>
<label class="f">email จากโดเมนที่ยังไม่ผูกกับลูกค้า<select id="em-unk"><option value="accept" ${es.unknownDomain === "accept" ? "selected" : ""}>รับเป็นคำขอปกติ ตอบลูกค้าทันที ยืนยันลูกค้าบนหน้าเคสภายหลัง (แนะนำ)</option><option value="hold" ${es.unknownDomain === "hold" ? "selected" : ""}>สร้างคำขอแต่พักไว้ให้ Admin / Manager ตรวจ (ไม่ตอบลูกค้า)</option><option value="ignore" ${es.unknownDomain === "ignore" ? "selected" : ""}>ข้าม ไม่สร้างคำขอ</option></select></label>
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
<li>หัวเรื่องมี [REQ-…] หรือหัวเรื่องเดิมจากผู้ส่งเดิมภายใน 3 วัน: เพิ่มเข้าเรื่องเดิม ถ้ารับเคสแล้วบันทึกเป็น Activity ของเคสและแจ้ง User</li>
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
      await post("/intake-admin/email", { enabled: $("em-on").checked, mailbox: $("em-mb").value.trim(), teamNotifyTo: $("em-team").value.trim(), autoReply: $("em-ack").checked, unknownDomain: $("em-unk").value, ignoreDomains: $("em-ign").value, perSenderPerHour: $("em-rate").value, keepDays: $("em-keep").value }, "PUT");
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
    ["work", "3. แต้มงาน (ปริมาณ × ความยาก)", 20],
    ["div", "4. ความหลากหลาย / Skill", 15],
    ["back", "5. งานค้างและการขยายเวลา", 10],
    ["doc", "6. คุณภาพการบันทึก", 10],
  ];
  const TH_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const ymLabel = (ym, full) => {
    const [y, m] = ym.split("-").map(Number);
    return `${full ? TH_FULL[m - 1] : TH_MONTHS[m - 1]} ${y + 543}`;
  };
  const kpiColor = (v, max) => (v == null ? "#9AA3AF" : v / max >= 0.8 ? "#1C6B45" : v / max >= 0.6 ? "#1764D8" : v / max >= 0.4 ? "#B07800" : "#9A1B30");
  /** KPI page of a person in an internal service team (scored on service requests). */
  function renderServiceKpi({ r, sel, owners, month, head, teamCards, teamName, params }) {
    const m = sel.metrics;
    const W = Object.fromEntries(sel.partDefs.map(([k, , w]) => [k, w]));
    const bars = sel.partDefs
      .filter(([, , w]) => w > 0)
      .map(([k, label, max], i) => {
        const v = sel.parts[k];
        return `<div class="kp-bar"><span>${i + 1}. ${esc(label)} (${max})</span><div class="t"><div style="width:${v == null ? 0 : Math.min(100, (v / max) * 100)}%;background:${kpiColor(v, max)}"></div></div><b>${v == null ? "-" : Math.round(v)} / ${max}</b></div>`;
      })
      .join("");
    const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $app.innerHTML = `${head}${teamCards}
${sel.insufficient ? `<div class="banner warn">${esc(sel.name)} ทำคำขอบริการเสร็จในเดือนนี้ ${m.srDone} งาน น้อยกว่า 3 งาน คะแนนจึงยังไม่ให้เกรด ใช้ดูแนวโน้มเท่านั้น</div>` : ""}
<div class="kp-g3">
<section class="card"><h2>คะแนนรวม</h2>
<div><span class="kp-score">${sel.score}</span>${sel.grade ? `<span class="kp-grade">${sel.grade}</span>` : `<span class="kp-grade na">ข้อมูลไม่พอ</span>`}</div>
<p class="muted" style="margin:6px 0 0">จาก 100 (+ โบนัส 5) · ชุดเกณฑ์ งานบริการภายใน${r.team.avgScore != null ? ` · ค่าเฉลี่ยทีม ${esc(teamName)} ${r.team.avgScore}` : ""}</p>
<div class="kp-trend" id="kp-trend"><div class="hint">กำลังโหลดแนวโน้ม…</div></div></section>
<section class="card"><h2>คะแนนแยกตามเกณฑ์</h2>${bars}
<div class="kp-bar"><span>+ โบนัส ความพอใจของผู้ขอ</span><div class="t"><div style="width:${((sel.parts.csat || 0) / 5) * 100}%;background:#C2410C"></div></div><b>+${sel.parts.csat || 0}</b></div>
<p class="hint" style="margin:6px 0 0">รวม ${Math.round(sel.base)} + โบนัส ${sel.parts.csat || 0}${sel.adjust ? ` ${sel.adjust.points > 0 ? "+" : ""}${sel.adjust.points} (ปรับโดย ${esc(sel.adjust.by || "-")}: ${esc(sel.adjust.reason)})` : ""} = ${sel.score}</p></section>
<section class="card"><h2>ตัวเลขของเดือน</h2><div class="stat2" style="grid-template-columns:1fr 1fr">
${stat("คำขอที่ทำเสร็จ", `${m.srDone} <span class="muted" style="font-size:14px">(ค่ากลางทีม ${m.teamMedianDone})</span>`)}
${stat("ทันกำหนด", m.srOnTimePct == null ? "-" : `${m.srOnTime} <span class="muted" style="font-size:14px">(${m.srOnTimePct}%)</span>`)}
${stat("เสร็จหลังเลื่อน Target", m.srAfterExt)}
${stat("เสร็จช้ากว่ากำหนด", `<span class="${m.srLate ? "t-over" : ""}">${m.srLate}</span>`)}
${stat("ค้างอยู่ตอนนี้", `${m.srOpen}${m.srOverdueNow ? ` <span class="t-over" style="font-size:14px">(เลย Target ${m.srOverdueNow})</span>` : ""}`)}
${stat("คะแนนจากผู้ขอ", m.ratingCount ? `${m.ratingAvg}/5 · ${m.ratingCount} งาน` : "-")}</div></section></div>
${Object.keys(sel.types).length ? `<section class="card"><h2>ประเภทงานที่ทำ</h2><div>${Object.entries(sel.types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="kp-tag">${esc(k)} · ${v}</span>`).join("")}</div></section>` : ""}
<section class="card"><h2>สรุปการทำงาน</h2><div class="kp-ai">${esc(sel.summary || "-").replace(/\n/g, "<br>")}</div></section>
${r.canAdjust ? `<section class="card noprint"><h2>ปรับคะแนนโดย Manager</h2><p class="hint" style="margin:0">ใช้กรณีที่ข้อมูลในระบบไม่สะท้อนงานจริง · บันทึกในประวัติการใช้งาน</p>
<div class="formgrid" style="align-items:end"><label class="f">คะแนน (−10 ถึง +10)<input type="number" id="kp-pts" min="-10" max="10" value="${sel.adjust ? sel.adjust.points : 0}"></label>
<label class="f" style="grid-column:span 2">เหตุผล<input id="kp-why" value="${esc(sel.adjust ? sel.adjust.reason : "")}" placeholder="เช่น งาน POC ใหญ่ 1 งานใช้เวลาทั้งเดือน"></label>
<div class="actions"><button class="btn primary" type="button" id="kp-save">บันทึก</button></div></div></section>` : ""}
${r.canAll ? `<section class="card"><div class="title"><h2>เทียบในทีม ${esc(teamName)} · ${ymLabel(month)}</h2><span>คลิกชื่อเพื่อดูรายละเอียด</span></div>
<div class="tablewrap"><table style="min-width:760px"><thead><tr><th>User</th><th class="n">คะแนน</th><th class="n">ทำเสร็จ</th><th class="n">ทันกำหนด</th><th class="n">ช้า</th><th class="n">ค้างอยู่</th><th class="n">คะแนนผู้ขอ</th></tr></thead><tbody>
${owners.map((o) => {
  const x = o.metrics;
  return o.profile === "service"
    ? `<tr class="click" data-href="#/kpi?${qs({ month, team: params.team, owner: o.id })}"><td style="font-weight:600">${esc(o.name)}</td><td class="n" style="font-weight:700">${o.score} ${o.grade || `<span class="muted" style="font-weight:400">ข้อมูลไม่พอ</span>`}</td><td class="n">${x.srDone}</td><td class="n">${x.srOnTimePct == null ? "-" : x.srOnTimePct + "%"}</td><td class="n">${x.srLate}</td><td class="n">${x.srOpen}</td><td class="n">${x.ratingCount ? x.ratingAvg + "/5" : "-"}</td></tr>`
    : `<tr class="click" data-href="#/kpi?${qs({ month, team: params.team, owner: o.id })}"><td style="font-weight:600">${esc(o.name)} <span class="muted" style="font-weight:400;font-size:12px">เกณฑ์ Support</span></td><td class="n" style="font-weight:700">${o.score} ${o.grade || ""}</td><td class="n" colspan="5"><span class="muted">ดูแล ${o.handled} เคส · ปิด ${x.closed}</span></td></tr>`;
}).join("")}</tbody></table></div></section>` : ""}
<section class="card noprint"><details><summary style="cursor:pointer;font-weight:600">เกณฑ์การให้คะแนน (งานบริการภายใน)</summary>
<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>เกณฑ์</th><th class="n">คะแนน</th><th>วิธีคิด</th></tr></thead><tbody>
<tr><td>1. ปริมาณงาน</td><td class="n">${W.volume}</td><td>จำนวนคำขอบริการที่ทำเสร็จในเดือน (ไม่นับคำขอซ้ำ) เทียบกับค่ากลางของทีม ทุกงานนับ 1 เท่ากัน · เท่าค่ากลางได้ประมาณ 3 ใน 4 · มากกว่าค่ากลาง 1.7 เท่าได้เต็ม</td></tr>
<tr><td>2. ทำได้ตามเวลาที่กำหนด</td><td class="n">${W.ontime}</td><td>เสร็จภายใน Target แรกที่อนุมัติ = เต็ม · เสร็จหลังขอเลื่อนแต่ทัน Target ใหม่ = ครึ่ง · ช้ากว่านั้น = 0</td></tr>
<tr><td>+ โบนัส ความพอใจของผู้ขอ</td><td class="n">5</td><td>คะแนน 1–5 ที่ผู้ขอให้ตอนยืนยันรับงาน ตั้งแต่ 2 งานในเดือน: เฉลี่ย ≥4.5 ได้ 5 · ≥4 ได้ 3 · ≥3.5 ได้ 1 (ไม่หักคะแนน)</td></tr>
</tbody></table></div><p class="hint">เกรด A ≥85 · A- 80–84 · B+ 75–79 · B 70–74 · C 60–69 · D ต่ำกว่า 60 · ทำเสร็จน้อยกว่า 3 งานยังไม่ให้เกรด · เทียบคะแนนกันได้เฉพาะในทีมเดียวกัน</p></details></section>`;
  }

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
    const r = await api("/kpi?" + qs({ month, team: params.team }));
    // A team without KPI (Sales): its own response page.
    if (r.teamProfile === "response" || (!r.canAll && r.myProfile === "response")) return location.replace("#/response?" + qs({ month, team: r.canAll ? r.teamCode : "" }));
    // A team set to "no KPI" (e.g. DEV): nothing is scored.
    if (r.teamProfile === "none" || (!r.canAll && r.myProfile === "none")) {
      $app.innerHTML = `<div class="head"><div><h1>KPI</h1></div>${r.canAll && r.teams.length > 1 ? `<div class="actions"><select id="kp-team" aria-label="ทีม" style="width:auto">${r.teams.map((t) => `<option value="${esc(t.code)}" ${t.code === r.teamCode ? "selected" : ""}>${esc(t.label)}</option>`).join("")}${r.allTeams ? `<option value="all">ทุกทีม</option>` : ""}</select></div>` : ""}</div>
<section class="card"><div class="empty">ทีมนี้ไม่คิด KPI · ไม่มีคะแนน ไม่อยู่ในอันดับ และไม่วัดผลรายคน<br>ทีมยังส่งและรับคำขอบริการ พร้อมการแจ้งเตือนตามปกติ</div></section>`;
      const ts = document.getElementById("kp-team");
      if (ts) ts.onchange = () => (location.hash = "#/kpi?" + qs({ month, team: ts.value }));
      return;
    }
    const owners = r.owners;
    const teamName = r.teamCode ? (r.teams.find((t) => t.code === r.teamCode) || {}).label || r.teamCode : "ทุกทีม";
    const sel = owners.find((o) => String(o.id) === String(params.owner)) || owners.find((o) => o.id === ME.user.id) || owners[0];
    const current = month === months[0];
    const head = `<div class="banner warn kp-trial"><strong>ทดลองใช้</strong> · เกณฑ์และคะแนนอยู่ระหว่างทดลอง ยังไม่ใช้ประเมินผลงานจริง ถ้าเห็นตัวเลขที่ไม่ตรงกับงานจริง แจ้ง Admin เพื่อปรับเกณฑ์</div>
<div class="head"><div><h1>KPI ราย User · ${ymLabel(month, true)} <span class="kp-beta">ทดลองใช้</span></h1>${r.canAll || r.teams.length ? `<p class="kp-team">ทีม ${esc(teamName)}${r.canAll ? ` · ${r.team.members} คนที่มีงานเดือนนี้` : ""}</p>` : ""}<p>คำนวณจากข้อมูลเคสในระบบ${current ? " · <strong>เดือนนี้ยังไม่จบ ตัวเลขยังเปลี่ยนได้</strong>" : ""} · Manager ปรับคะแนนได้ ±10 พร้อมเหตุผล</p></div>
<div class="actions" style="flex-direction:row;align-items:center">
${r.canAll && (r.teams.length > 1 || r.allTeams) ? `<select id="kp-team" aria-label="ทีม" style="width:auto">${r.teams.map((t) => `<option value="${esc(t.code)}" ${t.code === r.teamCode ? "selected" : ""}>${esc(t.label)}</option>`).join("")}${r.allTeams ? `<option value="all" ${!r.teamCode ? "selected" : ""}>ทุกทีม</option>` : ""}</select>` : ""}
${r.canAll && owners.length ? `<select id="kp-owner" aria-label="User" style="width:auto">${owners.map((o) => `<option value="${o.id}" ${sel && o.id === sel.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>` : ""}
<select id="kp-month" aria-label="เดือน" style="width:auto">${months.map((m) => `<option value="${m}" ${m === month ? "selected" : ""}>${ymLabel(m)}</option>`).join("")}</select>
<button class="btn" type="button" onclick="window.print()">พิมพ์ / PDF</button></div></div>`;
    const GCOL = { A: "#2E9E6A", B: "#7DB9E8", C: "#D9822B", D: "#E5484D" };
    const teamCards = r.teamSummary && r.teamSummary.length > 1
      ? `<section class="card noprint"><div class="title"><h2>KPI ราย ทีม · ${ymLabel(month)}</h2><span>${r.allTeams ? "ทุกทีม" : "ทีมของคุณ"} · กดการ์ดเพื่อดูคนในทีม</span></div><div class="kt-grid">${r.teamSummary
          .map((t) => {
            const g = Object.entries(t.grades).filter(([, n]) => n);
            return `<a class="kt ${t.code === r.teamCode ? "on" : ""}" href="#/kpi?${qs({ month, team: t.code })}"><h4><span>${esc(t.label)}</span><span class="muted" style="font-weight:400">${t.people} คน</span></h4>
<div class="kt-sc">${t.avgScore ?? "-"}<span class="muted"> เฉลี่ย${t.scored < t.people ? ` (${t.scored} คนมีเกรด)` : ""}</span></div>
<div class="kt-row"><span>${t.profile === "service" ? "ทันกำหนด" : "ทัน SLA"}</span><b>${t.slaPct == null ? "-" : t.slaPct + "%"}</b></div>
<div class="kt-gd">${g.map(([k, n]) => `<i style="flex:${n};background:${GCOL[k]}" title="${k} ${n} คน"></i>`).join("") || "<i style=\"flex:1;background:var(--line)\"></i>"}</div>
<div class="kt-row"><span>${["A", "B", "C", "D"].map((k) => `${k} ${t.grades[k] || 0}`).join(" · ")}</span></div></a>`;
          })
          .join("")}</div></section>`
      : "";
    if (!sel) {
      $app.innerHTML = head + teamCards + `<div class="empty">ไม่มีงานในเดือนนี้</div>`;
      bindKpiNav();
      return;
    }
    if (sel.profile === "service") renderServiceKpi({ r, sel, owners, month, head, teamCards, teamName, params });
    else renderSupportKpi();
    bindKpiAfter();
    return;
    function renderSupportKpi() {
    const m = sel.metrics;
    const W = Object.fromEntries((sel.partDefs || KPI_PARTS).map(([k, , w]) => [k, w]));
    const bars = (sel.partDefs ? sel.partDefs.map(([k, l, w], i) => [k, `${i + 1}. ${l}`, w]) : KPI_PARTS).filter(([, , max]) => max > 0).map(([k, label, max]) => {
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
    $app.innerHTML = `${head}${teamCards}
${sel.insufficient ? `<div class="banner warn">${esc(sel.name)} ปิดเคสในเดือนนี้ ${m.closed} เคส น้อยกว่า 3 เคส คะแนนจึงยังไม่ให้เกรด ใช้ดูแนวโน้มเท่านั้น</div>` : ""}
<div class="kp-g3">
<section class="card"><h2>คะแนนรวม</h2>
<div><span class="kp-score">${sel.score}</span>${sel.grade ? `<span class="kp-grade">${sel.grade}</span>` : `<span class="kp-grade na">ข้อมูลไม่พอ</span>`}</div>
<p class="muted" style="margin:6px 0 0">จาก 100 (+ โบนัส 10)${r.team.avgScore != null ? ` · ค่าเฉลี่ยทีม ${esc(teamName)} ${r.team.avgScore}` : ""}</p>
<div class="kp-trend" id="kp-trend"><div class="hint">กำลังโหลดแนวโน้ม…</div></div></section>
<section class="card"><h2>คะแนนแยกตามเกณฑ์</h2>${bars}
<div class="kp-bar"><span>+ โบนัส รับเคสจากลูกค้า</span><div class="t"><div style="width:${(sel.parts.bonus / 5) * 100}%;background:#7A4FBF"></div></div><b>+${sel.parts.bonus}</b></div>
<div class="kp-bar"><span>+ โบนัส ความพึงพอใจลูกค้า</span><div class="t"><div style="width:${((sel.parts.csat || 0) / 5) * 100}%;background:#C2410C"></div></div><b>+${sel.parts.csat || 0}</b></div>
<p class="hint" style="margin:6px 0 0">รวม ${Math.round(sel.base)} + โบนัส ${sel.parts.bonus + (sel.parts.csat || 0)}${sel.adjust ? ` ${sel.adjust.points > 0 ? "+" : ""}${sel.adjust.points} (ปรับโดย ${esc(sel.adjust.by || "-")}: ${esc(sel.adjust.reason)})` : ""} = ${sel.score}</p></section>
<section class="card"><h2>ตัวเลขของเดือน</h2><div class="stat2" style="grid-template-columns:1fr 1fr">
${stat("ดูแล / ปิดเคส", `${sel.handled} / ${m.closed}`)}
${stat("ปิดทัน SLA เดิม", m.slaPct == null ? "-" : `${m.onTime} <span class="muted" style="font-size:14px">(${m.slaPct}%)</span>`)}
${stat("ตอบสนองครั้งแรก (มัธยฐาน)", m.firstResponseHrs == null ? "-" : `${m.firstResponseHrs} ชม.`)}
${stat("อัปเดตเคสทุก", m.updateEveryDays == null ? "-" : `${m.updateEveryDays} วัน`)}
${stat("แต้มงาน", `${m.points ?? "-"} <span class="muted" style="font-size:14px">(ค่ากลางทีม ${m.teamMedianPoints ?? "-"})</span>`)}
${stat("เคสส่ง NICE", `${m.vendor ?? 0}${m.dedicated ? ' <span class="muted" style="font-size:14px">· ดูแลลูกค้าประจำ</span>' : ""}`)}
${stat("ขยายเวลา (อนุมัติ)", `${m.extensions} ครั้ง`)}
${stat("เกิน Due สิ้นเดือน", `<span class="${m.overdueAtEnd ? "t-over" : ""}">${m.overdueAtEnd}</span>`)}
${stat("Critical", m.critical)}
${stat("รับเคสลูกค้าใน 1 ชม.", m.fastClaims)}
${stat("Deploy Patch", m.deploys ? `${m.deploys} เคส` : 0)}
${stat("Meeting กับลูกค้า", m.meetings ? `${m.meetings} (Onsite ${m.meetingsOnsite || 0} · Online ${m.meetingsOnline || 0})` : 0)}
${stat("ความพึงพอใจลูกค้า", m.csatCount ? `${m.csatAvg}/5 · ${m.csatCount} คำตอบ` : "-")}</div></section></div>

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
<label class="f" style="grid-column:span 2">เหตุผล<input id="kp-why" value="${esc(sel.adjust ? sel.adjust.reason : "")}" placeholder="เช่น CASE-2026-0012 ช้าเพราะรอ Vendor ไม่ใช่ความผิดของ User"></label>
<div class="actions"><button class="btn primary" type="button" id="kp-save">บันทึก</button></div></div></section>` : ""}

${r.canAll ? `<section class="card"><div class="title"><h2>เทียบในทีม ${esc(teamName)} · ${ymLabel(month)}</h2><span>คลิกชื่อเพื่อดูรายละเอียด</span></div>
<div class="tablewrap"><table style="min-width:900px"><thead><tr><th>User</th><th class="n">คะแนน</th><th class="n">ดูแล / ปิด</th><th class="n">ทัน SLA</th><th class="n">ตอบสนอง</th><th class="n">อัปเดตทุก</th><th class="n">หลากหลาย</th><th>Skill หลัก</th></tr></thead><tbody>
${owners.map((o) => `<tr class="click" data-href="#/kpi?${qs({ month, team: params.team, owner: o.id })}"><td style="font-weight:600">${esc(o.name)}</td><td class="n" style="font-weight:700">${o.score} ${o.grade || `<span class="muted" style="font-weight:400">ข้อมูลไม่พอ</span>`}</td>
<td class="n">${o.handled} / ${o.metrics.closed}</td><td class="n">${o.metrics.slaPct == null ? "-" : o.metrics.slaPct + "%"}</td><td class="n">${o.metrics.firstResponseHrs == null ? "-" : o.metrics.firstResponseHrs + " ชม."}</td>
<td class="n">${o.metrics.updateEveryDays == null ? "-" : o.metrics.updateEveryDays + " วัน"}</td><td class="n">${o.metrics.diversity.toFixed(2)}</td><td>${esc(Object.entries(o.products).sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]).join(", ") || "-")}</td></tr>`).join("")}</tbody></table></div></section>` : ""}

<section class="card noprint"><details><summary style="cursor:pointer;font-weight:600">เกณฑ์การให้คะแนน</summary>
<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>เกณฑ์</th><th class="n">คะแนน</th><th>วิธีคิด</th></tr></thead><tbody>
<tr><td>1. ปิดทัน SLA</td><td class="n">${W.sla}</td><td>% เคสที่ปิดทัน Due เดิม (ก่อนขยาย) · ปิดทันเวลาที่ขยายได้ครึ่งหนึ่ง · Critical นับ 2 เท่า</td></tr>
<tr><td>2. ความเร็วตอบสนอง</td><td class="n">${W.resp}</td><td>Activity แรกหลังเปิดเคส ≤4 ชม. 8 · ≤8 ชม. 6 · ≤24 ชม. 4 · ≤48 ชม. 2 และอัปเดตเคสที่เปิดอยู่ทุก ≤2 วัน 7 · ≤3 วัน 5 · ≤5 วัน 3</td></tr>
<tr><td>3. แต้มงาน (ปริมาณ × ความยาก)</td><td class="n">${W.work}</td><td>แต้มต่อเคสที่ปิด = Severity (Critical 3, High 2, Medium 1.5, Deploy Product Patch 1.5, Low 1, Deploy MS Patch 1, ขอข้อมูล 0.5) × (1 + ส่ง NICE/มี CS Number 0.5 + Onsite 0.3 + Meeting Onsite 0.4 / Meeting Online 0.2 ต่อครั้ง นับ 2 ครั้งที่มากสุด ไม่เกิน 0.6 + Deploy Product Patch 0.3 / Deploy MS Patch 0.15 (ครั้งเดียวต่อเคส) + เปิดนานเกิน 7 วัน 0.2) × ความยากที่ Manager ปรับ (0.8–1.5) · เทียบค่ากลางของทีมเดียวกันแบบรากที่สอง: 20 × √(แต้ม ÷ ค่ากลาง) ÷ 1.3 สูงสุด 20 · เคสมากขึ้น 4 เท่าได้คะแนนเพิ่มประมาณ 2 เท่า</td></tr>
<tr><td>4. ความหลากหลาย / Skill</td><td class="n">${W.div}</td><td>ความกระจายของประเภทงาน Product และลูกค้า (0–1) × 10.5 + Product หรือประเภทงานที่ทำครั้งแรก 1.5 ต่อรายการ (สูงสุด 4.5) · Meeting กับลูกค้านับเป็นประเภทงานหนึ่ง Deploy Patch นับเป็นงาน Upgrade / Patch และครั้งแรกของทั้งสองอย่างนับเป็น Skill ใหม่ · คนที่ตั้งเป็น "ดูแลลูกค้าประจำ" ไม่นับความหลากหลายของลูกค้า</td></tr>
<tr><td>5. งานค้างและการขยายเวลา</td><td class="n">${W.back}</td><td>เริ่ม 10 · หัก 2 ต่อเคสเกิน Due สิ้นเดือน · หัก 1 ต่อการขยายที่อนุมัติ (สูงสุด 3)</td></tr>
<tr><td>6. คุณภาพการบันทึก</td><td class="n">${W.doc}</td><td>เคสที่ปิดมีบันทึกสุดท้าย ≥20 ตัวอักษร 5 · Activity ที่มีเนื้อหาเฉลี่ย ≥3 ต่อเคส 5</td></tr>
<tr><td>+ โบนัส</td><td class="n">5</td><td>รับเคสจากลูกค้าภายใน 1 ชม. ทุก 2 เคสได้ 1 (สูงสุด 5)</td></tr>
<tr><td>+ โบนัส ความพึงพอใจลูกค้า</td><td class="n">5</td><td>คะแนนแบบสอบถามหลังปิดเคสที่ลูกค้าตอบในเดือนนั้น ต้องมีอย่างน้อย 2 คำตอบ · เฉลี่ย ≥4.5 ได้ 5 · ≥4 ได้ 3 · ≥3.5 ได้ 1 · ให้เพิ่มอย่างเดียว ไม่หักคะแนน (คะแนน 1–2 แจ้ง Manager ให้ติดตามแทน)</td></tr></tbody></table></div>
<p class="hint">เกรด A ≥85 · A- 80–84 · B+ 75–79 · B 70–74 · C 60–69 · D ต่ำกว่า 60 · ปิดเคสน้อยกว่า 3 เคสไม่ให้เกรด</p></details></section>

${r.canEditCategories ? `<section class="card noprint"><details><summary style="cursor:pointer;font-weight:600">ตั้งค่าประเภทงาน (คำสำคัญ)</summary>
<p class="hint">1 บรรทัดต่อ 1 ประเภท รูปแบบ <span class="mono">ชื่อประเภท: คำ1, คำ2, คำ3</span> · ระบบเลือกประเภทที่เจอคำมากที่สุดในหัวข้อเคสและ Activity · ไม่เจอเลย = อื่นๆ</p>
<textarea id="kp-cats" rows="12" style="width:100%;font-family:var(--mono, monospace);font-size:13px">${esc(r.categories.map((c) => `${c.name}: ${c.keywords}`).join("\n"))}</textarea>
<div class="actions"><button class="btn primary" type="button" id="kp-cats-save">บันทึกประเภทงาน</button></div></details></section>` : ""}`;
    }
    function bindKpiAfter() {
    bindKpiNav();
    bindRowLinks();
    const sv = document.getElementById("kp-save");
    if (sv) sv.onclick = async () => {
      try {
        await post("/kpi/adjust", { month, userId: sel.id, points: Number(document.getElementById("kp-pts").value), reason: document.getElementById("kp-why").value }, "PUT");
        toast("บันทึกการปรับคะแนนแล้ว");
        viewKpi({ month, team: params.team, owner: sel.id });
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
        viewKpi({ month, team: params.team, owner: sel.id });
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
  }
  function bindKpiNav() {
    const o = document.getElementById("kp-owner");
    const mo = document.getElementById("kp-month");
    const tm = document.getElementById("kp-team");
    const go = (keepOwner) => (location.hash = "#/kpi?" + qs({ month: mo.value, team: tm ? tm.value : "", owner: keepOwner && o ? o.value : "" }));
    if (o) o.onchange = () => go(true);
    if (mo) mo.onchange = () => go(true);
    if (tm) tm.onchange = () => go(false);
  }

  // ------------------------------------------------------------ response score (teams without KPI, e.g. Sales)
  async function viewResponse(params) {
    setNav("response");
    const months = [];
    for (let i = 0; i < 12; i++) {
      const t = new Date();
      t.setDate(1);
      t.setMonth(t.getMonth() - i);
      months.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`);
    }
    const month = params.month || months[0];
    const r = await api("/kpi/response?" + qs({ month, user: params.user }));
    const s = r.sel;
    const head = `<div class="head"><div><h1>การตอบกลับ · ${ymLabel(month, true)}</h1><p class="kp-team">${r.teams.length ? "ทีม " + esc(r.teams.map((t) => t.label).join(", ")) + " · " : ""}ไม่คิด KPI · ใช้ดูว่าคำขอบริการไม่ติดอยู่ที่ฝั่งผู้ขอ</p></div>
<div class="actions" style="flex-direction:row;align-items:center">
${r.canAll && r.people.length ? `<select id="rs-user" aria-label="ผู้ใช้" style="width:auto">${r.people.map((p) => `<option value="${p.id}" ${s && p.id === s.id ? "selected" : ""}>${esc(p.name)}${p.score != null ? ` (${p.score})` : ""}</option>`).join("")}</select>` : ""}
<select id="rs-month" aria-label="เดือน" style="width:auto">${months.map((m) => `<option value="${m}" ${m === month ? "selected" : ""}>${ymLabel(m)}</option>`).join("")}</select></div></div>`;
    const bind = () => {
      const u = document.getElementById("rs-user");
      const mo = document.getElementById("rs-month");
      const go = () => (location.hash = "#/response?" + qs({ month: mo.value, user: u ? u.value : "" }));
      if (u) u.onchange = go;
      mo.onchange = go;
      bindRowLinks();
    };
    if (!s) {
      $app.innerHTML = head + `<div class="empty">ยังไม่มีคนในทีมที่วัดเฉพาะการตอบกลับ</div>`;
      return bind();
    }
    const st = s.stats;
    const col = (v) => (v == null ? "var(--muted)" : v >= 80 ? "#1F7A4D" : v >= 60 ? "#B26B00" : "var(--over-fg)");
    const stat = (k, v) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $app.innerHTML = `${head}
<div class="rs-grid"><section class="card"><h2>คะแนนการตอบกลับ${r.canAll ? ` · ${esc(s.name)}` : ""}</h2>
<div class="rs-big" style="color:${col(s.score)}">${s.score ?? "-"}</div>
<p class="muted" style="margin:6px 0 12px">${s.score == null ? "ไม่มีคำขอบริการในเดือนนี้" : "จาก 100"}${r.teamAvg != null ? ` · ทีมเฉลี่ย ${r.teamAvg}` : ""}</p>
${r.partDefs.filter(([, , w]) => w > 0).map(([k, l, w]) => `<div class="kp-bar"><span>${esc(l)} (${w})</span><div class="t"><div style="width:${Math.min(100, ((s.parts[k] || 0) / w) * 100)}%;background:${kpiColor(s.parts[k], w)}"></div></div><b>${Math.round(s.parts[k] || 0)} / ${w}</b></div>`).join("")}
<div class="stat2" style="grid-template-columns:1fr 1fr;margin-top:12px">
${stat("ส่งคำขอ", st.sent)}
${stat("ตอบเมื่อทีมขอข้อมูล (มัธยฐาน)", st.medianReplyHrs == null ? "-" : `${st.medianReplyHrs} ชม.`)}
${stat("ทีมขอข้อมูลเพิ่ม", `${st.answered} / ${st.asked} ตอบแล้ว`)}
${stat("ยืนยันรับงาน", st.decided ? `${st.confirmed} / ${st.decided}` : "-")}</div></section>
<section class="card"><div class="title"><h2>คำขอที่รอ${r.canAll && s.id !== ME.user.id ? esc(s.name) : "คุณ"}อยู่</h2><span>ทีมรับงานรอคำตอบ 2 วันทำการขึ้นไป</span></div>
${s.waiting.length ? `<div class="tablewrap"><table><thead><tr><th>คำขอ</th><th>รออะไร</th><th class="n">รอมาแล้ว</th></tr></thead><tbody>
${s.waiting.map((w) => `<tr class="click" data-href="#/sr/${w.id}"><td><span class="mono muted">${esc(w.srNo)}</span><br><a href="#/sr/${w.id}" style="font-weight:600">${esc(w.title)}</a></td><td>${esc(w.what)}</td><td class="n"><span class="chip ${w.days >= 3 ? "c-overdue" : "c-r1"}">${w.days} วันทำการ</span></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">ไม่มีคำขอที่รออยู่</div>`}
<details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">วิธีคิดคะแนน</summary><ul style="margin:8px 0 0;padding-left:18px;font-size:14px;line-height:1.8">
<li>ตอบเมื่อทีมขอข้อมูลเพิ่ม: ภายใน 1 วันทำการ เต็ม · 2 วัน 60% · 3 วัน 30% · ช้ากว่านั้นหรือยังไม่ตอบ 0</li>
<li>ยืนยันรับงานที่เสร็จ: % ของงานที่กดยืนยันภายใน 7 วันหลังทีมปิดงาน</li>
<li>ไม่มีคำขอค้างรอตัวเอง: หัก 34% ต่อคำขอที่รอคุณเกิน 2 วันทำการ (นับเฉพาะเดือนปัจจุบัน)</li>
<li>เดือนที่ไม่มีเรื่องให้ตอบ ข้อนั้นได้เต็ม · ไม่มีเกรด และไม่อยู่ในหน้าอันดับ KPI</li></ul></details></section></div>`;
    bind();
  }

  // ------------------------------------------------------------ overview by team
  const monthOpts = (cur, n = 6) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = new Date();
      t.setDate(1);
      t.setMonth(t.getMonth() - i);
      const ym = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
      out.push(`<option value="${ym}" ${ym === cur ? "selected" : ""}>${ymLabel(ym)}</option>`);
    }
    return out.join("");
  };
  const slaColor = (p) => (p == null ? "var(--line)" : p < 85 ? "var(--over)" : p < 95 ? "#D9822B" : "#2E9E6A");
  const teamKpis = (t) => `<div class="kpis">
<div class="kpi"><div class="l">ยังไม่ปิด</div><div class="v">${t.open}</div></div>
<div class="kpi"><div class="l">เกิน Due</div><div class="v" style="${t.overdue ? "color:var(--over-fg)" : ""}">${t.overdue}</div></div>
<div class="kpi"><div class="l">ใกล้ Due</div><div class="v">${t.soon}</div></div>
<div class="kpi"><div class="l">ปิดในเดือน</div><div class="v">${t.closed}</div></div>
<div class="kpi"><div class="l">ทัน SLA</div><div class="v">${t.slaPct == null ? "-" : t.slaPct + "%"}</div></div>
<div class="kpi"><div class="l">คำขอบริการค้าง</div><div class="v">${t.srOpen}</div></div></div>`;

  async function viewTeams(params) {
    setNav("team");
    const r = await api("/teams/overview?" + qs({ month: params.month }));
    $app.innerHTML = `<div class="head"><div><h1>ภาพรวม ราย ทีม</h1><p>เทียบงานของแต่ละทีม · ปิดในเดือนและ % ทัน SLA ตามเดือนที่เลือก · ยังไม่ปิด เกิน Due และใกล้ Due คือสถานะตอนนี้ · กดการ์ดเพื่อดูคนในทีม</p></div>
<div class="actions" style="flex-direction:row"><select id="tm-month" aria-label="เดือน" style="width:auto">${monthOpts(r.month)}</select></div></div>
${teamKpis(r.total)}
<div class="tm-grid">${r.teams
      .map(
        (t) => `<a class="tm-card" href="#/team/${encodeURIComponent(t.code)}?${qs({ month: params.month })}"><h3><span>${esc(t.label)}</span>${t.overdue ? `<span class="chip c-overdue">เกิน Due ${t.overdue}</span>` : `<span class="chip c-ok">ปกติ</span>`}</h3>
<div class="tm-nums"><div>ยังไม่ปิด<b>${t.open}</b></div><div>ใกล้ Due<b>${t.soon}</b></div><div>ปิดในเดือน<b>${t.closed}</b></div><div>คำขอค้าง<b>${t.srOpen}</b></div></div>
<div><div class="tm-foot"><span>ทัน SLA</span><b>${t.slaPct == null ? "-" : t.slaPct + "%"}</b></div><div class="tm-bar"><i style="width:${t.slaPct || 0}%;background:${slaColor(t.slaPct)}"></i></div></div>
<div class="tm-foot"><span>${t.members} คน${t.members ? ` · งานเฉลี่ย ${(t.open / t.members).toFixed(1)} เคส/คน` : ""}</span><span>${t.topCustomers.length ? "ลูกค้าหลัก: " + esc(t.topCustomers.join(", ")) : ""}</span></div></a>`
      )
      .join("") || `<div class="empty">ไม่มีทีม</div>`}</div>`;
    document.getElementById("tm-month").onchange = (e) => (location.hash = "#/team?" + qs({ month: e.target.value }));
  }

  async function viewTeam(code, params) {
    setNav("team");
    const r = await api(`/teams/overview/${encodeURIComponent(code)}?` + qs({ month: params.month }));
    const mx = Math.max(1, ...r.members.map((m) => m.open));
    $app.innerHTML = `<div class="crumb"><a href="#/team?${qs({ month: params.month })}">ภาพรวม ราย ทีม</a> / ${esc(r.team.label)}</div>
<div class="head"><div><h1>${esc(r.team.label)}</h1><p>${r.members.length} คน · ${ymLabel(r.month, true)} · กดชื่อเพื่อดูหน้า ราย User</p></div>
<div class="actions" style="flex-direction:row">${r.teams.length > 1 ? `<select id="tm-team" aria-label="ทีม" style="width:auto">${r.teams.map((t) => `<option value="${esc(t.code)}" ${t.code === r.team.code ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>` : ""}
<select id="tm-month" aria-label="เดือน" style="width:auto">${monthOpts(r.month)}</select></div></div>
${teamKpis(r.total)}
<section class="card"><div class="title"><h2>คนในทีม</h2><span>เรียงจากงานค้างมากสุด</span></div>
${r.members.length ? `<div class="tablewrap"><table style="min-width:880px"><thead><tr><th>ชื่อ</th><th>งานค้าง</th><th class="n">เกิน Due</th><th class="n">ใกล้ Due</th><th class="n">ปิดในเดือน</th><th class="n">ทัน SLA</th><th class="n">คำขอค้าง</th><th>ลูกค้าที่ดูแลอยู่</th></tr></thead><tbody>
${r.members
  .map(
    (m) => `<tr class="click" data-href="#/owner/${encodeURIComponent(m.ownerKey)}"><td><a href="#/owner/${encodeURIComponent(m.ownerKey)}" style="font-weight:600">${esc(m.name)}</a> <span class="muted" style="font-size:13px">${ROLE[m.role] || m.role}</span></td>
<td><div class="tm-load"><b>${m.open}</b><div class="tm-bar"><i style="width:${(m.open / mx) * 100}%;background:${m.open >= mx * 0.8 && m.open >= 5 ? "#D9822B" : "#2E9E6A"}"></i></div></div></td>
<td class="n">${m.overdue ? `<span class="chip c-overdue">${m.overdue}</span>` : 0}</td><td class="n">${m.soon}</td><td class="n">${m.closed}</td>
<td class="n" style="${m.slaPct != null && m.slaPct < 85 ? "color:var(--over-fg)" : ""}">${m.slaPct == null ? "-" : m.slaPct + "%"}</td><td class="n">${m.srOpen}</td><td>${esc(m.customers.join(", ") || "-")}</td></tr>`
  )
  .join("")}</tbody></table></div>` : `<div class="empty">ยังไม่มีคนในทีมนี้</div>`}</section>
<section class="card"><div class="title"><h2>เคสที่ต้องดูแลก่อน</h2><span>เกิน Due และใกล้ Due ของทั้งทีม</span></div>
${r.urgent.length ? `<div class="tablewrap"><table style="min-width:760px"><thead><tr><th>เคส</th><th>ลูกค้า</th><th>งาน</th><th>ผู้ดูแล</th><th>Severity</th><th>สถานะ</th></tr></thead><tbody>
${r.urgent.map((c) => `<tr class="click" data-href="#/case/${c.id}"><td><a href="#/case/${c.id}">${esc(caseRef(c))}</a></td><td>${esc(c.site)}</td><td>${esc(c.task)}</td><td>${esc(c.owner)}</td><td>${sevChip(c.severity)}</td><td>${chip(c.stage, c.stage === "overdue" && c.daysOverdue ? `เกิน Due ${c.daysOverdue} วัน` : "")}</td></tr>`).join("")}
</tbody></table></div>` : `<div class="empty">ไม่มีเคสเกินหรือใกล้ Due</div>`}</section>`;
    bindRowLinks();
    const tm = document.getElementById("tm-team");
    const mo = document.getElementById("tm-month");
    const go = () => (location.hash = `#/team/${encodeURIComponent(tm ? tm.value : r.team.code)}?` + qs({ month: mo.value }));
    if (tm) tm.onchange = go;
    mo.onchange = go;
  }

  // ------------------------------------------------------------ service requests (internal, SR-…)
  const SR_ST = { pending: "s-wait", info: "s-info", in_progress: "s-run", overdue: "s-due", done: "s-ok", rejected: "s-off", cancelled: "s-off" };
  const SR_SEV = { urgent_high: "sv1", urgent: "sv2", normal: "sv3" };
  const srChip = (r) => `<span class="srst ${SR_ST[r.status] || ""}">${esc(r.statusLabel)}</span>`;
  const srSev = (r) => `<span class="srsev ${SR_SEV[r.severity] || ""}">${esc(r.severityLabel)}</span>`;
  const dlong = (iso) => {
    if (!iso) return "-";
    const t = new Date(iso + "T00:00:00");
    return t.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  };
  let SR_META = null;
  async function srMeta(force) {
    if (!SR_META || force) SR_META = await api("/sr/meta");
    return SR_META;
  }
  async function refreshSrBadge() {
    try {
      const m = await srMeta(true);
      const n = m.canManage ? m.counts.pending : 0;
      const a = document.querySelector('#tabs a[data-nav="sr"]');
      if (!a) return;
      let b = a.querySelector(".badge");
      if (!b && n) {
        b = document.createElement("span");
        b.className = "badge";
        a.appendChild(b);
      }
      if (b) {
        b.textContent = n;
        b.hidden = !n;
        b.title = `${n} คำขอรออนุมัติ`;
      }
    } catch (e) {}
  }
  /** Read picked/pasted files as base64 for the JSON API. */
  function readFiles(list) {
    return Promise.all(
      [...list].map(
        (f) =>
          new Promise((ok, no) => {
            const r = new FileReader();
            r.onload = () => ok({ name: f.name || "pasted.png", type: f.type, data: String(r.result).split(",")[1] || "" });
            r.onerror = () => no(new Error(`อ่านไฟล์ ${f.name} ไม่ได้`));
            r.readAsDataURL(f);
          })
      )
    );
  }
  /** A file input with paste support; returns a getter for the picked files. */
  function filePicker(root, meta) {
    const inp = root.querySelector("input[type=file]");
    const out = root.querySelector(".fp-list");
    const files = [];
    const show = () => (out.innerHTML = files.map((f, i) => `<span class="gchip">📎 ${esc(f.name || "pasted.png")} <span class="muted">${Math.max(1, Math.round(f.size / 1024))} KB</span><button type="button" data-rm="${i}" aria-label="เอาไฟล์ ${esc(f.name)} ออก">×</button></span>`).join(""));
    const add = (list) => {
      for (const f of list) {
        const ext = (f.name || "x.png").split(".").pop().toLowerCase();
        if (!meta.fileExt.includes(ext)) toast(`ไฟล์ .${ext} ไม่รองรับ`, 5000);
        else if (f.size > meta.maxFileMb * 1048576) toast(`${f.name} ใหญ่เกิน ${meta.maxFileMb} MB`, 5000);
        else if (files.length >= 10) toast("แนบได้สูงสุด 10 ไฟล์ต่อครั้ง", 5000);
        else files.push(f);
      }
      show();
    };
    inp.onchange = () => {
      add(inp.files);
      inp.value = "";
    };
    out.onclick = (e) => {
      const b = e.target.closest("[data-rm]");
      if (b) {
        files.splice(Number(b.dataset.rm), 1);
        show();
      }
    };
    root.addEventListener("paste", (e) => {
      const imgs = [...(e.clipboardData?.files || [])];
      if (imgs.length) {
        e.preventDefault();
        add(imgs);
      }
    });
    return { get: () => readFiles(files), count: () => files.length };
  }
  const fileBox = (meta, label = "ไฟล์แนบ (ไม่บังคับ)") => `<div class="f fp"><span>${label}</span><input type="file" multiple accept="${meta.fileExt.map((x) => "." + x).join(",")}">
<span class="hint">ไม่เกิน ${meta.maxFileMb} MB ต่อไฟล์ · วางภาพหน้าจอ (Ctrl+V) ในกล่องนี้ได้</span><div class="fp-list"></div></div>`;

  /** Service requests visible to this user ("team" = everything they may see), [] on any error. */
  async function srList(scope) {
    if (ME.user.role === "viewer" || ME.user.role === "requester") return [];
    try {
      return (await api("/sr?scope=" + scope)).items;
    } catch (e) {
      return [];
    }
  }
  const srOpen = (r) => r.status === "in_progress" || r.status === "overdue";
  // Overdue first, then the nearest target date.
  const srByTarget = (a, b) => (b.status === "overdue") - (a.status === "overdue") || String(a.targetDate || "").localeCompare(String(b.targetDate || ""));
  const srDue = (r) => (r.status === "overdue" ? `<span class="t-over">เลย ${r.overdueDays} วันทำการ</span>` : r.daysLeft === 0 ? `<span class="t-r2">ครบวันนี้</span>` : r.daysLeft != null ? `อีก ${r.daysLeft} วันทำการ` : "");
  /** Compact table of service requests for the case pages (เคสของฉัน, ราย User, ประชุม). */
  function srWorkTable(items, { showAssignee = false, print = false } = {}) {
    if (!items.length) return `<div class="empty">ไม่มีคำขอบริการค้าง</div>`;
    return `<div class="tablewrap"><table class="${print ? "mt-index" : ""}"><thead><tr><th>เลขคำขอ</th><th>งานที่ขอ</th><th>ผู้ขอ</th>${showAssignee ? "<th>ผู้รับผิดชอบ</th>" : ""}<th>Severity</th><th>Target</th><th>สถานะ</th></tr></thead><tbody>
${items.map((r) => `<tr class="click" data-href="#/sr/${r.id}"><td class="mono"><a href="#/sr/${r.id}">${esc(r.srNo)}</a></td>
<td style="font-weight:600">${esc(r.title)}${r.customer ? `<div class="hint">${esc(r.customer)}</div>` : ""}</td>
<td>${esc(r.requester.name)}<div class="hint">${esc(r.requester.department || "")}</div></td>
${showAssignee ? `<td>${r.assignee ? esc(r.assignee.name) : "-"}</td>` : ""}
<td>${srSev(r)}</td>
<td>${r.targetDate ? fd(r.targetDate) : "-"}<div class="hint">${srDue(r)}</div></td>
<td>${srChip(r)}${r.ext ? `<div class="hint">ขอเลื่อนเป็น ${fd(r.ext.target)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }

  async function viewSr(params) {
    setNav("sr");
    const m = await srMeta(true);
    const isReq = ME.user.role === "requester";
    const scopes = isReq ? [["mine", "คำขอของฉัน"]] : [...(m.canManage || ME.user.role === "observer" ? [["team", "คำขอถึงทีม"]] : []), ["assigned", "ได้รับมอบหมาย"], ["mine", "ที่ฉันขอ"]];
    const scope = scopes.some((x) => x[0] === params.scope) ? params.scope : scopes[0][0];
    const { items: all } = await api("/sr?scope=" + scope);
    // Team filter: shown when the list holds requests to more than one team.
    const teamCount = {};
    all.forEach((r) => (teamCount[r.team] = teamCount[r.team] || { label: r.teamLabel, n: 0 }) && teamCount[r.team].n++);
    const teamOrder = ME.teams.map((t) => t.key).filter((k) => teamCount[k]).concat(Object.keys(teamCount).filter((k) => !ME.teams.some((t) => t.key === k)));
    const team = teamCount[params.team] ? params.team : "";
    const items = team ? all.filter((r) => r.team === team) : all;
    const groups = [
      ["", "ทั้งหมด", () => true],
      ["pending", "รออนุมัติ", (r) => r.status === "pending"],
      ["info", "ขอข้อมูลเพิ่ม", (r) => r.status === "info"],
      ["in_progress", "กำลังดำเนินการ", (r) => r.status === "in_progress"],
      ["overdue", "เลย Target", (r) => r.status === "overdue"],
      ["done", "เสร็จแล้ว", (r) => r.status === "done"],
      ["closed", "ไม่อนุมัติ / ยกเลิก", (r) => ["rejected", "cancelled"].includes(r.status)],
    ];
    const g = groups.find((x) => x[0] === (params.status || "")) || groups[0];
    const rows = items.filter(g[2]);
    const link = (o) => "#/sr?" + qs({ scope, team, status: params.status || "", ...o });
    $app.innerHTML = `<div class="pagehead"><div><h1>คำขอบริการ</h1><p class="muted" style="margin:0">ขอให้ทีม Engineer ช่วยทำงานภายใน เช่น ข้อมูล รายงาน ตั้งค่า · แยกจากเคสลูกค้า</p></div>
<a class="btn primary" href="#/sr/new">+ คำขอใหม่</a></div>
${m.profileMissing.length ? `<div class="banner warn">กรอกหน่วยงาน ตำแหน่ง และเบอร์โทรของคุณก่อนส่งคำขอแรก <a href="#/profile">กรอกข้อมูล</a></div>` : ""}
${scopes.length > 1 ? `<div class="fpills" role="tablist">${scopes.map(([k, l]) => `<a class="fpill ${k === scope ? "on" : ""}" role="tab" aria-selected="${k === scope}" href="#/sr?${qs({ scope: k })}">${l}</a>`).join("")}</div>` : ""}
${teamOrder.length > 1 ? `<div class="fpills" style="margin-top:8px" aria-label="ทีม"><span class="hint" style="align-self:center;margin-right:2px">ทีม</span><a class="fpill ${team ? "" : "on"}" href="${link({ team: "", status: "" })}">ทุกทีม <b>${all.length}</b></a>${teamOrder.map((k) => `<a class="fpill ${k === team ? "on" : ""}" href="${link({ team: k, status: "" })}">${esc(teamCount[k].label)} <b>${teamCount[k].n}</b></a>`).join("")}</div>` : ""}
<div class="fpills" style="margin-top:8px">${groups.map(([k, l, f]) => {
      const n = items.filter(f).length;
      return k && !n && k !== (params.status || "") ? "" : `<a class="fpill ${k === (params.status || "") ? "on" : ""}" href="${link({ status: k })}">${l} <b>${n}</b></a>`;
    }).join("")}</div>
<section class="card" style="padding:0;margin-top:12px"><div class="tablewrap"><table class="srtable"><thead><tr><th>คำขอ</th><th>ผู้ขอ</th><th>ผู้รับผิดชอบ</th><th>สถานะ</th><th>Target</th></tr></thead><tbody>
${rows.map((r) => `<tr data-go="#/sr/${r.id}" tabindex="0"><td><span class="mono muted">${esc(r.srNo)}</span><br><a href="#/sr/${r.id}" style="font-weight:600">${esc(r.title)}</a><br><span class="hint">${esc(r.teamLabel)} · ${srSev(r)}${r.customer ? ` · ${esc(r.customer)}` : ""}</span></td>
<td>${esc(r.requester.name)}<br><span class="hint">${esc(r.requester.department || "")}</span></td>
<td>${r.assignee ? esc(r.assignee.name) : `<span class="muted">-</span>`}</td>
<td>${srChip(r)}${r.ext ? `<br><span class="hint">ขอเลื่อนเป็น ${dlong(r.ext.target)}</span>` : ""}</td>
<td>${r.targetDate ? `${dlong(r.targetDate)}${r.status === "in_progress" && r.daysLeft != null ? `<br><span class="hint">อีก ${r.daysLeft} วันทำการ</span>` : r.status === "overdue" ? `<br><span class="hint" style="color:var(--bad,#C0283C)">เลย ${r.overdueDays} วันทำการ</span>` : ""}` : `${dlong(r.requestedDate)}<br><span class="hint">ที่ขอ</span>`}</td></tr>`).join("") || `<tr><td colspan="5" class="muted" style="padding:28px;text-align:center">ไม่มีคำขอ${g[0] ? "ในสถานะนี้" : ""}</td></tr>`}
</tbody></table></div></section>`;
    $app.querySelectorAll("tr[data-go]").forEach((tr) => {
      tr.onclick = (e) => {
        if (!e.target.closest("a")) location.hash = tr.dataset.go;
      };
      tr.onkeydown = (e) => {
        if (e.key === "Enter") location.hash = tr.dataset.go;
      };
    });
  }

  /** Department dropdown: the admin's list, plus the person's current value when it is not (or no longer) in it. */
  function deptSelect(names, cur, { other = true, name = "department" } = {}) {
    const extra = cur && !names.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (ไม่อยู่ในรายการ)</option>` : "";
    return `<select name="${name}"><option value="">เลือกหน่วยงาน</option>${extra}${names.map((n) => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("")}${other ? `<option value="__other">อื่นๆ (ขอให้ Admin เพิ่ม)</option>` : ""}</select>`;
  }

  async function viewProfile(after) {
    setNav("");
    const { profile: p, missing, departments = [] } = await api("/profile");
    $app.innerHTML = `<div class="pagehead"><div><h1>บัญชีของฉัน</h1><p class="muted" style="margin:0">${esc(p.email)} · ${ROLE[p.role] || p.role}</p></div></div>
<form class="card" id="pf" style="max-width:620px">
${missing.length ? `<div class="banner warn" style="margin:0">${after ? "ก่อนส่งคำขอแรก " : ""}ช่วยยืนยันข้อมูลของคุณ ทีมที่รับงานจะใช้ติดต่อกลับ${p.department || p.job_title || p.phone ? "<br>ระบบดึงข้อมูลบางส่วนจากบัญชี Microsoft ของบริษัทมาให้แล้ว ตรวจแล้วแก้ได้" : ""}</div>` : ""}
<label class="f">ชื่อที่แสดง<input name="display_name" value="${esc(p.display_name)}" maxlength="120"></label>
<div class="formgrid" style="grid-template-columns:1fr 1fr"><div class="stack" style="gap:8px"><label class="f">หน่วยงาน / ฝ่าย${deptSelect(departments, p.department || "")}<span class="hint" data-dept-hint>รายการนี้ Admin เป็นคนดูแล</span></label>
<label class="f" data-dept-other hidden>หน่วยงานที่ต้องการให้เพิ่ม<input name="department_other" maxlength="120" placeholder="เช่น ฝ่ายขายภาคเหนือ"></label></div>
<label class="f">ตำแหน่ง<input name="job_title" value="${esc(p.job_title || "")}" placeholder="เช่น Account Manager" required maxlength="120"></label></div>
<label class="f">เบอร์โทรที่ติดต่อได้<input name="phone" value="${esc(p.phone || "")}" placeholder="081-234-5678 หรือ 02-123-4567 ต่อ 105" required maxlength="60"><span class="hint">${["requester"].includes(p.role) ? "ทีมที่รับงานใช้ติดต่อกลับ" : "แสดงใน email ถึงลูกค้าเมื่อคุณรับเคส และในคำขอบริการ"}</span></label>
<div class="right"><button class="btn primary" type="submit">${after ? "บันทึกแล้วไปต่อ" : "บันทึก"}</button></div></form>
${after ? "" : `<section class="card" id="av-card" style="max-width:620px;margin-top:16px"></section>`}
${after ? "" : `<section class="card" id="app-card" style="max-width:620px;margin-top:16px"></section>`}`;
    if (!after) {
      avatarPicker(document.getElementById("av-card"));
      bindAppCard();
    }
    const f = document.getElementById("pf");
    const dOther = f.querySelector("[data-dept-other]");
    f.department.onchange = () => {
      dOther.hidden = f.department.value !== "__other";
      f.querySelector("[data-dept-hint]").textContent = dOther.hidden ? "รายการนี้ Admin เป็นคนดูแล" : "บันทึกแล้วระบบส่ง email ให้ Admin เพิ่มเข้ารายการ";
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.department.value) return toast("เลือกหน่วยงาน");
      try {
        const r = await post("/profile", Object.fromEntries(["display_name", "department", "department_other", "job_title", "phone"].map((k) => [k, f[k].value.trim()])), "PUT");
        Object.assign(ME.user, { display_name: r.profile.display_name, phone: r.profile.phone, department: r.profile.department, job_title: r.profile.job_title });
        SR_META = null;
        toast("บันทึกข้อมูลแล้ว");
        if (after) after();
        else history.length > 1 ? history.back() : (location.hash = "#/sr");
      } catch (err) {
        toast(err.message, 6000);
      }
    };
  }

  async function viewSrNew() {
    setNav("sr");
    const m = await srMeta(true);
    if (m.profileMissing.length) return viewProfile(() => viewSrNew());
    const seg = (name, opts, cur) => `<div class="seg" role="radiogroup">${opts.map((o) => `<label><input type="radio" name="${name}" value="${esc(o.key)}" ${o.key === cur ? "checked" : ""} required><span>${esc(o.label)}</span></label>`).join("")}</div>`;
    $app.innerHTML = `<div class="pagehead"><div><a href="#/sr" class="muted">← คำขอบริการ</a><h1>ส่งคำขอบริการ</h1></div></div>
<form class="card" id="srf" style="max-width:820px">
<div class="f"><span>ขอจากทีม</span>${seg("team", m.teams.map((t) => ({ key: t.code, label: t.label })), m.teams.length === 1 ? m.teams[0].code : "")}<span class="hint" id="sr-appr">เลือกทีมเพื่อดูผู้อนุมัติ</span></div>
<div class="f"><span>ประเภทคำขอ</span>${seg("requestKind", [{ key: "general", label: "งาน / ข้อมูล" }, { key: "meeting", label: "ขอให้ทีมเข้าร่วม Meeting" }], "general")}</div>
<div class="sr-meet" id="sr-meet" hidden>
<div class="banner warn" style="margin:0"><div><strong>Meeting กับลูกค้าเป็นงาน routine อยู่แล้ว</strong><br><span style="font-size:14px">ขอให้ทีมเข้าร่วมเมื่อจำเป็นต้องใช้ความรู้ด้านเทคนิคจริง และระบุเหตุผลให้ Manager ใช้ประกอบการอนุมัติ</span></div></div>
<div class="f"><span class="req">รูปแบบ Meeting</span>${seg("meetingMode", [{ key: "onsite", label: "Onsite (ที่ลูกค้า)" }, { key: "online", label: "Online" }], "")}</div>
<label class="f"><span class="req">เหตุผลที่ต้องให้ทีมเข้าร่วม</span><textarea name="meetingReason" rows="3" maxlength="1000" placeholder="เช่น ลูกค้าขอคุยเรื่องปัญหาเสียงหายใน Recording ที่เกิดซ้ำ ต้องการ Engineer อธิบายสาเหตุและแผนแก้ไขเชิงเทคนิค ฝั่ง Sales ตอบเองไม่ได้"></textarea><span class="hint" id="sr-mrc"></span></label>
</div>
<label class="f">หัวข้อ<input name="title" required minlength="5" maxlength="200" placeholder="เช่น ขอ report การโทรของ call center KTB เดือน ต.ค."></label>
<label class="f">รายละเอียดงานที่ต้องการ<textarea name="detail" rows="5" required minlength="20" maxlength="5000" placeholder="ต้องการอะไร ใช้ทำอะไร รูปแบบที่ต้องการ (เช่น Excel แยกรายวัน) ช่วงข้อมูล"></textarea></label>
<div class="formgrid" style="grid-template-columns:1.2fr 1fr">
<div class="f"><span>Severity</span>${seg("severity", m.severities, "normal")}<span class="hint" id="sr-sevhint">${esc(m.severities.find((x) => x.key === "normal").hint)}</span></div>
<label class="f">ต้องการรับงานภายใน<input type="date" name="requestedDate" required min="${m.minDate}"><span class="hint" id="sr-datehint">ตั้งแต่ ${dlong(m.minDate)} (วันทำการถัดไป) · Manager อาจปรับวันที่</span></label></div>
<div class="banner warn" id="sr-today" hidden style="margin:0"></div>
<label class="f">เกี่ยวกับลูกค้า (ไม่บังคับ)<input name="customer" maxlength="120" placeholder="เช่น KTB"></label>
${fileBox(m)}
<div class="right"><a class="btn" href="#/sr">ยกเลิก</a><button class="btn primary" type="submit">ส่งคำขอ</button></div></form>`;
    const f = document.getElementById("srf");
    const fp = filePicker(f, m);
    const meetBox = document.getElementById("sr-meet");
    const mrc = document.getElementById("sr-mrc");
    const syncKind = () => {
      const on = f.requestKind.value === "meeting";
      meetBox.hidden = !on;
      f.meetingReason.required = on;
      f.querySelectorAll("input[name=meetingMode]").forEach((x) => (x.required = on));
      f.title.placeholder = on ? "เช่น ขอ Engineer เข้าประชุมกับ KTB เรื่องเสียงหายใน Recording" : "เช่น ขอ report การโทรของ call center KTB เดือน ต.ค.";
    };
    const syncMrc = () => {
      const n = f.meetingReason.value.trim().length;
      mrc.textContent = `${n} ตัวอักษร · อย่างน้อย 40`;
      mrc.style.color = n >= 40 ? "" : "var(--r2-fg)";
    };
    f.querySelectorAll("input[name=requestKind]").forEach((x) => (x.onchange = syncKind));
    f.meetingReason.addEventListener("input", syncMrc);
    syncKind();
    syncMrc();
    f.querySelectorAll("input[name=team]").forEach((x) => (x.onchange = () => (document.getElementById("sr-appr").textContent = `ผู้อนุมัติ: ${(m.managers[x.value] || []).join(", ") || "Admin"}`)));
    // "Very urgent" may ask for today, with a reminder to phone the team's Manager for approval.
    const syncUrgent = () => {
      const urgent = f.severity.value === "urgent_high";
      const today = m.today || daysAgo(0);
      f.requestedDate.min = urgent ? today : m.minDate;
      document.getElementById("sr-datehint").textContent = urgent ? `ด่วนมาก เลือกวันนี้ (${dlong(today)}) ได้ · ปกติตั้งแต่ ${dlong(m.minDate)}` : `ตั้งแต่ ${dlong(m.minDate)} (วันทำการถัดไป) · Manager อาจปรับวันที่`;
      if (!urgent && f.requestedDate.value && f.requestedDate.value < m.minDate) f.requestedDate.value = "";
      const box = document.getElementById("sr-today");
      const isToday = urgent && f.requestedDate.value === today;
      box.hidden = !isToday;
      if (isToday) {
        const team = f.team.value;
        const ps = team ? m.managerPhones[team] || [] : [];
        box.innerHTML = `<div><strong>ต้องการงานภายในวันนี้: โทรหา Manager เพื่อขออนุมัติทันทีหลังส่งคำขอ</strong><br><span style="font-size:14px">${team ? (ps.length ? ps.map((p) => `${esc(p.name)}${p.phone ? ` · <a href="tel:${esc(p.phone.replace(/[^+0-9]/g, ""))}">${esc(p.phone)}</a>` : " · ยังไม่มีเบอร์ในระบบ"}`).join("<br>") : "Admin") : "เลือกทีมก่อน เพื่อดูชื่อและเบอร์ Manager"}</span><br><span style="font-size:13px">ระบบส่ง email ถึง Manager แล้วก็จริง แต่งานวันนี้ต้องคุยกันทางโทรศัพท์ ไม่อย่างนั้นอาจไม่ทันหรือไม่ได้รับอนุมัติ</span></div>`;
      }
    };
    f.querySelectorAll("input[name=severity]").forEach((x) => (x.onchange = () => {
      document.getElementById("sr-sevhint").textContent = m.severities.find((s) => s.key === x.value).hint;
      syncUrgent();
    }));
    f.querySelectorAll("input[name=team]").forEach((x) => x.addEventListener("change", syncUrgent));
    f.requestedDate.onchange = () => {
      const v = f.requestedDate.value;
      const day = new Date(v + "T00:00:00").getDay();
      const todayOk = f.severity.value === "urgent_high" && v === (m.today || daysAgo(0));
      f.requestedDate.setCustomValidity(!todayOk && (day === 0 || day === 6 || m.holidays.includes(v)) ? "เลือกวันทำการ (ไม่ใช่เสาร์ อาทิตย์ หรือวันหยุด)" : "");
      syncUrgent();
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        if (f.requestKind.value === "meeting" && f.meetingReason.value.trim().length < 40) {
          btn.disabled = false;
          f.meetingReason.focus();
          return toast("ใส่เหตุผลที่ต้องให้ทีมเข้าร่วม Meeting อย่างน้อย 40 ตัวอักษร");
        }
        const meet = f.requestKind.value === "meeting" ? { requestKind: "meeting", meetingMode: f.meetingMode.value, meetingReason: f.meetingReason.value } : { requestKind: "general" };
        const body = { team: f.team.value, title: f.title.value, detail: f.detail.value, severity: f.severity.value, requestedDate: f.requestedDate.value, customer: f.customer.value, ...meet, files: await fp.get() };
        const r = await post("/sr", body);
        toast(body.severity === "urgent_high" && body.requestedDate === (m.today || daysAgo(0)) ? `ส่งคำขอ ${r.srNo} แล้ว อย่าลืมโทรหา Manager เพื่อขออนุมัติ` : `ส่งคำขอ ${r.srNo} แล้ว ระบบส่ง email ยืนยันให้คุณ`, 8000);
        location.hash = "#/sr/" + r.id;
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 6000);
      }
    };
  }

  const SR_EV = {
    submitted: "ส่งคำขอ", edited: "แก้ไขคำขอ", resubmitted: "แก้ไขและส่งใหม่", info: "ขอข้อมูลเพิ่ม", approved: "อนุมัติ", rejected: "ไม่อนุมัติ", cancelled: "ยกเลิก",
    update: "ผู้ขอเพิ่มข้อมูล", note: "บันทึกจากทีม", reassigned: "เปลี่ยนผู้รับผิดชอบ", ext_asked: "ขอเลื่อน Target", ext_approved: "อนุมัติเลื่อน Target", ext_rejected: "ไม่อนุมัติการเลื่อน", closed: "ปิดคำขอ", reopened: "ขอเปิดใหม่", confirmed: "ยืนยันรับงาน",
  };
  function srEventLine(e, files) {
    const dd = e.data || {};
    const extra =
      e.kind === "approved" ? `Target ${dlong(dd.target)}${dd.target !== dd.requested ? ` (ผู้ขอต้องการ ${dlong(dd.requested)}${dd.reason ? ` · ${esc(dd.reason)}` : ""})` : ""}${dd.category ? ` · ประเภทงาน ${esc(dd.category)}` : ""}`
      : e.kind === "submitted" ? `ต้องการภายใน ${dlong(dd.requestedDate)}`
      : ["ext_asked", "ext_approved", "ext_rejected"].includes(e.kind) ? `${dlong(dd.from)} → ${dlong(dd.to)}`
      : e.kind === "reassigned" ? `${esc(dd.from || "-")} → ${esc(dd.to)}`
      : e.kind === "reopened" ? `Target ${dlong(dd.target)}`
      : e.kind === "confirmed" ? `ให้คะแนน ${"★".repeat(dd.rating || 0)}${"☆".repeat(5 - (dd.rating || 0))} ${dd.rating}/5`
      : e.kind === "closed" ? esc({ delivered: "ส่งงานแล้ว", not_possible: "ทำไม่ได้", duplicate: "ซ้ำกับคำขออื่น" }[dd.outcome] || "") : "";
    const fs = files.filter((f) => f.event_id === e.id);
    return `<li class="ev-${esc(e.kind)}"><div><b>${SR_EV[e.kind] || esc(e.kind)}</b> โดย ${esc(e.by_name || "ระบบ")}${extra ? ` · ${extra}` : ""}</div>
${e.text ? `<div class="srtext">${esc(e.text)}</div>` : ""}${fs.length ? `<div>${fs.map((f) => `<a class="gchip" href="api/sr-files/${f.id}" target="_blank" rel="noopener">📎 ${esc(f.file_name)}</a>`).join(" ")}</div>` : ""}
<div class="hint">${fdt(e.created_at)}</div></li>`;
  }
  function srDialog(title, inner, onOk, okLabel = "ยืนยัน") {
    const dlg = document.getElementById("dlg") || document.body.appendChild(Object.assign(document.createElement("dialog"), { id: "dlg" }));
    dlg.innerHTML = `<form class="card" method="dialog" id="srd" style="min-width:min(560px,92vw)"><h2>${title}</h2>${inner}
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">${okLabel}</button></div></form>`;
    const f = dlg.querySelector("#srd");
    f.onsubmit = async (e) => {
      if (e.submitter && e.submitter.value === "cancel") return;
      e.preventDefault();
      const b = f.querySelector("button[value=ok]");
      b.disabled = true;
      try {
        await onOk(f);
        dlg.close();
      } catch (err) {
        b.disabled = false;
        toast(err.message, 6000);
      }
    };
    dlg.showModal();
    return f;
  }

  async function viewSrItem(id) {
    setNav("sr");
    const [m, data] = await Promise.all([srMeta(), api("/sr/" + encodeURIComponent(id))]);
    const r = data.sr;
    const c = data.can;
    const done = (res) => {
      SR_META = null;
      refreshSrBadge();
      return viewSrItem(id);
    };
    const act = async (path, body, msg) => {
      await post(`/sr/${r.id}/${path}`, body);
      toast(msg, 4500);
      done();
    };
    const asg = data.assignees || [];
    const asgOpt = (sel) => asg.map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.display_name)} · งานภายในค้าง ${a.open_sr} · เคสเปิด ${a.open_cases}${a.phone ? "" : " · ยังไม่มีเบอร์"}</option>`).join("");
    const approvePanel = c.approve
      ? `<section class="card srapprove"><h2>ตรวจและอนุมัติ</h2>
<form id="apf"><div class="formgrid" style="grid-template-columns:1fr 1.3fr">
<label class="f">Target date<input type="date" name="targetDate" value="${r.requestedDate}" min="${new Date().toISOString().slice(0, 10)}" required><span class="hint">ผู้ขอต้องการ ${dlong(r.requestedDate)}</span></label>
<label class="f">ผู้รับผิดชอบ<select name="assigneeId" required><option value="">เลือกสมาชิกทีม ${esc(r.teamLabel)}</option>${asgOpt(null)}</select></label></div>
<label class="f" id="ap-why" hidden>เหตุผลที่ปรับวันที่ (ผู้ขอจะเห็น)<input name="targetReason" maxlength="500" placeholder="เช่น ขอส่งก่อน 1 วัน ให้ฝ่ายขายตรวจทันประชุม"></label>
<label class="f">ประเภทงาน (ใช้ใน KPI ด้านทักษะ)<select name="category"><option value="">ให้ระบบจัดจากหัวข้อ</option>${m.categories.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
<label class="f">หมายเหตุถึงผู้ขอและผู้รับผิดชอบ (ไม่บังคับ)<input name="note" maxlength="1000"></label>
<div class="actions"><button class="btn ok" type="submit">อนุมัติและมอบหมาย</button><button class="btn" type="button" id="ap-info">ขอข้อมูลเพิ่ม</button><button class="btn danger" type="button" id="ap-rej">ไม่อนุมัติ</button></div></form></section>`
      : "";
    const extBanner = r.ext
      ? `<div class="banner warn srext"><div><b>${esc(r.ext.by)} ขอเลื่อน Target</b> ${dlong(r.targetDate)} → <b>${dlong(r.ext.target)}</b><br>${esc(r.ext.reason)}</div>${c.decideExt ? `<div class="actions" style="margin:0"><button class="btn ok" type="button" id="ext-ok">อนุมัติเลื่อน</button><button class="btn" type="button" id="ext-no">ไม่อนุมัติ</button></div>` : `<span class="hint">รอ Manager</span>`}</div>`
      : "";
    const info = [
      ["ทีม", esc(r.teamLabel)],
      ["Severity", srSev(r)],
      ["ผู้ขอ", `${esc(r.requester.name)}${r.requester.department ? ` · ${esc(r.requester.department)}` : ""}${r.requester.title ? ` · ${esc(r.requester.title)}` : ""}<br><span class="hint">${esc(r.requester.email)}${r.requester.phone ? ` · <a href="tel:${esc(r.requester.phone.replace(/[^+0-9]/g, ""))}">${esc(r.requester.phone)}</a>` : ""}</span>`],
      ["ต้องการภายใน", dlong(r.requestedDate)],
      ...(r.targetDate ? [["Target date", `<b>${dlong(r.targetDate)}</b>${r.targetReason ? `<br><span class="hint">${esc(r.targetReason)}</span>` : ""}`]] : []),
      ...(r.assignee ? [["ผู้รับผิดชอบ", `${esc(r.assignee.name)}${r.assignee.phone ? ` · <a href="tel:${esc(r.assignee.phone.replace(/[^+0-9]/g, ""))}">${esc(r.assignee.phone)}</a>` : ""}`]] : []),
      ...(r.approvedBy ? [["อนุมัติโดย", `${esc(r.approvedBy)} · ${fdt(r.approvedAt)}`]] : []),
      ...(r.category ? [["ประเภทงาน", esc(r.category)]] : []),
      ...(r.customer ? [["ลูกค้า", esc(r.customer)]] : []),
      ...(r.managerNote ? [["หมายเหตุ Manager", esc(r.managerNote)]] : []),
      ...(r.outcome ? [["ผลลัพธ์", `<b>${esc(r.outcomeLabel)}</b> โดย ${esc(r.closedBy)} · ${fdt(r.closedAt)}${r.onTime != null ? ` · ${r.onTime ? "ทันกำหนด" : "ช้ากว่ากำหนด"}` : ""}<div class="srtext">${esc(r.resolution)}</div>`]] : []),
      ...(r.status === "rejected" ? [["เหตุผลที่ไม่อนุมัติ", `<div class="srtext">${esc(r.resolution)}</div>`]] : []),
    ];
    const buttons = [
      c.close ? `<button class="btn ok" type="button" id="b-close">ปิดคำขอ</button>` : "",
      c.extend ? `<button class="btn" type="button" id="b-ext">ขอเลื่อน Target</button>` : "",
      c.reassign ? `<button class="btn" type="button" id="b-re">เปลี่ยนผู้รับผิดชอบ</button>` : "",
      c.edit ? `<button class="btn" type="button" id="b-edit">${r.status === "info" ? "แก้ไขและส่งใหม่" : "แก้ไขคำขอ"}</button>` : "",
      c.cancel ? `<button class="btn danger" type="button" id="b-cancel">ยกเลิกคำขอ</button>` : "",
      c.confirm ? `<button class="btn ok" type="button" id="b-confirm">ยืนยันรับงาน</button>` : "",
      c.reopen ? `<button class="btn" type="button" id="b-reopen">ขอเปิดใหม่</button>` : "",
    ].join("");
    const infoEv = r.status === "info" ? data.events.filter((e) => e.kind === "info").pop() : null;
    $app.innerHTML = `<div class="pagehead"><div><a href="#/sr" class="muted">← คำขอบริการ</a>
<h1 style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="mono" style="font-size:.8em">${esc(r.srNo)}</span> ${esc(r.title)} ${srChip(r)}</h1></div>
<div class="actions" style="margin:0">${buttons}</div></div>
${infoEv ? `<div class="banner warn"><b>${esc(infoEv.by_name)} ขอข้อมูลเพิ่ม:</b> ${esc(infoEv.text)}${c.edit ? "<br>กด “แก้ไขและส่งใหม่” เพื่อส่งกลับให้ Manager" : ""}</div>` : ""}
${r.status === "overdue" ? `<div class="banner err">เลย Target มาแล้ว ${r.overdueDays} วันทำการ</div>` : ""}
${extBanner}
<div class="cols"><div class="main">
${r.requestKind === "meeting" ? `<section class="card sr-meet-card"><div class="title"><h2>ขอให้ทีมเข้าร่วม Meeting</h2><span class="chip c-deploy">${esc(r.meetingModeLabel)}</span></div><div class="k" style="font-size:13px;color:var(--muted)">เหตุผลที่ต้องให้ทีมเข้าร่วม</div><div class="srtext">${esc(r.meetingReason)}</div></section>` : ""}
<section class="card"><h2>รายละเอียด</h2><div class="srtext">${esc(r.detail)}</div></section>
${approvePanel}
<section class="card"><h2>ประวัติ</h2><ul class="srtl">${data.events.map((e) => srEventLine(e, data.files)).join("")}</ul>
${c.update ? `<form id="upf" class="stack" style="border-top:1px solid var(--line);padding-top:14px"><label class="f">${r.mine ? "เพิ่มข้อมูลถึงผู้รับผิดชอบ" : "บันทึก / ตอบผู้ขอ"}<textarea name="text" rows="2" maxlength="3000" placeholder="${r.mine ? "เช่น แนบ template เพิ่ม" : "เช่น กำลังดึงข้อมูล คาดว่าส่งได้พรุ่งนี้"}"></textarea></label>${fileBox(m)}<div class="right"><button class="btn primary" type="submit">ส่ง</button></div></form>` : ""}
</section></div>
<aside class="side"><section class="card"><h2>ข้อมูลคำขอ</h2><table class="kvt">${info.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
${c.confirm ? `<p class="hint">ได้รับงานแล้ว กด “ยืนยันรับงาน” และให้คะแนน 1–5${c.reopen ? ` · ถ้างานยังไม่ตรงที่ขอ กด “ขอเปิดใหม่” ได้ถึง ${dlong(r.canReopenUntil)}` : ""}</p>` : r.canReopenUntil && c.reopen ? `<p class="hint">ถ้างานยังไม่ตรงที่ขอ กด “ขอเปิดใหม่” ได้ถึง ${dlong(r.canReopenUntil)}</p>` : ""}
${r.confirmedAt ? `<p class="hint">ผู้ขอยืนยันรับงานแล้ว · ${"★".repeat(r.rating || 0)}${"☆".repeat(5 - (r.rating || 0))} ${r.rating}/5 · ${fdt(r.confirmedAt)}</p>` : ""}</section></aside></div>`;

    const $ = (x) => document.getElementById(x);
    const up = $("upf");
    if (up) {
      const fp = filePicker(up, m);
      up.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await post(`/sr/${r.id}/update`, { text: up.text.value, files: await fp.get() });
          toast(r.mine ? "ส่งถึงผู้รับผิดชอบแล้ว" : "บันทึกแล้ว ระบบแจ้งผู้ขอทาง email", 4500);
          done();
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    }
    const ap = $("apf");
    if (ap) {
      const why = () => ($("ap-why").hidden = ap.targetDate.value === r.requestedDate);
      ap.targetDate.onchange = () => {
        const day = new Date(ap.targetDate.value + "T00:00:00").getDay();
        ap.targetDate.setCustomValidity(day === 0 || day === 6 || m.holidays.includes(ap.targetDate.value) ? "เลือกวันทำการ" : "");
        why();
      };
      ap.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await act("approve", { targetDate: ap.targetDate.value, assigneeId: ap.assigneeId.value, targetReason: ap.targetReason.value, category: ap.category.value, note: ap.note.value }, "อนุมัติแล้ว ระบบส่ง email ถึงผู้รับผิดชอบและผู้ขอ");
        } catch (err) {
          toast(err.message, 6000);
        }
      };
      $("ap-info").onclick = () => srDialog("ขอข้อมูลเพิ่มจากผู้ขอ", `<label class="f">ต้องการข้อมูลอะไรเพิ่ม<textarea name="note" rows="3" required minlength="5" maxlength="1000"></textarea></label>`, (f) => act("info", { note: f.note.value }, "ส่งคำขอข้อมูลเพิ่มถึงผู้ขอแล้ว"), "ส่งถึงผู้ขอ");
      $("ap-rej").onclick = () => srDialog("ไม่อนุมัติคำขอ", `<label class="f">เหตุผล (ผู้ขอจะเห็น)<textarea name="reason" rows="3" required minlength="5" maxlength="1000"></textarea></label>`, (f) => act("reject", { reason: f.reason.value }, "ไม่อนุมัติแล้ว ระบบแจ้งผู้ขอ"), "ไม่อนุมัติ");
    }
    if ($("ext-ok")) {
      $("ext-ok").onclick = () => act("extend/decide", { approve: true }, "อนุมัติเลื่อน Target แล้ว").catch((e) => toast(e.message, 6000));
      $("ext-no").onclick = () => srDialog("ไม่อนุมัติการเลื่อน Target", `<label class="f">หมายเหตุถึงผู้รับผิดชอบ<input name="note" maxlength="500"></label>`, (f) => act("extend/decide", { approve: false, note: f.note.value }, "ไม่อนุมัติการเลื่อนแล้ว"), "ไม่อนุมัติ");
    }
    if ($("b-close"))
      $("b-close").onclick = () => {
        const f = srDialog(`ปิดคำขอ ${esc(r.srNo)}`, `<div class="f"><span>ผลลัพธ์</span><div class="seg">${[["delivered", "ส่งงานแล้ว"], ["not_possible", "ทำไม่ได้"], ["duplicate", "ซ้ำกับคำขออื่น"]].map(([k, l], i) => `<label><input type="radio" name="outcome" value="${k}" ${i ? "" : "checked"}><span>${l}</span></label>`).join("")}</div></div>
<label class="f">เหตุผล / สิ่งที่ส่งมอบ (อย่างน้อย ${m.resolutionMin} ตัวอักษร ผู้ขอจะเห็น)<textarea name="resolution" rows="4" required minlength="${m.resolutionMin}" maxlength="3000"></textarea></label>${fileBox(m, "ไฟล์ส่งมอบ (ไม่บังคับ)")}`,
          async (f) => act("close", { outcome: f.outcome.value, resolution: f.resolution.value, files: await fp.get() }, "ปิดคำขอแล้ว ระบบแจ้งผู้ขอทาง email"), "ปิดคำขอ");
        const fp = filePicker(f, m);
      };
    if ($("b-ext"))
      $("b-ext").onclick = () =>
        srDialog("ขอเลื่อน Target", `<p class="muted" style="margin:0">Target ตอนนี้ ${dlong(r.targetDate)} · Manager ต้องอนุมัติ และระบบแจ้งผู้ขอเมื่อวันที่เปลี่ยน</p><label class="f">วันที่ใหม่<input type="date" name="d" required min="${r.targetDate}"></label><label class="f">เหตุผล<textarea name="reason" rows="3" required minlength="10" maxlength="1000"></textarea></label>`,
          (f) => act("extend", { targetDate: f.d.value, reason: f.reason.value }, "ส่งคำขอเลื่อนถึง Manager แล้ว"), "ขอเลื่อน");
    if ($("b-re"))
      $("b-re").onclick = () => srDialog("เปลี่ยนผู้รับผิดชอบ", `<label class="f">ผู้รับผิดชอบใหม่<select name="a" required>${asgOpt(r.assignee && r.assignee.id)}</select></label><label class="f">หมายเหตุ (ไม่บังคับ)<input name="note" maxlength="500"></label>`, (f) => act("reassign", { assigneeId: f.a.value, note: f.note.value }, "เปลี่ยนผู้รับผิดชอบแล้ว"), "บันทึก");
    if ($("b-cancel")) $("b-cancel").onclick = () => srDialog("ยกเลิกคำขอ", `<label class="f">เหตุผล (ไม่บังคับ)<input name="reason" maxlength="500"></label>`, (f) => act("cancel", { reason: f.reason.value }, "ยกเลิกคำขอแล้ว"), "ยกเลิกคำขอ");
    if ($("b-confirm"))
      $("b-confirm").onclick = () =>
        srDialog(
          "ยืนยันรับงาน",
          `<p class="muted" style="margin:0">งานจาก ${esc(r.assignee ? r.assignee.name : "ทีม")} ตรงกับที่ขอแค่ไหน</p>
<div class="sr-rate" role="radiogroup" aria-label="คะแนน">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="rating" value="${n}" required ${n === 5 ? "" : ""}><span>${n}</span><small>${["", "ไม่ตรงเลย", "ต้องแก้หลายจุด", "พอใช้", "ดี", "ดีมาก"][n]}</small></label>`).join("")}</div>
<label class="f">ความเห็น (ไม่บังคับ · ให้ 1–2 ต้องใส่)<textarea name="note" rows="2" maxlength="1000"></textarea></label>
<p class="hint" style="margin:0">ยืนยันแล้วจะขอเปิดใหม่ไม่ได้</p>`,
          (f) => act("confirm", { rating: Number(f.rating.value), note: f.note.value }, "ยืนยันรับงานแล้ว ขอบคุณสำหรับคะแนน"),
          "ยืนยันรับงาน"
        );
    if ($("b-reopen")) $("b-reopen").onclick = () => srDialog("ขอเปิดคำขอใหม่", `<p class="muted" style="margin:0">คำขอกลับไปที่ ${esc(r.assignee ? r.assignee.name : "ผู้รับผิดชอบเดิม")}</p><label class="f">งานยังไม่ตรงที่ขออย่างไร<textarea name="reason" rows="3" required minlength="10" maxlength="1000"></textarea></label>`, (f) => act("reopen", { reason: f.reason.value }, "เปิดคำขอใหม่แล้ว ระบบแจ้งผู้รับผิดชอบ"), "ขอเปิดใหม่");
    if ($("b-edit"))
      $("b-edit").onclick = () => {
        const f = srDialog(r.status === "info" ? "แก้ไขและส่งใหม่" : "แก้ไขคำขอ", `<label class="f">หัวข้อ<input name="title" value="${esc(r.title)}" required minlength="5" maxlength="200"></label>
<label class="f">รายละเอียด<textarea name="detail" rows="5" required minlength="20" maxlength="5000">${esc(r.detail)}</textarea></label>
<div class="formgrid" style="grid-template-columns:1fr 1fr"><label class="f">Severity<select name="severity">${m.severities.map((s) => `<option value="${s.key}" ${s.key === r.severity ? "selected" : ""}>${s.label}</option>`).join("")}</select></label>
<label class="f">ต้องการภายใน<input type="date" name="d" value="${r.requestedDate}" required></label></div>
${r.status === "info" ? `<label class="f">ข้อความถึง Manager (ไม่บังคับ)<input name="note" maxlength="1000"></label>` : ""}${fileBox(m)}`,
          async (f) => {
            await post(`/sr/${r.id}`, { title: f.title.value, detail: f.detail.value, severity: f.severity.value, requestedDate: f.d.value, note: f.note ? f.note.value : "", files: await fp.get() }, "PUT");
            toast(r.status === "info" ? "ส่งกลับให้ Manager แล้ว" : "บันทึกแล้ว", 4500);
            done();
          }, r.status === "info" ? "ส่งใหม่" : "บันทึก");
        const fp = filePicker(f, m);
      };
  }

  async function bindHolidays() {
    const el = document.getElementById("hol-card");
    if (!el) return;
    const { holidays } = await api("/settings/holidays");
    el.innerHTML = `<div class="title"><h2>วันหยุดบริษัท</h2><span>ใช้นับวันทำการของคำขอบริการ (เตือนก่อนครบ 1 วันทำการ, ค้างอนุมัติ, เลย Target) · เสาร์-อาทิตย์นับเป็นวันหยุดอยู่แล้ว</span></div>
<label class="f">วันที่ บรรทัดละ 1 วัน (ปี ค.ศ.-เดือน-วัน) ข้อความหลังวันที่ใส่เป็นชื่อวันหยุดได้<textarea id="hol-txt" rows="6" placeholder="2026-12-07 ชดเชยวันพ่อ&#10;2026-12-10 วันรัฐธรรมนูญ&#10;2026-12-31 วันสิ้นปี">${holidays.join("\n")}</textarea></label>
<div class="right"><button class="btn primary" type="button" id="hol-save">บันทึกวันหยุด</button></div>`;
    document.getElementById("hol-save").onclick = async () => {
      const list = document.getElementById("hol-txt").value.split("\n").map((l) => l.trim()).filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
      try {
        const r = await post("/settings/holidays", { holidays: list }, "PUT");
        toast(`บันทึกวันหยุด ${r.holidays.length} วันแล้ว`);
        SR_META = null;
        bindHolidays();
      } catch (e) {
        toast(e.message, 6000);
      }
    };
  }

  // ------------------------------------------------------------ avatars
  const AVATARS = [
    ["fox", "🦊", "#FFE1CC"], ["owl", "🦉", "#EADFCF"], ["tiger", "🐯", "#FFEBC2"], ["cat", "🐱", "#F4E3F0"], ["panda", "🐼", "#E4ECF2"], ["koala", "🐨", "#E3E8EE"],
    ["octo", "🐙", "#FBDDE6"], ["penguin", "🐧", "#DCEBFA"], ["lion", "🦁", "#FFE9B8"], ["frog", "🐸", "#DDF3D6"], ["dolphin", "🐬", "#D6EEF7"], ["unicorn", "🦄", "#EFE2FB"],
    ["rocket", "🚀", "#DCE6FB"], ["robot", "🤖", "#E2E7EF"], ["headset", "🎧", "#E6E1FA"], ["wrench", "🛠️", "#E9EDE3"], ["coffee", "☕", "#F1E4D6"], ["star", "🌟", "#FFF1C7"],
  ];
  const AV = Object.fromEntries(AVATARS.map(([k, e, bg]) => [k, { e, bg }]));
  const AV_COLORS = ["#2F6FDB", "#0E8F7E", "#C2410C", "#7C3AED", "#BE185D", "#0369A1", "#15803D", "#A16207", "#4338CA"];
  /** Photo > chosen avatar > initial on a colour picked from the id. */
  function avHtml(u, cls = "") {
    const name = (u.name || u.display_name || u.email || "?").trim();
    const a = u.avatar || "";
    if (a.startsWith("photo:")) return `<span class="uav ${cls}"><img src="api/avatar/${u.id}?v=${encodeURIComponent(a.slice(6, 20))}" alt=""></span>`;
    if (AV[a]) return `<span class="uav emo ${cls}" style="background:${AV[a].bg}" aria-hidden="true">${AV[a].e}</span>`;
    return `<span class="uav ${cls}" style="background:${AV_COLORS[(Number(u.id) || name.length) % AV_COLORS.length]}" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>`;
  }
  function paintMeAvatar() {
    const el = document.getElementById("me-av");
    if (!el) return;
    el.outerHTML = avHtml({ id: ME.user.id, name: ME.user.display_name, avatar: ME.user.avatar }, "me-av").replace('class="uav', 'id="me-av" class="uav');
  }
  function avatarPicker(host) {
    const draw = () => {
      const u = { id: ME.user.id, name: ME.user.display_name, avatar: ME.user.avatar };
      host.innerHTML = `<div class="title"><h2>Avatar</h2><span>แสดงในอันดับ KPI หน้าราย User และมุมขวาบน</span></div>
<div class="avpick"><div class="avprev">${avHtml(u, "xl")}<span class="hint">${(ME.user.avatar || "").startsWith("photo:") ? "ใช้รูปที่อัปโหลด" : ME.user.avatar ? "avatar ที่เลือก" : "ยังไม่เลือก ใช้ตัวอักษรชื่อ"}</span></div>
<div><div class="avgrid" role="radiogroup" aria-label="เลือก avatar">${AVATARS.map(([k, e, bg]) => `<button type="button" class="avopt" role="radio" aria-checked="${ME.user.avatar === k}" aria-label="${k}" data-k="${k}" style="background:${bg}">${e}</button>`).join("")}</div>
<div class="actions" style="margin-top:12px"><label class="btn" for="av-file" style="cursor:pointer">อัปโหลดรูปของฉัน</label><input type="file" id="av-file" accept="image/png,image/jpeg,image/webp" hidden>
<button type="button" class="btn" id="av-none">ใช้ตัวอักษรชื่อ</button><span class="hint">รูปถูกตัดเป็นวงกลม 256×256 ไม่บังคับ</span></div></div></div>`;
      const save = async (body) => {
        try {
          const r = await post("/profile/avatar", body, "PUT");
          ME.user.avatar = r.avatar;
          paintMeAvatar();
          draw();
          toast("เปลี่ยน avatar แล้ว");
        } catch (e) {
          toast(e.message, 6000);
        }
      };
      host.querySelector(".avgrid").onclick = (e) => {
        const b = e.target.closest(".avopt");
        if (b) save({ avatar: b.dataset.k });
      };
      host.querySelector("#av-none").onclick = () => save({ avatar: null });
      host.querySelector("#av-file").onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = c.height = 256;
          const m = Math.min(img.width, img.height);
          c.getContext("2d").drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, 256, 256);
          URL.revokeObjectURL(img.src);
          save({ photo: c.toDataURL("image/jpeg", 0.85) });
        };
        img.onerror = () => toast("เปิดรูปนี้ไม่ได้ ลองไฟล์ JPG หรือ PNG", 5000);
        img.src = URL.createObjectURL(f);
        e.target.value = "";
      };
    };
    draw();
  }

  // ------------------------------------------------------------ KPI ranking (animated)
  const BADGE = {
    improved: ["🚀", "พัฒนาสูงสุด", "v"], sla100: ["⏱️", "SLA 100%", "g"], skill: ["🧩", "ทักษะใหม่", "b"],
    doc: ["📝", "Resolution ครบ", "b"], streak: ["🔥", "Top 5 สามเดือน", "o"], best: ["⭐", "สถิติส่วนตัว", "o"],
  };
  const PART_LABEL = { sla: "SLA", resp: "ตอบสนองเร็ว", work: "แต้มงาน", div: "ทักษะหลากหลาย", back: "งานค้าง / ขยายเวลา", doc: "เอกสาร / Resolution", bonus: "โบนัสทีม", csat: "ความพึงพอใจลูกค้า" };
  const PART_TIP = { sla: "ปิดเคสให้ทัน Due", resp: "ตอบเคสแรกเร็วและอัปเดตสม่ำเสมอ", work: "ปิดเคส โดยเฉพาะเคสยาก (Critical, ส่ง NICE, Onsite)", div: "ทำงานหลาย product / ประเภท", back: "ลดเคสค้างและการขอขยาย", doc: "เขียน Resolution ให้ครบทุกเคส", bonus: "รับเคสจากลูกค้าภายใน 1 ชม.", csat: "ให้ลูกค้าพอใจ แจ้งผลและวิธีแก้ให้ชัดก่อนปิดเคส" };
  let rankTimers = [];
  const rkLater = (fn, ms) => rankTimers.push(setTimeout(fn, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms));
  function rkCount(el, to, ms = 900) {
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return (el.textContent = to.toFixed(1));
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = (to * (1 - Math.pow(1 - k, 3))).toFixed(1);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  let fxBits = [];
  function confettiAt(cv, x, y) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !cv) return;
    const ctx = cv.getContext("2d");
    const r = cv.getBoundingClientRect();
    cv.width = r.width * devicePixelRatio;
    cv.height = r.height * devicePixelRatio;
    const cols = ["#C9971C", "#2F6FDB", "#0E8F7E", "#BE185D", "#7C3AED"];
    for (let i = 0; i < 90; i++) fxBits.push({ x, y, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3, s: 4 + Math.random() * 5, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: cols[i % 5], life: 0 });
    const tick = () => {
      if (!cv.isConnected) return (fxBits = []);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      fxBits = fxBits.filter((b) => b.life < 120);
      for (const b of fxBits) {
        b.life++; b.vy += 0.22; b.x += b.vx; b.y += b.vy; b.r += b.vr; b.vx *= 0.99;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.globalAlpha = Math.max(0, 1 - b.life / 120);
        ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore();
      }
      if (fxBits.length) requestAnimationFrame(tick);
    };
    tick();
  }
  const rkChg = (r) => (r.rank == null ? `<span class="rchip c-same">ยังไม่ครบเกณฑ์</span>` : r.prevRank == null ? `<span class="rchip c-new">ใหม่</span>` : r.delta > 0 ? `<span class="rchip c-up">▲ ${r.delta}</span>` : r.delta < 0 ? `<span class="rchip c-down">▼ ${-r.delta}</span>` : `<span class="rchip c-same">–</span>`);
  const rkBadges = (r) => r.badges.map((b) => `<span class="rbdg ${BADGE[b][2]}">${BADGE[b][0]} ${BADGE[b][1]}</span>`).join("");

  async function viewRank(params) {
    setNav("rank");
    rankTimers.forEach(clearTimeout);
    rankTimers = [];
    if (!ME.leaderboard || !ME.leaderboard.visible) {
      $app.innerHTML = `<div class="empty">อันดับ KPI ยังเปิดให้เฉพาะ Manager ในช่วงทดลอง</div>`;
      return;
    }
    const style = ["podium", "race", "mine"].includes(params.style) ? params.style : "podium";
    const n = [1, 3, 6, 12].includes(Number(params.n)) ? Number(params.n) : 1;
    const lb = await api("/kpi/leaderboard?" + qs({ n, team: params.team || "", month: params.month || "" }));
    const go = (o) => (location.hash = "#/rank?" + qs({ style, n, team: params.team || "", who: params.who || "", ...o }));
    const seg = (key, cur, opts) => `<span class="seg2" role="group">${opts.map(([v, l]) => `<button type="button" data-${key}="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join("")}</span>`;
    const title = { 1: "อันดับประจำเดือน", 3: "อันดับ 3 เดือน", 6: "อันดับ 6 เดือน", 12: "อันดับ 1 ปี" }[n];
    $app.innerHTML = `
<div class="head"><div><h1>อันดับ KPI ${lb.settings.visibility === "managers" ? `<span class="chip c-r1" style="vertical-align:middle;font-size:13px">ทดลอง · เห็นเฉพาะ Manager</span>` : ""}</h1>
<p>${esc(lb.period.label)}${lb.period.current ? " (เดือนนี้ยังไม่จบ คะแนนเปลี่ยนได้)" : ""} · เทียบกับ ${esc(lb.period.prevLabel)} · เกณฑ์จัดอันดับ: อย่างน้อย ${lb.settings.minCases} เคส</p></div>
<div class="actions"><a class="btn" href="#/kpi">รายละเอียด KPI</a></div></div>
<div class="rkbar">
<div><span class="hint">รูปแบบ</span> ${seg("style", style, [["podium", "A · โพเดียม"], ["race", "B · Bar race"], ["mine", "C · การ์ดรายคน"]])}</div>
<div><span class="hint">ช่วงเวลา</span> ${seg("n", n, [[1, "เดือนนี้"], [3, "3 เดือน"], [6, "6 เดือน"], [12, "1 ปี"]])}</div>
<label class="f" style="flex:0 1 200px"><span class="sr">ทีม</span><select id="rk-team"><option value="">ทุกทีม</option>${lb.teams.map((t) => `<option value="${esc(t.code)}" ${t.code === lb.team ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
<button type="button" class="btn" id="rk-replay">▶ เล่นอีกครั้ง</button></div>
<section class="card rkstage" id="rk-stage"><canvas class="rkfx" id="rk-fx" aria-hidden="true"></canvas><div id="rk-view"></div></section>
${lb.isManager ? `<p class="hint">ตอนเปิดให้ทุกคนเห็น: หน้ารวมแสดงถึงอันดับ ${lb.settings.publicTop} ส่วนอันดับอื่นแต่ละคนเห็นเฉพาะของตัวเอง ${can("settings_manage") ? `· <a href="#/settings">ตั้งค่าการแสดงผล</a>` : ""}</p>` : lb.hidden ? `<p class="hint">แสดงอันดับ 1–${lb.settings.publicTop} และของคุณ</p>` : ""}`;
    $app.querySelectorAll("[data-style]").forEach((b) => (b.onclick = () => go({ style: b.dataset.style })));
    $app.querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => go({ n: b.dataset.n })));
    document.getElementById("rk-team").onchange = (e) => go({ team: e.target.value });
    const view = document.getElementById("rk-view");
    const cv = document.getElementById("rk-fx");
    const stageXY = (el) => {
      const a = el.getBoundingClientRect();
      const s = document.getElementById("rk-stage").getBoundingClientRect();
      return [a.left - s.left + a.width / 2, a.top - s.top + a.height / 2];
    };
    const rows = lb.rows;
    if (!rows.length) {
      view.innerHTML = `<div class="empty">ยังไม่มีเคสในช่วงนี้</div>`;
      return;
    }

    const drawPodium = () => {
      const ranked = rows.filter((r) => r.rank);
      const top = ranked.slice(0, 3);
      const rest = rows.filter((r) => !top.includes(r));
      const improved = rows.find((r) => r.badges.includes("improved"));
      const me = rows.find((r) => r.id === ME.user.id);
      const pod = (r, k) => (r ? `<div class="pd p${k}"><div class="who pre">${k === 1 ? '<span class="crown" aria-hidden="true">👑</span>' : ""}${avHtml(r, "lg")}
<div class="nm">${esc(r.name)}</div><div class="sc mono"><span data-to="${r.score}">0</span></div><div>${rkChg(r)}</div></div><div class="block pre">${k}</div></div>` : `<div></div>`);
      view.innerHTML = `<h2 style="text-align:center">${title}</h2>
${top.length ? `<div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>` : `<div class="empty">ยังไม่มีใครครบเกณฑ์ในช่วงนี้</div>`}
<div class="spot">${improved ? `<div class="s pre">🚀 พัฒนาขึ้นมากที่สุด <b>${esc(improved.name)}</b> +${improved.scoreDelta} คะแนน</div>` : ""}
${me && me.rank && me.rank > 1 ? `<div class="s pre">👤 คุณอยู่อันดับ <b>${me.rank}</b> อีก <b class="mono">${(ranked[me.rank - 2].score - me.score + 0.1).toFixed(1)}</b> คะแนนแซงอันดับ ${me.rank - 1}</div>` : ""}</div>
<div class="rkrows">${rest.map((r) => `<a class="rkrow pre ${r.id === ME.user.id ? "me" : ""}" href="#/rank?${qs({ style: "mine", n, team: lb.team, who: r.id })}"><span class="rk mono">${r.rank ?? "–"}</span>${avHtml(r)}
<span class="nm">${esc(r.name)}${r.id === ME.user.id ? " (คุณ)" : ""}<small>${esc(r.teams.join(", "))} · ${r.cases} เคส</small></span>
<span class="bd">${rkChg(r)}${rkBadges(r)}</span><span class="sc mono">${r.score.toFixed(1)}</span></a>`).join("")}</div>`;
      [".p3", ".p2", ".p1"].forEach((sel, i) => rkLater(() => view.querySelector(sel + " .block")?.classList.remove("pre"), 150 + i * 280));
      [".p3", ".p2", ".p1"].forEach((sel, i) => rkLater(() => {
        const w = view.querySelector(sel + " .who");
        if (!w) return;
        w.classList.remove("pre");
        const s = w.querySelector("[data-to]");
        rkCount(s, Number(s.dataset.to));
        if (sel === ".p1") rkLater(() => confettiAt(cv, ...stageXY(w.querySelector(".uav"))), 350);
      }, 700 + i * 320));
      rkLater(() => view.querySelectorAll(".spot .s").forEach((x) => x.classList.remove("pre")), 1700);
      view.querySelectorAll(".rkrow").forEach((x, i) => rkLater(() => x.classList.remove("pre"), 1800 + i * 90));
    };

    const drawRace = () => {
      const H = 46;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      const ids = rows.map((r) => r.id);
      const frames = lb.frames;
      view.innerHTML = `<div class="rk-rhead"><h2 id="rk-rh">คะแนนสะสมเดือนต่อเดือน</h2><span class="seg2" id="rk-vt" role="group" hidden><button type="button" data-v="bar" aria-pressed="false">แท่ง</button><button type="button" data-v="line" aria-pressed="true">เส้น</button></span></div><p class="hint" style="margin:2px 0 0">${lb.frames.length === 1 ? "ช่วง 1 เดือนมีเฟรมเดียว เลือก 3 เดือนขึ้นไปเพื่อดูการแซง" : `${lb.frames.length} เดือน · ${esc(lb.period.label)}`}</p>
<div id="rk-box"><div class="race" id="rk-race" style="height:${ids.length * H + 10}px">${ids.map((id, i) => `<div class="lane ${id === ME.user.id ? "me" : ""}" data-id="${id}" style="transform:translateY(${i * H}px)"><div class="ln">${avHtml(byId[id], "sm")}<span>${esc(byId[id].name.split(" ")[0])}</span></div><div class="track"><div class="fill" style="width:0;background:${AV_COLORS[id % AV_COLORS.length]}"><span>0</span></div></div></div>`).join("")}<div class="month" id="rk-mo"></div></div></div>
<div class="race-ctl"><span class="hint" id="rk-fl"></span><div class="prog" aria-hidden="true"><i id="rk-pg"></i></div></div>`;
      const lanes = new Map([...view.querySelectorAll(".lane")].map((l) => [Number(l.dataset.id), l]));
      const max = Math.max(60, ...frames.flatMap((f) => f.rows.map((r) => r.score)));
      const draw = (f, idx) => {
        const seen = new Set();
        f.rows.forEach((r, i) => {
          const l = lanes.get(r.id);
          if (!l) return;
          seen.add(r.id);
          l.style.transform = `translateY(${i * H}px)`;
          l.style.opacity = 1;
          const fill = l.querySelector(".fill");
          fill.style.width = `${Math.max(8, (r.score / max) * 100)}%`;
          rkTo(fill.querySelector("span"), r.score);
        });
        let k = f.rows.length;
        lanes.forEach((l, id) => { if (!seen.has(id)) { l.style.transform = `translateY(${k++ * H}px)`; l.style.opacity = 0.35; } });
        document.getElementById("rk-mo").textContent = f.label;
        document.getElementById("rk-fl").textContent = `ถึงเดือน ${f.label}`;
        document.getElementById("rk-pg").style.width = `${((idx + 1) / frames.length) * 100}%`;
      };
      const STEP = 2200; // ms per month
      frames.forEach((f, i) => rkLater(() => draw(f, i), 400 + i * STEP));
      const end = 400 + (frames.length - 1) * STEP + 1600;
      rkLater(() => {
        const last = frames[frames.length - 1].rows[0];
        const l = last && lanes.get(last.id);
        if (l) {
          const [x, y] = stageXY(l.querySelector(".fill"));
          confettiAt(cv, x + l.querySelector(".fill").offsetWidth / 2 - 10, y);
        }
      }, end);
      // Hold the final bars, then show the same numbers as a line chart (needs 2+ months).
      if (frames.length > 1) {
        rkLater(() => { const r = document.getElementById("rk-race"); if (r) r.classList.add("out"); }, end + 2200);
        rkLater(() => rkLines(frames, byId, true), end + 2900);
      }
    };
    const rkTo = (el, to) => {
      const from = parseFloat(el.textContent) || 0;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return (el.textContent = to.toFixed(1));
      const t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / 1400); el.textContent = (from + (to - from) * (1 - Math.pow(1 - k, 3))).toFixed(1); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    };
    const rkLines = (frames, byId, animate) => {
      const box = document.getElementById("rk-box");
      if (!box) return;
      const W = Math.max(300, box.clientWidth);
      const narrow = W < 560;
      const padL = 36, padR = narrow ? 96 : 160, padT = 14, padB = 30, Hh = narrow ? 300 : 380;
      const color = (id) => (id === ME.user.id ? "var(--accent)" : AV_COLORS[id % AV_COLORS.length]);
      const ids = Object.keys(byId).map(Number);
      const series = ids.map((id) => ({ id, v: frames.map((f) => { const r = f.rows.find((x) => x.id === id); return r ? r.score : null; }) })).filter((x) => x.v.some((v) => v != null));
      const all = series.flatMap((x) => x.v.filter((v) => v != null));
      if (!all.length) return;
      const lo = Math.max(0, Math.floor((Math.min(...all) - 0.5) / 5) * 5), hi = Math.ceil((Math.max(...all) + 0.5) / 5) * 5 || 5;
      const x = (i) => padL + (i / Math.max(1, frames.length - 1)) * (W - padL - padR);
      const y = (v) => padT + (1 - (v - lo) / Math.max(1, hi - lo)) * (Hh - padT - padB);
      const tickStep = hi - lo > 40 ? 20 : hi - lo > 20 ? 10 : 5;
      const ticks = []; for (let t = lo; t <= hi; t += tickStep) ticks.push(t);
      const fin = frames[frames.length - 1].rows;
      const leader = fin[0] && fin[0].id;
      const lastOf = (sr) => { for (let i = sr.v.length - 1; i >= 0; i--) if (sr.v[i] != null) return [i, sr.v[i]]; return [0, 0]; };
      // End labels kept at least 22px apart so names never overlap.
      const tags = series.map((sr) => { const [i, v] = lastOf(sr); return { sr, i, v, y: y(v) }; }).sort((a, b) => a.y - b.y);
      for (let k = 1; k < tags.length; k++) tags[k].y = Math.max(tags[k].y, tags[k - 1].y + 22);
      const over = tags.length ? tags[tags.length - 1].y - (Hh - padB + 4) : 0;
      if (over > 0) tags.forEach((t) => (t.y -= over));
      const path = (sr) => { let d = "", pen = false; sr.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
      const ord = (id) => (id === leader ? 3 : id === ME.user.id ? 2 : 1);
      const first = (nm) => esc(String(nm || "").split(" ")[0]);
      box.innerHTML = `<div class="rk-lc ${animate ? "pre" : ""}" id="rk-lc"><svg viewBox="0 0 ${W} ${Hh}" height="${Hh}" role="img" aria-label="กราฟเส้นคะแนนสะสมรายเดือน">
<g class="grid">${ticks.map((t) => `<line x1="${padL}" x2="${W - padR + 6}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}</g>
<g class="xl">${frames.map((f, i) => { const every = Math.ceil(frames.length / (narrow ? 4 : 8)); return i % every && i !== frames.length - 1 ? "" : `<text x="${x(i)}" y="${Hh - 8}" text-anchor="middle">${esc(narrow ? f.label.split(" ")[0] : f.label)}</text>`; }).join("")}</g>
${[...series].sort((a, b) => ord(a.id) - ord(b.id)).map((sr) => {
        const cls = sr.id === leader ? "top" : sr.id === ME.user.id ? "me" : "";
        return `<path class="ln2 ${cls}" data-id="${sr.id}" d="${path(sr)}" stroke="${color(sr.id)}"><title>${esc(byId[sr.id].name)}: ${sr.v.map((v, i) => `${frames[i].label} ${v == null ? "-" : v.toFixed(1)}`).join(" · ")}</title></path>
${sr.v.map((v, i) => (v == null ? "" : `<circle class="dot" cx="${x(i)}" cy="${y(v)}" r="${cls ? 4 : 3}" fill="${color(sr.id)}"><title>${esc(byId[sr.id].name)} ${esc(frames[i].label)}: ${v.toFixed(1)}</title></circle>`)).join("")}`;
      }).join("")}
${tags.map((t) => { const rk = fin.findIndex((r) => r.id === t.sr.id) + 1; const ex = x(t.i);
        return `<g class="tag2 ${t.sr.id === ME.user.id ? "me" : ""}" data-id="${t.sr.id}"><line x1="${ex + 5}" y1="${y(t.v)}" x2="${ex + 14}" y2="${t.y}" stroke="${color(t.sr.id)}" stroke-width="1.5"/>
<text x="${ex + 18}" y="${t.y + 4}">${rk === 1 ? "👑 " : ""}${first(byId[t.sr.id].name)}${t.sr.id === ME.user.id ? " (คุณ)" : ""}</text>${narrow ? "" : `<text class="v" x="${W - 6}" y="${t.y + 4}" text-anchor="end">${t.v.toFixed(1)}</text>`}</g>`; }).join("")}
</svg></div>`;
      document.getElementById("rk-rh").textContent = "เส้นคะแนนตลอดช่วง";
      const leadName = leader && byId[leader] ? byId[leader].name : "-";
      document.getElementById("rk-fl").textContent = `อันดับ 1: ${leadName} · ชี้ที่เส้นเพื่อดูคะแนนรายเดือน`;
      document.getElementById("rk-pg").style.width = "100%";
      const lc = document.getElementById("rk-lc");
      const paths = [...lc.querySelectorAll(".ln2")];
      if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        paths.forEach((pa) => { const L = pa.getTotalLength(); pa.style.strokeDasharray = L; pa.style.strokeDashoffset = L; });
        requestAnimationFrame(() => requestAnimationFrame(() => { lc.classList.remove("pre"); paths.forEach((pa) => (pa.style.strokeDashoffset = 0)); }));
        rkLater(() => lc.classList.add("done"), 2700);
      } else { lc.classList.remove("pre"); lc.classList.add("done"); }
      lc.querySelectorAll(".tag2").forEach((g) => {
        const pa = paths.find((q) => q.dataset.id === g.dataset.id);
        if (!pa) return;
        g.onmouseenter = () => pa.classList.add("hl");
        g.onmouseleave = () => pa.classList.remove("hl");
      });
      const vt = document.getElementById("rk-vt");
      vt.hidden = false;
      vt.onclick = (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.v === "bar") run();
        else rkLines(frames, byId, true);
      };
    };

    const drawMine = () => {
      const pickable = lb.isManager ? rows : rows.filter((r) => r.id === ME.user.id);
      const who = Number(params.who) || (rows.find((r) => r.id === ME.user.id) || rows[0]).id;
      const me = pickable.find((r) => r.id === who) || pickable[0];
      if (!me) {
        view.innerHTML = `<div class="empty">คุณยังไม่มีเคสในช่วงนี้</div>`;
        return;
      }
      const ranked = rows.filter((r) => r.rank);
      const ahead = me.rank && me.rank > 1 ? ranked[me.rank - 2] : null;
      const need = ahead ? Math.max(0.1, ahead.score - me.score + 0.1) : 0;
      const parts = Object.entries(lb.partMax).filter(([k]) => me.parts[k] != null);
      const ratio = parts.map(([k, mx]) => me.parts[k] / mx);
      const strong = parts[ratio.indexOf(Math.max(...ratio))]?.[0];
      const gapPts = parts.map(([k, mx]) => mx - me.parts[k]);
      const weak = parts[gapPts.indexOf(Math.max(...gapPts))]?.[0];
      const tmax = Math.max(60, ...me.trend.map((t) => t.score || 0));
      view.innerHTML = `<div class="rkmine-head"><h2>${lb.isManager ? "การ์ดรายคน" : "การ์ดของฉัน"}</h2>
${lb.isManager ? `<label class="f" style="flex:0 1 240px"><span class="sr">เลือกคน</span><select id="rk-who">${rows.map((r) => `<option value="${r.id}" ${r.id === me.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>` : ""}
${me.personalBest ? `<span class="chip c-r1">⭐ สถิติดีที่สุด</span>` : ""}</div>
<div class="rkmine">
<div class="mc"><div class="bigrank">${avHtml(me, "xl")}<span class="n">#${me.rank ?? "–"}</span><span class="hint">${me.rank ? `จาก ${ranked.length} คน` : "ยังไม่ครบเกณฑ์จัดอันดับ"} ${rkChg(me)}</span></div>
<div><span class="mono" style="font-size:28px;font-weight:700" id="rk-msc">0</span> <span class="hint">คะแนน ${me.scoreDelta != null ? (me.scoreDelta >= 0 ? `<span class="rchip c-up">+${me.scoreDelta}</span>` : `<span class="rchip c-down">${me.scoreDelta}</span>`) + ` เทียบ ${esc(lb.period.prevLabel)}` : ""} · ${me.cases} เคส${me.slaPct != null ? ` · SLA ${me.slaPct}%` : ""}</span></div>
${ahead ? `<div class="rkgap"><div>อีก <b class="mono">${need.toFixed(1)}</b> คะแนน แซง <b>${esc(ahead.name)}</b> ขึ้นอันดับ ${me.rank - 1}</div><div class="meter" aria-hidden="true"><i id="rk-mt"></i></div></div>` : me.rank === 1 ? `<div class="rkgap"><div>🏆 อันดับ 1 ของช่วงนี้</div></div>` : ""}
<div class="parts">${parts.map(([k, mx]) => `<div class="pt ${k === strong ? "best" : k === weak ? "weak" : ""}"><span>${PART_LABEL[k]}${k === strong ? " · จุดแข็ง" : k === weak ? " · เพิ่มได้มากสุด" : ""}</span><div class="m"><i data-w="${Math.min(100, (me.parts[k] / mx) * 100)}"></i></div><span class="v mono">${me.parts[k]}/${mx}</span></div>`).join("")}</div>
${weak ? `<p class="hint" style="margin:0">เพิ่มคะแนนได้มากสุดที่ “${PART_LABEL[weak]}” (อีก ${(lb.partMax[weak] - me.parts[weak]).toFixed(1)} คะแนน): ${PART_TIP[weak]}</p>` : ""}</div>
<div class="mc"><h3>คะแนน 6 เดือน</h3>
<div class="trend">${me.trend.map((t, i) => `<div class="${i === 5 ? "cur" : ""}"><b class="mono">${t.score ?? "–"}</b><span class="col"><i data-h="${t.score ? Math.max(6, (t.score / tmax) * 100) : 0}"></i></span><span>${esc(t.label)}</span></div>`).join("")}</div>
<h3>เหรียญ</h3>
<div class="medals">${Object.entries(BADGE).map(([k, [ic, t]]) => `<div class="medal pre ${me.badges.includes(k) ? "" : "locked"}"><span class="ic" aria-hidden="true">${ic}</span><b>${t}</b><span>${me.badges.includes(k) ? "ได้แล้ว" : "ยังไม่ได้"}</span></div>`).join("")}</div>
${me.sr ? `<p class="hint" style="margin:0">ทำคำขอบริการภายในเสร็จ ${me.sr} งาน (นับเป็นทักษะ)</p>` : ""}</div></div>`;
      const w = document.getElementById("rk-who");
      if (w) w.onchange = () => go({ who: w.value });
      rkCount(document.getElementById("rk-msc"), me.score, 1000);
      rkLater(() => { const m = document.getElementById("rk-mt"); if (m) m.style.width = `${Math.max(8, 100 - need * 10)}%`; }, 500);
      view.querySelectorAll(".pt .m i").forEach((x, i) => rkLater(() => (x.style.width = x.dataset.w + "%"), 400 + i * 90));
      view.querySelectorAll(".trend i").forEach((x, i) => rkLater(() => (x.style.height = x.dataset.h + "%"), 600 + i * 110));
      view.querySelectorAll(".medal").forEach((x, i) => rkLater(() => x.classList.remove("pre"), 1100 + i * 160));
      if (me.personalBest || me.rank === 1) rkLater(() => confettiAt(cv, ...stageXY(view.querySelector(".bigrank .uav"))), 900);
    };

    const run = () => {
      rankTimers.forEach(clearTimeout);
      rankTimers = [];
      fxBits = [];
      ({ podium: drawPodium, race: drawRace, mine: drawMine })[style]();
    };
    document.getElementById("rk-replay").onclick = run;
    run();
  }

  /** Settings: which team uses which KPI criteria set, and the weights, from a chosen month. */
  async function bindKpiProfiles() {
    const host = document.getElementById("kpf-body");
    if (!host) return;
    let r;
    try {
      r = await api("/kpi/profiles");
    } catch (e) {
      host.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
      return;
    }
    const nextMonths = [];
    for (let i = -3; i <= 3; i++) {
      const t = new Date();
      t.setDate(1);
      t.setMonth(t.getMonth() + i);
      nextMonths.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`);
    }
    const keys = Object.keys(r.profiles);
    host.innerHTML = `<p class="hint" style="margin:0 0 10px">แต่ละทีมใช้ชุดเกณฑ์เดียว · คนที่อยู่หลายทีม ถ้ามีทีม Support อยู่ด้วยใช้ Support · ทีมใหม่อยู่ชุด Support จนกว่าจะย้าย · เดือนก่อนหน้าเดือนที่เลือกไม่เปลี่ยน</p>
<div class="tablewrap"><table class="kpf-tbl" style="min-width:560px"><thead><tr><th>ทีม</th>${keys.map((k) => `<th class="c">${esc(r.profiles[k].label)}</th>`).join("")}</tr></thead><tbody>
${r.teams.map((t) => `<tr><td>${esc(t.label)}</td>${keys.map((k) => `<td class="c"><input type="radio" name="kpf-${esc(t.code)}" value="${k}" ${t.profile === k ? "checked" : ""} aria-label="${esc(t.label)}: ${esc(r.profiles[k].label)}"></td>`).join("")}</tr>`).join("")}
</tbody></table></div>
<div class="kpf-grid" style="margin-top:14px">${keys
      .map((k) => {
        const p = r.profiles[k];
        if (!p.parts.length) return `<div class="kpf" data-p="${k}"><h3>${esc(p.label)}</h3><div class="hint">${esc(p.hint)}</div></div>`;
        return `<div class="kpf" data-p="${k}"><h3>${esc(p.label)}</h3><div class="hint">${esc(p.hint)}</div>
<div class="kpf-w">${p.parts.map(([pk, l, w]) => `<label><span>${esc(l)}</span><input type="number" min="0" max="100" step="1" data-w="${k}.${pk}" value="${w}" aria-label="${esc(p.label)} ${esc(l)}"></label>`).join("")}</div>
<div class="kpf-sum" data-sum="${k}"></div></div>`;
      })
      .join("")}</div>
<div class="right" style="align-items:center;margin-top:12px"><span class="hint">มีผลตั้งแต่</span><select id="kpf-from" style="width:auto">${nextMonths.map((m) => `<option value="${m}" ${m === r.month ? "selected" : ""}>${ymLabel(m)}</option>`).join("")}</select>
<button class="btn primary" type="button" id="kpf-save">บันทึกเกณฑ์ KPI</button></div>
${r.versions.length ? `<p class="hint" style="margin:8px 0 0">ประวัติ: ${r.versions.map((v) => `เริ่ม ${ymLabel(v.from)} โดย ${esc(v.by || "-")}`).join(" · ")}</p>` : ""}`;
    // One team = one profile: a team's radios share one name across the columns.
    const sums = () =>
      keys.forEach((k) => {
        const n = [...host.querySelectorAll(`[data-w^="${k}."]`)].reduce((a, i) => a + (Number(i.value) || 0), 0);
        const el = host.querySelector(`[data-sum="${k}"]`);
        if (!el) return;
        el.textContent = `รวม ${n} / 100 ${n === 100 ? "✓" : "· ต้องเท่ากับ 100"}`;
        el.classList.toggle("bad", n !== 100);
      });
    host.querySelectorAll("[data-w]").forEach((i) => (i.oninput = sums));
    sums();
    document.getElementById("kpf-save").onclick = async () => {
      const teams = {};
      r.teams.forEach((t) => {
        const c = host.querySelector(`input[name="kpf-${t.code}"]:checked`);
        if (c) teams[t.code] = c.value;
      });
      const weights = {};
      host.querySelectorAll("[data-w]").forEach((i) => {
        const [p, k] = i.dataset.w.split(".");
        (weights[p] = weights[p] || {})[k] = Number(i.value);
      });
      try {
        await post("/kpi/profiles", { from: document.getElementById("kpf-from").value, teams, weights }, "PUT");
        toast("บันทึกเกณฑ์ KPI แล้ว");
        bindKpiProfiles();
      } catch (e) {
        toast(e.message, 6000);
      }
    };
  }

  async function bindTeamAdmin() {
    const host = document.getElementById("team-body");
    if (!host) return;
    let teams = (await api("/teams-admin")).teams;
    let changed = false;
    const draw = () => {
      host.innerHTML = `<div class="tablewrap"><table style="min-width:640px"><thead><tr><th style="width:60px">ลำดับ</th><th>ชื่อทีม</th><th>รหัส</th><th style="text-align:right">ผู้ใช้</th><th style="text-align:right">เคสเปิดอยู่ / ทั้งหมด</th><th></th></tr></thead><tbody>
${teams.map((t, i) => `<tr><td style="white-space:nowrap"><button class="btn" type="button" data-up="${i}" ${i ? "" : "disabled"} aria-label="เลื่อนขึ้น" style="min-height:30px;padding:0 8px">↑</button><button class="btn" type="button" data-down="${i}" ${i < teams.length - 1 ? "" : "disabled"} aria-label="เลื่อนลง" style="min-height:30px;padding:0 8px">↓</button></td>
<td><input value="${esc(t.label)}" data-label="${esc(t.code)}" maxlength="60" aria-label="ชื่อทีม ${esc(t.label)}" style="width:100%"></td>
<td class="mono" data-no-i18n>${esc(t.code)}</td><td style="text-align:right">${t.users}</td><td style="text-align:right">${t.open_cases} / ${t.cases}</td>
<td style="text-align:right;white-space:nowrap"><button class="btn" type="button" data-save="${esc(t.code)}" style="min-height:32px">บันทึกชื่อ</button>${t.cases || t.requests ? "" : ` <button class="btn danger" type="button" data-del="${esc(t.code)}" style="min-height:32px">ลบ</button>`}</td></tr>`).join("")}
</tbody></table></div>
<div class="formgrid" style="grid-template-columns:2fr 1fr auto;align-items:end;margin-top:12px">
<label class="f">ชื่อทีมใหม่<input id="tm-label" maxlength="60" placeholder="เช่น Genesys Cloud"></label>
<label class="f">รหัส (ไม่บังคับ)<input id="tm-code" maxlength="20" placeholder="สร้างจากชื่อให้" class="mono" style="text-transform:uppercase"></label>
<button class="btn primary" type="button" id="tm-add" style="min-height:44px">เพิ่มทีม</button></div>
<p class="hint" style="margin:6px 0 0">รหัสทีมเปลี่ยนไม่ได้หลังสร้าง (ใช้ในข้อมูลเคส) เปลี่ยนได้เฉพาะชื่อ · ลบได้เฉพาะทีมที่ยังไม่มีเคสหรือคำขอบริการ · หลังเพิ่มทีม ไปที่ “จัดการผู้ใช้” เพื่อใส่สมาชิกและ Manager ของทีม${changed ? ` · <b>หน้าเว็บจะโหลดใหม่เพื่อแสดงทีมล่าสุดเมื่อออกจากหน้านี้</b>` : ""}</p>`;
      const move = async (i, d) => {
        const order = teams.map((t) => t.code);
        [order[i], order[i + d]] = [order[i + d], order[i]];
        try {
          teams = (await post("/teams-admin-order", { order }, "PUT")).teams;
          changed = true;
          draw();
        } catch (e) {
          toast(e.message, 6000);
        }
      };
      host.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => move(Number(b.dataset.up), -1)));
      host.querySelectorAll("[data-down]").forEach((b) => (b.onclick = () => move(Number(b.dataset.down), 1)));
      host.querySelectorAll("[data-save]").forEach(
        (b) =>
          (b.onclick = async () => {
            const code = b.dataset.save;
            const label = host.querySelector(`[data-label="${code}"]`).value.trim();
            try {
              teams = (await post(`/teams-admin/${encodeURIComponent(code)}`, { label }, "PUT")).teams;
              changed = true;
              toast("บันทึกชื่อทีมแล้ว");
              draw();
            } catch (e) {
              toast(e.message, 6000);
            }
          })
      );
      host.querySelectorAll("[data-del]").forEach(
        (b) =>
          (b.onclick = async () => {
            const t = teams.find((x) => x.code === b.dataset.del);
            if (!confirm(`ลบทีม “${t.label}”?${t.users ? ` ผู้ใช้ ${t.users} คนจะถูกเอาออกจากทีมนี้` : ""}`)) return;
            try {
              teams = (await api(`/teams-admin/${encodeURIComponent(t.code)}`, { method: "DELETE" })).teams;
              changed = true;
              toast("ลบทีมแล้ว");
              draw();
            } catch (e) {
              toast(e.message, 6000);
            }
          })
      );
      document.getElementById("tm-add").onclick = async () => {
        const label = document.getElementById("tm-label").value.trim();
        const code = document.getElementById("tm-code").value.trim().toUpperCase();
        if (!label) return toast("ใส่ชื่อทีม");
        try {
          const r = await post("/teams-admin", { label, code: code || undefined });
          teams = r.teams;
          changed = true;
          toast(`เพิ่มทีม “${label}” แล้ว (รหัส ${r.code})`, 5000);
          draw();
        } catch (e) {
          toast(e.message, 6000);
        }
      };
    };
    draw();
    // The team lists everywhere else come from the page's start-up data: refresh once the admin leaves Settings.
    const onLeave = () => {
      window.removeEventListener("hashchange", onLeave);
      if (changed) location.reload();
    };
    window.addEventListener("hashchange", onLeave);
  }

  async function bindDepartments() {
    const host = document.getElementById("dept-body");
    if (!host) return;
    let list = (await api("/departments")).list.map((x) => ({ ...x, was: x.name }));
    const draw = () => {
      host.innerHTML = `<div class="stack" style="gap:6px">${list.map((x, i) => `<div class="dept-row ${x.active ? "" : "off"}"><input value="${esc(x.name)}" data-i="${i}" aria-label="ชื่อหน่วยงาน">${x.active ? "" : `<span class="chip c-normal">ปิดอยู่</span>`}<button class="btn" type="button" data-t="${i}" style="min-height:32px">${x.active ? "ปิด" : "เปิด"}</button></div>`).join("")}</div>
<div style="display:flex;gap:8px;margin-top:10px"><input id="dept-new" placeholder="ชื่อหน่วยงานใหม่" style="flex:1;min-width:0"><button class="btn" type="button" id="dept-add">เพิ่ม</button><button class="btn primary" type="button" id="dept-save">บันทึก</button></div>
<p class="hint" style="margin:6px 0 0">แก้ชื่อในช่องได้เลย คนที่ใช้ชื่อเดิมจะถูกเปลี่ยนตามเมื่อบันทึก · ปิดแทนการลบ คนที่เลือกไว้แล้วยังเห็นชื่อเดิม แต่คนใหม่เลือกไม่ได้</p>`;
      host.querySelectorAll("input[data-i]").forEach((el) => (el.oninput = () => (list[Number(el.dataset.i)].name = el.value)));
      host.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { const x = list[Number(b.dataset.t)]; x.active = !x.active; draw(); }));
      document.getElementById("dept-add").onclick = () => {
        const v = document.getElementById("dept-new").value.trim();
        if (!v) return;
        if (list.some((x) => x.name.toLowerCase() === v.toLowerCase())) return toast("มีหน่วยงานนี้แล้ว");
        list.push({ name: v, active: true, was: "" });
        draw();
      };
      document.getElementById("dept-save").onclick = async () => {
        try {
          const r = await post("/departments", { list }, "PUT");
          list = r.list.map((x) => ({ ...x, was: x.name }));
          draw();
          toast("บันทึกรายการหน่วยงานแล้ว");
        } catch (err) {
          toast(err.message, 6000);
        }
      };
    };
    draw();
  }

  function bindLeaderboardSettings() {
    const el = document.getElementById("lb-card");
    if (!el) return;
    api("/kpi/leaderboard?n=1").then((lb) => {
      const s = lb.settings;
      el.innerHTML = `<div class="title"><h2>อันดับ KPI</h2><span>ช่วงทดลองให้เห็นเฉพาะ Manager · เปิดให้ทุกคนเมื่อพร้อม</span></div>
<div class="f"><span>ใครเห็นหน้าอันดับ</span><div class="seg"><label><input type="radio" name="lbv" value="managers" ${s.visibility !== "all" ? "checked" : ""}><span>เฉพาะ Admin / Manager / Observer (ทดลอง)</span></label><label><input type="radio" name="lbv" value="all" ${s.visibility === "all" ? "checked" : ""}><span>ทุกคน</span></label></div>
<span class="hint">เมื่อเลือก “ทุกคน” Engineer เห็นอันดับ 1–${s.publicTop} และของตัวเองเท่านั้น</span></div>
<div class="formgrid" style="grid-template-columns:1fr 1fr"><label class="f">แสดงอันดับต่อสาธารณะถึงอันดับ<input type="number" id="lb-top" min="3" max="20" value="${s.publicTop}"></label>
<label class="f">ต้องมีเคสอย่างน้อย (เคส) จึงจัดอันดับ<input type="number" id="lb-min" min="1" max="50" value="${s.minCases}"></label></div>
<div class="right"><button class="btn primary" type="button" id="lb-save">บันทึก</button></div>`;
      document.getElementById("lb-save").onclick = async () => {
        try {
          await post("/kpi/leaderboard/settings", { visibility: el.querySelector("input[name=lbv]:checked").value, publicTop: document.getElementById("lb-top").value, minCases: document.getElementById("lb-min").value }, "PUT");
          toast("บันทึกการตั้งค่าอันดับ KPI แล้ว");
        } catch (e) {
          toast(e.message, 6000);
        }
      };
    }).catch(() => (el.hidden = true));
  }

  // ------------------------------------------------------------ similar closed cases (case form / open case)
  function simHtml(items) {
    if (!items.length) return "";
    return `<div class="title"><h2>เคสคล้ายกันที่เคยปิดแล้ว</h2><span>${items.length} เคส · ดูวิธีแก้ก่อนเริ่มงาน</span></div>
<div class="sim-list">${items
      .map(
        (s) => `<article class="sim">
<div class="sim-h"><a class="mono" href="#/case/${s.id}" target="_blank" rel="noopener">${esc(s.caseNo || "#" + s.id)}</a><span class="sim-score" title="ความคล้าย">${s.score}%</span></div>
<div class="sim-m">${esc(s.site || "-")}${s.product ? " · " + esc(s.product) : ""} · ${sevChip(s.severity)} · ปิด ${fd(s.closedAt)} · ${esc(s.owner || "-")}${s.sameSite ? ` <span class="chip c-normal">ลูกค้าเดียวกัน</span>` : ""}</div>
<div class="sim-t">${esc(s.task)}</div>
${s.resolution ? `<div class="sim-r"><b>วิธีแก้</b> ${esc(s.resolution)}</div>` : `<div class="sim-r none">ไม่มี Resolution</div>`}
${s.rca ? `<div class="sim-r rca"><b>RCA${s.rcaCategory ? " · " + esc(s.rcaCategory) : ""}</b> ${esc(s.rca)}</div>` : ""}
${s.matched.length ? `<div class="sim-w">คำที่ตรง: ${s.matched.map((w) => `<span data-no-i18n>${esc(w)}</span>`).join("")}</div>` : ""}
</article>`
      )
      .join("")}</div>`;
  }
  function bindSimilar(f, c) {
    const box = document.getElementById("sim-card");
    if (!box || !f) return;
    let timer = null;
    let last = "";
    const run = async () => {
      const q = [f.task.value, f.detail ? f.detail.value : ""].join(" ").trim();
      const key = [q, f.site.value, f.product.value].join("|");
      if (key === last) return;
      last = key;
      if (q.length < 4) return (box.hidden = true);
      try {
        const r = await api(`/cases/similar?${qs({ q, site: f.site.value.trim(), product: f.product.value, exclude: c ? c.id : "" })}`);
        box.innerHTML = simHtml(r.items);
        box.hidden = !r.items.length;
      } catch (e) {
        box.hidden = true;
      }
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 600);
    };
    ["task", "detail", "site"].forEach((n) => f[n] && f[n].addEventListener("input", later));
    f.product.addEventListener("change", later);
    if (c) run();
  }

  // ------------------------------------------------------------ customer satisfaction on the case page
  const CSAT_FACE = ["", "😞", "🙁", "😐", "🙂", "😄"];
  function csatCard(s) {
    if (!s) return "";
    const ch = s.channel === "email" ? "ตอบใน email เดิมของลูกค้า" : s.channel === "line" ? "LINE (ผ่าน chatbot)" : "email";
    return `<section class="card"><div class="title"><h2>ความพึงพอใจของลูกค้า</h2><span>ส่งเมื่อปิดเคส</span></div>
${s.rating ? `<div class="csat-big ${s.rating <= 2 ? "low" : s.rating >= 4 ? "good" : ""}"><span aria-hidden="true">${CSAT_FACE[s.rating]}</span><b>${s.rating}/5</b></div>
${s.comment ? `<div class="resol">${esc(s.comment)}</div>` : ""}
<p class="muted" style="margin:0;font-size:13px">ลูกค้าตอบ ${fdt(s.rated_at)}</p>` : `<p class="muted" style="margin:0;font-size:14px">ส่งแบบสอบถามแล้ว ${fdt(s.sent_at)} ทาง ${ch} · ลูกค้ายังไม่ตอบ (ลิงก์ใช้ได้ถึง ${fd(String(s.expires_at).slice(0, 10))})</p>`}
</section>`;
  }

  // ------------------------------------------------------------ customer page
  const HEALTH = { ok: ["ปกติ", "c-normal"], warn: ["ต้องติดตาม", "c-r1"], bad: ["ต้องระวัง", "c-overdue"] };
  // ------------------------------------------------------------ customer details + installed solution
  const CI_FIELDS = [
    ["full_name", "ชื่อเต็ม", "เช่น ธนาคารกรุงไทย จำกัด (มหาชน)"],
    ["location", "สถานที่ติดตั้ง", "เช่น Contact Center อาคารสำนักงานใหญ่ · DR site"],
    ["contact", "ผู้ติดต่อหลัก", "ชื่อ ตำแหน่ง เบอร์โทร"],
    ["account_manager", "Account Manager", ""],
    ["engineers", "Engineer ประจำ", "เช่น สมชาย (หลัก) · วิภา (สำรอง)"],
    ["contract_sla", "SLA ตามสัญญา", "เช่น Critical 4 ชม. · ปกติ 3 วันทำการ"],
    ["remote_access", "Remote access", "เช่น VPN FortiClient · ขอสิทธิ์ล่วงหน้า 1 วัน"],
    ["notes", "หมายเหตุ", ""],
  ];
  async function loadCustInfo(host, site) {
    let r;
    try {
      r = await api("/customer-info?site=" + encodeURIComponent(site));
    } catch (e) {
      host.innerHTML = `<div class="banner err">โหลดข้อมูลลูกค้าไม่สำเร็จ: ${esc(e.message)}</div>`;
      return;
    }
    renderCustInfo(host, site, r);
  }
  function renderCustInfo(host, site, r) {
    const p = r.profile || {};
    const filled = CI_FIELDS.filter(([k]) => p[k]);
    const until = (x) => {
      if (!x.supportUntil) return x.supportKind || "";
      const left = Math.round((new Date(x.supportUntil + "T00:00:00") - new Date()) / 86400000);
      return `${esc(x.supportKind || "สัญญา")} ถึง ${new Date(x.supportUntil + "T00:00:00").toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" })}${left < 0 ? ` <span class="chip c-overdue">หมดแล้ว</span>` : left <= 60 ? ` <span class="chip c-r1">อีก ${left} วัน</span>` : ""}`;
    };
    const empty = !filled.length && !r.products.length;
    host.innerHTML = `<section class="card"><div class="title"><h2>ข้อมูลลูกค้าและ Solution ที่ติดตั้ง</h2>${r.canEdit ? `<button class="btn" type="button" data-ci-edit>${empty ? "เพิ่มข้อมูล" : "แก้ไข"}</button>` : ""}</div>
${empty ? `<div class="empty" style="padding:12px">ยังไม่มีข้อมูลลูกค้าและรายการ Product${r.aliases.length ? ` · ชื่อเรียกอื่น: ${esc(r.aliases.join(", "))}` : ""}${r.canEdit ? " · กด เพิ่มข้อมูล" : ""}</div>` : `<div class="ci-grid">
<div>${filled.length || r.aliases.length ? `<dl class="ci-dl">${filled.map(([k, l]) => `<dt>${l}</dt><dd>${esc(p[k])}</dd>`).join("")}${r.aliases.length ? `<dt>ชื่อเรียกอื่น</dt><dd>${esc(r.aliases.join(", "))}</dd>` : ""}</dl>` : `<div class="hint">ยังไม่มีข้อมูลลูกค้า</div>`}
</div>
<div><h3 class="ci-h">Solution ที่ติดตั้ง <span class="muted" style="font-weight:400">${r.products.length} Product</span></h3>
${r.products.length ? r.products.map((x) => `<div class="ci-prod"><div><div class="nm">${esc(x.product)}</div><div class="sub">${esc(x.category)}</div></div>
<div><b>${esc(x.version || "-")}</b><div class="sub">เวอร์ชัน</div></div>
<div class="ci-mods">${x.modules.map((m) => `<span>${esc(m)}</span>`).join("") || `<span class="sub">-</span>`}</div>
<div><div style="font-size:13px">${until(x) || "-"}</div><div class="sub">${x.team ? "ทีม " + esc(teamLabel(x.team)) : ""}${x.notes ? (x.team ? " · " : "") + esc(x.notes) : ""}</div></div></div>`).join("") : `<div class="hint" style="padding:8px 0">ยังไม่มีรายการ Product</div>`}</div></div>
${p.updatedAt ? `<p class="hint" style="margin:10px 0 0">แก้ล่าสุดโดย ${esc(p.updatedBy || "-")} · ${fdt(p.updatedAt)}</p>` : ""}`}</section>`;
    host.querySelectorAll("[data-ci-edit]").forEach((b) => (b.onclick = () => editCustInfo(host, site, r)));
  }
  async function editCustInfo(host, site, r) {
    const p = r.profile || {};
    const LK = await lookups().catch(() => ({ product: [] }));
    const prodRow = (x = {}) => `<div class="ci-erow">
<label class="f">Product<input name="product" list="ci-prod-list" value="${esc(x.product || "")}" required maxlength="120"></label>
<label class="f">ประเภท<input name="category" value="${esc(x.category || "")}" placeholder="เช่น Recording" maxlength="80"></label>
<label class="f">เวอร์ชัน<input name="version" value="${esc(x.version || "")}" maxlength="60"></label>
<label class="f" style="grid-column:span 2">Module (คั่นด้วย ,)<input name="modules" value="${esc((x.modules || []).join(", "))}" placeholder="เช่น Voice, Screen, QM"></label>
<label class="f">สัญญา<select name="supportKind"><option value="">-</option>${r.supportKinds.map((k) => `<option ${k === x.supportKind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
<label class="f">ถึงวันที่<input type="date" name="supportUntil" value="${esc(x.supportUntil || "")}"></label>
<label class="f">ทีมที่ดูแล<select name="team"><option value="">-</option>${ME.teams.map((t) => `<option value="${esc(t.key)}" ${t.key === x.team ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
<label class="f" style="grid-column:span 3">หมายเหตุ<input name="notes" value="${esc(x.notes || "")}" maxlength="500"></label>
<div class="ci-rm"><button class="btn" type="button" data-rm>ลบ</button></div></div>`;
    host.innerHTML = `<form class="card" id="ci-form"><div class="title"><h2>ข้อมูลลูกค้า ${esc(site)}</h2></div>
<div class="formgrid">${CI_FIELDS.map(([k, l, ph]) => `<label class="f" ${k === "notes" ? 'style="grid-column:1/-1"' : ""}>${l}${k === "notes" ? `<textarea name="${k}" rows="2" maxlength="2000">${esc(p[k] || "")}</textarea>` : `<input name="${k}" value="${esc(p[k] || "")}" placeholder="${esc(ph)}" maxlength="400">`}</label>`).join("")}</div>
<h2 style="margin-top:18px">Solution ที่ติดตั้ง</h2><div id="ci-rows">${(r.products.length ? r.products : [{}]).map(prodRow).join("")}</div>
<datalist id="ci-prod-list">${(LK.product || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
<div class="right" style="justify-content:space-between"><button class="btn" type="button" id="ci-add">+ เพิ่ม Product</button><span><button class="btn" type="button" id="ci-cancel">ยกเลิก</button> <button class="btn primary">บันทึก</button></span></div></form>`;
    const rows = host.querySelector("#ci-rows");
    const bindRm = () => rows.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => b.closest(".ci-erow").remove()));
    bindRm();
    host.querySelector("#ci-add").onclick = () => {
      rows.insertAdjacentHTML("beforeend", prodRow());
      bindRm();
    };
    host.querySelector("#ci-cancel").onclick = () => renderCustInfo(host, site, r);
    host.querySelector("#ci-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const profile = Object.fromEntries(CI_FIELDS.map(([k]) => [k, f.elements[k].value]));
      const products = [...rows.querySelectorAll(".ci-erow")]
        .map((row) => Object.fromEntries([...row.querySelectorAll("input,select")].map((i) => [i.name, i.value])))
        .filter((x) => x.product.trim() || x.version.trim() || x.modules.trim());
      try {
        const out = await post("/customer-info", { site, profile, products }, "PUT");
        toast("บันทึกข้อมูลลูกค้าแล้ว");
        renderCustInfo(host, site, out);
      } catch (err) {
        toast(err.message, 6000);
      }
    };
  }

  async function viewCustomer(params) {
    setNav("customer");
    const site = params.site || "";
    const list = (await api("/customer")).list;
    if (!site) {
      $app.innerHTML = `
<div class="head"><div><h1>ราย ลูกค้า</h1><p>ภาพรวมของลูกค้าแต่ละราย จากเคสที่คุณเห็นได้ (12 เดือนล่าสุด) เรียงจากเคสเกิน Due มากสุด</p></div></div>
<section class="card">${list.length ? `<div class="tablewrap"><table style="min-width:520px"><thead><tr><th>ลูกค้า</th><th style="text-align:right">ยังไม่ปิด</th><th style="text-align:right">เกิน Due</th><th style="text-align:right">เคสทั้งหมด</th></tr></thead><tbody>
${list.map((x) => `<tr class="click" data-href="#/customer?site=${encodeURIComponent(x.site)}"><td style="font-weight:600"><a href="#/customer?site=${encodeURIComponent(x.site)}">${esc(x.site)}</a></td><td style="text-align:right">${x.open}</td><td style="text-align:right">${x.overdue ? `<span class="chip c-overdue">${x.overdue}</span>` : "0"}</td><td style="text-align:right">${x.total}</td></tr>`).join("")}
</tbody></table></div>` : `<div class="empty">ยังไม่มีเคส</div>`}</section>`;
      bindRowLinks();
      return;
    }
    const x = await api(`/customer?site=${encodeURIComponent(site)}`);
    const st = x.stats;
    const [hl, hc] = HEALTH[x.health];
    const maxM = Math.max(1, ...x.months.map((m) => Math.max(m.opened, m.onTime + m.late)));
    const maxT = Math.max(1, ...x.types.map((t) => t.n));
    const opts = list.some((l) => l.site.toLowerCase() === site.toLowerCase()) ? list : [{ site }, ...list];
    $app.innerHTML = `
<div class="crumb"><a href="#/customer">ราย ลูกค้า</a> / ${esc(x.site)}</div>
<section class="card owner-head" style="flex-direction:row">
<div><h1 style="font-size:24px">${esc(x.site)} <span class="chip ${hc}" style="vertical-align:middle">${hl}</span></h1><div class="muted" style="font-size:14px">เคสทั้งหมด ${x.total} เคส · ข้อมูล 6 เดือนล่าสุด</div></div>
<div class="actions"><label class="f" style="flex:0 1 260px;flex-direction:row;align-items:center;gap:8px">เปลี่ยนลูกค้า
<select id="cpick">${opts.map((l) => `<option value="${esc(l.site)}" ${l.site.toLowerCase() === site.toLowerCase() ? "selected" : ""}>${esc(l.site)}${l.open ? ` (${l.open})` : ""}</option>`).join("")}</select></label>
${lvl("export") === "all" ? `<a class="btn" href="#/reports?site=${encodeURIComponent(x.site)}">Export เคสของลูกค้านี้</a>` : ""}</div></section>
<div id="cinfo"><div class="hint">กำลังโหลดข้อมูลลูกค้า…</div></div>
<div class="banner ${x.health === "bad" ? "err" : x.health === "warn" ? "warn" : "ok"} health-reasons"><strong>สุขภาพลูกค้า: ${hl}</strong><ul>${x.reasons.map((r) => `<li>${esc(r.text)}</li>`).join("")}</ul></div>
<div class="kpis">
<div class="kpi k-all"><div class="l">ยังไม่ปิด</div><div class="v">${st.open}</div></div>
<div class="kpi k-overdue"><div class="l">เกิน Due</div><div class="v">${st.overdue}</div></div>
<div class="kpi k-closed"><div class="l">ปิดทัน SLA · 6 เดือน</div><div class="v">${st.slaPct == null ? "-" : st.slaPct + "%"}</div><div class="s">ปิด ${st.closed6} เคส · เปิดใหม่ ${st.opened6}</div></div>
<div class="kpi k-normal"><div class="l">ใช้เวลาปิดเฉลี่ย</div><div class="v">${st.avgDays == null ? "-" : st.avgDays}</div><div class="s">วัน</div></div>
<div class="kpi k-sr"><div class="l">ความพึงพอใจ</div><div class="v">${x.csat.avg == null ? "-" : x.csat.avg}</div><div class="s">${x.csat.rated ? `จาก ${x.csat.rated} คำตอบ (ส่ง ${x.csat.sent})` : x.csat.sent ? `ส่ง ${x.csat.sent} ยังไม่มีคำตอบ` : "ยังไม่มีแบบสอบถาม"}</div></div>
</div>
<section class="card"><div class="title"><h2>เคสที่ยังไม่ปิด (${x.open.length})</h2><span>เรียงจากเกิน Due มากสุด</span></div>
${x.open.length ? `<div class="tablewrap"><table style="min-width:760px"><thead><tr><th>เลขเคส</th><th>Severity</th><th>งาน</th><th>User</th><th>เปิดเคส</th><th>Due</th><th>สถานะ</th></tr></thead><tbody>
${x.open.map((c) => `<tr class="click" data-href="#/case/${c.id}"><td><a class="mono" href="#/case/${c.id}">${esc(caseRef(c))}</a>${c.csNumber ? `<div class="muted" style="font-size:12px">${esc(c.csNumber)}</div>` : ""}</td><td>${sevChip(c.severity)}</td><td style="font-size:13px">${esc(c.task || "")}</td><td>${esc(c.owner || "-")}</td><td>${fd(c.startDate)}</td><td>${fd(c.dueDate)}</td><td>${chip(c.stage)}${c.stage === "overdue" ? ` <small class="muted">${c.daysOverdue} วัน</small>` : ""}</td></tr>`).join("")}
</tbody></table></div>` : `<div class="empty">ไม่มีเคสค้าง</div>`}</section>
<div class="grid2">
<section class="card"><div class="title"><h2>เคสรายเดือน</h2><span>เปิดใหม่ เทียบกับปิดทัน / ไม่ทัน SLA</span></div>
<div class="mbars">${x.months.map((m) => `<div class="mb"><div class="mb-cols">
<div class="mb-o" style="height:${(m.opened / maxM) * 100}%" title="เปิดใหม่ ${m.opened}"></div>
<div class="mb-c" style="height:${((m.onTime + m.late) / maxM) * 100}%">${m.late ? `<div style="flex:${m.late};background:var(--over)" title="ปิดไม่ทัน ${m.late}"></div>` : ""}${m.onTime ? `<div style="flex:${m.onTime};background:var(--normal)" title="ปิดทัน ${m.onTime}"></div>` : ""}</div></div>
<div class="mb-n">${m.opened} / ${m.onTime + m.late}</div><div class="mb-l">${esc(ymLabel(m.ym))}</div></div>`).join("")}</div>
<div class="legend"><span><span class="dot" style="background:#9DB7E8" aria-hidden="true"></span>เปิดใหม่</span><span><span class="dot d-normal" aria-hidden="true"></span>ปิดทัน SLA</span><span><span class="dot d-overdue" aria-hidden="true"></span>ปิดเกิน Due</span></div></section>
<section class="card"><div class="title"><h2>ประเภทงาน</h2><span>6 เดือนล่าสุด รวมเคสที่ยังเปิด</span></div>
${x.types.length ? `<div class="hbars">${x.types.map((t) => `<div class="hb"><span class="hb-l">${esc(t.name)}</span><span class="hb-b"><i style="width:${(t.n / maxT) * 100}%"></i></span><span class="hb-n">${t.n}</span></div>`).join("")}</div>` : `<div class="empty">ไม่มีข้อมูล</div>`}
${x.products.length || x.owners.length ? `<div class="stat2" style="margin-top:6px"><div><div class="k">Product</div><div style="font-size:14px">${x.products.map((p) => `${esc(p.name)} (${p.n})`).join(", ") || "-"}</div></div><div><div class="k">ใครดูแลบ่อย</div><div style="font-size:14px">${x.owners.map((p) => `${esc(p.name)} (${p.n})`).join(", ") || "-"}</div></div></div>` : ""}
</section></div>
<div class="grid2">
<section class="card"><div class="title"><h2>RCA ล่าสุดจาก NICE</h2><span>${x.rca.length} รายการ</span></div>
${x.rca.length ? x.rca.map((r) => `<div class="rca-item"><div><a class="mono" href="#/case/${r.id}">${esc(r.caseNo || "#" + r.id)}</a> <span class="muted">${esc(r.csNumber || "")} · ${esc(r.category || "")} · ${fd(r.date)}</span></div><div style="font-size:14px">${esc(r.text)}</div></div>`).join("") : `<div class="empty">ยังไม่มี RCA</div>`}</section>
<section class="card"><div class="title"><h2>ความเห็นจากลูกค้า</h2><span>แบบสอบถามหลังปิดเคส</span></div>
${x.csat.comments.length ? x.csat.comments.map((r) => `<div class="rca-item"><div><span aria-hidden="true">${CSAT_FACE[r.rating]}</span> <b>${r.rating}/5</b> · <a class="mono" href="#/case/${r.case_id}">${esc(r.case_no || "#" + r.case_id)}</a> <span class="muted">${fdt(r.rated_at)}</span></div>${r.comment ? `<div style="font-size:14px">${esc(r.comment)}</div>` : ""}</div>`).join("") : `<div class="empty">ยังไม่มีคำตอบจากลูกค้า</div>`}</section></div>
<section class="card" id="cr-card"></section>
<section class="card"><div class="title"><h2>ปิดล่าสุด</h2><span>6 เดือน</span></div>
${x.recentClosed.length ? `<div class="tablewrap"><table style="min-width:760px"><thead><tr><th>เลขเคส</th><th>งาน / วิธีแก้</th><th>User</th><th>ปิดเมื่อ</th><th>SLA</th></tr></thead><tbody>
${x.recentClosed.map((c) => `<tr class="click" data-href="#/case/${c.id}"><td><a class="mono" href="#/case/${c.id}">${esc(caseRef(c))}</a></td><td style="font-size:13px">${esc(c.task || "")}${c.resolution ? `<div class="muted">${esc(c.resolution)}</div>` : ""}</td><td>${esc(c.owner || "-")}</td><td>${fd(c.closedAt)}</td><td>${c.onTime ? `<span class="chip c-normal">ทัน</span>` : `<span class="chip c-overdue">ไม่ทัน</span>`}</td></tr>`).join("")}
</tbody></table></div>` : `<div class="empty">ไม่มีเคสที่ปิดใน 6 เดือน</div>`}</section>`;
    document.getElementById("cpick").onchange = (e) => (location.hash = "#/customer?site=" + encodeURIComponent(e.target.value));
    loadCustInfo(document.getElementById("cinfo"), x.site);
    bindRowLinks();
    bindCustomerReport(x.site);
  }

  // ------------------------------------------------------------ settings: Microsoft Teams alerts
  async function bindTeamsNotify() {
    const host = document.getElementById("tn-body");
    if (!host) return;
    let s;
    try {
      s = await api("/teams-notify");
    } catch (e) {
      host.closest("section").hidden = true;
      return;
    }
    const rows = [{ code: "_default", label: "ช่องกลาง (ทีมที่ไม่ได้ตั้งลิงก์ของตัวเอง)" }, ...s.teams];
    host.innerHTML = `<p class="hint" style="margin:0 0 10px">ใน Teams ของแต่ละทีม: ช่อง (Channel) → ••• → Workflows → “Post to a channel when a webhook request is received” → คัดลอกลิงก์มาวางที่นี่ ไม่ต้องให้สิทธิ์ Microsoft Graph เพิ่ม ลิงก์เป็นความลับ ใครมีลิงก์ก็ส่งข้อความเข้าช่องได้</p>
<div class="stack" style="gap:12px">${rows
      .map((t) => {
        const ch = s.channels[t.code] || {};
        const ev = ch.url ? ch.events || [] : s.defaultEvents;
        return `<details class="tn-row" data-code="${esc(t.code)}" ${ch.url || t.code === "_default" ? "open" : ""}><summary class="tn-h"><b>${esc(t.label)}</b>${ch.url ? `<span class="chip c-normal">ตั้งแล้ว</span>` : `<span class="muted" style="font-size:13px">ยังไม่ตั้ง</span>`}</summary>
<div style="display:flex;gap:8px"><input type="url" class="tn-url mono" value="${esc(ch.url || "")}" placeholder="https://….logic.azure.com/workflows/… หรือ ….powerplatform.com/…" style="flex:1;min-width:0" autocomplete="off" spellcheck="false"><button class="btn" type="button" data-tntest style="min-height:40px">ทดสอบ</button></div>
<div class="tn-ev">${Object.entries(s.events).map(([k, l]) => `<label class="chk"><input type="checkbox" value="${k}" ${ev.includes(k) ? "checked" : ""}><span>${esc(l)}</span></label>`).join("")}</div></details>`;
      })
      .join("")}</div>
<div class="right" style="margin-top:12px"><button class="btn primary" type="button" id="tn-save">บันทึกการแจ้งเตือน Teams</button></div>`;
    const collect = () => {
      const channels = {};
      host.querySelectorAll(".tn-row").forEach((r) => {
        const url = r.querySelector(".tn-url").value.trim();
        if (url) channels[r.dataset.code] = { url, events: [...r.querySelectorAll(".tn-ev input:checked")].map((x) => x.value) };
      });
      return channels;
    };
    host.querySelectorAll("[data-tntest]").forEach(
      (b) =>
        (b.onclick = async () => {
          const url = b.closest(".tn-row").querySelector(".tn-url").value.trim();
          if (!url) return toast("วางลิงก์ Workflows ก่อน");
          b.disabled = true;
          try {
            const r = await post("/teams-notify/test", { url });
            toast(r.dryRun ? "โหมดทดสอบ (DRY RUN): ไม่ได้ส่งจริง" : "ส่งข้อความทดสอบแล้ว ดูในช่อง Teams", 5000);
          } catch (e) {
            toast(e.message, 7000);
          } finally {
            b.disabled = false;
          }
        })
    );
    document.getElementById("tn-save").onclick = async () => {
      try {
        await post("/teams-notify", { channels: collect() }, "PUT");
        toast("บันทึกการแจ้งเตือน Teams แล้ว");
        bindTeamsNotify();
      } catch (e) {
        toast(e.message, 7000);
      }
    };
  }

  // ------------------------------------------------------------ checklist (PM cases) and team files on the case page
  function checklistCard(list, c, permsC, ma, files) {
    if ((!list || !list.length) && !ma) return "";
    list = list || [];
    const left = list.filter((x) => !x.done).length;
    const canTick = permsC.edit && c.stage !== "closed";
    const filled = (files || []).filter((f) => f.kind === "ma");
    const maHtml = ma
      ? `<div class="ma-box"><div class="ma-h"><strong>แบบฟอร์ม MA</strong>${filled.length ? ` <span class="chip c-ok">อัปโหลดแล้ว</span>` : ma.filled ? ` <span class="chip c-ok">อัปโหลดแล้ว (เคสเดิม)</span>` : ` <span class="chip c-r1">ยังไม่อัปโหลด</span>`}</div>
<div class="ma-row"><a class="btn" href="api/case/${c.id}/ma-form">ดาวน์โหลดแบบฟอร์ม</a>${canTick ? `<label class="btn primary"><input type="file" id="ma-up" accept=".pdf,.docx,.doc,.xlsx,.xls,image/*" hidden>อัปโหลดฉบับที่กรอกแล้ว</label>` : ""}</div>
<div class="hint" style="margin:0">${esc(ma.fileName)} · กรอกแล้วอัปโหลดกลับก่อนปิดเคส (ไฟล์ หรือถ่ายรูปแบบฟอร์มกระดาษก็ได้)</div>
${filled.length ? `<ul class="ma-files">${filled.map((f) => `<li><a href="api/case/${c.id}/files/${f.id}?dl=1">${esc(f.file_name)}</a> <span class="muted">${esc(f.by || "")} · ${fdt(f.created_at)}</span></li>`).join("")}</ul>` : ""}</div>`
      : "";
    return `<section class="card" id="ck-card"><div class="title"><h2>Checklist งาน PM</h2><span>${left ? `เหลือ ${left} จาก ${list.length} ข้อ` : ma && !filled.length && !ma.filled ? "ครบแล้ว เหลืออัปโหลดแบบฟอร์ม MA" : "ครบแล้ว ปิดเคสได้"}</span></div>
<div class="ck-list">${list
      .map(
        (x) => `<label class="ck ${x.done ? "done" : ""}"><input type="checkbox" data-ck="${x.seq}" ${x.done ? "checked" : ""} ${canTick ? "" : "disabled"}><span><span class="ck-t">${x.seq}. ${esc(x.item)}</span>${x.done ? `<span class="ck-m">${esc(x.done_by || "")} · ${fdt(x.done_at)}${x.note ? " · " + esc(x.note) : ""}</span>` : ""}</span></label>`
      )
      .join("")}</div>
${left && canTick ? `<p class="hint" style="margin:0">ปิดเคสได้เมื่อติ๊กครบทุกข้อ${ma ? " และอัปโหลดแบบฟอร์ม MA" : ""} ถ้ารอบนี้ไม่ได้ทำ ให้ปิดเป็น Cancel หรือ N/A</p>` : ""}
${maHtml}</section>`;
  }
  function bindChecklist(c) {
    const mu = document.getElementById("ma-up");
    if (mu)
      mu.onchange = async () => {
        const file = mu.files[0];
        if (!file) return;
        try {
          toast(`กำลังอัปโหลด ${file.name}…`, 2000);
          const x = await readForUpload(file);
          await post(`/case/${c.id}/files`, { ...x, kind: "ma" });
          toast("อัปโหลดแบบฟอร์ม MA แล้ว");
          viewCase(c.id);
        } catch (e) {
          toast(e.message, 6000);
        }
      };
    document.querySelectorAll("#ck-card [data-ck]").forEach(
      (el) =>
        (el.onchange = async () => {
          let note = "";
          if (el.checked) note = prompt("หมายเหตุ (ถ้ามี) เช่น ค่าที่วัดได้ หรือสิ่งที่พบ") || "";
          try {
            await post(`/case/${c.id}/checklist/${el.dataset.ck}`, { done: el.checked, note }, "PUT");
            viewCase(c.id);
          } catch (e) {
            el.checked = !el.checked;
            toast(e.message, 6000);
          }
        })
    );
  }

  /** A phone photo is shrunk to at most 1600 px (JPEG) before upload; other files go as they are. */
  function readForUpload(file) {
    return new Promise((resolve, reject) => {
      const isImg = /^image\/(jpeg|png|webp)$/.test(file.type);
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("อ่านไฟล์ไม่ได้"));
      fr.onload = () => {
        if (!isImg) return resolve({ name: file.name, mime: file.type || "application/octet-stream", data: String(fr.result).split(",")[1] });
        const img = new Image();
        img.onerror = () => resolve({ name: file.name, mime: file.type, data: String(fr.result).split(",")[1] });
        img.onload = () => {
          const k = Math.min(1, 1600 / Math.max(img.width, img.height));
          if (k === 1 && file.size < 1.5 * 1024 * 1024) return resolve({ name: file.name, mime: file.type, data: String(fr.result).split(",")[1] });
          const cv = document.createElement("canvas");
          cv.width = Math.round(img.width * k);
          cv.height = Math.round(img.height * k);
          cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
          const name = file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg";
          resolve({ name, mime: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.85).split(",")[1] });
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function teamFilesCard(files, c, permsC) {
    const can = permsC.edit;
    if (!files.length && !can) return "";
    return `<section class="card" id="tf-card"><div class="title"><h2>รูปและไฟล์ของทีม${files.length ? ` (${files.length})` : ""}</h2><span>ถ่ายรูปหน้างาน / แนบ log</span></div>
${can ? `<div class="tf-actions"><label class="btn primary tf-cam"><input type="file" accept="image/*" capture="environment" id="tf-cam" hidden>📷 ถ่ายรูป</label><label class="btn"><input type="file" id="tf-file" multiple hidden>แนบไฟล์</label></div>
<input type="text" id="tf-cap" placeholder="คำอธิบายรูป (ไม่บังคับ) เช่น หน้าจอ error ที่เครื่อง Agent" maxlength="300">` : ""}
${files.length ? `<div class="cf-grid">${files
      .map((f) => {
        const u = `api/case/${c.id}/files/${f.id}`;
        const img = /^image\//.test(f.mime);
        return `<div class="cf-wrap"><a class="cf" href="${u}" target="_blank" rel="noopener" title="${esc(f.file_name)}">${img ? `<img src="${u}" alt="${esc(f.caption || f.file_name)}" loading="lazy">` : `<span class="cf-ext">${esc((f.file_name.split(".").pop() || "").toUpperCase())}</span>`}<span class="cf-n">${esc(f.caption || f.file_name)}</span><span class="cf-d">${fdt(f.created_at)} · ${esc(f.by || "")}</span></a>${f.created_by === ME.user.id || ME.user.role === "admin" ? `<button type="button" class="cf-del" data-delf="${f.id}" aria-label="ลบ ${esc(f.file_name)}">×</button>` : ""}</div>`;
      })
      .join("")}</div>` : `<p class="muted" style="margin:0;font-size:14px">ยังไม่มีรูปหรือไฟล์ เปิดจากมือถือแล้วกด “ถ่ายรูป” ได้ทันที</p>`}</section>`;
  }
  function bindTeamFiles(c) {
    const up = async (files) => {
      const cap = document.getElementById("tf-cap");
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) {
          toast(`${file.name} ใหญ่เกินไป`);
          continue;
        }
        try {
          toast(`กำลังอัปโหลด ${file.name}…`, 2000);
          const x = await readForUpload(file);
          await post(`/case/${c.id}/files`, { ...x, caption: cap ? cap.value.trim() : "" });
        } catch (e) {
          toast(e.message, 6000);
        }
      }
      viewCase(c.id);
    };
    ["tf-cam", "tf-file"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.onchange = () => el.files.length && up([...el.files]);
    });
    document.querySelectorAll("#tf-card [data-delf]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm("ลบไฟล์นี้?")) return;
          try {
            await api(`/case/${c.id}/files/${b.dataset.delf}`, { method: "DELETE" });
            viewCase(c.id);
          } catch (e) {
            toast(e.message, 6000);
          }
        })
    );
  }

  // ------------------------------------------------------------ customer monthly report (customer page)
  async function bindCustomerReport(site) {
    const el = document.getElementById("cr-card");
    if (!el) return;
    let r;
    try {
      r = await api(`/customer/report?site=${encodeURIComponent(site)}`);
    } catch (e) {
      el.hidden = true;
      return;
    }
    const s = r.setting;
    const canDl = r.canEdit || lvl("export") === "all";
    if (!canDl) return (el.hidden = true);
    el.innerHTML = `<div class="title"><h2>Report รายเดือนให้ลูกค้า (PDF)</h2><span>ภาษาอังกฤษ · มีเฉพาะเลขเคส หัวข้อ วันที่ ผล SLA และ Resolution ไม่มีบันทึกภายใน</span></div>
<div class="cr-row"><label class="f" style="flex:0 1 220px">เดือน<select id="cr-month">${r.months.map((ym) => `<option value="${ym}" ${ym === r.defaultMonth ? "selected" : ""}>${esc(ymLabel(ym, true))}</option>`).join("")}</select></label>
<a class="btn" id="cr-view" target="_blank" rel="noopener">ดูตัวอย่าง PDF</a></div>
${r.canEdit ? `<div class="formgrid" style="grid-template-columns:1fr 1fr">
<label class="f">ส่งถึง (อีเมลลูกค้า คั่นด้วย ,)<input id="cr-to" value="${esc(s.recipients || "")}" placeholder="it.manager@customer.co.th"></label>
<label class="f">CC (เช่น Manager / Sales ของเรา)<input id="cr-cc" value="${esc(s.cc || "")}" placeholder="manager@sinostech.co.th"></label></div>
<label class="chk"><input type="checkbox" id="cr-on" ${s.enabled ? "checked" : ""}><span>ส่งอัตโนมัติทุกวันที่ 2 ของเดือน 09:10 (Report ของเดือนก่อน)</span></label>
<p class="hint" style="margin:0">${s.last_sent_at ? `ส่งล่าสุด ${fdt(s.last_sent_at)} (เดือน ${esc(ymLabel(s.last_ym, true))})` : "ยังไม่เคยส่ง"}</p>
<div class="actions"><button class="btn" type="button" id="cr-send">ส่งเดือนที่เลือกตอนนี้</button><button class="btn primary" type="button" id="cr-save">บันทึก</button></div>` : ""}`;
    const view = document.getElementById("cr-view");
    const month = document.getElementById("cr-month");
    const setHref = () => (view.href = `api/customer/report.pdf?site=${encodeURIComponent(site)}&month=${month.value}`);
    month.onchange = setHref;
    setHref();
    const save = document.getElementById("cr-save");
    if (save)
      save.onclick = async () => {
        try {
          await post("/customer/report", { site, recipients: document.getElementById("cr-to").value, cc: document.getElementById("cr-cc").value, enabled: document.getElementById("cr-on").checked }, "PUT");
          toast("บันทึกการส่ง Report ให้ลูกค้าแล้ว");
          bindCustomerReport(site);
        } catch (e) {
          toast(e.message, 6000);
        }
      };
    const send = document.getElementById("cr-send");
    if (send)
      send.onclick = async () => {
        const to = document.getElementById("cr-to").value.trim();
        if (!to) return toast("ใส่อีเมลผู้รับก่อน");
        if (!confirm(`ส่ง Report เดือน ${ymLabel(month.value, true)} ถึง ${to} ตอนนี้?`)) return;
        send.disabled = true;
        try {
          const x = await post("/customer/report/send", { site, month: month.value, to, cc: document.getElementById("cr-cc").value });
          toast(`ส่งแล้วถึง ${x.to.join(", ")}`, 5000);
          bindCustomerReport(site);
        } catch (e) {
          toast(e.message, 6000);
        } finally {
          send.disabled = false;
        }
      };
  }

  // ------------------------------------------------------------ PM schedules
  async function viewPm() {
    setNav("pm");
    const [r, lk, us] = await Promise.all([api("/pm"), lookups(), api("/users/options").catch(() => ({ users: [] }))]);
    const myTeams = ME.user.role === "admin" ? ME.teams.map((t) => t.key) : ME.user.teams;
    const due = (p) => {
      const n = Math.round((new Date(String(p.next_date).slice(0, 10)) - new Date(daysAgo(0))) / 86400000);
      return n <= 0 ? "วันนี้" : n === 1 ? "พรุ่งนี้" : `อีก ${n} วัน`;
    };
    $app.innerHTML = `
<div class="head"><div><h1>งาน PM ตามรอบ</h1><p>ระบบเปิดเคสให้ผู้รับผิดชอบเองทุกเช้า 07:00 ในวันที่ถึงรอบ พร้อม checklist ปิดเคสได้เมื่อติ๊กครบ</p></div>
<div class="actions">${r.canManage ? `<button class="btn primary" type="button" id="pm-new">+ เพิ่มงาน PM</button>` : ""}</div></div>
<section class="card">${r.items.length ? `<div class="tablewrap"><table style="min-width:860px"><thead><tr><th>งาน</th><th>ลูกค้า</th><th>ทีม / ผู้รับผิดชอบ</th><th>ทุก</th><th>รอบถัดไป</th><th>เคสล่าสุด</th><th></th></tr></thead><tbody>
${r.items.map((p) => `<tr class="${p.active ? "" : "off"}"><td style="font-weight:600">${esc(p.title)}<div class="muted" style="font-size:12px;font-weight:400">${p.checklist.length} ข้อใน checklist${p.ma_file_name ? ` · <a href="api/pm/${p.id}/ma-form">แบบฟอร์ม MA</a>` : ""}${p.product ? " · " + esc(p.product) : ""}</div></td>
<td><a href="#/customer?site=${encodeURIComponent(p.site)}">${esc(p.site)}</a></td>
<td>${esc(p.team_label || p.team)}<div class="muted" style="font-size:12px">${esc(p.owner_name || "-")}</div></td>
<td>${p.every_months} เดือน</td>
<td>${p.active ? `${fd(String(p.next_date).slice(0, 10), true)}<div class="muted" style="font-size:12px">${due(p)}</div>` : `<span class="chip c-closed">หยุดไว้</span>`}</td>
<td>${p.last_case_id ? `<a class="mono" href="#/case/${p.last_case_id}">${esc(p.last_case_no || "#" + p.last_case_id)}</a>${p.last_closed_at ? ` <span class="chip c-normal">ปิดแล้ว</span>` : ""}` : "-"}</td>
<td style="text-align:right;white-space:nowrap">${r.canManage ? `<button class="btn" type="button" data-pme="${p.id}" style="min-height:34px">แก้</button> ${p.active ? `<button class="btn" type="button" data-pmo="${p.id}" style="min-height:34px">เปิดเคสรอบนี้เลย</button>` : ""}` : ""}</td></tr>`).join("")}
</tbody></table></div>` : `<div class="empty">ยังไม่มีงาน PM${r.canManage ? " กด “เพิ่มงาน PM” เพื่อเริ่ม" : ""}</div>`}</section>
<dialog id="dlg"></dialog>`;
    const form = (p) => {
      const dlg = document.getElementById("dlg");
      const team = p ? p.team : myTeams[0];
      const userOpts = (t, sel) => us.users.filter((u) => u.teams.includes(t)).map((u) => `<option value="${u.id}" ${u.id === sel ? "selected" : ""}>${esc(u.display_name)}</option>`).join("");
      dlg.innerHTML = `<form class="card" method="dialog" id="pmf" style="width:min(640px,92vw)">
<h2>${p ? "แก้งาน PM" : "เพิ่มงาน PM"}</h2>
<label class="f"><span class="req">ชื่องาน</span><input name="title" value="${esc(p ? p.title : "")}" maxlength="200" placeholder="เช่น ตรวจสุขภาพระบบ NICE Engage รายไตรมาส" required></label>
<div class="formgrid" style="grid-template-columns:1fr 1fr">
<label class="f"><span class="req">ลูกค้า</span><select name="site" required><option value="">เลือกลูกค้า</option>${lk.site.map((s) => `<option ${p && p.site === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
<label class="f">Product<select name="product"><option value="">-</option>${lk.product.map((s) => `<option ${p && p.product === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
<label class="f"><span class="req">ทีม</span><select name="team">${ME.teams.filter((t) => myTeams.includes(t.key) || (p && t.key === p.team)).map((t) => `<option value="${t.key}" ${t.key === team ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
<label class="f"><span class="req">ผู้รับผิดชอบ</span><select name="owner_id">${userOpts(team, p ? p.owner_id : ME.user.id)}</select></label>
<label class="f"><span class="req">ทำทุก</span><select name="every_months">${[1, 2, 3, 4, 6, 12].map((n) => `<option value="${n}" ${(p ? p.every_months : 3) === n ? "selected" : ""}>${n} เดือน</option>`).join("")}</select></label>
<label class="f"><span class="req">รอบถัดไป (วันที่เปิดเคส)</span><input type="date" name="next_date" value="${p ? String(p.next_date).slice(0, 10) : daysAgo(-1)}" required></label></div>
<label class="f"><span class="req">Checklist (1 บรรทัด = 1 ข้อ)</span><textarea name="checklist" rows="6" placeholder="ตรวจพื้นที่ดิสก์ของ Logger&#10;ตรวจ backup ล่าสุด&#10;ทดสอบอัดเสียงและเปิดฟัง 3 สาย&#10;ส่งสรุปผลให้ลูกค้า">${esc(p ? p.checklist.join("\n") : "")}</textarea></label>
<div class="f"><label for="pm-ma">แบบฟอร์ม MA (ไม่บังคับ)</label><input type="file" id="pm-ma" name="ma" accept=".pdf,.docx,.doc,.xlsx,.xls">
<span class="hint">PDF, Word หรือ Excel ไม่เกิน 10 MB · ทุกรอบ ผู้รับผิดชอบดาวน์โหลดไปกรอก แล้วอัปโหลดกลับก่อนปิดเคส</span>
${p && p.ma_file_name ? `<div class="ma-cur"><span>ไฟล์ปัจจุบัน: <a href="api/pm/${p.id}/ma-form">${esc(p.ma_file_name)}</a> · เลือกไฟล์ใหม่เพื่อแทนที่</span><label class="chk"><input type="checkbox" name="ma_remove"><span>เอาแบบฟอร์มออก</span></label></div>` : ""}</div>
<label class="f">หมายเหตุสำหรับผู้รับผิดชอบ<textarea name="note" rows="2" maxlength="1000">${esc(p ? p.note || "" : "")}</textarea></label>
${p ? `<label class="chk"><input type="checkbox" name="active" ${p.active ? "checked" : ""}><span>ใช้งานอยู่ (เอาติ๊กออกเพื่อหยุดชั่วคราว)</span></label>` : ""}
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="save">บันทึก</button></div></form>`;
      const f = dlg.querySelector("#pmf");
      f.team.onchange = () => (f.owner_id.innerHTML = userOpts(f.team.value, ME.user.id));
      dlg.onclose = async () => {
        if (dlg.returnValue !== "save") return;
        const body = { title: f.title.value, site: f.site.value, product: f.product.value, team: f.team.value, owner_id: Number(f.owner_id.value), every_months: Number(f.every_months.value), next_date: f.next_date.value, checklist: f.checklist.value, note: f.note.value, active: f.active ? f.active.checked : true };
        try {
          const saved = await post(p ? `/pm/${p.id}` : "/pm", body, p ? "PUT" : "POST");
          const id = saved.id || (p && p.id);
          const file = f.ma && f.ma.files[0];
          if (file) {
            if (file.size > 10 * 1024 * 1024) throw new Error("แบบฟอร์ม MA ใหญ่เกิน 10 MB");
            const x = await readForUpload(file);
            await post(`/pm/${id}/ma-form`, x);
          } else if (f.ma_remove && f.ma_remove.checked) await api(`/pm/${id}/ma-form`, { method: "DELETE" });
          toast("บันทึกงาน PM แล้ว");
          viewPm();
        } catch (e) {
          toast(e.message, 6000);
          setTimeout(() => form({ ...(p || {}), ...body, checklist: String(body.checklist).split("\n"), id: p && p.id }), 50);
        }
      };
      dlg.showModal();
    };
    const nb = document.getElementById("pm-new");
    if (nb) nb.onclick = () => form(null);
    document.querySelectorAll("[data-pme]").forEach((b) => (b.onclick = () => form(r.items.find((x) => x.id === Number(b.dataset.pme)))));
    document.querySelectorAll("[data-pmo]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm("เปิดเคสของรอบนี้ตอนนี้เลย? รอบถัดไปจะเลื่อนตามรอบที่ตั้งไว้")) return;
          try {
            const x = await post(`/pm/${b.dataset.pmo}/open-now`, {});
            toast(`เปิดเคส ${x.caseNo} แล้ว`);
            location.hash = "#/case/" + x.caseId;
          } catch (e) {
            toast(e.message, 6000);
          }
        })
    );
  }

  // ------------------------------------------------------------ installable app + notifications on this device
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
  });
  function registerSw() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  const b64u = (s) => {
    const p = "=".repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  };
  async function bindAppCard() {
    const el = document.getElementById("app-card");
    if (!el) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const pushOk = "serviceWorker" in navigator && "PushManager" in window && window.isSecureContext;
    let info = { enabled: false, devices: 0 };
    try {
      info = await api("/push");
    } catch (e) {}
    let sub = null;
    if (pushOk) {
      try {
        const reg = await navigator.serviceWorker.ready;
        sub = await reg.pushManager.getSubscription();
      } catch (e) {}
    }
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    el.innerHTML = `<div class="title"><h2>ใช้บนมือถือเหมือนแอป</h2><span>ติดตั้งไอคอน และรับแจ้งเตือนบนเครื่องนี้</span></div>
<div class="app-row"><div><b>ติดตั้งเป็นแอป</b><div class="hint">${standalone ? "เปิดจากแอปอยู่แล้ว" : ios ? "iPhone / iPad: เปิดใน Safari กดปุ่มแชร์ ⬆︎ แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”" : "Android / Chrome / Edge: กดปุ่มด้านขวา หรือเมนู ⋮ → “ติดตั้งแอป”"}</div></div>
${!standalone && !ios ? `<button class="btn" type="button" id="app-install" ${installPrompt ? "" : "disabled"}>ติดตั้ง</button>` : ""}</div>
<div class="app-row"><div><b>การแจ้งเตือนบนเครื่องนี้</b><div class="hint">${
      !info.enabled ? "Admin ยังไม่ได้เปิดใช้ (ต้องตั้ง VAPID key ที่ server)"
      : !pushOk ? (ios && !standalone ? "iPhone: ติดตั้งเป็นแอปก่อน แล้วเปิดจากไอคอนบนหน้าจอโฮม จึงเปิดแจ้งเตือนได้" : "เบราว์เซอร์นี้ไม่รองรับ")
      : perm === "denied" ? "เครื่องนี้ปิดการแจ้งเตือนของเว็บนี้ไว้ เปิดได้ที่การตั้งค่าของเบราว์เซอร์"
      : sub ? "เปิดอยู่: เคสใหม่ของทีม เคสที่โอนให้คุณ แจ้งเตือนรอบ 1–2 / เกิน Due งาน PM และคำขอบริการ"
      : "ยังไม่เปิด"
    }${info.devices ? ` · เปิดไว้ ${info.devices} เครื่อง` : ""}</div></div>
${info.enabled && pushOk && perm !== "denied" ? (sub ? `<span style="display:flex;gap:8px"><button class="btn" type="button" id="push-test">ทดสอบ</button><button class="btn" type="button" id="push-off">ปิด</button></span>` : `<button class="btn primary" type="button" id="push-on">เปิดแจ้งเตือน</button>`) : ""}</div>`;
    const ib = document.getElementById("app-install");
    if (ib)
      ib.onclick = async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        bindAppCard();
      };
    const on = document.getElementById("push-on");
    if (on)
      on.onclick = async () => {
        try {
          if ((await Notification.requestPermission()) !== "granted") return toast("ไม่ได้รับอนุญาตให้แจ้งเตือน");
          const reg = await navigator.serviceWorker.ready;
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(info.publicKey) });
          await post("/push/subscribe", s.toJSON());
          toast("เปิดการแจ้งเตือนบนเครื่องนี้แล้ว");
        } catch (e) {
          toast("เปิดการแจ้งเตือนไม่สำเร็จ: " + e.message, 6000);
        }
        bindAppCard();
      };
    const off = document.getElementById("push-off");
    if (off)
      off.onclick = async () => {
        try {
          await post("/push/unsubscribe", { endpoint: sub.endpoint });
          await sub.unsubscribe();
        } catch (e) {}
        toast("ปิดการแจ้งเตือนบนเครื่องนี้แล้ว");
        bindAppCard();
      };
    const t = document.getElementById("push-test");
    if (t)
      t.onclick = async () => {
        try {
          const x = await post("/push/test", {});
          toast(x.sent ? "ส่งแล้ว ดูการแจ้งเตือนบนเครื่อง" : "ส่งไม่สำเร็จ ลองปิดแล้วเปิดใหม่", 5000);
        } catch (e) {
          toast(e.message, 6000);
        }
      };
  }

  // ------------------------------------------------------------ skill map
  async function viewSkills(params) {
    setNav("skills");
    const team = params.team || "";
    const m = await api(`/skills${team ? "?team=" + encodeURIComponent(team) : ""}`);
    const lv = (n) => m.levels.find((l) => l.level === n);
    const cnt = (p, min) => m.people.filter((x) => ((m.skills[x.id] || {})[p] || {}).level >= min).length;
    const teamLabel = Object.fromEntries(ME.teams.map((t) => [t.key, t.label]));
    const cell = (p, prod) => {
      const s = (m.skills[p.id] || {})[prod];
      const n = (m.exp[p.id] || {})[prod] || 0;
      const low = n >= 5 && (!s || s.level <= 1);
      const tip = s ? `${lv(s.level).label}: ${lv(s.level).hint}${s.note ? " · " + s.note : ""} · แก้โดย ${s.by || "-"} ${fdt(s.at)}` : "ยังไม่ประเมิน";
      return `<td class="sk-td"><button type="button" class="sk-cell ${s ? "l" + s.level : "none"}" data-u="${p.id}" data-p="${esc(prod)}" ${m.canEdit ? "" : "disabled"} title="${esc(tip)}" aria-label="${esc(p.name)} ${esc(prod)}: ${esc(s ? lv(s.level).label : "ยังไม่ประเมิน")}">
<b>${s ? s.level : "–"}</b><span>${s ? esc(lv(s.level).label) : "ยังไม่ประเมิน"}</span></button>
${n ? `<div class="sk-exp ${low ? "warn" : ""}" title="${low ? "ทำเคสนี้หลายครั้ง แต่ระดับยังต่ำ ลองทบทวน" : "จำนวนเคสที่ดูแลใน 12 เดือน"}">${low ? "⚠ " : ""}${n} เคส</div>` : ""}</td>`;
    };
    $app.innerHTML = `
<div class="head"><div><h1>Skill Map</h1><p>ระดับความสามารถของแต่ละคนในทุก Product · ตัวเลขใต้ช่องคือจำนวนเคสที่ดูแลจริงใน 12 เดือน ใช้ตรวจว่าระดับที่ประเมินสมเหตุสมผล</p></div>
<div class="actions">${m.teams.length > 1 ? `<select id="sk-team" aria-label="ทีม" style="max-width:260px"><option value="">ทุกทีม</option>${m.teams.map((t) => `<option value="${t.code}" ${t.code === team ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>` : ""}
${m.canEdit ? `<button class="btn" type="button" id="sk-extras">จัดการ Skill อื่น</button><a class="btn" href="api/skills/template${team ? "?team=" + encodeURIComponent(team) : ""}">ดาวน์โหลด Excel ไปกรอก</a><label class="btn primary" style="cursor:pointer"><input type="file" id="sk-file" accept=".xlsx" hidden>นำเข้า Excel</label>` : ""}</div></div>
<div class="sk-legend">${m.levels.map((l) => `<span class="sk-lg"><span class="sk-cell l${l.level}" aria-hidden="true"><b>${l.level}</b></span><span><b>${esc(l.label)}</b><br><small>${esc(l.hint)}</small></span></span>`).join("")}</div>
<section class="card">${m.people.length && m.products.length ? `<div class="tablewrap"><table class="sk-table" style="min-width:${260 + m.products.length * 112}px"><thead>${m.extras.length ? `<tr class="sk-group"><th class="sk-name"></th><th colspan="${m.products.length - m.extras.length}">Product</th><th colspan="${m.extras.length}" class="sk-x">Skill อื่น</th><th></th></tr>` : ""}<tr><th class="sk-name">ชื่อ</th>${m.products.map((p) => `<th class="sk-th ${m.extras.includes(p) ? "sk-x" : ""}">${esc(p)}</th>`).join("")}<th class="sk-th">ทำเองได้</th></tr></thead><tbody>
${m.people.map((p) => `<tr><td class="sk-name"><b>${esc(p.name)}</b><div class="muted" style="font-size:12px">${esc(p.teams.map((t) => teamLabel[t] || t).join(", "))}${p.role === "manager" ? " · Manager" : ""}</div></td>${m.products.map((pr) => cell(p, pr)).join("")}
<td class="sk-td sk-sum">${m.products.filter((pr) => ((m.skills[p.id] || {})[pr] || {}).level >= 2).length} / ${m.products.length}</td></tr>`).join("")}
</tbody><tfoot>
<tr><td class="sk-name">ทำเองได้ (ระดับ 2 ขึ้นไป)</td>${m.products.map((pr) => { const n = cnt(pr, 2); return `<td class="sk-td"><span class="chip ${n < 2 ? "c-overdue" : "c-normal"}">${n} คน${n < 2 ? " · เสี่ยง" : ""}</span></td>`; }).join("")}<td></td></tr>
<tr><td class="sk-name">ชำนาญขึ้นไป (3–4)</td>${m.products.map((pr) => `<td class="sk-td">${cnt(pr, 3)} คน</td>`).join("")}<td></td></tr>
</tfoot></table></div>
<p class="hint" style="margin:10px 0 0">จำนวนเคสแสดงเฉพาะ Product (Skill อื่นไม่มีเคสให้นับ) · “เสี่ยง” = มีคนทำเองได้น้อยกว่า 2 คน ถ้าคนนั้นลาหรือลาออก จะไม่มีคนแทน ควรวางแผนสอนงาน · ⚠ = ดูแลเคสของ Product นั้นตั้งแต่ 5 เคสขึ้นไป แต่ระดับยังเป็น 0–1${m.canEdit ? " · กดที่ช่องเพื่อแก้ระดับ" : ""}</p>` : `<div class="empty">${m.products.length ? "ไม่มีผู้ใช้ในทีมนี้" : "ยังไม่มี Product ในรายการ"}</div>`}</section>
<dialog id="dlg"></dialog>`;
    const ts = document.getElementById("sk-team");
    if (ts) ts.onchange = () => (location.hash = "#/skills" + (ts.value ? "?team=" + encodeURIComponent(ts.value) : ""));
    const dlg = document.getElementById("dlg");
    if (m.canEdit)
      document.querySelectorAll(".sk-table .sk-cell[data-u]").forEach(
        (b) =>
          (b.onclick = () => {
            const p = m.people.find((x) => x.id === Number(b.dataset.u));
            const prod = b.dataset.p;
            const s = (m.skills[p.id] || {})[prod];
            const n = (m.exp[p.id] || {})[prod] || 0;
            dlg.innerHTML = `<form class="card" method="dialog" id="skf" style="width:min(520px,92vw)"><h2>${esc(p.name)} · ${esc(prod)}</h2>
<p class="muted" style="margin:0;font-size:14px">ดูแลเคส ${esc(prod)} ${n} เคสใน 12 เดือน</p>
<div class="sk-pick">${m.levels.map((l) => `<label class="sk-opt"><input type="radio" name="lv" value="${l.level}" ${s && s.level === l.level ? "checked" : ""}><span class="sk-cell l${l.level}" aria-hidden="true"><b>${l.level}</b></span><span><b>${esc(l.label)}</b><br><small class="muted">${esc(l.hint)}</small></span></label>`).join("")}
<label class="sk-opt"><input type="radio" name="lv" value="" ${s ? "" : "checked"}><span class="sk-cell none" aria-hidden="true"><b>–</b></span><span><b>ยังไม่ประเมิน</b></span></label></div>
<label class="f">หมายเหตุ (ไม่บังคับ)<input name="note" maxlength="300" value="${esc(s ? s.note : "")}" placeholder="เช่น ผ่าน training NICE Engage 7.x แล้ว"></label>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">บันทึก</button></div></form>`;
            const f = dlg.querySelector("#skf");
            dlg.onclose = async () => {
              if (dlg.returnValue !== "ok") return;
              try {
                await post("/skills", { user_id: p.id, product: prod, level: f.lv.value, note: f.note.value }, "PUT");
                viewSkills(params);
              } catch (e) {
                toast(e.message, 6000);
              }
            };
            dlg.showModal();
          })
      );
    const xb = document.getElementById("sk-extras");
    if (xb)
      xb.onclick = () => {
        dlg.innerHTML = `<form class="card" method="dialog" id="skx" style="width:min(520px,92vw)"><h2>Skill อื่น (นอกจาก Product)</h2>
<p class="muted" style="margin:0;font-size:14px">เช่น Presale, Project Management, Network, SQL · 1 บรรทัด = 1 Skill · Product มาจากรายการ Product ในระบบอยู่แล้ว ไม่ต้องใส่ซ้ำ</p>
<label class="f">รายการ Skill<textarea name="x" rows="8" maxlength="1500">${esc(m.extras.join("\n"))}</textarea></label>
<p class="hint" style="margin:0">ลบชื่อออกเพื่อซ่อนคอลัมน์ ระดับที่กรอกไว้ยังเก็บอยู่ ใส่ชื่อเดิมกลับมาก็แสดงเหมือนเดิม</p>
<div class="right"><button class="btn" value="cancel" formnovalidate>ยกเลิก</button><button class="btn primary" value="ok">บันทึก</button></div></form>`;
        const f = dlg.querySelector("#skx");
        dlg.onclose = async () => {
          if (dlg.returnValue !== "ok") return;
          try {
            await post("/skills/extras", { extras: f.x.value.split("\n") }, "PUT");
            toast("บันทึกรายการ Skill แล้ว");
            viewSkills(params);
          } catch (e) {
            toast(e.message, 6000);
          }
        };
        dlg.showModal();
      };
    const fileIn = document.getElementById("sk-file");
    if (fileIn)
      fileIn.onchange = async () => {
        const file = fileIn.files[0];
        if (!file) return;
        const b64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(",")[1]);
          r.onerror = () => rej(new Error("อ่านไฟล์ไม่ได้"));
          r.readAsDataURL(file);
        });
        fileIn.value = "";
        let pv;
        try {
          pv = await post("/skills/import", { file: b64 });
        } catch (e) {
          return toast(e.message, 7000);
        }
        const sm = pv.summary;
        const changed = pv.rows.filter((r) => r.changes.length || r.errors.length);
        dlg.innerHTML = `<form class="card" method="dialog" style="width:min(760px,94vw)"><h2>ตรวจก่อนนำเข้า Skill</h2>
<p style="margin:0">${sm.people} คนในไฟล์ · จะเปลี่ยน <b>${sm.changes}</b> ค่า${sm.errors ? ` · <span style="color:var(--over)"><b>${sm.errors} แถวผิด</b> ต้องแก้ก่อน</span>` : ""}${sm.unknownColumns.length ? `<br><span class="muted" style="font-size:13px">ข้ามคอลัมน์ที่ไม่ใช่ Product ในระบบ: ${sm.unknownColumns.map(esc).join(", ")}</span>` : ""}</p>
${changed.length ? `<div class="tablewrap" style="max-height:50vh"><table style="min-width:520px"><thead><tr><th>แถว</th><th>ชื่อ / Email</th><th>สิ่งที่เปลี่ยน</th></tr></thead><tbody>${changed
          .map((r) => `<tr><td>${r.row}</td><td>${esc(r.name || r.email || "-")}</td><td>${r.errors.map((e) => `<div style="color:var(--over)">${esc(e)}</div>`).join("")}${r.changes.map((c) => `<span class="gchip">${esc(c.product)}: ${c.from == null ? "–" : c.from} → <b>${c.to}</b></span>`).join(" ")}</td></tr>`)
          .join("")}</tbody></table></div>` : `<p class="muted">ค่าทั้งหมดในไฟล์ตรงกับในระบบแล้ว ไม่มีอะไรเปลี่ยน</p>`}
<div class="right"><button class="btn" value="cancel">ปิด</button>${!sm.errors && sm.changes ? `<button class="btn primary" value="ok">นำเข้า ${sm.changes} ค่า</button>` : ""}</div></form>`;
        dlg.onclose = async () => {
          if (dlg.returnValue !== "ok") return;
          try {
            const r = await post("/skills/import", { file: b64, apply: true });
            toast(`นำเข้าแล้ว ${r.applied} ค่า`);
            viewSkills(params);
          } catch (e) {
            toast(e.message, 7000);
          }
        };
        dlg.showModal();
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
        case "owner":
          if (parts[2] === "meeting") return await viewMeeting(decodeURIComponent(parts[1]), params);
          return await viewOwner(parts[1] ? decodeURIComponent(parts[1]) : null, params);
        case "customer": return await viewCustomer(params);
        case "team": return parts[1] ? await viewTeam(decodeURIComponent(parts[1]), params) : await viewTeams(params);
        case "pm": return await viewPm();
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
        case "skills": return await viewSkills(params);
        case "kpi": return await viewKpi(params);
        case "response": return await viewResponse(params);
        case "rank": return await viewRank(params);
        case "sr": return parts[1] === "new" ? await viewSrNew() : parts[1] ? await viewSrItem(parts[1]) : await viewSr(params);
        case "profile": return await viewProfile();
        default:
          if (ME.user.role === "requester") return (location.hash = "#/sr");
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
    if (window.I18N && ME.user.lang && I18N.sync(ME.user.lang)) return; // the account's language differs from this browser's
    cfg = { ...cfg, ...ME.config };
    buildChrome();
    const lb = document.getElementById("lang");
    if (lb && window.I18N) {
      lb.textContent = I18N.lang === "en" ? "ไทย" : "EN";
      lb.onclick = () => I18N.set(I18N.lang === "en" ? "th" : "en", { save: (l) => post("/profile/lang", { lang: l }, "PUT") });
    }
    if (ME.user.role !== "requester") {
      refreshIntakeBadge();
      setInterval(() => document.visibilityState === "visible" && refreshIntakeBadge(), 120000);
    }
    refreshSrBadge();
    window.addEventListener("hashchange", route);
    route();
    registerSw();
  })();
})();
