// Header bell: how many items are waiting on the signed-in user.
//   admin            : transfers + item requests waiting for their decision (not their own)
//   operator         : transfers waiting for their approval (not their own)
//   field_supervisor : their own batches still waiting for approval
//   viewer           : nothing
// Click the bell to open the page where the work is. Exposes window.RTVBell.updateBadge().
//
// Load AFTER app.js (it uses `sb` from there). Do NOT paste app.js into this file:
// re-declaring its top-level consts throws "Identifier '$' has already been declared"
// and the whole script is skipped.
(() => {
  const BELL_ID = "rtv-bell";

  const countOf = async q => {
    const { count, error } = await q;
    return error ? 0 : (count || 0);
  };
  const head = table => sb.from(table).select("id", { count: "exact", head: true });

  async function waiting() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const email = (session.user.email || "").toLowerCase();

    const { data: role, error: roleErr } = await sb.rpc("app_role");
    if (roleErr || !role || role === "viewer") return null;

    if (role === "field_supervisor") {
      const n = await countOf(head("enumerator_batches").eq("status", "PENDING"));
      return { n, href: null, label: n + " batch(es) awaiting approval" };
    }

    let tq = head("pending_transfers").eq("status", "PENDING").neq("submitted_by", email);
    // Items an admin added (e.g. new stock) must be approved by an operator of that location,
    // so an admin cannot act on them - leave them out of the admin's count.
    if (role === "admin") tq = tq.eq("requires_operator_approval", false);
    const transfers = countOf(tq);

    if (role === "admin") {
      const requests = countOf(head("item_requests").eq("status", "PENDING").neq("requested_by", email));
      const [t, r] = await Promise.all([transfers, requests]);
      const parts = [t && t + " transfer(s)", r && r + " item request(s)"].filter(Boolean);
      return { n: t + r, href: t ? "approvals.html" : "requests.html",
               label: parts.join(" and ") + " awaiting your approval" };
    }

    const t = await transfers;                       // operator
    return { n: t, href: "approvals.html", label: t + " transfer(s) awaiting your approval" };
  }

  async function updateBadge() {
    try {
      const nav = document.getElementById("nav");
      if (!nav) return;
      const old = document.getElementById(BELL_ID);
      const r = await waiting();
      if (!r || !r.n) { if (old) old.remove(); return; }

      const el = document.createElement(r.href ? "a" : "span");
      el.id = BELL_ID;
      if (r.href) el.href = r.href;
      el.style.cssText = "margin-right:10px;background:#dc2626;color:#fff;font-size:12px;" +
                         "font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;text-decoration:none";
      el.textContent = "\uD83D\uDD14 " + r.n;
      el.title = r.label;

      if (old) old.replaceWith(el);
      else {
        const who = nav.querySelector(".who");
        who ? nav.insertBefore(el, who) : nav.appendChild(el);
      }
    } catch (e) {
      console.warn("RTVBell:", e);
    }
  }

  window.RTVBell = { updateBadge };

  // guard() draws the header asynchronously - wait for it, then show the badge.
  let tries = 0;
  const boot = () => {
    if (document.querySelector("#nav .who")) updateBadge();
    else if (tries++ < 20) setTimeout(boot, 250);
  };
  boot();
})();