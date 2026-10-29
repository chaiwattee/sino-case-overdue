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

  function renderLogin(sso) {
    const e = params.get("e");
    const errText = e ? ERR[e] || (e.startsWith("ms_") ? "Microsoft ปฏิเสธการเข้าสู่ระบบ" : ERR.failed) : "";
    box.innerHTML = `<h2 style="font-size:24px">เข้าสู่ระบบ</h2>
<div id="msg" class="banner err" ${errText ? "" : "hidden"} role="alert">${esc(errText)}</div>
${sso ? `<a class="btn primary big" href="/auth/login">
<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="8" height="8" fill="currentColor"/><rect x="11" y="1" width="8" height="8" fill="currentColor"/><rect x="1" y="11" width="8" height="8" fill="currentColor"/><rect x="11" y="11" width="8" height="8" fill="currentColor"/></svg>
เข้าด้วยบัญชี Microsoft ของบริษัท</a>
<p class="muted" style="margin:0;font-size:13px">พนักงาน Sinostech ใช้ปุ่มนี้ ไม่ต้องจำรหัสผ่านแยก</p>
<div class="or"><span></span>บัญชีภายนอก<span></span></div>` : ""}
<form id="f" class="stack">
<label class="f">อีเมล<input type="email" name="email" autocomplete="username" required></label>
<label class="f">รหัสผ่าน<input type="password" name="password" autocomplete="current-password" required></label>
<label class="chk"><input type="checkbox" name="remember" checked>จำการเข้าสู่ระบบ</label>
<button class="btn ${sso ? "" : "primary"} big" type="submit">เข้าสู่ระบบด้วยรหัสผ่าน</button>
</form>
<p class="muted" style="margin:0;font-size:13px">ลืมรหัสผ่านหรือยังไม่มีบัญชี ติดต่อ Admin ของระบบ</p>`;
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
        renderLogin(window.__sso);
        msg("ตั้งรหัสผ่านใหม่แล้ว เข้าสู่ระบบได้เลย", "ok");
      } catch (e) {
        msg(e.message);
      }
    };
  }

  fetch("/auth/config")
    .then((r) => r.json())
    .then((c) => {
      window.__sso = c.sso;
      const token = params.get("reset");
      if (token) renderReset(token);
      else renderLogin(c.sso);
    })
    .catch(() => renderLogin(false));
})();
