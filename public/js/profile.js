/* ============================================================
   profile.js - first-time profile setup (self-selected
   preferences, never diagnoses) + caregiver-assisted setup
   for children. No names, birth dates or identifying details
   are collected - age group only.
   ============================================================ */

import { el, clear, $, toast, emit, explainDetails, fmtDate } from "./ui.js";
import { getProfile, saveProfile } from "./storage.js";
import { CONVERSATION_LANGUAGES } from "./agent.js";

export const AGE_GROUPS = [
  { id: "child", label: "Child", hint: "Ages roughly 5–12 · caregiver-assisted setup" },
  { id: "teenager", label: "Teenager", hint: "Roughly 13–17" },
  { id: "adult", label: "Adult", hint: "18 and over" },
];

export const NEED_OPTIONS = [
  { id: "stuttering", label: "Stuttering", hint: "Repetitions, or difficulty getting words started" },
  { id: "aphasia", label: "Aphasia", hint: "Finding words and building sentences" },
  { id: "dysarthria", label: "Dysarthria", hint: "Articulation & intelligibility practice" },
  { id: "apraxia", label: "Apraxia of speech", hint: "Sequencing the movements of speech" },
  { id: "abi", label: "Acquired brain injury", hint: "Working toward communication goals" },
  { id: "general", label: "General speech practice", hint: "Confidence and everyday practice" },
];

export const ACTIVITY_PREFS = [
  "Supportive conversation",
  "Picture naming & word games",
  "Storytelling",
  "Reading aloud",
  "Role-play & social situations",
  "Sentence building",
  "Awareness & reflection",
  "Repetition drills (only if a clinician suggested them)",
];

export const COMFORT_LABELS = {
  1: "1 · Very unsure",
  2: "2 · Nervous",
  3: "3 · Getting there",
  4: "4 · Fairly comfortable",
  5: "5 · Very comfortable",
};

export function needLabel(id) {
  return NEED_OPTIONS.find((n) => n.id === id)?.label || id;
}

export function ageLabel(id) {
  return AGE_GROUPS.find((n) => n.id === id)?.label || id;
}

export function languageLabel(id) {
  return CONVERSATION_LANGUAGES.find((n) => n.id === id)?.label || "Auto-detect / device language";
}

/* ------------------------------------------------------------------
   Render
------------------------------------------------------------------ */
export function renderProfile() {
  const root = $("#profile-root");
  if (!root) return;
  clear(root);
  const profile = getProfile();
  if (profile) root.append(renderSummary(profile));
  else root.append(renderWizard(null));
}

/* ------------------------------------------------------------------
   Summary (after setup)
------------------------------------------------------------------ */
function renderSummary(profile) {
  const card = el("div", { class: "card" });
  card.append(
    el("div", { class: "card-head" }, [
      el("h3", { text: "Your practice profile" }),
      el("button", {
        class: "btn btn-small",
        text: "Edit profile",
        onclick: () => {
          clear($("#profile-root")).append(renderWizard(profile));
        },
      }),
    ]),
    el("p", { class: "muted", text: "Saved in this browser only · created " + fmtDate(profile.createdAt) })
  );

  const rows = [
    ["Age group", ageLabel(profile.ageGroup)],
    [
      "Practice interests (self-selected)",
      (profile.needs || []).map((n) => el("span", { class: "badge", text: needLabel(n), style: "margin:2px 4px 2px 0" })),
    ],
    ["Personal goals", profile.goals || "—"],
    ["Comfort level", COMFORT_LABELS[profile.comfort] || String(profile.comfort)],
    ["Conversation language", languageLabel(profile.language)],
  ];
  if (profile.ageGroup === "child") {
    rows.push([
      "Caregiver-assisted setup",
      profile.caregiverAssisted ? "Yes — a caregiver helped set this up" : "Not confirmed",
    ]);
  }

  const table = el("table", { class: "data" }, [
    el("tbody", {}, rows.map(([k, v]) =>
      el("tr", {}, [
        el("th", { text: k, attrs: { scope: "row" } }),
        el("td", Array.isArray(v) ? {} : { text: String(v) }, Array.isArray(v) ? v : []),
      ])
    )),
  ]);
  card.append(table);

  card.append(
    el("div", { class: "notice", style: "margin-top:12px" }, [
      el("strong", { text: "Reminder: " }),
      document.createTextNode(
        "these are your own practice preferences, not diagnoses. Dr. Sturgis does not diagnose any condition."
      ),
    ])
  );
  return card;
}

