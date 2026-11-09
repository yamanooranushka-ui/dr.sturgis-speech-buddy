/* ============================================================
   app.js - boot, navigation, consent, system banner.
   ============================================================ */

import { $, $$, el, toast, initModal, showConsentModal, on, emit } from "./ui.js";
import { hasConsent, getProfile, getSession, getSessions, signupAccount, loginAccount, logoutAccount } from "./storage.js";
import { renderProfile } from "./profile.js";
import { renderPaths } from "./activities.js";
import { initLive, refreshLive } from "./live.js";
import { renderInsights } from "./insights.js";
import { renderProgress } from "./progress.js";
import { renderPrivacy } from "./privacy.js";

const SECTIONS = ["profile", "paths", "live", "insights", "progress", "privacy"];
let currentSection = null;

function setNavOpen(open) {
  const nav = $("#main-nav");
  const toggle = $("#nav-toggle");
  const backdrop = $("#nav-backdrop");
  if (nav) nav.classList.toggle("is-open", open);
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
  if (backdrop) backdrop.hidden = !open;
  const lock = open && window.matchMedia("(max-width: 860px)").matches;
  for (const node of [document.querySelector(".app-footer"), $("#main"), $("#system-banner")]) {
    if (node) node.inert = lock;
  }
}

export function showSection(name, { updateHash = true, focus = true } = {}) {
  if (!SECTIONS.includes(name)) name = "paths";
  currentSection = name;

  for (const section of SECTIONS) {
    const node = $("#section-" + section);
    if (node) node.hidden = section !== name;
  }
  $$(".nav-btn").forEach((btn) => {
    if (btn.dataset.section === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  if (updateHash && location.hash.slice(1) !== name) {
    history.replaceState(null, "", "#" + name);
  }

  // Close the mobile menu after navigating
  setNavOpen(false);

  // Re-render dynamic sections when shown
  if (name === "profile") renderProfile();
  if (name === "paths") renderPaths();
  if (name === "insights") renderInsights();
  if (name === "progress") renderProgress();
  if (name === "privacy") renderPrivacy();
  if (name === "live") refreshLive();

  if (focus) $("#main")?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initNav() {
  $$(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showSection(btn.dataset.section));
  });

  const toggle = $("#nav-toggle");
  toggle?.addEventListener("click", () => {
    const open = !$("#main-nav")?.classList.contains("is-open");
    setNavOpen(open);
    if (open) $("#main-nav .nav-btn")?.focus();
  });

  $("#nav-backdrop")?.addEventListener("click", () => {
    setNavOpen(false);
    toggle?.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#main-nav")?.classList.contains("is-open")) {
      setNavOpen(false);
      toggle?.focus();
    }
  });

  window.matchMedia("(max-width: 860px)").addEventListener("change", (e) => {
    if (!e.matches) setNavOpen(false);
  });

  // Any element with data-goto="section" navigates there
  document.addEventListener("click", (e) => {
    const target = e.target.closest?.("[data-goto]");
    if (target) showSection(target.dataset.goto);
  });

  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (SECTIONS.includes(name) && name !== currentSection) {
      showSection(name, { updateHash: false });
    }
  });
}

async function checkSystem() {
  const banner = $("#system-banner");
  if (!banner || banner.dataset.checked) return;
  banner.dataset.checked = "1";
  try {
    const resp = await fetch("/api/health");
    const data = await resp.json();
    if (data.mock) {
      banner.hidden = false;
      banner.append(
        el("span", {
          html:
            "<strong>Demo mode:</strong> no <code>GEMINI_API_KEY</code> found on this machine. " +
            "Conversation and transcription replies are simulated. Copy <code>.env.example</code> " +
            "to <code>.env</code>, add your key, and restart the server for real AI replies.",
        })
      );
    }
  } catch {
    banner.hidden = false;
    banner.textContent =
      "Cannot reach the Dr. Sturgis backend. Make sure server.py is running, then reload.";
  }
}

function initEventHandlers() {
  on("patientai:consent", () => {
    refreshLive();
  });
  on("patientai:profile", () => {
    renderPaths();
  });
}

function initRenderers() {
  renderProfile();
  renderPaths();
  initLive();
  renderInsights();
  renderProgress();
  renderPrivacy();
}

let appReady = false;

function showSignedIn(session) {
  const label = $("#signed-in-as");
  if (label) label.textContent = session?.name ? `Signed in as ${session.name}` : "";
}

async function enterApp() {
  const session = getSession();
  if (!session) return;
  document.body.classList.add("is-authed");
  showSignedIn(session);
  if (!appReady) {
    initNav();
    initRenderers();
    initEventHandlers();
    $("#logout-btn")?.addEventListener("click", () => {
      logoutAccount();
      document.body.classList.remove("is-authed");
      toast("Logged out.");
    });
    appReady = true;
  }
  refreshLive();
  renderProfile();
  const practiced = getSessions().some((s) => s.activityId && s.activityId !== "conversation");
  showSection(practiced ? "paths" : "profile", { updateHash: true, focus: false });
  checkSystem();
  if (!hasConsent()) {
    const granted = await showConsentModal();
    emit("patientai:consent", { granted });
    if (granted) toast("Thanks — voice features are now available.");
  }
}

function initAuth() {
  const form = $("#auth-form");
  const nameWrap = $("#auth-name-wrap");
  const error = $("#auth-error");
  const submit = $("#auth-submit");
  const title = $("#auth-title");
  const nameInput = $("#auth-name");
  const password = $("#auth-password");
  let mode = "signup";

  const setMode = (next) => {
    mode = next;
    const signup = mode === "signup";
    nameWrap.hidden = !signup;
    nameInput.required = signup;
    title.textContent = signup ? "Create your account" : "Log in";
    submit.textContent = signup ? "Create account" : "Log in";
    password.setAttribute("autocomplete", signup ? "new-password" : "current-password");
    $("#auth-tab-signup")?.classList.toggle("btn-primary", signup);
    $("#auth-tab-login")?.classList.toggle("btn-primary", !signup);
    error.hidden = true;
  };

  $("#auth-tab-signup")?.addEventListener("click", () => setMode("signup"));
  $("#auth-tab-login")?.addEventListener("click", () => setMode("login"));

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: nameInput.value,
      email: $("#auth-email").value,
      password: password.value,
    };
    const result = mode === "signup" ? signupAccount(payload) : loginAccount(payload);
    if (!result.ok) {
      error.hidden = false;
      error.textContent = result.error;
      return;
    }
    error.hidden = true;
    form.reset();
    setMode("signup");
    await enterApp();
  });
}

async function boot() {
  initModal();
  initAuth();
  if (new URLSearchParams(location.search).has("login")) {
    logoutAccount();
    document.body.classList.remove("is-authed");
    $("#auth-tab-login")?.click();
    history.replaceState(null, "", location.pathname);
    return;
  }
  if (getSession()) await enterApp();
}

boot();
