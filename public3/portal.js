// Sino S-Tech Customer Portal (English only). Customer accounts, separate from staff sign-in.
(() => {
  const $app = document.getElementById("app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fdt = (v) => (v ? new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");
  const fd = (v) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "-");
  let ME = null;

  async function api(path, opts = {}) {
    const res = await fetch("/api/portal" + path, {
      credentials: "same-origin", ...opts,
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(body.error || "Something went wrong. Please try again.");
      e.code = body.code; e.status = res.status;
      if (body.code === "LOGIN" && path !== "/me") { ME = null; viewLogin(); }
      if (body.code === "CHANGE_PASSWORD") { viewPassword(); }
      throw e;
    }
    return body;
  }
  const post = (p, body) => api(p, { method: "POST", body: body || {} });
  function toast(t) {
    const d = Object.assign(document.createElement("div"), { className: "toast", textContent: t });
    document.body.appendChild(d); setTimeout(() => d.remove(), 3500);
  }
  const logo = `<img class="logo" src="/sinostech-logo.png" alt="Sino S-Tech">`;
  const footer = `<footer>Sino S-Tech Limited · Customer Support Portal · For urgent issues outside business hours, please call our hotline.</footer>`;

  function shell(active, inner) {
    $app.innerHTML = `<header class="top"><div class="wrap">${logo}<nav><a href="#/cases" class="${active === "cases" ? "on" : ""}">Our cases</a><a href="#/new" class="${active === "new" ? "on" : ""}">Report a case</a><a href="#/password" class="${active === "password" ? "on" : ""}">Change password</a></nav>
<div class="who"><span class="pill">${esc(ME.company)} · ${esc(ME.username)}</span><a href="#" id="out">Sign out</a></div></div></header>
<main class="wrap">${ME.warnExpiry ? `<div class="warn">Your password expires in ${ME.expiresInDays} day${ME.expiresInDays > 1 ? "s" : ""}. <a href="#/password">Change it now</a>.</div>` : ""}${inner}</main>${footer}`;
    document.getElementById("out").onclick = async (e) => { e.preventDefault(); await post("/logout").catch(() => {}); ME = null; location.hash = ""; viewLogin(); };
  }

  // ------------------------------------------------------------ sign in
  function viewLogin(msg) {
    $app.innerHTML = `<div class="center"><div class="box card">${logo}
<h1 style="margin-top:20px">Customer Support Portal</h1><p class="muted" style="margin:0">Report and track your cases with Sino S-Tech.</p>
<form id="lf"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<div id="lerr" ${msg ? "" : "hidden"} class="err">${esc(msg || "")}</div>
<button class="btn primary block">Sign in</button></form>
<p class="muted small" style="margin:18px 0 0">Forgot your password or locked out? Please contact your Sino S-Tech account team to reset it. After 5 incorrect attempts the account is locked for 15 minutes.</p></div></div>`;
    document.getElementById("lf").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, err = document.getElementById("lerr"), b = f.querySelector("button");
      b.disabled = true; err.hidden = true;
      try {
        const r = await post("/login", { username: f.username.value, password: f.password.value });
        ME = r.me;
        if (ME.mustChange) viewPassword(); else { location.hash = "#/cases"; route(); }
      } catch (x) { err.textContent = x.message; err.hidden = false; f.password.value = ""; }
      b.disabled = false;
    };
  }

  // ------------------------------------------------------------ password (forced at first sign-in and every 90 days)
  function viewPassword() {
    const forced = ME && ME.mustChange;
    const inner = `<div class="box card" style="margin:0 auto">${forced ? logo : ""}
<h1 style="margin-top:${forced ? 20 : 0}px">${forced ? "Set a new password" : "Change password"}</h1>
<p class="muted" style="margin:0">${forced ? (ME.firstLogin ? "Your initial password works only once. Please set your own password to continue." : "Your password has expired. Please set a new one to continue.") : "Your password expires every 90 days."}</p>
<form id="pf"><label for="c">Current password</label><input id="c" name="current" type="password" autocomplete="current-password" required>
<label for="n">New password</label><input id="n" name="password" type="password" autocomplete="new-password" required>
<ul class="rules" id="rules"></ul>
<label for="n2">Confirm new password</label><input id="n2" name="confirm" type="password" autocomplete="new-password" required>
<div id="perr" hidden class="err"></div>
<button class="btn primary block" id="pb" disabled>Save password</button></form>
${forced ? `<p class="small" style="margin:16px 0 0"><a href="#" id="out2">Sign out</a></p>` : ""}</div>`;
    if (forced) $app.innerHTML = `<div class="center">${inner}</div>`; else shell("password", inner);
    const f = document.getElementById("pf");
    const user = (ME.username || "").toLowerCase(), comp = (ME.company || "").toLowerCase();
    const parts = [user, comp, ...user.split(/[._@-]/)].filter((w) => w.length >= 3);
    const check = () => {
      const p = f.password.value;
      const rules = [
        ["At least 12 characters", p.length >= 12],
        ["An uppercase and a lowercase letter", /[A-Z]/.test(p) && /[a-z]/.test(p)],
        ["A number", /[0-9]/.test(p)],
        ["A special character, e.g. ! @ # $", /[^A-Za-z0-9]/.test(p)],
        ["Does not contain your username or company name", p && !parts.some((w) => p.toLowerCase().includes(w))],
        ["Passwords match", p && p === f.confirm.value],
      ];
      document.getElementById("rules").innerHTML = rules.map(([t, ok]) => `<li class="${p ? (ok ? "ok" : "no") : ""}">${p ? (ok ? "✓" : "✗") : "•"} ${t}</li>`).join("") + `<li>• Not one of your last 5 passwords</li>`;
      document.getElementById("pb").disabled = !rules.every((r) => r[1]);
    };
    f.password.oninput = check; f.confirm.oninput = check; check();
    const o2 = document.getElementById("out2");
    if (o2) o2.onclick = async (e) => { e.preventDefault(); await post("/logout").catch(() => {}); ME = null; viewLogin(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = document.getElementById("perr");
      err.hidden = true;
      try {
        const r = await post("/password", { current: f.current.value, password: f.password.value, confirm: f.confirm.value });
        ME = r.me; toast("Password changed."); location.hash = "#/cases"; route();
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    };
  }

  // ------------------------------------------------------------ cases
  const stChip = (c) => `<span class="st st-${c.statusKey}">${esc(c.status)}</span>`;
  async function viewCases() {
    shell("cases", `<div class="muted">Loading…</div>`);
    const d = await api("/cases");
    const main = $app.querySelector("main");
    main.innerHTML = `${ME.warnExpiry ? `<div class="warn">Your password expires in ${ME.expiresInDays} day${ME.expiresInDays > 1 ? "s" : ""}. <a href="#/password">Change it now</a>.</div>` : ""}
<div class="head"><h1>Cases for ${esc(d.company)}</h1><a class="btn primary" href="#/new">+ Report a case</a></div>
<div class="filters"><input id="q" type="search" placeholder="Search by case number or subject"><select id="s"><option value="">All statuses</option><option value="open">Open cases</option>
<option value="received">Received</option><option value="progress">In progress</option><option value="waiting">Awaiting information</option><option value="resolved">Resolved – awaiting confirmation</option><option value="closed">Closed</option></select></div>
<div class="tablewrap"><table><thead><tr><th>Case number</th><th>Subject</th><th>Reported via</th><th>Status</th><th>Last update</th></tr></thead><tbody id="tb"></tbody></table></div>
<p class="muted small">Showing cases your company reported to Sino S-Tech by email, web form or this portal.</p>`;
    const draw = () => {
      const q = document.getElementById("q").value.trim().toLowerCase(), s = document.getElementById("s").value;
      const rows = d.cases.filter((c) => (!q || `${c.ref} ${c.reqNo} ${c.subject}`.toLowerCase().includes(q)) && (!s || (s === "open" ? c.statusKey !== "closed" : c.statusKey === s)));
      document.getElementById("tb").innerHTML = rows.length ? rows.map((c) => `<tr class="click" data-id="${c.id}"><td><a class="mono" href="#/case/${c.id}">${esc(c.ref)}</a>${c.caseNo ? `<div class="muted small">${esc(c.reqNo)}</div>` : ""}</td><td>${esc(c.subject)}</td><td class="muted">${esc(c.channel)}</td><td>${stChip(c)}</td><td>${fdt(c.updatedAt)}</td></tr>`).join("")
        : `<tr><td colspan="5" class="empty">${d.cases.length ? "No cases match your search." : "No cases yet. Use “Report a case” to tell us about an issue."}</td></tr>`;
      document.querySelectorAll("tr.click").forEach((tr) => (tr.onclick = (e) => { if (e.target.tagName !== "A") location.hash = `#/case/${tr.dataset.id}`; }));
    };
    document.getElementById("q").oninput = draw; document.getElementById("s").onchange = draw; draw();
  }

  async function viewCase(id) {
    shell("cases", `<div class="muted">Loading…</div>`);
    const d = await api(`/cases/${id}`);
    const c = d.case;
    const labels = ["Received", "In progress", "Resolved", "Closed"];
    const main = $app.querySelector("main");
    main.innerHTML = `<p class="small"><a href="#/cases">← Back to our cases</a></p>
<div class="grid"><div>
<div class="card"><div class="mono" style="color:var(--accent)">${esc(c.ref)}</div><h1 style="margin:6px 0">${esc(c.subject)}</h1>
<p class="muted small" style="margin:0">Reported ${fdt(c.createdAt)} via ${esc(c.channel)} by ${esc(c.reportedBy || "-")} · Handled by Sino S-Tech Support</p>
<div class="steps">${labels.map((l, i) => `<div class="stp ${i + 1 < c.step ? "d" : i + 1 === c.step ? (c.statusKey === "closed" ? "d" : "c") : ""}"><i>${i + 1 < c.step || (i + 1 === c.step && c.statusKey === "closed") ? "✓" : i + 1}</i>${l}</div>`).join("")}</div>
<p style="text-align:center;margin:8px 0 0">${stChip(c)}</p></div>
<div class="card" style="margin-top:20px"><h2>Updates</h2>
${d.updates.map((u) => `<div class="up ${u.mine ? "mine" : u.system ? "sys" : ""}">${esc(u.text)}<small>${esc(u.from)} · ${fdt(u.at)}</small></div>`).join("")}
${c.canReply ? `<form id="rf"><label for="rt">Reply to the support team</label><textarea id="rt" rows="3" maxlength="3000" placeholder="Add information or answer a question from our team" required></textarea><div style="margin-top:10px"><button class="btn primary">Send</button></div></form>`
      : c.statusKey === "closed" ? `<p class="muted small">This case is closed. If the issue comes back, please <a href="#/new">report a new case</a>.</p>` : `<p class="muted small">You can reply here once an engineer has been assigned and you have a case number.</p>`}</div></div>
<div class="card" style="align-self:start"><h2>Details</h2><dl class="meta"><dt>Case number</dt><dd class="mono">${esc(c.caseNo || "Not assigned yet")}</dd><dt>Request</dt><dd class="mono">${esc(c.reqNo)}</dd>
<dt>System</dt><dd>${esc(c.product || "-")}</dd><dt>Urgency</dt><dd>${esc(c.severity || "-")}</dd><dt>Status</dt><dd>${esc(c.status)}</dd><dt>Last update</dt><dd>${fdt(c.updatedAt)}</dd></dl>
<h2 style="margin-top:20px">What you reported</h2><p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:0">${esc(c.detail || "")}</p></div></div>`;
    const rf = document.getElementById("rf");
    if (rf) rf.onsubmit = async (e) => {
      e.preventDefault();
      try { await post(`/cases/${id}/reply`, { text: document.getElementById("rt").value }); toast("Message sent to the support team."); viewCase(id); } catch (x) { toast(x.message); }
    };
  }

  async function viewNew() {
    shell("new", `<div class="muted">Loading…</div>`);
    const d = await api("/form");
    const main = $app.querySelector("main");
    main.innerHTML = `<div class="card" style="max-width:760px;margin:0 auto"><h1>Report a case</h1><p class="muted" style="margin:0">You get a request number right away, and an email confirmation like a case reported by email.</p>
<form id="nf"><label for="sj">Subject</label><input id="sj" name="subject" maxlength="150" required placeholder="e.g. Agents cannot log in after the update">
<label for="pr">Affected system</label><select id="pr" name="product" required><option value="">Choose…</option>${d.products.map((p) => `<option>${esc(p)}</option>`).join("")}</select>
<label for="sv">Urgency</label><select id="sv" name="severity" required><option value="">Choose…</option>${d.severities.map((s) => `<option value="${esc(s.value)}">${esc(s.label)} — ${esc(s.hint)}</option>`).join("")}</select>
<label for="dt">Details</label><textarea id="dt" name="detail" rows="6" maxlength="5000" required placeholder="What happened, when it started, how many users are affected, any error message"></textarea>
<label for="st">When did it start? (optional)</label><input id="st" name="startedText" maxlength="120" placeholder="e.g. Today 09:00">
<label for="rf2">Your reference number (optional)</label><input id="rf2" name="customerRef" maxlength="120">
<h2 style="margin-top:24px">Contact for this case</h2>
<label for="cn">Name</label><input id="cn" name="contactName" required value="${esc(d.contact.name)}">
<label for="em">Email</label><input id="em" name="email" type="email" required value="${esc(d.contact.email)}">
<label for="ph">Call-back number</label><input id="ph" name="phone" required value="${esc(d.contact.phone)}">
<div id="nerr" hidden class="err"></div>
<button class="btn primary block">Submit case</button></form></div>`;
    const f = document.getElementById("nf");
    const send = async (confirmDuplicate) => {
      const err = document.getElementById("nerr"), b = f.querySelector("button.block");
      err.hidden = true; b.disabled = true;
      const body = Object.fromEntries(["subject", "product", "severity", "detail", "startedText", "customerRef", "contactName", "email", "phone"].map((k) => [k, f[k].value]));
      try {
        const r = await post("/cases", { ...body, confirmDuplicate });
        main.innerHTML = `<div class="card" style="max-width:640px;margin:0 auto;text-align:center"><h1>Thank you. We received your case.</h1>
<p>Your request number is <span class="mono" style="font-size:20px">${esc(r.reqNo)}</span></p>
<p class="muted">We sent a confirmation to your email. An engineer will contact you, and you can follow the case here.${r.afterHours ? " It is outside business hours now: for urgent issues please call our hotline." : ""}</p>
<p><a class="btn primary" href="#/case/${r.id}">View the case</a> <a class="btn" href="#/cases">Back to our cases</a></p></div>`;
      } catch (x) {
        if (x.status === 409 && !confirmDuplicate && confirm(`${x.message}\n\nSend as a new case anyway?`)) return send(true);
        err.textContent = x.message; err.hidden = false; b.disabled = false;
      }
    };
    f.onsubmit = (e) => { e.preventDefault(); send(false); };
  }

  // ------------------------------------------------------------ router
  async function route() {
    if (!ME) {
      try { ME = (await api("/me")).me; } catch (e) { return viewLogin(); }
    }
    if (ME.mustChange) return viewPassword();
    const h = location.hash.replace(/^#\/?/, "");
    try {
      if (h.startsWith("case/")) return await viewCase(Number(h.split("/")[1]));
      if (h === "new") return await viewNew();
      if (h === "password") return viewPassword();
      return await viewCases();
    } catch (e) {
      if (e.code !== "LOGIN" && e.code !== "CHANGE_PASSWORD") shell("cases", `<div class="card"><div class="err">${esc(e.message)}</div><p><a href="#/cases">Back to our cases</a></p></div>`);
    }
  }
  window.addEventListener("hashchange", route);
  route();
})();