/* ------------------------------------------------------------------
   Wizard (setup / edit)
------------------------------------------------------------------ */
function renderWizard(existing) {
  const isEdit = !!existing;
  const form = el("form", { class: "card", novalidate: true });

  form.append(
    el("h3", { text: isEdit ? "Edit your profile" : "Set up your practice profile" }),
    el("p", { class: "muted", text: isEdit
      ? "Changes take effect right away. Your past sessions stay as they are."
      : "Takes about a minute. Everything you choose here is a preference you select yourself — never a diagnosis." })
  );

  /* ---- Age group ---- */
  const ageInputs = [];
  const ageFieldset = el("fieldset", {}, [el("legend", { text: "1 · Which age group fits you?" })]);
  const ageGrid = el("div", { class: "choice-grid" });
  for (const group of AGE_GROUPS) {
    const input = el("input", {
      type: "radio",
      name: "ageGroup",
      value: group.id,
      attrs: { required: true },
    });
    if (existing?.ageGroup === group.id) input.checked = true;
    ageInputs.push(input);
    ageGrid.append(
      el("label", { class: "choice" }, [
        input,
        el("span", {}, [
          el("strong", { text: group.label }),
          el("small", { text: group.hint }),
        ]),
      ])
    );
  }
  ageFieldset.append(ageGrid);
  form.append(ageFieldset);

  /* ---- Caregiver (children) ---- */
  const caregiverBox = el("fieldset", { hidden: true }, [
    el("legend", { text: "Caregiver-assisted setup" }),
    el("div", { class: "notice", style: "margin-bottom:10px" }, [
      el("strong", { text: "For children: " }),
      document.createTextNode(
        "a caregiver should help with setup and supervise practice. We never ask for a child's name or exact age — only the age group above."
      ),
    ]),
  ]);
  const caregiverInput = el("input", { type: "checkbox", name: "caregiver" });
  if (existing?.caregiverAssisted) caregiverInput.checked = true;
  caregiverBox.append(
    el("label", { class: "choice" }, [
      caregiverInput,
      el("span", {}, [
        el("strong", { text: "A caregiver is helping me set this up" }),
        el("small", { text: "Required for children's profiles" }),
      ]),
    ])
  );
  form.append(caregiverBox);

  const syncCaregiver = () => {
    const isChild = ageInputs.some((i) => i.checked && i.value === "child");
    caregiverBox.hidden = !isChild;
  };
  ageInputs.forEach((i) => i.addEventListener("change", syncCaregiver));
  syncCaregiver();

  /* ---- Communication needs ---- */
  const needInputs = [];
  const needFieldset = el("fieldset", {}, [
    el("legend", { text: "2 · What would you like to practise?" }),
    el("p", { class: "muted small", text: "Pick one or more. These are self-selected practice interests — you are not being diagnosed." }),
  ]);
  const needGrid = el("div", { class: "choice-grid" });
  for (const need of NEED_OPTIONS) {
    const input = el("input", { type: "checkbox", name: "need", value: need.id });
    if ((existing?.needs || []).includes(need.id)) input.checked = true;
    needInputs.push(input);
    needGrid.append(
      el("label", { class: "choice" }, [
        input,
        el("span", {}, [
          el("strong", { text: need.label }),
          el("small", { text: need.hint }),
        ]),
      ])
    );
  }
  needFieldset.append(needGrid);
  form.append(needFieldset);

  /* ---- Goals ---- */
  const goalsInput = el("textarea", {
    class: "input",
    name: "goals",
    id: "profile-goals",
    placeholder: "e.g. Order food confidently, tell a short story to my class, speak more comfortably on the phone…",
    attrs: { maxlength: 600 },
  });
  goalsInput.value = existing?.goals || "";
  const goalChips = el("div", { class: "chip-row", style: "margin-top:8px" });
  const SUGGESTED_GOALS = [
    "Feel more confident speaking",
    "Be understood by family and friends",
    "Practise everyday conversations",
    "Get ready for school / work situations",
  ];
  for (const g of SUGGESTED_GOALS) {
    goalChips.append(
      el("button", {
        type: "button",
        class: "chip btn-small",
        text: "+ " + g,
        onclick: () => {
          const cur = goalsInput.value.trim();
          goalsInput.value = cur ? cur.replace(/\s*$/, "") + (cur.endsWith(".") ? " " : "; ") + g : g;
          goalsInput.focus();
        },
      })
    );
  }
  form.append(
    el("fieldset", {}, [
      el("legend", { text: "3 · Your personal goals" }),
      el("label", { attrs: { for: "profile-goals" }, text: "What would you like to work toward?" }),
      goalsInput,
      goalChips,
    ])
  );

  /* ---- Comfort ---- */
  const comfortValue = existing?.comfort ?? 3;
  const comfortOutput = el("output", { class: "range-value", text: COMFORT_LABELS[comfortValue] });
  const comfortInput = el("input", {
    type: "range",
    min: "1",
    max: "5",
    step: "1",
    value: String(comfortValue),
    name: "comfort",
    attrs: { "aria-label": "Comfort level speaking right now" },
  });
  comfortInput.addEventListener("input", () => {
    comfortOutput.textContent = COMFORT_LABELS[comfortInput.value];
  });
  form.append(
    el("fieldset", {}, [
      el("legend", { text: "4 · How comfortable do you feel speaking right now?" }),
      el("div", { class: "range-wrap" }, [comfortInput, comfortOutput]),
      el("p", {
        class: "muted small",
        text: "This is how you feel today — you can change it any time, and practice suggestions follow it. It is never used to score you.",
      }),
    ])
  );

  const languageSelect = el("select", {
    class: "input",
    name: "language",
    attrs: { "aria-label": "Preferred conversation language" },
  });
  for (const option of CONVERSATION_LANGUAGES) {
    const opt = el("option", { text: option.label, attrs: { value: option.id } });
    if ((existing?.language || "auto") === option.id) opt.selected = true;
    languageSelect.append(opt);
  }
  form.append(
    el("fieldset", {}, [
      el("legend", { text: "5 · Conversation language" }),
      el("label", { attrs: { for: "profile-language" }, text: "What language should the practice partner use?" }),
      languageSelect,
      el("p", {
        class: "muted small",
        text: "Auto uses your device language. Hinglish is handled as natural Hindi-English code-mixing; the AI will answer in the language you speak.",
      }),
    ])
  );

  /* ---- Consent + errors ---- */
  const consentBox = el("label", { class: "choice", style: "margin-bottom:10px" }, [
    el("input", { type: "checkbox", name: "ack", attrs: { required: true } }),
    el("span", {
      html:
        "I understand Dr. Sturgis is a <strong>student prototype</strong> — not a medical device or " +
        "substitute for professional care — and that voice features send audio/transcripts to an external AI service.",
    }),
  ]);
  if (existing) consentBox.querySelector("input").checked = true;

  const errorBox = el("p", {
    class: "notice notice-warn",
    role: "alert",
    hidden: true,
  });

  const submitBtn = el("button", {
    type: "submit",
    class: "btn btn-primary",
    text: isEdit ? "Save changes" : "Create my profile",
  });

  form.append(
    el("div", {}, [consentBox, errorBox]),
    el("div", { class: "form-actions" }, [
      submitBtn,
      isEdit
        ? el("button", {
            type: "button",
            class: "btn",
            text: "Cancel",
            onclick: () => renderProfile(),
          })
        : null,
    ]),
    explainDetails(
      "What data does this profile store?",
      "Age group, your chosen practice interests, goals and comfort level — stored only in this browser's localStorage.",
      "No name, no date of birth, no exact age, no audio. Use Privacy → Export to download it or Delete to remove it permanently."
    )
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    const age = ageInputs.find((i) => i.checked)?.value;
    const needs = needInputs.filter((i) => i.checked).map((i) => i.value);
    const ack = consentBox.querySelector("input").checked;

    if (!age) return fail("Please choose an age group.");
    if (age === "child" && !caregiverInput.checked) {
      return fail("Children's profiles need a caregiver to confirm they are helping with setup.");
    }
    if (needs.length === 0) return fail("Please pick at least one thing to practise.");
    if (!ack) return fail("Please confirm the prototype notice before saving.");

    const profile = saveProfile({
      ageGroup: age,
      needs,
      goals: goalsInput.value.trim(),
      activities: [],
      comfort: Number(comfortInput.value),
      language: languageSelect.value || "auto",
      caregiverAssisted: age === "child" ? caregiverInput.checked : undefined,
    });

    toast(isEdit ? "Profile updated." : "Profile created — your practice paths are ready!");
    emit("patientai:profile", { profile });
    renderProfile();
    return true;

    function fail(message) {
      errorBox.textContent = message;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: "nearest" });
      return false;
    }
  });

  return form;
}
