import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $app = document.getElementById("app");
const $userbar = document.getElementById("userbar");
const dlg = document.getElementById("dlg");
const DEFAULT_CATS = ["Mains", "Sides", "Desserts", "Drinks", "Plates & utensils"];

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR")) {
  $app.innerHTML = `<div class="card"><h2>Setup needed</h2>
    <p>Add your Firebase settings to <code>firebase-config.js</code> (see README).</p></div>`;
  throw new Error("Missing Firebase config");
}

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

let user = null;
let unsubs = [];
let routeId = 0;

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toDate = (ts) => (ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null);
const ms = (ts) => toDate(ts)?.getTime() ?? 0;
const fmtWhen = (ts) => {
  const d = toDate(ts);
  return d ? d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric",
    year: "numeric", hour: "numeric", minute: "2-digit" }) : "Date TBD";
};
const fmtAgo = (ts) => {
  const d = toDate(ts);
  return d ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "just now";
};
const toLocalInput = (ts) => {
  const d = toDate(ts) || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const inviteUrl = (id, token) => `${location.origin}${location.pathname}#/join/${id}/${token}`;
const me = () => ({ uid: user.uid, name: user.displayName || user.email, email: user.email, photo: user.photoURL || "" });
const avatar = (url, name) => url
  ? `<img class="avatar" src="${esc(url)}" alt="" referrerpolicy="no-referrer">`
  : `<span class="avatar" title="${esc(name)}"></span>`;
const snapDocs = (s) => s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 2800);
}

async function logHistory(eid, type, summary, extra = {}) {
  try {
    await addDoc(collection(db, "events", eid, "history"), {
      type, summary, actorUid: user.uid, actorName: me().name, at: serverTimestamp(), ...extra,
    });
  } catch (e) { console.warn("history write failed", e); }
}

function openDialog(title, bodyHtml, onSubmit, submitLabel = "Save") {
  dlg.innerHTML = `<form class="dlg-form"><h2>${esc(title)}</h2>${bodyHtml}
    <div class="row end"><button type="button" class="ghost" data-close>Cancel</button>
    <button type="submit" class="primary">${esc(submitLabel)}</button></div></form>`;
  const form = dlg.querySelector("form");
  form.querySelector("[data-close]").onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const keepOpen = await onSubmit(new FormData(form), form);
      if (!keepOpen) dlg.close();
    } catch (err) {
      console.error(err);
      toast(err.code === "permission-denied" ? "You don't have permission to do that." : err.message || "Something went wrong", true);
    } finally { btn.disabled = false; }
  };
  dlg.showModal();
  form.querySelector("input:not([readonly]),select,textarea")?.focus();
  return form;
}

/* ---------- auth ---------- */
async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== "auth/popup-closed-by-user") {
      toast(e.message, true);
    }
  }
}

function renderUserbar() {
  if (!user) { $userbar.innerHTML = ""; return; }
  $userbar.innerHTML = `${avatar(user.photoURL, user.displayName)}
    <button class="ghost small" id="signout">Sign out</button>`;
  document.getElementById("signout").onclick = () => signOut(auth);
}

function renderSignIn() {
  const joining = location.hash.startsWith("#/join/");
  $app.innerHTML = `<div class="card center signin"><div class="logo">🥘</div><h1>Potluck</h1>
    <p class="muted">${joining ? "You've been invited to a potluck. Sign in with Google to join." : "Plan who's bringing what."}</p>
    <button class="btn google" id="gbtn">Sign in with Google</button></div>`;
  document.getElementById("gbtn").onclick = signIn;
}

/* ---------- router ---------- */
function route() {
  routeId++;
  unsubs.forEach((u) => u());
  unsubs = [];
  if (dlg.open) dlg.close();
  $app.onclick = null;
  if (!user) return renderSignIn();
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "new") return renderNew();
  if (parts[0] === "event" && parts[1]) return renderEvent(parts[1]);
  if (parts[0] === "join" && parts[1] && parts[2]) return doJoin(parts[1], parts[2]);
  return renderHome();
}
window.addEventListener("hashchange", route);
onAuthStateChanged(auth, (u) => { user = u; renderUserbar(); route(); });

