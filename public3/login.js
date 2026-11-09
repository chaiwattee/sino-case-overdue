(function () {
  "use strict";
  const box = document.getElementById("box");
  const params = new URLSearchParams(location.search);
  const ERR = {
    notuser: "บัญชีนี้ยังไม่มีสิทธิ์ใช้งานระบบ ติดต่อ Admin เพื่อเพิ่มผู้ใช้",
    disabled: "บัญชีนี้ถูกปิดใช้งาน ติดต่อ Admin",
    uselocal: "บัญชีนี้ใช้อีเมลและรหัสผ่าน กรอกด้านล่างแทน",
    state: "การเข้าสู่ระบบหมดเวลา ลองใหม่อีกครั้ง",
    nonce: "การเข้าสู่ระบบไม่สมบูรณ์ ลองใหม่อีกครั้ง",
    aud: "บัญชีนี้ไม่ได้อยู่ในองค์กร Sinostech",
    sso_off: "ยังไม่ได้ตั้งค่า login ด้วย Microsoft",
    failed: "เข้าสู่ระบบด้วย Microsoft ไม่สำเร็จ ลองใหม่อีกครั้ง",
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "เกิดข้อผิดพลาด");
    return j;
  }

  function msg(text, kind = "err") {
    const el = document.getElementById("msg");
    el.className = "banner " + kind;
    el.textContent = text;
    el.hidden = !text;
  }

  // Staff sign in on Microsoft's own page; the password form (outside accounts) is shown only on request,
  // so the page never looks like a copied Microsoft login.
  function companyNote(c) {
    if (!c) return "";
    return `<div class="login-note">ระบบภายในของ <strong>${esc(c.legalName || c.name)}</strong> สำหรับพนักงานและผู้ที่ได้รับสิทธิ์เท่านั้น
ปุ่มด้านบนพาไปยืนยันตัวตนที่หน้า login ของ Microsoft 365 ขององค์กรโดยตรง หน้านี้ไม่ได้ขอรหัสผ่าน Microsoft ของคุณ${c.url ? `<br><a href="${esc(c.url)}" rel="noopener">เว็บไซต์ ${esc(c.name)}</a>` : ""}</div>`;
  }
  function renderLogin(sso, company) {
    const e = params.get("e");
    const errText = e ? ERR[e] || (e.startsWith("ms_") ? "Microsoft ปฏิเสธการเข้าสู่ระบบ" : ERR.failed) : "";
    const showPw = !sso || e === "uselocal" || params.get("pw") === "1";
    box.innerHTML = `<h2 style="font-size:24px">เข้าสู่ระบบ Sino Case SLA</h2>
<div id="msg" class="banner err" ${errText ? "" : "hidden"} role="alert">${esc(errText)}</div>
${sso ? `<a class="btn primary big" href="/auth/login">
<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
เข้าสู่ระบบด้วยบัญชีบริษัท</a>` : ""}
${companyNote(company)}
<button type="button" class="linkbtn" id="show-link">พนักงานที่ไม่มีบัญชี Microsoft: รับลิงก์เข้าระบบทาง email</button>
<div id="lk" hidden>
<div class="or"><span></span>รับลิงก์ทาง email<span></span></div>
<form id="lf" class="stack">
<label class="f">email บริษัทของคุณ<input type="email" name="email" autocomplete="email" required placeholder="ชื่อ@sinostech.co.th"></label>
<button class="btn big" type="submit">ส่งลิงก์เข้าระบบ</button>
<p class="muted" style="margin:0;font-size:13px">สำหรับส่งคำขอบริการและดูสถานะ ลิงก์ใช้ได้ 15 นาที ครั้งเดียว ไม่ต้องจำรหัสผ่าน</p>
</form></div>
${sso && !showPw ? `<button type="button" class="linkbtn" id="show-pw">บัญชีภายนอก: เข้าด้วยอีเมลและรหัสผ่านของระบบนี้</button>` : ""}
<div id="pw" ${showPw ? "" : "hidden"}>
${sso ? `<div class="or"><span></span>บัญชีภายนอก<span></span></div>` : ""}
<form id="f" class="stack">
<label class="f">อีเมล<input type="email" name="email" autocomplete="username" required></label>
<label class="f">รหัสผ่านของระบบนี้<input type="password" name="password" autocomplete="current-password" required></label>
<label class="chk"><input type="checkbox" name="remember" checked>จำการเข้าสู่ระบบ</label>
<button class="btn ${sso ? "" : "primary"} big" type="submit">เข้าสู่ระบบด้วยรหัสผ่าน</button>
</form>
<p class="muted" style="margin:0;font-size:13px">ลืมรหัสผ่านหรือยังไม่มีบัญชี ติดต่อ Admin ของระบบ</p></div>`;
    const sp = document.getElementById("show-pw");
    if (sp) sp.onclick = () => {
      document.getElementById("pw").hidden = false;
      sp.hidden = true;
      document.querySelector("#f input[name=email]").focus();
    };
    const sl = document.getElementById("show-link");
    sl.onclick = () => {
      document.getElementById("lk").hidden = false;
      sl.hidden = true;
      document.querySelector("#lf input[name=email]").focus();
    };
    const lf = document.getElementById("lf");
    lf.onsubmit = async (ev) => {
      ev.preventDefault();
      const b = lf.querySelector("button");
      b.disabled = true;
      try {
        const r = await post("/auth/email-link", { email: lf.email.value });
        msg(r.message + " ตรวจในกล่อง Junk ด้วย", "ok");
        setTimeout(() => (b.disabled = false), 30000);
      } catch (e) {
        msg(e.message);
        b.disabled = false;
      }
    };
    const f = document.getElementById("f");
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const b = f.querySelector("button");
      b.disabled = true;
      try {
        await post("/auth/local", { email: f.email.value, password: f.password.value, remember: f.remember.checked });
        location.href = "/";
      } catch (e) {
        msg(e.message);
        b.disabled = false;
      }
    };
  }

  function renderReset(token) {
    box.innerHTML = `<h2 style="font-size:24px">ตั้งรหัสผ่านใหม่</h2>
<div id="msg" class="banner err" hidden role="alert"></div>
<form id="f" class="stack">
<label class="f">รหัสผ่านใหม่ (อย่างน้อย 10 ตัว มีทั้งตัวอักษรและตัวเลข)<input type="password" name="p1" autocomplete="new-password" required minlength="10"></label>
<label class="f">ยืนยันรหัสผ่านใหม่<input type="password" name="p2" autocomplete="new-password" required></label>
<button class="btn primary big" type="submit">บันทึกรหัสผ่าน</button>
</form>`;
    const f = document.getElementById("f");
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      if (f.p1.value !== f.p2.value) return msg("รหัสผ่านสองช่องไม่ตรงกัน");
      try {
        await post("/auth/reset", { token, password: f.p1.value });
        history.replaceState(null, "", "/login.html");
        renderLogin(window.__sso, window.__company);
        msg("ตั้งรหัสผ่านใหม่แล้ว เข้าสู่ระบบได้เลย", "ok");
      } catch (e) {
        msg(e.message);
      }
    };
  }

  // Opened from the email: one press signs in (a POST, so link scanners in mail systems cannot use the link up).
  function renderLink(token) {
    box.innerHTML = `<h2 style="font-size:24px">เข้าสู่ระบบด้วยลิงก์ทาง email</h2>
<div id="msg" class="banner err" hidden role="alert"></div>
<p class="muted" style="margin:0">กดปุ่มด้านล่างเพื่อเข้าสู่ระบบคำขอบริการ</p>
<button class="btn primary big" type="button" id="go">เข้าสู่ระบบ</button>
<a class="linkbtn" href="/login.html">กลับหน้าเข้าสู่ระบบ</a>`;
    document.getElementById("go").onclick = async (ev) => {
      ev.target.disabled = true;
      try {
        await post("/auth/email-link/use", { token });
        location.href = "/#/sr";
      } catch (e) {
        msg(e.message);
        ev.target.disabled = false;
      }
    };
  }

  fetch("/auth/config")
    .then((r) => r.json())
    .then((c) => {
      window.__sso = c.sso;
      window.__company = c.company;
      const token = params.get("reset");
      if (token) renderReset(token);
      else if (params.get("link")) renderLink(params.get("link"));
      else renderLogin(c.sso, c.company);
    })
    .catch(() => renderLogin(false));
})();

(function () {
  const b = document.getElementById("lang");
  if (!b || !window.I18N) return;
  b.textContent = I18N.lang === "en" ? "ไทย" : "EN";
  b.onclick = () => I18N.set(I18N.lang === "en" ? "th" : "en");
})();
