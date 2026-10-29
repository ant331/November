const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sb = supabase.createClient(RTV.url, RTV.key, { auth: { persistSession: true, autoRefreshToken: true } });
const never = () => new Promise(() => {});
const say = (el, t, ok) => { el.hidden = !t; el.className = "msg " + (ok ? "ok" : "bad"); el.textContent = t || ""; };

// Page access by role (UX guard only - the real protection is row-level security in the database).
//  ROLE_PAGES: a role listed here may open ONLY these pages.
//  PAGE_ROLES: a page listed here may be opened ONLY by these roles.
//  ROLE_HOME : where a role is sent when it opens a page it is not allowed to see.
const ROLE_PAGES = { field_supervisor: ["field_supervisors"] };
const PAGE_ROLES = {
  field_supervisors: ["admin", "operator", "field_supervisor"],
  request:  ["admin", "operator"],   // operators ask for items
  requests: ["admin", "operator"]    // admins approve / reject, operators follow their districts
};
const ROLE_HOME  = { field_supervisor: "field_supervisors.html" };
const NAV = [
  ["dashboard", "Dashboard"],
  ["Transfers", [["transfer", "Transfer Form"], ["request", "Request Items"], ["requests", "Item Requests"]]],
  ["movements", "Movement Log"],
  ["assets", "Assets"],
  ["field_supervisors", "Asset Allocation"]
];

// Header dropdowns (click to open; closes on outside click, Escape, scroll or resize).
// The menu is position:fixed so it is never clipped by the header, whatever style.css does.
let ddReady = false;
function wireDropdowns() {
  if (!$("#dd-css")) {
    const st = document.createElement("style");
    st.id = "dd-css";
    st.textContent =
      "#nav .dd{display:inline-block}" +
      "#nav .dd-toggle{cursor:pointer}" +
      "#nav .dd-menu{position:fixed;z-index:1000;min-width:190px;padding:6px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 30px rgba(15,23,42,.18)}" +
      "#nav .dd-menu[hidden]{display:none}" +
      "#nav .dd-menu a{display:block;padding:9px 12px;border:0;border-radius:7px;background:transparent;color:#0f172a;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap}" +
      "#nav .dd-menu a:hover,#nav .dd-menu a:focus-visible{background:#eef2fb;color:#2E5299;outline:none}" +
      "#nav .dd-menu a.on{background:#f1f5f9;color:#2E5299;font-weight:600}" +
      "#nav .dd-toggle:focus-visible{outline:2px solid #fff;outline-offset:2px}";
    document.head.appendChild(st);
  }
  const closeAll = () => document.querySelectorAll("#nav .dd").forEach(d => {
    d.querySelector(".dd-menu").hidden = true;
    d.querySelector(".dd-toggle").setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll("#nav .dd").forEach(d => {
    const t = d.querySelector(".dd-toggle"), m = d.querySelector(".dd-menu");
    const open = () => {
      closeAll();
      m.hidden = false;
      const r = t.getBoundingClientRect();
      m.style.top = (r.bottom + 6) + "px";
      m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + "px";
      t.setAttribute("aria-expanded", "true");
    };
    t.onclick = e => { e.preventDefault(); m.hidden ? open() : closeAll(); };
    t.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); open(); m.querySelector("a").focus(); } };
    m.onkeydown = e => { if (e.key === "Escape") { closeAll(); t.focus(); } };
  });
  if (!ddReady) {
    ddReady = true;
    document.addEventListener("click", e => { if (!e.target.closest("#nav .dd")) closeAll(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeAll(); });
    addEventListener("resize", closeAll);
    addEventListener("scroll", closeAll, { passive: true });
  }
}

