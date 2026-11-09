/* ============================================================
   privacy.js - Privacy & Data section.

   * Shows exactly what is stored and what leaves the device.
   * Consent status + re-review.
   * Export / delete controls (local storage only, no database).
   * Child-data and external-service disclosures.
   ============================================================ */

import {
  $, el, clear, openModal, closeModal, toast, explainDetails, on, emit,
  fmtDateTime, downloadJson, confirmAction, showConsentModal,
} from "./ui.js";
import {
  getProfile, getSessions, getConsent, setConsent, exportAll, deleteAll,
  clearSessions, storageUsageBytes, hasConsent,
} from "./storage.js";

export function renderPrivacy() {
  const root = $("#privacy-root");
  if (!root) return;
  clear(root);

  const consent = getConsent();
  const profile = getProfile();
  const sessions = getSessions();
  const bytes = storageUsageBytes();

  /* ---- Consent ---- */
  root.append(
    el("div", { class: "card" }, [
      el("h3", { text: "Recording & AI consent" }),
      el("p", {}, [
        document.createTextNode(
          hasConsent()
            ? "You agreed to use voice features. Audio and transcripts are sent to Google Gemini when you record or hold a live conversation."
            : "You chose to browse without recording. Voice features stay disabled until you agree."
        ),
        consent?.ts ? el("span", { class: "muted small", text: " (decision saved " + fmtDateTime(consent.ts) + ")" }) : null,
      ]),
      el("div", { class: "btn-row" }, [
        el("button", {
          type: "button",
          class: hasConsent() ? "btn" : "btn btn-primary",
          text: hasConsent() ? "Review consent again" : "Allow voice features",
          onclick: async () => {
            await showConsentModal();
            emit("patientai:consent", { granted: hasConsent() });
            renderPrivacy();
          },
        }),
        hasConsent()
          ? el("button", {
              type: "button", class: "btn btn-danger",
              text: "Withdraw consent (disable voice)",
              onclick: async () => {
                if (!confirmAction("Withdraw consent? Recording and live conversation will be disabled until you agree again.")) return;
                setConsent(false);
                emit("patientai:consent", { granted: false });
                toast("Consent withdrawn. Voice features disabled.");
                renderPrivacy();
              },
            })
          : null,
      ]),
    ])
  );

  /* ---- What's stored / what's shared ---- */
  root.append(
    el("div", { class: "card", style: "margin-top:14px" }, [
      el("h3", { text: "What Dr. Sturgis stores — and what leaves your device" }),
      el("div", { class: "table-wrap" }, [
        el("table", { class: "data" }, [
          el("thead", {}, [el("tr", {}, ["Data", "Where it lives", "When it leaves your device"]
            .map((h) => el("th", { text: h, attrs: { scope: "col" } })))]),
          el("tbody", {}, [
            ["Profile (age group, practice interests, goals, comfort)",
              "This browser's localStorage", "Never, unless you start a conversation (sent as context to Gemini)"],
            ["Sessions, reflections, measurements",
              "This browser's localStorage", "Never — analysis runs on your local backend"],
            ["Typed chat messages",
              "This browser's localStorage (history is in-page only)",
              "Sent to Google Gemini via the local backend for replies"],
            ["Spoken words",
              "Not stored as audio", "Your browser turns speech into text, then that text is sent to Google Gemini for a reply"],
            ["Live-conversation transcripts",
              "Saved to localStorage after analysis",
              "Speech is converted to text by your browser/its vendor service, then text goes to Gemini"],
            ["API keys", "Server only (.env / environment)",
              "Never sent to the browser"],
          ].map(([a, b, c]) => el("tr", {}, [
            el("td", { text: a }), el("td", { text: b }), el("td", { text: c }),
          ]))),
        ]),
      ]),
      el("p", { class: "muted small", style: "margin-top:10px", text:
        `Currently using about ${(bytes / 1024).toFixed(1)} KB of browser storage across ${sessions.length} session(s).` }),
      explainDetails(
        "External AI services",
        "Dr. Sturgis's local backend forwards your messages (and, when you record, your audio) to Google Gemini to generate replies and transcripts. Your API key never leaves the server.",
        "Review Google's privacy policy for how Gemini handles data. If you prefer, simply don't use the voice/chat features — profile, practice activities and local analysis all work offline."
      ),
    ])
  );

  /* ---- Children ---- */
  root.append(
    el("div", { class: "card", style: "margin-top:14px" }, [
      el("h3", { text: "Children's data" }),
      el("p", { class: "muted", text:
        "For children we collect an age group only — never a name, birth date, school, location or any other identifying detail. " +
        "Caregiver-assisted setup is required for child profiles. We suggest children practise with a caregiver present, and that " +
        "caregivers review exported data before sharing it." }),
    ])
  );

  /* ---- Your data controls ---- */
  root.append(
    el("div", { class: "card", style: "margin-top:14px" }, [
      el("h3", { text: "Your data controls" }),
      el("p", { class: "muted", text: "Everything is stored locally in this browser. You are always in control." }),
      el("div", { class: "btn-row" }, [
        el("button", {
          type: "button", class: "btn btn-primary",
          text: "⬇ Export all data (JSON)",
          onclick: () => {
            const data = exportAll();
            downloadJson(`dr-sturgis-data-${new Date().toISOString().slice(0, 10)}.json`, data);
            toast("Export downloaded. Store it somewhere safe.");
          },
        }),
        el("button", {
          type: "button", class: "btn",
          text: "🗑 Delete session history only",
          attrs: { disabled: sessions.length ? null : "" },
          onclick: () => {
            if (!confirmAction(`Delete all ${sessions.length} session(s) and their reflections? This cannot be undone.`)) return;
            clearSessions();
            toast("Session history deleted.");
            emit("patientai:data");
            renderPrivacy();
          },
        }),
        el("button", {
          type: "button", class: "btn btn-danger",
          text: " Delete everything",
          onclick: openDeleteAllDialog,
        }),
      ]),
      el("p", { class: "muted small", style: "margin-top:10px", text:
        "“Delete everything” removes your profile, sessions, consent and settings from this browser immediately. There is no server-side copy — Dr. Sturgis has no database." }),
    ])
  );

  /* ---- About / disclaimer ---- */
  root.append(
    el("div", { class: "card", style: "margin-top:14px" }, [
      el("h3", { text: "About Dr. Sturgis" }),
      el("p", {}, [
        el("strong", { text: "Dr. Sturgis is a student prototype. " }),
        document.createTextNode(
          "It is not a medical device, not a diagnostic tool, not a treatment, and not a substitute for " +
          "professional care. It does not diagnose any condition. All measurements shown are experimental " +
          "estimates for self-reflection — never clinical measurements. Always consult a qualified " +
          "speech-language pathologist for advice about speech and language."
        ),
      ]),
      el("p", { class: "muted small", text:
        "Condition-specific activities are self-practice or clinician-configured — nothing in this app has been " +
        "claimed as clinically validated. Dysarthria, apraxia of speech and acquired-brain-injury activities run " +
        "only from a configuration provided by a clinician." }),
    ])
  );
}

