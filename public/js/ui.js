/* ============================================================
   ui.js - shared DOM helpers: elements, modal, toast, formatters,
   accessible experimental-measurement explainers, consent gate.
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Create a DOM element.
 * el("button", { class: "btn", text: "Hi", onclick: fn, attrs: {...} }, [children])
 */
const FILLER_WORDS = new Set(["um", "uh", "er", "ah", "hmm", "umm", "uhh", "erm", "mmm"]);

/** Put repeated words and fillers inside the transcript itself. */
export function appendMarkedTranscript(parent, text) {
  const tokens = String(text || "").split(/(\s+)/);
  let prevKey = "";
  let prevSpan = null;
  for (const token of tokens) {
    if (!token) continue;
    if (!token.trim()) {
      parent.append(document.createTextNode(token));
      continue;
    }
    const key = token.toLowerCase().replace(/[^a-z']/g, "");
    const stutter = /^[a-z]{1,4}(?:-[a-z]{1,8})+$/i.test(token.replace(/[^a-z-]/gi, ""));
    const span = document.createElement("span");
    span.textContent = token;
    if (key && FILLER_WORDS.has(key)) {
      span.className = "mark-filler";
      span.title = "Filler word";
    } else if (stutter) {
      span.className = "mark-repeat";
      span.title = "Repeated sound";
    } else if (key && key === prevKey) {
      span.className = "mark-repeat";
      span.title = "Repeated word";
      if (prevSpan && !prevSpan.classList.contains("mark-filler")) {
        prevSpan.classList.add("mark-repeat");
        prevSpan.title = "Repeated word";
      }
    }
    parent.append(span);
    if (key) {
      prevKey = key;
      prevSpan = span;
    }
  }
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "attrs") {
      for (const [a, v] of Object.entries(value)) {
        if (v === null || v === undefined || v === false) continue;
        node.setAttribute(a, v === true ? "" : String(v));
      }
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------- Tiny event bus ---------------- */
export function emit(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, handler) {
  document.addEventListener(name, handler);
}

/* ---------------- Toast + live announcements ---------------- */
let toastTimer = null;

export function toast(message, { error = false, ms = 3600 } = {}) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  node.classList.toggle("is-error", !!error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, ms);
}

export function announce(message) {
  const node = $("#sr-status");
  if (!node) return;
  node.textContent = "";
  setTimeout(() => {
    node.textContent = message;
  }, 30);
}

/* ---------------- Modal ---------------- */
let lastFocused = null;
let modalCloseHandler = null;

export function openModal(title, content, { onClose = null, wide = false } = {}) {
  const backdrop = $("#app-modal");
  const titleNode = $("#app-modal-title");
  const body = clear($("#app-modal-body"));
  titleNode.textContent = title;
  if (content) body.append(content);
  const modal = backdrop.querySelector(".modal");
  if (wide) modal.style.maxWidth = "820px";
  else modal.style.maxWidth = "";
  lastFocused = document.activeElement;
  modalCloseHandler = onClose;
  backdrop.hidden = false;
  // Focus first focusable element for keyboard users
  const focusable = backdrop.querySelector(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  (focusable || modal).focus();
  return body;
}

export function closeModal() {
  const backdrop = $("#app-modal");
  if (!backdrop || backdrop.hidden) return;
  backdrop.hidden = true;
  clear($("#app-modal-body"));
  const handler = modalCloseHandler;
  modalCloseHandler = null;
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
  if (handler) handler();
}

export function initModal() {
  $("#app-modal-close")?.addEventListener("click", closeModal);
  $("#app-modal")?.addEventListener("mousedown", (e) => {
    if (e.target.id === "app-modal") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#app-modal").hidden) closeModal();
  });
}

/* ---------------- Formatters ---------------- */
export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

export function fmtNum(value, digits = 1) {
  if (value === null || value === undefined || isNaN(value)) return "—";
  return Number(value).toFixed(digits).replace(/\.0$/, "");
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}

/* ---------------- Experimental measurement explainer ---------------- */
/**
 * A <details> block explaining what an experimental measurement means,
 * how it is computed and what it cannot detect. Every metric card uses this.
 */
export function explainDetails(summaryText, what, limits) {
  const body = el("div", { class: "explain-body" }, [
    el("p", { text: what }),
    el("p", { text: limits }),
  ]);
  return el("details", { class: "explain" }, [
    el("summary", { text: summaryText || "What does this mean?" }),
    body,
  ]);
}

/** Standard disclaimer block used under every analysis/insight panel. */
export function limitationNotice(text) {
  return el("div", { class: "notice notice-warn", role: "note" }, [
    el("strong", { text: "Experimental estimate — not a clinical measurement. " }),
    document.createTextNode(text),
  ]);
}

/* ---------------- Confirmation ---------------- */
export function confirmAction(message) {
  return window.confirm(message);
}

/* ---------------- Consent gate ---------------- */
import { hasConsent, setConsent } from "./storage.js";

export function consentGranted() {
  return hasConsent();
}

/**
 * Show the blocking consent modal. Resolves true if the user agreed,
 * false if they chose to browse without recording.
 */
export function showConsentModal() {
  return new Promise((resolve) => {
    const modal = $("#consent-modal");
    if (!modal) {
      resolve(false);
      return;
    }
    modal.hidden = false;
    const agree = $("#consent-agree");
    const decline = $("#consent-decline");

    const finish = (granted) => {
      setConsent(granted);
      modal.hidden = true;
      agree.removeEventListener("click", onAgree);
      decline.removeEventListener("click", onDecline);
      resolve(granted);
    };
    const onAgree = () => finish(true);
    const onDecline = () => finish(false);
    agree.addEventListener("click", onAgree);
    decline.addEventListener("click", onDecline);
    agree.focus();
  });
}

/** Require consent before a voice feature; opens the modal if missing. */
export async function requireConsentFor(featureLabel) {
  if (consentGranted()) return true;
  const ok = await showConsentModal();
  if (!ok) {
    toast(`Recording consent is needed for ${featureLabel}. You can browse without it.`, {
      error: true,
      ms: 4200,
    });
  }
  return ok;
}

/* ---------------- Misc ---------------- */
export function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadJson(filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2), "application/json");
}