/* ---------- home ---------- */
async function renderHome() {
  const rid = routeId;
  $app.innerHTML = `<div class="row between"><h1>Your potlucks</h1>
    <a class="btn primary" href="#/new">+ New potluck</a></div>
    <div id="lists"><p class="muted">Loading…</p></div>`;
  try {
    const ptrs = await getDocs(collection(db, "users", user.uid, "events"));
    const results = await Promise.allSettled(ptrs.docs.map(async (p) => {
      const s = await getDoc(doc(db, "events", p.id));
      return s.exists() ? { id: s.id, ...s.data() } : null;
    }));
    if (rid !== routeId) return;
    const events = results.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
    const cutoff = Date.now() - 6 * 3600e3; // stays "upcoming" until 6h after start
    const upcoming = events.filter((e) => ms(e.when) >= cutoff).sort((a, b) => ms(a.when) - ms(b.when));
    const past = events.filter((e) => ms(e.when) < cutoff).sort((a, b) => ms(b.when) - ms(a.when));
    const card = (e) => {
      const d = toDate(e.when);
      return `<a class="card event-card" href="#/event/${e.id}">
        <div class="date-badge">${d ? d.toLocaleString(undefined, { month: "short" }) : "—"}<span>${d ? d.getDate() : ""}</span></div>
        <div><h3>${esc(e.title)}</h3>
        <p class="muted small">${esc(fmtWhen(e.when))}${e.location ? " · " + esc(e.location) : ""}</p>
        <span class="tag">${e.ownerUid === user.uid ? "Host" : "Guest"}</span></div></a>`;
    };
    document.getElementById("lists").innerHTML = `
      <h2>Upcoming</h2>
      <div class="list" style="margin:10px 0 20px">${upcoming.map(card).join("") || `<p class="muted">Nothing planned yet — start one!</p>`}</div>
      ${past.length ? `<h2>Past potlucks</h2><div class="list" style="margin-top:10px">${past.map(card).join("")}</div>` : ""}`;
  } catch (e) {
    console.error(e);
    document.getElementById("lists").innerHTML = `<p class="muted">Couldn't load your potlucks. ${esc(e.message)}</p>`;
  }
}

