/* "Add details" page for a customer request (/u/<token>). Plain JS, English, no build step. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  const API = "/api/public/update/" + encodeURIComponent(token);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const when = (iso) => {
    const t = new Date(iso);
    return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}, ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  let info = null;
  let files = [];

  async function call(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { "X-Requested-With": "fetch", ...(opts.headers || {}) } });
    let body = {};
    try {
      body = await res.json();
    } catch (e) {}
    if (!res.ok) throw Object.assign(new Error(body.error || "Something went wrong. Please try again."), { body, status: res.status });
    return body;
  }

  function company(c) {
    if (!c) return;
    $("foot").innerHTML = `${esc(c.legalName || c.name)} · Support${c.url ? ` · <a href="${esc(c.url)}" rel="noopener">${esc(c.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : ""}<br>This link is for your case only. Please do not forward it. The details you send are used only for this case.`;
  }
  function fail(msg) {
    app.innerHTML = `<div class="center"><h1>This page cannot be opened</h1><p class="lead">${esc(msg)}</p><p class="hint">You can still reply to the email from Sinostech Support and we will receive it.</p></div>`;
  }
  function hotlineBox() {
    if (!info.afterHours) return "";
    const lines = (info.hotline && info.hotline.lines) || [];
    return `<div class="hot"><strong>We are currently outside business hours (${esc(info.hours.end)}–${esc(info.hours.start)})</strong><br>
Non-urgent case: an engineer will contact you the next day.${lines.length ? `<br>Urgent case: please call the hotline in this order. If nobody answers within ${info.hotline.waitMinutes} minutes, call the next number.
<table>${lines.map((l, n) => `<tr><td>${["1st", "2nd", "3rd"][n]}</td><td><a class="n" href="tel:${esc(l.phone.replace(/[^+0-9]/g, ""))}">${esc(l.phone)}</a></td><td>${esc(l.label)}</td></tr>`).join("")}</table>
Please quote ${esc(info.reqNo)} when you call.` : ""}</div>`;
  }

  function render() {
    files = [];
    const sev = info.severities;
    app.innerHTML = `
<div><h1>Add details to ${esc(info.reqNo)}</h1>
<p class="lead">Everything is optional. Add what you know — it goes straight into your case${info.claimed ? " and the engineer is notified" : ""}.</p></div>
${info.test ? `<div class="test">Test link: this case is for testing only.</div>` : ""}
<div class="cust"><div><strong>${esc(info.subject)}</strong><br><span style="color:var(--muted)">${esc(info.customer)}${info.reportedBy ? ` · reported by ${esc(info.reportedBy)}` : ""} · ${when(info.createdAt)}${info.caseNo ? ` · case ${esc(info.caseNo)}` : ""}</span></div></div>
${hotlineBox()}
<form id="f" novalidate>
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<section><h2>Contact</h2><div class="grid">
<div class="f"><label for="contactName">Contact name</label><input id="contactName" name="contactName" value="${esc(info.current.contactName)}" autocomplete="name"><div class="hint">Who should the engineer talk to?</div></div>
<div class="f"><label for="phone">Call-back number</label><input id="phone" name="phone" type="tel" value="${esc(info.current.phone)}" placeholder="e.g. 081-234-5678" autocomplete="tel"><div class="hint">A number we can reach you on today</div></div>
</div></section>
<section><h2>The problem</h2><div class="grid">
<div class="f"><label for="product">Affected system</label><select id="product" name="product"><option value="">Not sure</option>${info.products.map((p) => `<option ${p === info.current.product ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
<div class="f"><label for="startedText">Started at</label><input id="startedText" name="startedText" placeholder="e.g. today 08:30"></div>
<div class="f"><label for="affected">Users affected</label><input id="affected" name="affected" placeholder="e.g. about 20 agents"></div>
</div>
<div class="f"><span class="lbl">Urgency</span><div class="sev">${sev.map((x) => `<label><span class="t"><input type="radio" name="severity" value="${esc(x.value)}">${esc(x.label)}</span><span class="d">${esc(x.hint)}</span></label>`).join("")}</div>
<div class="hint">Our engineer confirms the final priority.</div></div>
<div class="f"><label for="detail">More details</label><textarea id="detail" name="detail" rows="4" placeholder="What did you try? Any error message? Anything that changed recently?"></textarea></div>
</section>
<section><h2>Screenshots and files</h2>
<label class="drop" id="drop" tabindex="0"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
<span>Drag images here, choose files, or paste a screenshot (Ctrl+V)</span><input type="file" id="file" multiple hidden accept="${info.attachments.ext.map((e) => "." + e).join(",")}"></label>
<div class="hint">Up to ${info.attachments.maxFiles} files, ${info.attachments.maxMb} MB each · ${info.attachments.ext.join(", ")}</div>
<div class="thumbs" id="thumbs"></div></section>
<div id="msg"></div>
<div class="foot"><span class="hint">You can also reply to our email — it goes to the same case.</span><button class="btn primary" type="submit" id="send">Send details</button></div>
</form>`;
    bind();
  }

  function drawThumbs() {
    $("thumbs").innerHTML = files
      .map((x, n) => `<div class="thumb">${x.url ? `<img src="${x.url}" alt="">` : `<div class="ph">${x.error ? "✕" : x.id ? esc((x.name.split(".").pop() || "").toUpperCase()) : "Uploading…"}</div>`}
<div class="nm" title="${esc(x.error || x.name)}" style="${x.error ? "color:#A5162E" : ""}">${esc(x.error || x.name)}</div><button type="button" data-rm="${n}" aria-label="Remove ${esc(x.name)}">×</button></div>`)
      .join("");
    $("thumbs").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => {
      const x = files[Number(b.dataset.rm)];
      files.splice(Number(b.dataset.rm), 1);
      if (x.id) call("/files/" + x.id, { method: "DELETE" }).catch(() => {});
      drawThumbs();
    }));
  }
  async function add(list) {
    for (const file of list) {
      if (files.filter((x) => !x.error).length >= info.attachments.maxFiles) break;
      const item = { name: file.name || "screenshot.png", url: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
      files.push(item);
      drawThumbs();
      try {
        const r = await call("/files", { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(item.name) } });
        item.id = r.file.id;
      } catch (e) {
        item.error = e.message;
      }
      drawThumbs();
    }
  }

  function bind() {
    const drop = $("drop");
    const input = $("file");
    input.onchange = () => add([...input.files]).then(() => (input.value = ""));
    drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click());
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over"))));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove("over"))));
    drop.addEventListener("drop", (e) => add([...e.dataTransfer.files]));
    document.onpaste = (e) => {
      const imgs = [...(e.clipboardData || {}).items || []].filter((x) => x.kind === "file").map((x) => x.getAsFile()).filter(Boolean);
      if (imgs.length) {
        e.preventDefault();
        add(imgs.map((f, n) => new File([f], f.name && f.name !== "image.png" ? f.name : `screenshot-${Date.now()}${n ? "-" + n : ""}.png`, { type: f.type || "image/png" })));
      }
    };
    $("f").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (files.some((x) => !x.id && !x.error)) return ($("msg").innerHTML = `<div class="err">Please wait until the files finish uploading.</div>`);
      const btn = $("send");
      btn.disabled = true;
      $("msg").innerHTML = "";
      try {
        const r = await call("", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            website: f.website.value, contactName: f.contactName.value, phone: f.phone.value, product: f.product.value, startedText: f.startedText.value,
            affected: f.affected.value, detail: f.detail.value, severity: (f.querySelector("input[name=severity]:checked") || {}).value || "", files: files.filter((x) => x.id).map((x) => x.id),
          }),
        });
        done(r);
      } catch (err) {
        $("msg").innerHTML = `<div class="err">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  }

  function done(r) {
    document.onpaste = null;
    app.innerHTML = `<div class="center"><div class="okmark"><svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10" fill="none" stroke="#1C6B45" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>Thank you — details received</h1>
<p class="lead">Added to <strong style="font-family:ui-monospace,Consolas,monospace;color:var(--accent)">${esc(r.caseNo || r.reqNo)}</strong>${r.files ? ` with ${r.files} file${r.files > 1 ? "s" : ""}` : ""}. ${info.claimed ? "Your engineer has been notified." : "The support team can see it now."}</p>
${hotlineBox()}
<button class="btn" type="button" id="more">Add more details</button>
<p class="hint">This link keeps working while your case is open.</p></div>`;
    $("more").onclick = () => load();
  }

  async function load() {
    try {
      info = await call("");
      company(info.company);
      render();
    } catch (e) {
      company(e.body && e.body.company);
      fail(e.message);
    }
  }
  load();
})();
