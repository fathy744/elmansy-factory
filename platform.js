// Connects the factory app to Firebase (database + email/password sign-in).
// The app talks to `window.claude.use(name)`; this file provides those
// capabilities ("db", "user", "downloads") on top of Firebase.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  connectAuthEmulator, getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const cfg = window.FIREBASE_CONFIG;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = '<span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M7 4h10M7 20h10" stroke="#fff"/><path d="M8 4c0 3 8 3 8 6s-8 3-8 6 8 3 8 4" stroke="#D98324"/><path d="M16 4c0 3-8 3-8 6s8 3 8 6-8 3-8 4" stroke="#6F86FF"/></svg></span>';

function gate(html) {
  let g = document.getElementById('authGate');
  if (!g) {
    g = document.createElement('div'); g.id = 'authGate'; g.dir = 'rtl';
    document.body.appendChild(g);
  }
  g.innerHTML = `<div class="ag-card">${LOGO}${html}</div>`;
  g.hidden = false;
  return g;
}
function hideGate() { const g = document.getElementById('authGate'); if (g) g.hidden = true; }

if (!cfg || !cfg.apiKey) {
  gate(`<h1>النظام لسه محتاج إعداد</h1><p>ملف <b>config.js</b> فاضي. افتح ملف <b>README.md</b> في المستودع واتبع خطوات ربط Firebase، أو ابعت بيانات المشروع للمطوّر.</p>`);
} else {
  main();
}

