/* Customer case form opened from a one-time link (/r/<token>). Plain JS, no build step. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  const API = "/api/public/intake/" + encodeURIComponent(token);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TH_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hm = (t) => `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const when = (iso) => {
    const t = new Date(iso);
    return `${t.getDate()} ${TH_MONTHS[t.getMonth()]} ${t.getFullYear()}, ${hm(t)}`;
  };
  const SEV_TH = { Critical: "Critical", High: "High", Medium: "Medium", Low: "Low", "Request information": "Question" };
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
    if (!res.ok) throw Object.assign(new Error(body.error || "Something went wrong. Please try again."), { body, status: res.status });
    return body;
  }

  // Company identity on every state of the page (helps customers and browsers trust the form).
  function company(c) {
    if (!c) return;
    const contact = [c.supportPhone ? `Tel. ${esc(c.supportPhone)}` : "", c.supportEmail ? `<a href="mailto:${esc(c.supportEmail)}">${esc(c.supportEmail)}</a>` : ""].filter(Boolean).join(" · ");
    document.getElementById("foot").innerHTML = `${esc(c.legalName || c.name)} · Support${c.url ? ` · <a href="${esc(c.url)}" rel="noopener">${esc(c.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : ""}${contact ? ` · ${contact}` : ""}<br>This link works once. Please do not forward it. Your details are used only for this case.`;
  }

  function fail(msg) {
    app.innerHTML = `<div class="center"><h1>This form cannot be opened</h1><p class="lead">${esc(msg)}</p>
<p class="hint">For help, contact Sinostech Support on LINE or by email as usual.</p></div>`;
  }

  const field = (id, label, { req, type = "text", value = "", ex, hint, attrs = "" }) => `<div class="f">
<label for="${id}">${label}${req ? ' <span class="req">*</span>' : ""}</label>
<input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${req ? "required" : ""} ${attrs}>
${ex ? `<div class="ex">Example: <b>${esc(ex)}</b></div>` : ""}<div class="hint">${hint}</div></div>`;

  function render() {
    const left = Math.max(0, Math.round((new Date(info.expiresAt) - Date.now()) / 60000));
    const ex = new Date(info.expiresAt);
    $("exp").textContent = left <= 120 ? `One-time link · expires at ${hm(ex)} (in ${left} min)` : `One-time link · expires ${ex.getDate()} ${TH_MONTHS[ex.getMonth()]} ${hm(ex)}`;
    app.innerHTML = `
<div><h1>Report a case to Sinostech Support</h1>
<p class="lead">Please complete the form so our team can start right away. Every field has an example. Fields marked <span class="req">*</span> are required.</p></div>
${info.test ? `<div class="test">Test link: this case is for testing only.</div>` : ""}
<div class="cust ${info.matched ? "" : "warn"}"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
<div><strong>${esc(info.customer || "Company not specified")}</strong> <span>${info.matched ? "· your company" : "· our team will confirm the company name"}</span></div></div>
<form id="f" novalidate>
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<section><h2>1. Your contact details</h2><div class="grid">
${field("contactName", "Contact name", { req: true, value: info.contactName, ex: "Somying Jaidee", hint: "The person our engineer should contact about this case", attrs: 'autocomplete="name" maxlength="120"' })}
${field("position", "Position / department", { ex: "IT Support, Contact Center", hint: "Helps us know whether to talk technical details or usage (optional)", attrs: 'maxlength="120"' })}
${field("phone", "Call-back number", { req: true, type: "tel", value: info.contactPhone, ex: "081-234-5678", hint: "A number we can reach you on during working hours", attrs: 'autocomplete="tel" maxlength="60"' })}
${field("email", "Email", { type: "email", value: info.contactEmail, ex: "somying@company.co.th", hint: "We use it to send updates or ask for more information (optional)", attrs: 'autocomplete="email" maxlength="200"' })}
</div></section>
<section><h2>2. The problem</h2><div class="grid">
<div class="f"><label for="product">Affected system <span class="req">*</span></label>
<select id="product" name="product" required><option value="">Choose a system</option>${info.products.map((p) => `<option>${esc(p)}</option>`).join("")}<option value="Not sure">Not sure</option></select>
<div class="ex">Example: <b>${esc(info.products[0] || "NRX")}</b></div>
<div class="hint">The system where users see the problem. If you are not sure, choose “Not sure”.</div></div>
${field("startedText", "Started at", { ex: `${new Date().getDate()} ${TH_MONTHS[new Date().getMonth()]} ${new Date().getFullYear()}, 09:15`, hint: "Approximate date and time — helps us find the right logs (optional)", attrs: 'maxlength="120"' })}
</div>
<fieldset class="f" style="border:0;margin:0;padding:0"><legend class="lbl" style="padding:0;margin-bottom:4px;font-weight:600">Urgency <span class="req">*</span></legend>
<div class="hint" style="margin-bottom:6px">Choose the level closest to the real impact. Our engineer confirms the final priority.</div>
<div class="sev">${info.severities.map((s) => `<label><span class="t" style="color:${SEV_COLOR[s.value]}"><input type="radio" name="severity" value="${esc(s.value)}" required> ${esc(SEV_TH[s.value] || s.value)}</span><span class="d">${esc(s.hint)}</span></label>`).join("")}</div></fieldset>
${field("subject", "Subject", { req: true, ex: "Agents cannot log in since this morning", hint: "One short line, up to 150 characters", attrs: 'maxlength="150"' })}
<div class="f"><label for="detail">Details <span class="req">*</span></label>
<textarea id="detail" name="detail" rows="6" maxlength="5000" required placeholder="- What happens: 25 agents get &quot;Invalid session&quot; at login&#10;- What you tried: restarted PCs and cleared cache, still failing&#10;- Impact: the 5th-floor contact center cannot take calls"></textarea>
<div class="hint">Symptoms, error messages, what you already tried and the impact. The more detail, the faster we can fix it.</div></div>
<div class="grid">
${field("affected", "Users affected", { ex: "25 agents, or the whole center", hint: "An estimate is fine (optional)", attrs: 'maxlength="120"' })}
${field("customerRef", "Your reference number", { ex: "INC0012345", hint: "Your internal ticket number, if any. We will quote it whenever we contact you (optional)", attrs: 'maxlength="120"' })}
</div>
${info.attachments ? `<div class="f"><span class="lbl">Attachments</span>
<label class="drop" id="drop" tabindex="0"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
Choose files, drag them here, or paste a screenshot (Ctrl+V)<input type="file" id="file" multiple hidden></label>
<ul class="files" id="flist"></ul>
<div class="hint">Screenshots or log files, up to ${info.attachments.maxFiles} files, ${info.attachments.maxMb} MB each (optional)</div></div>` : ""}
</section>
<div id="msg"></div>
<div class="foot" style="flex-direction:column;align-items:stretch">
<label class="consent"><input type="checkbox" name="consent" required><span>I agree that SINO S-TECH LIMITED may use this name, phone number and email only to contact me about this case.</span></label>
<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
<span class="hint">You get a reference number right away, and ${info.channel === "line" ? "a LINE message" : "an email"} when an engineer takes the case.</span>
<button class="btn primary" type="submit" id="send">Send case</button></div></div>
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
        .map((x, i) => `<li><span>${esc(x.name)} <span class="hint">${x.id ? Math.ceil(x.size / 1024) + " KB" : x.error ? "" : "Uploading…"}</span>${x.error ? ` <span style="color:var(--red)">${esc(x.error)}</span>` : ""}</span><button type="button" data-rm="${i}">Remove</button></li>`)
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
          item.error = `larger than ${info.attachments.maxMb} MB`;
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
    document.onpaste = (e) => {
      const imgs = [...((e.clipboardData || {}).items || [])].filter((x) => x.kind === "file").map((x) => x.getAsFile()).filter(Boolean);
      if (imgs.length) {
        e.preventDefault();
        add(imgs.map((f, n) => new File([f], `screenshot-${Date.now()}${n ? "-" + n : ""}.png`, { type: f.type || "image/png" })));
      }
    };
  }

  async function send(confirmDuplicate) {
    const f = $("f");
    const msg = $("msg");
    msg.innerHTML = "";
    const v = (n) => (f.elements[n] ? f.elements[n].value.trim() : "");
    const sev = f.querySelector("input[name=severity]:checked");
    const miss = [];
    if (!v("contactName")) miss.push("contact name");
    if (!v("phone")) miss.push("call-back number");
    if (!v("product")) miss.push("affected system");
    if (!sev) miss.push("urgency");
    if (!v("subject")) miss.push("subject");
    if (!v("detail")) miss.push("details");
    if (miss.length) {
      msg.innerHTML = `<div class="err" role="alert">Please fill in: ${esc(miss.join(", "))}</div>`;
      return;
    }
    if (!f.consent.checked) {
      msg.innerHTML = `<div class="err" role="alert">Please tick the consent box.</div>`;
      return;
    }
    if (files.some((x) => !x.id && !x.error)) {
      msg.innerHTML = `<div class="err" role="alert">Please wait until the files finish uploading.</div>`;
      return;
    }
    const btn = $("send");
    btn.disabled = true;
    btn.textContent = "Sending…";
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
      btn.textContent = "Send case";
      if (e.body && e.body.code === "DUPLICATE") {
        msg.innerHTML = `<div class="dup" role="alert"><span>${esc(e.message)}</span><div><button class="btn" type="button" id="dupok">Send as a new case</button></div></div>`;
        $("dupok").onclick = () => send(true);
        return;
      }
      if (e.status === 410 || e.status === 404) return fail(e.message);
      msg.innerHTML = `<div class="err" role="alert">${esc(e.message)}</div>`;
    }
  }

  function hotlineBox(r) {
    if (!r.afterHours) return "";
    const lines = (r.hotline && r.hotline.lines) || [];
    return `<div class="hot"><strong>We are currently outside business hours (${esc(r.hours.end)}–${esc(r.hours.start)})</strong><br>
Non-urgent case: an engineer will contact you the next day.${lines.length ? `<br>Urgent case: please call the hotline in this order. If nobody answers within ${r.hotline.waitMinutes} minutes, call the next number.
<table>${lines.map((l, n) => `<tr><td>${["1st", "2nd", "3rd"][n]}</td><td><a class="n" href="tel:${esc(l.phone.replace(/[^+0-9]/g, ""))}">${esc(l.phone)}</a></td><td>${esc(l.label)}</td></tr>`).join("")}</table>
Please quote ${esc(r.reqNo)} when you call.` : ""}</div>`;
  }

  function success(r) {
    $("exp").textContent = "";
    window.scrollTo(0, 0);
    const via = r.channel === "line" ? "a LINE message" : r.contactEmail ? "an email at " + esc(r.contactEmail) : "a call";
    app.innerHTML = `<div class="center"><div class="okmark"><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#1C6B45" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>We have received your case</h1><p class="lead" style="margin:0">Our team has been notified. When an engineer takes the case you will receive ${via} with the engineer's name.</p></div>
<div class="reqno"><span>Your reference number</span><strong>${esc(r.reqNo)}</strong><span class="hint">Please quote it whenever you contact us</span></div>
${hotlineBox(r)}
<dl class="sum">
<div><dt>Company</dt><dd>${esc(r.site || r.customerText || "-")}</dd></div>
<div><dt>Contact</dt><dd>${esc(r.contactName)} · ${esc(r.contactPhone)}</dd></div>
<div><dt>System / urgency</dt><dd>${esc(r.product)} · <span style="color:${SEV_COLOR[r.severity]}">${esc(SEV_TH[r.severity] || r.severity)}</span></dd></div>
<div><dt>Reported</dt><dd>${esc(when(r.createdAt))}</dd></div>
<div class="full"><dt>Subject</dt><dd>${esc(r.subject)}</dd></div></dl>
<section><h2 style="border:0;padding:0">What happens next</h2><ol class="next">
<li><span class="n">1</span><span><strong>Our team takes the case</strong> and assigns an engineer. You will receive ${r.channel === "line" ? "a LINE message" : "an email"}.</span></li>
<li><span class="n">2</span><span><strong>The engineer contacts you</strong> for more information or remote access if needed.</span></li>
<li><span class="n">3</span><span><strong>We let you know</strong> when it is fixed and the case is closed.</span></li></ol></section>
${r.updateUrl ? `<p style="text-align:center;margin:0"><a class="btn" href="${esc(r.updateUrl)}">Add more details or screenshots later</a></p>` : ""}
<p class="hint" style="text-align:center;margin:0">You can close this page.${r.channel === "line" ? " To report something new, tap “Report a case” in LINE again." : ""}</p>`;
  }

  (async function boot() {
    try {
      info = await call("");
      company(info.company);
      render();
    } catch (e) {
      if (e.body) company(e.body.company);
      fail(e.message);
    }
  })();
})();
