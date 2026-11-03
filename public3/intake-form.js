/* Customer case form opened from a one-time link (/r/<token>). Plain JS, no build step. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  const API = "/api/public/intake/" + encodeURIComponent(token);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const hm = (t) => `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const when = (iso) => {
    const t = new Date(iso);
    return `${t.getDate()} ${TH_MONTHS[t.getMonth()]} ${t.getFullYear()} เวลา ${hm(t)} น.`;
  };
  const SEV_TH = { Critical: "Critical", High: "High", Medium: "Medium", Low: "Low", "Request information": "ขอข้อมูล" };
  const SEV_COLOR = { Critical: "#A5162E", High: "#9A3D0B", Medium: "#7A5600", Low: "#1C6B45", "Request information": "#4A5361" };
  const openedAt = Date.now();
  let info = null;
  const files = [];

  async function call(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { "X-Requested-With": "fetch", ...(opts.headers || {}) } });
    let body = {};
    try {
      body = await res.json();
    } catch (e) {}
    if (!res.ok) throw Object.assign(new Error(body.error || "เกิดข้อผิดพลาด กรุณาลองใหม่"), { body, status: res.status });
    return body;
  }

  function fail(msg) {
    app.innerHTML = `<div class="center"><h1>เปิดฟอร์มไม่ได้</h1><p class="lead">${esc(msg)}</p>
<p class="hint">ต้องการความช่วยเหลือ ติดต่อทีม Support ทาง LINE OA หรือโทรหาทีมงานได้ตามปกติ</p></div>`;
  }

  const field = (id, label, { req, type = "text", value = "", ex, hint, attrs = "" }) => `<div class="f">
<label for="${id}">${label}${req ? ' <span class="req">*</span>' : ""}</label>
<input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${req ? "required" : ""} ${attrs}>
${ex ? `<div class="ex">ตัวอย่าง: <b>${esc(ex)}</b></div>` : ""}<div class="hint">${hint}</div></div>`;

  function render() {
    const left = Math.max(0, Math.round((new Date(info.expiresAt) - Date.now()) / 60000));
    $("exp").textContent = `ลิงก์ใช้ได้ 1 ครั้ง · หมดอายุ ${hm(new Date(info.expiresAt))} น. (อีก ${left} นาที)`;
    app.innerHTML = `
<div><h1>แจ้งเคสถึงทีม Support</h1>
<p class="lead">กรอกข้อมูลให้ครบเพื่อให้ทีมงานเริ่มตรวจสอบได้ทันที ทุกช่องมีตัวอย่างและคำอธิบาย ช่องที่มี <span class="req">*</span> ต้องกรอก</p></div>
${info.test ? `<div class="test">ลิงก์ทดสอบ: เคสนี้ใช้ทดสอบระบบเท่านั้น</div>` : ""}
<div class="cust ${info.matched ? "" : "warn"}"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
<div><strong>${esc(info.customer || "ไม่ระบุบริษัท")}</strong> <span>${info.matched ? "· บริษัทของคุณ" : "· ทีมงานจะยืนยันชื่อบริษัทอีกครั้ง"}</span></div></div>
<form id="f" novalidate>
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<section><h2>1. ข้อมูลผู้แจ้ง</h2><div class="grid">
${field("contactName", "ชื่อผู้ติดต่อ (Customer contact name)", { req: true, value: info.contactName, ex: "สมหญิง ใจดี", hint: "ชื่อ-นามสกุลของคนที่ทีมงานจะติดต่อกลับเรื่องเคสนี้", attrs: 'autocomplete="name" maxlength="120"' })}
${field("position", "ตำแหน่ง / แผนก", { ex: "IT Support, Contact Center", hint: "ช่วยให้ทีมงานรู้ว่าควรคุยเรื่องเทคนิคหรือเรื่องการใช้งาน (ไม่บังคับ)", attrs: 'maxlength="120"' })}
${field("phone", "เบอร์โทรติดต่อ", { req: true, type: "tel", value: info.contactPhone, ex: "081-234-5678", hint: "ใช้โทรกลับกรณีเร่งด่วน ใส่เบอร์ที่ติดต่อได้ในเวลาทำงาน", attrs: 'autocomplete="tel" maxlength="60"' })}
${field("email", "อีเมล", { type: "email", value: info.contactEmail, ex: "somying@company.co.th", hint: "ทีมงานใช้ส่งรายละเอียดหรือขอข้อมูลเพิ่มเรื่องเคสนี้ (ไม่บังคับ)", attrs: 'autocomplete="email" maxlength="200"' })}
</div></section>
<section><h2>2. รายละเอียดปัญหา</h2><div class="grid">
<div class="f"><label for="product">ระบบที่มีปัญหา (Product) <span class="req">*</span></label>
<select id="product" name="product" required><option value="">เลือกระบบ</option>${info.products.map((p) => `<option>${esc(p)}</option>`).join("")}<option value="ไม่แน่ใจ">ไม่แน่ใจ</option></select>
<div class="ex">ตัวอย่าง: <b>${esc(info.products[0] || "NRX")}</b></div>
<div class="hint">ระบบที่ผู้ใช้เจอปัญหา ถ้าไม่แน่ใจให้เลือก “ไม่แน่ใจ” ทีมงานจะตรวจให้</div></div>
${field("startedText", "เริ่มพบปัญหาเมื่อ", { ex: `${new Date().getDate()} ${TH_MONTHS[new Date().getMonth()]} ${new Date().getFullYear()} เวลา 09:15`, hint: "วันและเวลาโดยประมาณที่เริ่มเกิดปัญหา ช่วยให้ทีมงานหา log ได้ตรงช่วง (ไม่บังคับ)", attrs: 'maxlength="120"' })}
</div>
<fieldset class="f" style="border:0;margin:0;padding:0"><legend class="lbl" style="padding:0;margin-bottom:4px;font-weight:600">ความรุนแรงของปัญหา (Severity) <span class="req">*</span></legend>
<div class="hint" style="margin-bottom:6px">เลือกระดับที่ตรงกับผลกระทบจริงมากที่สุด ทีมงานอาจปรับระดับหลังตรวจสอบ</div>
<div class="sev">${info.severities.map((s) => `<label><span class="t" style="color:${SEV_COLOR[s.value]}"><input type="radio" name="severity" value="${esc(s.value)}" required> ${esc(SEV_TH[s.value] || s.value)}</span><span class="d">${esc(s.hint)}</span></label>`).join("")}</div></fieldset>
${field("subject", "หัวข้อปัญหา", { req: true, ex: "Agent login เข้าระบบไม่ได้ ตั้งแต่เช้า", hint: "สรุปปัญหาสั้นๆ 1 บรรทัด ไม่เกิน 150 ตัวอักษร", attrs: 'maxlength="150"' })}
<div class="f"><label for="detail">รายละเอียด <span class="req">*</span></label>
<textarea id="detail" name="detail" rows="6" maxlength="5000" required placeholder="- อาการ: Agent 25 คนกด login แล้วขึ้น &quot;Invalid session&quot;&#10;- ทำอะไรไปแล้ว: restart เครื่อง และล้าง cache แล้ว ยังไม่หาย&#10;- กระทบ: ศูนย์ Contact Center ชั้น 5 รับสายไม่ได้"></textarea>
<div class="hint">เล่าอาการ ข้อความ error ที่เห็น สิ่งที่ลองทำไปแล้ว และผลกระทบ ยิ่งละเอียด ทีมงานยิ่งแก้ได้เร็ว</div></div>
<div class="grid">
${field("affected", "จำนวนผู้ใช้ที่ได้รับผลกระทบ", { ex: "25 คน หรือ ทั้งศูนย์", hint: "ประมาณการได้ (ไม่บังคับ)", attrs: 'maxlength="120"' })}
${field("customerRef", "เลขอ้างอิงของคุณ", { ex: "INC0012345", hint: "เลข ticket ในระบบของบริษัทคุณ ถ้ามี ทีมงานจะอ้างอิงเลขนี้ทุกครั้งที่ติดต่อ (ไม่บังคับ)", attrs: 'maxlength="120"' })}
</div>
${info.attachments ? `<div class="f"><span class="lbl">แนบไฟล์</span>
<label class="drop" id="drop" tabindex="0"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
เลือกไฟล์ หรือลากไฟล์มาวางที่นี่<input type="file" id="file" multiple hidden></label>
<ul class="files" id="flist"></ul>
<div class="hint">ภาพหน้าจอ error หรือไฟล์ log ไม่เกิน ${info.attachments.maxFiles} ไฟล์ ไฟล์ละไม่เกิน ${info.attachments.maxMb} MB (ไม่บังคับ)</div></div>` : ""}
</section>
<div id="msg"></div>
<div class="foot" style="flex-direction:column;align-items:stretch">
<label class="consent"><input type="checkbox" name="consent" required><span>ยินยอมให้ Sinostech ใช้ชื่อ เบอร์โทร และอีเมลนี้ เพื่อติดต่อเรื่องเคสนี้เท่านั้น</span></label>
<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
<span class="hint">หลังกดส่ง คุณได้เลขรับแจ้งทันที และได้ข้อความทาง LINE เมื่อมี Engineer รับเคส</span>
<button class="btn primary" type="submit" id="send">ส่งแจ้งเคส</button></div></div>
</form>`;
    const f = $("f");
    f.onsubmit = (e) => {
      e.preventDefault();
      send(false);
    };
    if (info.attachments) bindFiles();
  }

  function bindFiles() {
    const input = $("file");
    const drop = $("drop");
    const list = $("flist");
    const draw = () =>
      (list.innerHTML = files
        .map((x, i) => `<li><span>${esc(x.name)} <span class="hint">${x.id ? Math.ceil(x.size / 1024) + " KB" : x.error ? "" : "กำลังอัปโหลด…"}</span>${x.error ? ` <span style="color:var(--red)">${esc(x.error)}</span>` : ""}</span><button type="button" data-rm="${i}">ลบ</button></li>`)
        .join(""));
    list.onclick = async (e) => {
      const i = e.target.dataset.rm;
      if (i === undefined) return;
      const x = files[i];
      files.splice(i, 1);
      draw();
      if (x.id) call("/files/" + x.id, { method: "DELETE" }).catch(() => {});
    };
    const add = async (fl) => {
      for (const file of fl) {
        if (files.filter((x) => !x.error).length >= info.attachments.maxFiles) break;
        const item = { name: file.name, size: file.size };
        files.push(item);
        draw();
        if (file.size > info.attachments.maxMb * 1024 * 1024) {
          item.error = `ใหญ่เกิน ${info.attachments.maxMb} MB`;
          draw();
          continue;
        }
        try {
          const r = await call("/files", { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) } });
          item.id = r.file.id;
        } catch (err) {
          item.error = err.message;
        }
        draw();
      }
    };
    input.onchange = () => add([...input.files]).then(() => (input.value = ""));
    drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click());
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over"))));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove("over"))));
    drop.addEventListener("drop", (e) => add([...e.dataTransfer.files]));
  }

  async function send(confirmDuplicate) {
    const f = $("f");
    const msg = $("msg");
    msg.innerHTML = "";
    const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : "");
    const sev = f.querySelector("input[name=severity]:checked");
    const miss = [];
    if (!v("contactName")) miss.push("ชื่อผู้ติดต่อ");
    if (!v("phone")) miss.push("เบอร์โทร");
    if (!v("product")) miss.push("ระบบที่มีปัญหา");
    if (!sev) miss.push("ความรุนแรง");
    if (!v("subject")) miss.push("หัวข้อปัญหา");
    if (!v("detail")) miss.push("รายละเอียด");
    if (miss.length) {
      msg.innerHTML = `<div class="err" role="alert">กรุณากรอก: ${esc(miss.join(", "))}</div>`;
      return;
    }
    if (!f.consent.checked) {
      msg.innerHTML = `<div class="err" role="alert">กรุณาติ๊กยินยอมให้ใช้ข้อมูลติดต่อ</div>`;
      return;
    }
    if (files.some((x) => !x.id && !x.error)) {
      msg.innerHTML = `<div class="err" role="alert">รอให้อัปโหลดไฟล์เสร็จก่อน</div>`;
      return;
    }
    const btn = $("send");
    btn.disabled = true;
    btn.textContent = "กำลังส่ง…";
    try {
      const r = await call("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactName: v("contactName"), position: v("position"), phone: v("phone"), email: v("email"), product: v("product"),
          startedText: v("startedText"), severity: sev.value, subject: v("subject"), detail: v("detail"), affected: v("affected"),
          customerRef: v("customerRef"), consent: true, website: v("website"), openedAt, confirmDuplicate,
          files: files.filter((x) => x.id).map((x) => x.id),
        }),
      });
      success(r);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "ส่งแจ้งเคส";
      if (e.body && e.body.code === "DUPLICATE") {
        msg.innerHTML = `<div class="dup" role="alert"><span>${esc(e.message)}</span><div><button class="btn" type="button" id="dupok">ส่งเป็นเรื่องใหม่</button></div></div>`;
        $("dupok").onclick = () => send(true);
        return;
      }
      if (e.status === 410 || e.status === 404) return fail(e.message);
      msg.innerHTML = `<div class="err" role="alert">${esc(e.message)}</div>`;
    }
  }

  function success(r) {
    $("exp").textContent = "";
    window.scrollTo(0, 0);
    app.innerHTML = `<div class="center"><div class="okmark"><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#1C6B45" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>ได้รับแจ้งเคสของคุณแล้ว</h1><p class="lead" style="margin:0">ทีมงานได้รับแจ้งเตือนแล้ว เมื่อมี Engineer รับเคส คุณจะได้ข้อความทาง LINE พร้อมชื่อผู้รับผิดชอบ</p></div>
<div class="reqno"><span>เลขรับแจ้งของคุณ</span><strong>${esc(r.reqNo)}</strong><span class="hint">ใช้เลขนี้อ้างอิงทุกครั้งที่ติดต่อทีมงาน</span></div>
<dl class="sum">
<div><dt>บริษัท</dt><dd>${esc(r.site || r.customerText || "-")}</dd></div>
<div><dt>ผู้ติดต่อ</dt><dd>${esc(r.contactName)} · ${esc(r.contactPhone)}</dd></div>
<div><dt>ระบบ / ความรุนแรง</dt><dd>${esc(r.product)} · <span style="color:${SEV_COLOR[r.severity]}">${esc(SEV_TH[r.severity] || r.severity)}</span></dd></div>
<div><dt>แจ้งเมื่อ</dt><dd>${esc(when(r.createdAt))}</dd></div>
<div class="full"><dt>หัวข้อ</dt><dd>${esc(r.subject)}</dd></div></dl>
<section><h2 style="border:0;padding:0">ขั้นตอนต่อจากนี้</h2><ol class="next">
<li><span class="n">1</span><span><strong>ทีมงานรับเคส</strong> และมอบหมาย Engineer ผู้รับผิดชอบ คุณจะได้ข้อความทาง LINE</span></li>
<li><span class="n">2</span><span><strong>Engineer ติดต่อกลับ</strong> เพื่อสอบถามข้อมูลเพิ่ม หรือขอ remote เข้าตรวจสอบ</span></li>
<li><span class="n">3</span><span><strong>แจ้งผล</strong> เมื่อแก้ไขเสร็จและปิดเคส</span></li></ol></section>
<p class="hint" style="text-align:center;margin:0">ปิดหน้านี้ได้เลย ถ้าต้องการแจ้งเรื่องใหม่ กด “แจ้งเคส” ใน LINE อีกครั้ง</p>`;
  }

  (async function boot() {
    try {
      info = await call("");
      render();
    } catch (e) {
      fail(e.message);
    }
  })();
})();