async function main() {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  let fs;
  try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch { fs = initializeFirestore(app, {}); }
  // Local testing only: point at the Firebase emulators when config asks for it.
  if (cfg.emulator) { connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); connectFirestoreEmulator(fs, '127.0.0.1', 8085); }

  const S = { uid: null, email: '', name: '', owner: false, ownerUid: null, ownerName: '', names: {} };

  // ---------- helpers ----------
  const mapErr = e => {
    const c = e && e.code || '';
    if (c.includes('permission-denied')) return { code: 'invalid_argument', message: 'ليس لديك صلاحية لهذا الإجراء.' };
    if (c.includes('resource-exhausted')) return { code: 'quota_exceeded', message: e.message };
    return { code: 'unavailable', message: e && e.message || 'error' };
  };
  // Writes resolve when the server confirms. Offline, Firestore keeps the write
  // in its local queue and syncs later, so don't hold the UI forever.
  const settle = p => Promise.race([
    p.catch(e => { throw mapErr(e); }),
    new Promise(r => setTimeout(r, navigator.onLine ? 15000 : 1200))
  ]);
  const wrapDoc = s => ({
    id: s.id, exists: typeof s.exists === 'function' ? s.exists() : true, data: () => s.data(),
    metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites }
  });
  const emptyQS = { docs: [], size: 0, empty: true, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  const newId = () => doc(collection(fs, '_')).id;

  function docRef(path) {
    const r = doc(fs, path);
    return {
      id: r.id, path,
      get: async () => { try { return wrapDoc(await getDoc(r)); } catch (e) { if ((e.code || '').includes('permission')) return { id: r.id, exists: false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: false } }; throw mapErr(e); } },
      set: d => settle(setDoc(r, d)),
      update: d => settle(updateDoc(r, d)),
      delete: () => settle(deleteDoc(r)),
      onSnapshot: (next, err) => onSnapshot(r, { includeMetadataChanges: true }, s => next(wrapDoc(s)), e => {
        if ((e.code || '').includes('permission')) next({ id: r.id, exists: false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: false } });
        else err && err(mapErr(e));
      }),
      collection: p => colRef(path + '/' + p)
    };
  }
  function colRef(path) {
    const c = collection(fs, path);
    const toQS = s => ({ docs: s.docs.map(wrapDoc), size: s.size, empty: s.empty, docChanges: () => [], metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
    return {
      path,
      doc: id => docRef(path + '/' + (id || newId())),
      add: async d => { const r = docRef(path + '/' + newId()); await r.set(d); return r; },
      get: async () => { try { return toQS(await getDocs(c)); } catch (e) { if ((e.code || '').includes('permission')) return emptyQS; throw mapErr(e); } },
      onSnapshot: (next, err) => {
        // Employees can only read their own membership record.
        if (path === 'members' && !S.owner) {
          return docRef('members/' + S.uid).onSnapshot(d => next(d.exists ? { ...emptyQS, docs: [d], size: 1, empty: false } : emptyQS));
        }
        if (path === 'requests') { setTimeout(() => next(emptyQS), 0); return () => {}; }
        return onSnapshot(c, { includeMetadataChanges: true }, s => next(toQS(s)), e => {
          if ((e.code || '').includes('permission')) next(emptyQS); else err && err(mapErr(e));
        });
      }
    };
  }
  const db = { doc: docRef, collection: colRef };

  const initials = n => (String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('') || '?');
  const COLORS = ['#3346C9', '#C0317A', '#0D8A88', '#D98324', '#2F8A4C', '#7A4BC9'];
  const colorOf = id => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  const avatar = (id, name) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${colorOf(id)}"/><text x="32" y="41" text-anchor="middle" font-family="Tahoma,sans-serif" font-size="24" fill="#fff">${esc(initials(name))}</text></svg>`);
  const prof = id => {
    const name = id === S.ownerUid ? S.ownerName : (S.names[id] || (id === S.uid ? S.name : ''));
    return { id, name: name || '', avatarUrl: avatar(id, name), color: colorOf(id), email: null, isMe: id === S.uid, guest: false };
  };
  const user = {
    me: async () => ({ id: S.uid, name: S.owner ? S.ownerName : S.name, avatarUrl: avatar(S.uid, S.owner ? S.ownerName : S.name), color: colorOf(S.uid), email: S.email, isOwner: S.owner, canEdit: S.owner }),
    id: async () => S.uid, isOwner: async () => S.owner, canEdit: async () => S.owner, can: async () => true,
    name: async () => S.name, avatarUrl: async () => avatar(S.uid, S.name), email: async () => S.email,
    profiles: async ids => Object.fromEntries([].concat(ids).map(i => [i, prof(i)])),
    search: async () => []
  };
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.html$/.test(filename) ? 'text/html;charset=utf-8' : /\.json$/.test(filename) ? 'application/json' : 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: 'saved' };
    }
  };

  // ---------- tools the users page calls ----------
  window.__fb = {
    async createUser(email, password) {
      const sec = initializeApp(cfg, 'create-' + Date.now());
      try { const a2 = getAuth(sec); if (cfg.emulator) connectAuthEmulator(a2, 'http://127.0.0.1:9099', { disableWarnings: true }); const cred = await createUserWithEmailAndPassword(a2, email, password); await signOut(a2); return cred.user.uid; }
      catch (e) { throw { code: e.code, message: authMsg(e) }; }
      finally { deleteApp(sec).catch(() => {}); }
    },
    async resetPassword(email) { await sendPasswordResetEmail(auth, email); },
    async signOut() { await signOut(auth); location.reload(); }
  };

  function authMsg(e) {
    const c = e && e.code || '';
    if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'الإيميل أو كلمة المرور غير صحيحة.';
    if (c.includes('email-already-in-use')) return 'الإيميل ده مستخدم في حساب تاني.';
    if (c.includes('weak-password')) return 'كلمة المرور لازم تكون 6 حروف أو أرقام على الأقل.';
    if (c.includes('invalid-email')) return 'الإيميل مكتوب غلط.';
    if (c.includes('too-many-requests')) return 'محاولات كتير. استنى دقيقة وجرب تاني.';
    if (c.includes('network')) return 'مفيش اتصال بالإنترنت.';
    if (c.includes('unauthorized-domain')) return 'الموقع ده مش مضاف في Firebase (Authorized domains).';
    return 'حصل خطأ: ' + (e && e.message || c);
  }

  // ---------- sign-in screens ----------
  async function ownerMeta() {
    try { const s = await getDoc(doc(fs, 'meta/owner')); return s.exists() ? s.data() : null; }
    catch { return undefined; }
  }
  function loginScreen(err = '', mode = 'login') {
    const g = gate(mode === 'reset'
      ? `<h1>استرجاع كلمة المرور</h1><p>اكتب إيميلك وهنبعتلك رابط تغيير كلمة المرور.</p>
         <form id="agForm"><label>الإيميل<input id="agEmail" type="email" autocomplete="email" required dir="ltr"></label>
         <div class="ag-err">${esc(err)}</div><button class="btn" type="submit">إرسال الرابط</button><button class="ag-link" type="button" id="agBack">رجوع لتسجيل الدخول</button></form>`
      : `<h1>تسجيل الدخول</h1><p>نظام إدارة مصنع المنسي للغزل والنسيج</p>
         <form id="agForm"><label>الإيميل<input id="agEmail" type="email" autocomplete="username" required dir="ltr"></label>
         <label>كلمة المرور<input id="agPass" type="password" autocomplete="current-password" required dir="ltr"></label>
         <div class="ag-err">${esc(err)}</div><button class="btn" type="submit">دخول</button><button class="ag-link" type="button" id="agReset">نسيت كلمة المرور؟</button></form>`);
    g.querySelector('#agReset')?.addEventListener('click', () => loginScreen('', 'reset'));
    g.querySelector('#agBack')?.addEventListener('click', () => loginScreen());
    g.querySelector('#agForm').addEventListener('submit', async e => {
      e.preventDefault(); const b = g.querySelector('button[type=submit]'); b.disabled = true;
      const email = g.querySelector('#agEmail').value.trim();
      try {
        if (mode === 'reset') { await sendPasswordResetEmail(auth, email); loginScreen('تم إرسال الرابط على إيميلك.'); }
        else await signInWithEmailAndPassword(auth, email, g.querySelector('#agPass').value);
      } catch (er) { b.disabled = false; g.querySelector('.ag-err').textContent = authMsg(er); }
    });
    setTimeout(() => g.querySelector('#agEmail')?.focus(), 50);
  }
  function ownerSetupScreen(err = '') {
    const g = gate(`<h1>إنشاء حساب صاحب المصنع</h1><p>أول مرة تفتح النظام. الحساب ده هيبقى المالك وليه كل الصلاحيات، ومنه هتعمل حسابات العاملين.</p>
      <form id="agForm"><label>الاسم<input id="agName" required autocomplete="name"></label>
      <label>الإيميل<input id="agEmail" type="email" required autocomplete="username" dir="ltr"></label>
      <label>كلمة المرور (6 على الأقل)<input id="agPass" type="password" minlength="6" required autocomplete="new-password" dir="ltr"></label>
      <div class="ag-err">${esc(err)}</div><button class="btn" type="submit">إنشاء حساب المالك</button>
      <button class="ag-link" type="button" id="agHave">عندي حساب بالفعل</button></form>`);
    g.querySelector('#agHave').addEventListener('click', () => loginScreen());
    g.querySelector('#agForm').addEventListener('submit', async e => {
      e.preventDefault(); const b = g.querySelector('button[type=submit]'); b.disabled = true;
      const name = g.querySelector('#agName').value.trim();
      try {
        pendingOwnerName = name;
        await createUserWithEmailAndPassword(auth, g.querySelector('#agEmail').value.trim(), g.querySelector('#agPass').value);
      } catch (er) { b.disabled = false; pendingOwnerName = null; g.querySelector('.ag-err').textContent = authMsg(er); }
    });
  }
  let pendingOwnerName = null, started = false;

  gate('<h1>جاري التحميل…</h1><p>بنجهّز نظام المصنع.</p>');
  onAuthStateChanged(auth, async u => {
    if (!u) {
      if (started) { location.reload(); return; }
      const m = await ownerMeta();
      if (m === null) ownerSetupScreen(); else loginScreen();
      return;
    }
    if (started) return;
    S.uid = u.uid; S.email = u.email || '';
    let m = await ownerMeta();
    if (m === null && pendingOwnerName) {
      try { await setDoc(doc(fs, 'meta/owner'), { uid: u.uid, name: pendingOwnerName, createdAt: Date.now() }); m = { uid: u.uid, name: pendingOwnerName }; }
      catch { m = await ownerMeta(); }
    }
    S.ownerUid = m?.uid || null; S.ownerName = m?.name || 'صاحب المصنع'; S.owner = !!m && m.uid === u.uid;
    if (S.owner) {
      S.name = S.ownerName;
      onSnapshot(collection(fs, 'members'), s => { s.docs.forEach(d => { S.names[d.id] = d.data().name || d.data().email || ''; }); }, () => {});
    } else {
      try { const md = await getDoc(doc(fs, 'members/' + u.uid)); if (md.exists()) S.name = md.data().name || ''; } catch {}
    }
    started = true;
    hideGate();
    window.__resolvePlatform({ use: async n => n === 'db' ? db : n === 'user' ? user : n === 'downloads' ? downloads : null });
  });
}
