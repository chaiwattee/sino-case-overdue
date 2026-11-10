// Display language TH / EN. The app is written in Thai; in English mode every Thai phrase the app itself wrote is swapped
// for its English text from i18n-en.json as the page renders (a MutationObserver), so views need no changes.
// Data people typed (customer names, case notes) stays as typed. Switching language reloads the page.
(function () {
  "use strict";
  const KEY = "case-lang";
  let lang = "th";
  try {
    lang = localStorage.getItem(KEY) === "en" ? "en" : "th";
  } catch (e) {}
  const TH = "฀-๿";
  const hasThai = new RegExp(`[${TH}]`);
  let dict = null;
  let re = null;
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE"]);

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function build(d) {
    dict = d;
    const keys = Object.keys(d).filter((k) => d[k]).sort((a, b) => b.length - a.length);
    // A phrase is replaced only when it is not part of a longer Thai word (Thai has no spaces between words).
    re = keys.length ? new RegExp(`(?<![${TH}])(?:${keys.map(esc).join("|")})(?![${TH}])`, "g") : null;
  }
  const tr = (s) => (re && hasThai.test(s) ? s.replace(re, (m) => dict[m]) : s);
  // An <option> without a value submits its text: keep the original Thai as its value before translating the label.
  const keepValue = (t) => {
    const p = t.parentNode;
    if (p && p.nodeName === "OPTION" && !p.hasAttribute("value")) p.setAttribute("value", p.textContent);
  };

  function walk(root) {
    if (!re || !root) return;
    if (root.nodeType === 3) {
      const pe = root.parentElement;
      if (hasThai.test(root.nodeValue) && !(pe && (SKIP.has(pe.nodeName) || pe.closest("[data-no-i18n]")))) {
        const v = tr(root.nodeValue);
        if (v !== root.nodeValue) {
          keepValue(root);
          root.nodeValue = v;
        }
      }
      return;
    }
    if (root.nodeType !== 1 || SKIP.has(root.nodeName) || (root.closest && root.closest("[data-no-i18n]"))) return;
    for (const a of ATTRS) {
      const v = root.getAttribute && root.getAttribute(a);
      if (v && hasThai.test(v)) {
        const t = tr(v);
        if (t !== v) root.setAttribute(a, t);
      }
    }
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.nodeName) || n.hasAttribute("data-no-i18n")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) {
        if (hasThai.test(n.nodeValue)) {
          const v = tr(n.nodeValue);
          if (v !== n.nodeValue) {
            keepValue(n);
            n.nodeValue = v;
          }
        }
      } else {
        for (const a of ATTRS) {
          const v = n.getAttribute(a);
          if (v && hasThai.test(v)) {
            const t = tr(v);
            if (t !== v) n.setAttribute(a, t);
          }
        }
      }
    }
  }

  async function start() {
    document.documentElement.lang = "en";
    try {
      const r = await fetch("i18n-en.json?v=3.14.1", { credentials: "same-origin" });
      build(await r.json());
    } catch (e) {
      return;
    }
    walk(document.body);
    if (hasThai.test(document.title)) document.title = tr(document.title);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") walk(m.target);
        else if (m.type === "attributes") walk(m.target);
        else m.addedNodes.forEach((x) => walk(x));
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  window.I18N = {
    get lang() {
      return lang;
    },
    t: (s) => (lang === "en" ? tr(String(s)) : String(s)),
    /** Remember the choice (here and, when signed in, on the account) and reload in that language. */
    async set(l, { save } = {}) {
      l = l === "en" ? "en" : "th";
      try {
        localStorage.setItem(KEY, l);
      } catch (e) {}
      if (save) await save(l).catch(() => {});
      location.reload();
    },
    /** The account's language wins over this browser's (signed in on another device). */
    sync(l) {
      if ((l === "en" ? "en" : "th") === lang) return false;
      try {
        localStorage.setItem(KEY, l);
      } catch (e) {}
      location.reload();
      return true;
    },
  };
  if (lang === "en") {
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  }
})();
