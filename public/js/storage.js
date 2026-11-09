/* ============================================================
   storage.js - all personal data lives in browser localStorage.
   No database, no server-side storage. Everything can be
   exported or deleted from the Privacy section.
   ============================================================ */

const PREFIX = "patientai.";

export const K = {
  consent: "consent",
  profile: "profile",
  levels: "levels",
  clinician: "clinician",
  sessions: "sessions",
  settings: "settings",
  accounts: "accounts",
  session: "session",
};

const USER_KEYS = new Set([
  K.profile,
  K.levels,
  K.clinician,
  K.sessions,
  K.settings,
]);

function currentEmail() {
  return readBrowserSession()?.email || "";
}

function fullKey(key) {
  if (USER_KEYS.has(key)) {
    const email = currentEmail();
    // No signed-in email: never fall back to another account's data.
    if (!email) return PREFIX + "nouser." + key;
    return PREFIX + "user." + encodeURIComponent(email) + "." + key;
  }
  return PREFIX + key;
}

export function get(key, fallback = null) {
  try {
    const raw = localStorage.getItem(fullKey(key));
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(fullKey(key), JSON.stringify(value));
    return true;
  } catch (err) {
    console.error("storage set failed", key, err);
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(fullKey(key));
  } catch {
    /* ignore */
  }
}

/* ---------------- Consent ---------------- */
export const CONSENT_VERSION = 1;

export function getConsent() {
  return get(K.consent, null);
}

export function hasConsent() {
  const c = getConsent();
  return !!(c && c.granted && c.version === CONSENT_VERSION);
}

export function setConsent(granted) {
  set(K.consent, {
    granted: !!granted,
    version: CONSENT_VERSION,
    ts: Date.now(),
  });
}

/* ---------------- Profile ---------------- */
export function getProfile() {
  return get(K.profile, null);
}

/* ---------------- Local account (this browser only) ---------------- */
export function getAccounts() {
  const list = get(K.accounts, []);
  return Array.isArray(list) ? list : [];
}

const SESSION_KEY = "patientai.session";
const WELCOME_KEY = "patientai.pathsWelcome";

function readBrowserSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session && session.email ? session : null;
  } catch {
    return null;
  }
}

function writeBrowserSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  remove(K.session);
}

export function getSession() {
  return readBrowserSession();
}

export function signupAccount({ name, email, password }) {
  const emailKey = String(email || "").trim().toLowerCase();
  const displayName = String(name || "").trim();
  if (!displayName) return { ok: false, error: "Please enter your name." };
  if (!emailKey || !emailKey.includes("@")) return { ok: false, error: "Please enter a valid email." };
  if (!password || String(password).length < 4) return { ok: false, error: "Use a password of at least 4 characters." };
  const accounts = getAccounts();
  if (accounts.some((a) => a.email === emailKey)) {
    return { ok: false, error: "That email already has an account in this browser. Log in instead." };
  }
  accounts.push({ name: displayName, email: emailKey, password: String(password) });
  set(K.accounts, accounts);
  writeBrowserSession({ email: emailKey, name: displayName });
  sessionStorage.removeItem(WELCOME_KEY);
  return { ok: true };
}

export function loginAccount({ email, password }) {
  const emailKey = String(email || "").trim().toLowerCase();
  const account = getAccounts().find((a) => a.email === emailKey && a.password === String(password || ""));
  if (!account) return { ok: false, error: "Those details don't match an account saved in this browser." };
  writeBrowserSession({ email: account.email, name: account.name });
  sessionStorage.removeItem(WELCOME_KEY);
  return { ok: true };
}

export function logoutAccount() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  try { sessionStorage.removeItem(WELCOME_KEY); } catch { /* ignore */ }
  remove(K.session);
}

export function saveProfile(profile) {
  const existing = getProfile();
  const merged = {
    ...profile,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  set(K.profile, merged);
  return merged;
}

/* ---------------- Levels (user-controlled difficulty) ---------------- */
export function getLevels() {
  return get(K.levels, {});
}

export function setLevel(pathId, level) {
  const levels = getLevels();
  levels[pathId] = level;
  set(K.levels, levels);
}

/* ---------------- Clinician configuration ---------------- */
export function getClinician() {
  return get(K.clinician, {});
}

export function saveClinician(pathId, config) {
  const all = getClinician();
  all[pathId] = { ...config, savedAt: Date.now() };
  set(K.clinician, all);
}

export function clearClinician(pathId) {
  const all = getClinician();
  delete all[pathId];
  set(K.clinician, all);
}

/* ---------------- Sessions ---------------- */
export function getSessions() {
  const list = get(K.sessions, []);
  return Array.isArray(list) ? list : [];
}

export function logSession(session) {
  const list = getSessions();
  const record = {
    id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    ...session,
  };
  list.push(record);
  // Safety valve: keep the last 500 sessions so localStorage never fills up.
  while (list.length > 500) list.shift();
  set(K.sessions, list);
  return record;
}

export function clearSessions() {
  set(K.sessions, []);
}

export function updateSession(id, patch) {
  const list = getSessions();
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch };
  set(K.sessions, list);
  return list[idx];
}

/* ---------------- Settings ---------------- */
export function getSettings() {
  return {
    tts: true,
    autoListen: true,
    conversationLanguage: "auto",
    conversationMode: "casual",
    ...(get(K.settings, {}) || {}),
  };
}

export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  set(K.settings, s);
  return s;
}

/* ---------------- Export / delete ---------------- */
function allKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

export function exportAll() {
  const data = {};
  for (const key of allKeys()) {
    try {
      data[key] = JSON.parse(localStorage.getItem(key));
    } catch {
      data[key] = localStorage.getItem(key);
    }
  }
  return {
    app: "Dr. Sturgis",
    note: "Student prototype. Not a medical device. Data exported voluntarily by the user.",
    exportedAt: new Date().toISOString(),
    data,
  };
}

export function deleteAll() {
  for (const key of allKeys()) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(WELCOME_KEY);
  } catch { /* ignore */ }
}

export function storageUsageBytes() {
  let total = 0;
  for (const key of allKeys()) {
    total += (localStorage.getItem(key) || "").length + key.length;
  }
  return total;
}