function openDeleteAllDialog() {
  const input = el("input", {
    class: "input",
    attrs: { placeholder: "Type DELETE to confirm", "aria-label": "Type DELETE to confirm" },
  });
  const error = el("p", { class: "notice notice-warn", role: "alert", hidden: true, text: "Please type DELETE exactly." });

  const body = el("div", {}, [
    el("p", { text: "This permanently removes your profile, sessions, consent and settings from this browser. " +
      "It cannot be undone — export your data first if you want a copy." }),
    el("label", { text: "Type DELETE to confirm" }),
    input,
    error,
    el("div", { class: "btn-row", style: "margin-top:12px" }, [
      el("button", {
        type: "button", class: "btn btn-danger",
        text: "Delete all my data",
        onclick: () => {
          if (input.value.trim().toUpperCase() !== "DELETE") {
            error.hidden = false;
            input.focus();
            return;
          }
          deleteAll();
          closeModal();
          toast("All Dr. Sturgis data deleted from this browser.");
          // Re-render everything to first-run state
          window.location.hash = "profile";
          window.location.reload();
        },
      }),
      el("button", { type: "button", class: "btn", text: "Cancel", onclick: closeModal }),
    ]),
  ]);

  openModal("Delete all data", body);
}

// Re-render when data changes elsewhere
on("patientai:data", () => {
  const section = $("#section-privacy");
  if (section && !section.hidden) renderPrivacy();
});