// Auth guard + header. Resolves {email, role}; redirects to the sign-in page when not allowed.
async function guard(page) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace("index.html"); return never(); }
  const { data: role, error } = await sb.rpc("app_role");
  if (error) { say($("#msg"), "Could not verify your access: " + error.message); return never(); }
  if (!role) { await sb.auth.signOut(); location.replace("index.html?denied=1"); return never(); }
  const only = ROLE_PAGES[role];
  if ((only && !only.includes(page)) || (PAGE_ROLES[page] && !PAGE_ROLES[page].includes(role))) {
    location.replace(ROLE_HOME[role] || "dashboard.html"); return never();
  }
  const can = p => only ? only.includes(p) : (!PAGE_ROLES[p] || PAGE_ROLES[p].includes(role));
  const link = (p, l) => `<a href="${p}.html"${p === page ? ' class="on"' : ""}>${esc(l)}</a>`;
  const menu = NAV.map(([a, b]) => {
    if (!Array.isArray(b)) return can(a) ? link(a, b) : "";
    const kids = b.filter(([p]) => can(p));
    if (!kids.length) return "";
    if (kids.length === 1) return link(kids[0][0], kids[0][1]);
    return `<div class="dd"><a href="#" class="dd-toggle${kids.some(([p]) => p === page) ? " on" : ""}" aria-haspopup="true" aria-expanded="false">${esc(a)} <span aria-hidden="true">▾</span></a>` +
      `<div class="dd-menu" role="menu" hidden>${kids.map(([p, l]) => link(p, l).replace("<a ", '<a role="menuitem" ')).join("")}</div></div>`;
  }).join("");
  $("#nav").innerHTML = `<img src="img/logo.png" alt="Raising The Village"><nav>${menu}</nav>` +
    `<span class="who">${esc(session.user.email)} · ${esc(role)}<button class="ghost" id="out">Sign out</button></span>`;
  wireDropdowns();
  $("#out").onclick = async () => { await sb.auth.signOut(); location.replace("index.html"); };
  return { email: session.user.email, role };
}

// Fetch every row (PostgREST returns max 1000 per request, so page through).
async function all(table, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select("*");
    for (const [c, asc] of order) q = q.order(c, { ascending: asc });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000 || out.length >= 50000) return out;
  }
}

function csv(cols, rows, name) {
  const c = v => { v = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const t = [cols.map(x => c(x[1])).join(","), ...rows.map(r => cols.map(x => c(r[x[0]])).join(","))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + t], { type: "text/csv" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

// Read-only table with search, dropdown filters, paging and CSV export.
// o = { rows, cols:[[key,label,fmt?]], sel:[[key,label]], file }
function view(o) {
  let p = 0, F = [];
  const N = 50, q = $("#q");
  const S = o.sel.map(([k, l]) => {
    const s = $("#f_" + k);
    s.innerHTML = `<option value="">${esc(l)}: all</option>` + [...new Set(o.rows.map(r => r[k]).filter(Boolean))].sort().map(v => `<option>${esc(v)}</option>`).join("");
    s.onchange = () => { p = 0; draw(); };
    return [k, s];
  });
  function draw() {
    const t = q.value.trim().toLowerCase();
    F = o.rows.filter(r => S.every(([k, s]) => !s.value || r[k] === s.value) && (!t || o.cols.some(([k]) => String(r[k] ?? "").toLowerCase().includes(t))));
    const n = F.length, pages = Math.max(1, Math.ceil(n / N));
    p = Math.min(p, pages - 1);
    $("#tbl").innerHTML = `<thead><tr>${o.cols.map(c => `<th>${esc(c[1])}</th>`).join("")}</tr></thead><tbody>` +
      (F.slice(p * N, p * N + N).map(r => `<tr>${o.cols.map(([k, , f]) => `<td>${f ? f(r[k], r) : esc(r[k])}</td>`).join("")}</tr>`).join("") ||
       `<tr><td colspan="${o.cols.length}" class="empty">No matching records</td></tr>`) + "</tbody>";
    $("#pg").innerHTML = `<button class="ghost" id="pv"${p ? "" : " disabled"}>‹ Prev</button><span>${n ? p * N + 1 : 0}–${Math.min(n, p * N + N)} of ${n}</span><button class="ghost" id="nx"${p < pages - 1 ? "" : " disabled"}>Next ›</button>`;
    $("#pv").onclick = () => { p--; draw(); };
    $("#nx").onclick = () => { p++; draw(); };
  }
  q.oninput = () => { p = 0; draw(); };
  $("#csv").onclick = () => csv(o.cols.filter(c => !c[3]), F, o.file);   // c[3] = true: skip in CSV (e.g. action buttons)
  draw();
}