/* ---------- new event ---------- */
function renderNew() {
  $app.innerHTML = `<a href="#/" class="back">← All potlucks</a>
    <form class="card dlg-form" id="newf"><h1>New potluck</h1>
      <label>Name<input name="title" required maxlength="100" placeholder="Friendsgiving 2026"></label>
      <label>Location<input name="location" maxlength="200" placeholder="Address or place"></label>
      <label>Date & time<input name="when" type="datetime-local" required></label>
      <label>Notes for guests<textarea name="notes" maxlength="2000" placeholder="Parking, theme, allergies to know about…"></textarea></label>
      <label class="check"><input type="checkbox" name="defaults" checked> Start with default categories (Mains, Sides, Desserts, Drinks, Plates & utensils)</label>
      <div class="row end"><button class="primary" type="submit">Create potluck</button></div>
    </form>`;
  const form = document.getElementById("newf");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    const f = new FormData(form);
    try {
      const token = newToken();
      const title = f.get("title").trim();
      const ref = await addDoc(collection(db, "events"), {
        title, location: f.get("location").trim(), notes: f.get("notes").trim(),
        when: Timestamp.fromDate(new Date(f.get("when"))),
        ownerUid: user.uid, ownerName: me().name, ownerEmail: user.email,
        inviteToken: token, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      await setDoc(doc(db, "events", ref.id, "members", user.uid), { ...me(), token, role: "host", joinedAt: serverTimestamp() });
      await setDoc(doc(db, "users", user.uid, "events", ref.id), { role: "host", addedAt: serverTimestamp() });
      if (f.get("defaults")) {
        await Promise.all(DEFAULT_CATS.map((name, i) =>
          addDoc(collection(db, "events", ref.id, "categories"), { name, order: i, createdAt: serverTimestamp() })));
      }
      await logHistory(ref.id, "event.created", `created “${title}”`);
      location.hash = `#/event/${ref.id}`;
    } catch (err) {
      console.error(err);
      toast(err.message, true);
      btn.disabled = false;
    }
  };
}

/* ---------- join via link ---------- */
async function doJoin(eid, token) {
  const rid = routeId;
  $app.innerHTML = `<div class="card center"><p>Joining potluck…</p></div>`;
  const memRef = doc(db, "events", eid, "members", user.uid);
  let already = false;
  try { already = (await getDoc(memRef)).exists(); } catch { /* not a member yet */ }
  try {
    if (!already) {
      await setDoc(memRef, { ...me(), token, role: "guest", joinedAt: serverTimestamp() });
      await setDoc(doc(db, "users", user.uid, "events", eid), { role: "guest", addedAt: serverTimestamp() });
      await logHistory(eid, "member.joined", "joined the potluck");
    }
    if (rid === routeId) location.replace(`#/event/${eid}`);
  } catch (e) {
    console.error(e);
    if (rid !== routeId) return;
    $app.innerHTML = `<div class="card center"><h2>This invite link doesn't work</h2>
      <p class="muted">It may have been reset by the host. Ask them for a new link.</p>
      <a class="btn" href="#/">Go to my potlucks</a></div>`;
  }
}

/* ---------- event page ---------- */
function renderEvent(eid) {
  const rid = routeId;
  const st = { ev: null, cats: [], items: [], members: [], history: [], historyOpen: false, failed: false };
  $app.innerHTML = `<p class="muted">Loading…</p>`;
  const draw = () => { if (rid === routeId && !st.failed) drawEvent(eid, st); };
  const onErr = (e) => {
    console.error(e);
    if (rid !== routeId || st.failed) return;
    st.failed = true;
    $app.innerHTML = `<div class="card center"><h2>Can't open this potluck</h2>
      <p class="muted">You may not be on the guest list, or the host removed you.</p>
      <a class="btn" href="#/">Back to my potlucks</a></div>`;
  };
  const sub = (q, key) => unsubs.push(onSnapshot(q, (s) => { st[key] = snapDocs(s); draw(); }, onErr));
  unsubs.push(onSnapshot(doc(db, "events", eid), (s) => {
    st.ev = s.exists() ? { id: s.id, ...s.data({ serverTimestamps: "estimate" }) } : null;
    if (!st.ev) return onErr(new Error("not found"));
    draw();
  }, onErr));
  sub(query(collection(db, "events", eid, "categories"), orderBy("order")), "cats");
  sub(query(collection(db, "events", eid, "items"), orderBy("createdAt")), "items");
  sub(collection(db, "events", eid, "members"), "members");
  sub(query(collection(db, "events", eid, "history"), orderBy("at", "desc"), limit(200)), "history");

  $app.onclick = (e) => {
    const el = e.target.closest("[data-act]");
    if (el) handleAction(eid, st, el.dataset.act, el.dataset);
  };
}

function drawEvent(eid, st) {
  const ev = st.ev;
  if (!ev) return;
  const isHost = ev.ownerUid === user.uid;
  const active = st.items.filter((i) => !i.deleted);
  const catIds = new Set(st.cats.map((c) => c.id));
  const groups = st.cats.map((c) => ({ cat: c, items: active.filter((i) => i.categoryId === c.id) }));
  const orphans = active.filter((i) => !catIds.has(i.categoryId));
  if (orphans.length || !st.cats.length) groups.push({ cat: { id: "", name: "Other" }, items: orphans });
  const isPast = ms(ev.when) < Date.now();

  const itemHtml = (i) => {
    const mine = i.uid === user.uid;
    const canEdit = mine || isHost;
    return `<li class="${mine ? "mine" : ""}">${avatar(i.userPhoto, i.userName)}
      <div class="body"><div class="name">${esc(i.name)}${i.quantity ? ` <span class="muted small">· ${esc(i.quantity)}</span>` : ""}</div>
      <div class="muted small">${mine ? "You" : esc(i.userName)}${i.notes ? " — " + esc(i.notes) : ""}</div></div>
      ${canEdit ? `<button class="icon" data-act="edit-item" data-id="${i.id}" title="Edit">✏️</button>
        <button class="icon" data-act="remove-item" data-id="${i.id}" title="Remove">🗑️</button>` : ""}</li>`;
  };
  const catHtml = (g) => `<section class="card"><div class="row between">
      <h3>${esc(g.cat.name)} <span class="count">${g.items.length}</span></h3>
      ${isHost && g.cat.id ? `<div class="row"><button class="icon" data-act="rename-cat" data-id="${g.cat.id}" title="Rename">✏️</button>
        <button class="icon" data-act="del-cat" data-id="${g.cat.id}" title="Delete category">🗑️</button></div>` : ""}</div>
      ${g.items.length ? `<ul class="items">${g.items.map(itemHtml).join("")}</ul>`
        : `<p class="muted small" style="margin:.4rem 0 0">Nobody yet — <button class="link" data-act="add-item" data-cat="${g.cat.id}">bring something</button></p>`}
    </section>`;

  const members = [...st.members].sort((a, b) => (a.role === "host" ? -1 : b.role === "host" ? 1 : String(a.name).localeCompare(b.name)));
  const bringing = (uid) => active.filter((i) => i.uid === uid).map((i) => i.name);

  $app.innerHTML = `
    <a href="#/" class="back">← All potlucks</a>
    <section class="card">
      <div class="row between wrap"><h1>${esc(ev.title)}</h1>${isPast ? `<span class="tag">Past</span>` : ""}</div>
      <p class="meta">📅 ${esc(fmtWhen(ev.when))}</p>
      ${ev.location ? `<p class="meta">📍 <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}">${esc(ev.location)}</a></p>` : ""}
      ${ev.notes ? `<p class="notes">${esc(ev.notes)}</p>` : ""}
      <p class="muted small">Hosted by ${esc(ev.ownerName)}</p>
      ${isHost ? `<div class="row wrap gap" style="margin-top:8px">
        <button class="primary" data-act="invite">Invite people</button>
        <button data-act="edit-event">Edit details</button>
        <button data-act="add-cat">+ Category</button></div>` : ""}
    </section>
    <div class="row between wrap"><h2>Who's bringing what</h2>
      <button class="primary" data-act="add-item">+ I'm bringing…</button></div>
    ${groups.map(catHtml).join("")}
    <section class="card"><h2>Guests (${members.length})</h2>
      <ul class="people">${members.map((m) => {
        const b = bringing(m.uid);
        return `<li>${avatar(m.photo, m.name)}<div class="grow"><div>${esc(m.name)}${m.role === "host" ? ` <span class="tag">Host</span>` : ""}</div>
          <div class="muted small">${b.length ? esc(b.join(", ")) : "Nothing signed up yet"}</div></div>
          ${isHost && m.uid !== user.uid ? `<button class="icon danger" data-act="remove-member" data-id="${m.uid}" title="Remove guest">✕</button>` : ""}</li>`;
      }).join("")}</ul>
    </section>
    <section class="card"><details id="hist" ${st.historyOpen ? "open" : ""}>
      <summary><h2 style="display:inline">History</h2> <span class="muted small">(${st.history.length} changes)</span></summary>
      <ul class="history">${st.history.map((h) => `<li><strong>${esc(h.actorName)}</strong> ${esc(h.summary)}
        <div class="muted small">${esc(fmtAgo(h.at))}</div></li>`).join("") || `<li class="muted">No activity yet.</li>`}</ul>
    </details></section>`;

  document.getElementById("hist").ontoggle = (e) => (st.historyOpen = e.target.open);
}

/* ---------- actions ---------- */
async function handleAction(eid, st, act, data) {
  const ev = st.ev;
  const evRef = doc(db, "events", eid);
  try {
    switch (act) {
      case "add-item": return openItemDialog(eid, st, null, data.cat);
      case "edit-item": return openItemDialog(eid, st, st.items.find((i) => i.id === data.id));

      case "remove-item": {
        const it = st.items.find((i) => i.id === data.id);
        if (!it || !confirm(`Remove “${it.name}”?`)) return;
        await updateDoc(doc(db, "events", eid, "items", it.id),
          { deleted: true, deletedAt: serverTimestamp(), deletedBy: user.uid, updatedAt: serverTimestamp() });
        await logHistory(eid, "item.removed",
          `removed “${it.name}”${it.uid !== user.uid ? ` (brought by ${it.userName})` : ""}`, { itemId: it.id, before: pickItem(it) });
        return toast("Removed");
      }

      case "edit-event":
        return openDialog("Edit potluck", `
          <label>Name<input name="title" required maxlength="100" value="${esc(ev.title)}"></label>
          <label>Location<input name="location" maxlength="200" value="${esc(ev.location)}"></label>
          <label>Date & time<input name="when" type="datetime-local" required value="${toLocalInput(ev.when)}"></label>
          <label>Notes for guests<textarea name="notes" maxlength="2000">${esc(ev.notes)}</textarea></label>`,
        async (f) => {
          const after = { title: f.get("title").trim(), location: f.get("location").trim(), notes: f.get("notes").trim(),
            when: Timestamp.fromDate(new Date(f.get("when"))) };
          const changed = [];
          if (after.title !== ev.title) changed.push(`name to “${after.title}”`);
          if (after.location !== (ev.location || "")) changed.push(`location to “${after.location || "none"}”`);
          if (after.when.toMillis() !== ms(ev.when)) changed.push(`date/time to ${fmtWhen(after.when)}`);
          if (after.notes !== (ev.notes || "")) changed.push("notes");
          if (!changed.length) return;
          await updateDoc(evRef, { ...after, updatedAt: serverTimestamp() });
          await logHistory(eid, "event.updated", `changed ${changed.join(", ")}`, {
            before: { title: ev.title, location: ev.location || "", notes: ev.notes || "", when: ev.when }, after });
          toast("Saved");
        });

      case "invite": {
        const form = openDialog("Invite people", `
          <p class="muted small" style="margin:0">Anyone with this link can sign in with Google and join. Reset it to stop new people joining (current guests stay).</p>
          <input id="invlink" readonly value="${esc(inviteUrl(eid, ev.inviteToken))}">
          <div class="row wrap gap">${navigator.share ? `<button type="button" id="invshare">Share…</button>` : ""}
          <button type="button" class="danger" id="invreset">Reset link</button></div>`,
        async () => {
          const v = document.getElementById("invlink").value;
          try { await navigator.clipboard.writeText(v); toast("Link copied"); }
          catch { document.getElementById("invlink").select(); toast("Select and copy the link", true); return true; }
        }, "Copy link");
        form.querySelector("#invshare")?.addEventListener("click", () =>
          navigator.share({ title: ev.title, text: `Join my potluck: ${ev.title}`, url: document.getElementById("invlink").value }).catch(() => {}));
        form.querySelector("#invreset").addEventListener("click", async () => {
          if (!confirm("Reset the link? The old one will stop working for new guests.")) return;
          const token = newToken();
          await updateDoc(evRef, { inviteToken: token, updatedAt: serverTimestamp() });
          await logHistory(eid, "invite.reset", "reset the invite link");
          document.getElementById("invlink").value = inviteUrl(eid, token);
          toast("New link ready");
        });
        return;
      }

      case "add-cat":
        return openDialog("New category", `<label>Category name<input name="name" required maxlength="60" placeholder="e.g. Appetizers"></label>`,
          async (f) => {
            const name = f.get("name").trim();
            const order = Math.max(-1, ...st.cats.map((c) => c.order ?? 0)) + 1;
            await addDoc(collection(db, "events", eid, "categories"), { name, order, createdAt: serverTimestamp() });
            await logHistory(eid, "category.created", `added category “${name}”`);
          }, "Add");

      case "rename-cat": {
        const c = st.cats.find((x) => x.id === data.id);
        return openDialog("Rename category", `<label>Category name<input name="name" required maxlength="60" value="${esc(c.name)}"></label>`,
          async (f) => {
            const name = f.get("name").trim();
            if (name === c.name) return;
            await updateDoc(doc(db, "events", eid, "categories", c.id), { name });
            await logHistory(eid, "category.renamed", `renamed category “${c.name}” to “${name}”`);
          });
      }

      case "del-cat": {
        const c = st.cats.find((x) => x.id === data.id);
        if (st.items.some((i) => !i.deleted && i.categoryId === c.id)) return toast("Move or remove the items in this category first", true);
        if (!confirm(`Delete category “${c.name}”?`)) return;
        await deleteDoc(doc(db, "events", eid, "categories", c.id));
        return logHistory(eid, "category.deleted", `deleted category “${c.name}”`);
      }

      case "remove-member": {
        const m = st.members.find((x) => x.uid === data.id);
        if (!m || !confirm(`Remove ${m.name} from this potluck? Their items stay listed.`)) return;
        await deleteDoc(doc(db, "events", eid, "members", m.uid));
        return logHistory(eid, "member.removed", `removed ${m.name}`);
      }
    }
  } catch (err) {
    console.error(err);
    toast(err.code === "permission-denied" ? "You don't have permission to do that." : err.message, true);
  }
}

const pickItem = (i) => ({ name: i.name, categoryId: i.categoryId || "", quantity: i.quantity || "", notes: i.notes || "" });

function openItemDialog(eid, st, item, presetCat) {
  const catSel = item ? item.categoryId : (presetCat ?? st.cats[0]?.id ?? "");
  const options = st.cats.map((c) => `<option value="${c.id}" ${c.id === catSel ? "selected" : ""}>${esc(c.name)}</option>`).join("")
    + `<option value="" ${!catSel ? "selected" : ""}>Other</option>`;
  openDialog(item ? "Edit item" : "What are you bringing?", `
    <label>Item<input name="name" required maxlength="100" value="${esc(item?.name)}" placeholder="Mac and cheese"></label>
    <label>Category<select name="categoryId">${options}</select></label>
    <label>Amount <span class="muted small">(optional)</span><input name="quantity" maxlength="60" value="${esc(item?.quantity)}" placeholder="Serves 10, 2 bags, a 12-pack…"></label>
    <label>Notes <span class="muted small">(optional)</span><input name="notes" maxlength="200" value="${esc(item?.notes)}" placeholder="Vegetarian, contains nuts…"></label>`,
  async (f) => {
    const after = { name: f.get("name").trim(), categoryId: f.get("categoryId"),
      quantity: f.get("quantity").trim(), notes: f.get("notes").trim() };
    const catName = (id) => st.cats.find((c) => c.id === id)?.name || "Other";
    if (!item) {
      const ref = await addDoc(collection(db, "events", eid, "items"), {
        ...after, uid: user.uid, userName: me().name, userPhoto: me().photo, deleted: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      await logHistory(eid, "item.added", `is bringing “${after.name}” (${catName(after.categoryId)})`, { itemId: ref.id, after });
      return toast("Added — thanks!");
    }
    const before = pickItem(item);
    const changes = [];
    if (after.name !== before.name) changes.push(`“${before.name}” → “${after.name}”`);
    if (after.categoryId !== before.categoryId) changes.push(`moved to ${catName(after.categoryId)}`);
    if (after.quantity !== before.quantity) changes.push(`amount: ${after.quantity || "none"}`);
    if (after.notes !== before.notes) changes.push(`notes: ${after.notes || "none"}`);
    if (!changes.length) return;
    await updateDoc(doc(db, "events", eid, "items", item.id), { ...after, updatedAt: serverTimestamp(), updatedBy: user.uid });
    await logHistory(eid, "item.updated", `edited “${before.name}”: ${changes.join("; ")}`, { itemId: item.id, before, after });
    toast("Saved");
  }, item ? "Save" : "Add");
}
