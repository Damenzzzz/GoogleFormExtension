const STORAGE_KEYS = {
  profile: "localAiProfile",
  preferences: "localAiPreferences",
  optionalInstructions: "localAiOptionalInstructions",
  form: "localAiLastForm",
  draft: "localAiDraft",
  rawAIResponse: "localAiRawAIResponse",
  status: "localAiStatus"
};

const PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "city",
  "country",
  "age",
  "occupation",
  "universityOrCompany",
  "education",
  "skills",
  "experience",
  "languages",
  "shortBio",
  "motivation"
];

const DEFAULT_STATUS = {
  formStatus: "Not analyzed",
  questionsFound: 0,
  aiStatus: "Idle",
  fillStatus: "Not filled"
};

const state = {
  form: null,
  draft: null,
  editedAnswers: {},
  rawAIResponse: "",
  rawResponseVisible: false,
  status: { ...DEFAULT_STATUS },
  busy: false,
  highlightTimer: null
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadStoredState();
  await refreshActiveTabLabel();
  renderStatus();
  renderPreview();
}

function bindEvents() {
  $("saveProfileBtn").addEventListener("click", saveProfile);
  $("analyzeBtn").addEventListener("click", analyzeForm);
  $("generateBtn").addEventListener("click", generateAnswers);
  $("previewBtn").addEventListener("click", previewAnswers);
  $("fillBtn").addEventListener("click", () => fillAnswers("safe"));
  $("fillAllBtn").addEventListener("click", () => fillAnswers("all"));
  $("clearBtn").addEventListener("click", clearDraft);
  $("rawToggleBtn").addEventListener("click", toggleRawResponse);
  $("previewList").addEventListener("input", handlePreviewEdit);
  $("previewList").addEventListener("change", handlePreviewEdit);
  $("previewList").addEventListener("click", handlePreviewAction);
}

async function loadStoredState() {
  const stored = await chromeGet([
    STORAGE_KEYS.profile,
    STORAGE_KEYS.preferences,
    STORAGE_KEYS.optionalInstructions,
    STORAGE_KEYS.form,
    STORAGE_KEYS.draft,
    STORAGE_KEYS.rawAIResponse,
    STORAGE_KEYS.status
  ]);

  setProfileFormValues(stored[STORAGE_KEYS.profile] || {});
  setPreferencesFormValues(stored[STORAGE_KEYS.preferences] || {});
  $("optionalInstructions").value = stored[STORAGE_KEYS.optionalInstructions] || "";

  state.form = stored[STORAGE_KEYS.form] || null;
  state.draft = stored[STORAGE_KEYS.draft] || null;
  state.rawAIResponse = state.draft?.rawResponse || stored[STORAGE_KEYS.rawAIResponse] || "";
  state.editedAnswers = {};
  state.status = {
    ...DEFAULT_STATUS,
    ...(stored[STORAGE_KEYS.status] || {})
  };
}

async function refreshActiveTabLabel() {
  try {
    const tab = await getActiveTab();
    const isForm = isGoogleFormUrl(tab?.url || "");
    $("activePageLabel").textContent = isForm ? "Google Form detected" : "Open a Google Form";
  } catch {
    $("activePageLabel").textContent = "Open a Google Form";
  }
}

async function saveProfile() {
  await persistProfile(true);
}

async function persistProfile(showNotification) {
  const profile = getProfileFromForm();
  const preferences = getPreferencesFromForm();
  const optionalInstructions = $("optionalInstructions").value.trim();

  await chromeSet({
    [STORAGE_KEYS.profile]: profile,
    [STORAGE_KEYS.preferences]: preferences,
    [STORAGE_KEYS.optionalInstructions]: optionalInstructions
  });

  if (showNotification) {
    showToast("Profile saved locally.");
  }
}

async function analyzeForm() {
  await runBusy(async () => {
    const tab = await getActiveTab();

    if (!isGoogleFormUrl(tab?.url || "")) {
      throw new Error("Open a Google Forms page before analyzing.");
    }

    setStatus({
      formStatus: "Analyzing",
      aiStatus: state.status.aiStatus === "Error" ? "Idle" : state.status.aiStatus
    });

    const response = await sendToActiveTab({ type: "ANALYZE_FORM" });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not analyze this Google Form.");
    }

    state.form = response.form;
    state.draft = null;
    state.editedAnswers = {};
    state.rawAIResponse = "";
    state.rawResponseVisible = false;

    setStatus({
      formStatus: "Analyzed",
      questionsFound: response.form?.questions?.length || 0,
      aiStatus: "Idle",
      fillStatus: "Not filled"
    });

    await chromeSet({
      [STORAGE_KEYS.form]: state.form,
      [STORAGE_KEYS.draft]: null,
      [STORAGE_KEYS.rawAIResponse]: "",
      [STORAGE_KEYS.status]: state.status
    });

    await clearFormHighlightsSilently();
    renderPreview();
    showToast(`Form analyzed. Questions found: ${state.status.questionsFound}.`);
  });
}

async function generateAnswers() {
  await runBusy(async () => {
    await persistProfile(false);

    if (!state.form || !Array.isArray(state.form.questions) || state.form.questions.length === 0) {
      throw new Error("Analyze the form before generating answers.");
    }

    setStatus({
      aiStatus: "Generating",
      fillStatus: "Not filled"
    });
    state.rawAIResponse = "";
    state.rawResponseVisible = false;

    const payload = {
      profile: getProfileFromForm(),
      preferences: getPreferencesFromForm(),
      optionalInstructions: $("optionalInstructions").value.trim(),
      form: state.form
    };

    const response = await sendRuntimeMessage({
      type: "GENERATE_ANSWERS",
      payload
    });

    if (!response?.ok) {
      await handleGenerationError(response);
      throw new Error(response?.error?.message || "AI generation failed.");
    }

    state.draft = response.result;
    state.editedAnswers = {};
    state.rawAIResponse = "";
    setStatus({ aiStatus: "Generated" });

    await persistDraft();
    renderPreview();

    try {
      await previewAnswersOnForm();
    } catch (error) {
      console.warn("Preview highlight failed after generation:", error);
    }

    const count = state.draft?.answers?.length || 0;
    showToast(`Generated ${count} answers. Review and edit before filling.`);
  });
}

async function handleGenerationError(response) {
  if (!response?.error?.rawResponse) {
    return;
  }

  const rawResponse = String(response.error.rawResponse);
  state.draft = {
    answers: [],
    warnings: ["AI returned a response that could not be parsed as the expected JSON."],
    rawResponse
  };
  state.rawAIResponse = rawResponse;
  state.rawResponseVisible = false;
  setStatus({ aiStatus: "Error" });

  await persistDraft();
  renderPreview();
  console.error("Raw AI response:", response.error.rawResponse);
}

async function previewAnswers() {
  renderPreview();

  if (!hasPreviewAnswers()) {
    showToast("Generate answers first.");
    return;
  }

  try {
    await previewAnswersOnForm();
    showToast("Preview highlighted on the Google Form.");
  } catch (error) {
    showToast(error?.message || "Could not highlight answers on the form.");
  }
}

async function previewAnswersOnForm() {
  if (!hasPreviewAnswers() || !state.form) {
    return;
  }

  await sendToActiveTab({
    type: "PREVIEW_ANSWERS_ON_FORM",
    payload: {
      answers: state.draft.answers,
      questions: state.form.questions || []
    }
  });
}

async function fillAnswers(mode) {
  await runBusy(async () => {
    if (!state.form || !hasPreviewAnswers()) {
      throw new Error("Generate and review answers before filling.");
    }

    const response = await sendToActiveTab({
      type: mode === "all" ? "FILL_ALL_PREVIEWED" : "FILL_SAFE_ANSWERS",
      answers: state.draft.answers || [],
      questions: state.form.questions || []
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not fill answers.");
    }

    const result = response.result || {};
    const filledCount = result.filledCount ?? result.filled ?? 0;
    const skippedCount = result.skippedCount ?? result.skipped ?? 0;
    const fillStatus = filledCount > 0 && skippedCount === 0 ? "Filled" : filledCount > 0 ? "Filled partially" : "Not filled";

    setStatus({ fillStatus });

    await chromeSet({
      [STORAGE_KEYS.status]: state.status
    });

    await clearFormHighlightsSilently();
    showToast(`Filled ${filledCount} answers, skipped ${skippedCount}.`);
  });
}

async function clearDraft() {
  state.form = null;
  state.draft = null;
  state.editedAnswers = {};
  state.rawAIResponse = "";
  state.rawResponseVisible = false;
  state.status = { ...DEFAULT_STATUS };

  await chromeRemove([STORAGE_KEYS.form, STORAGE_KEYS.draft, STORAGE_KEYS.rawAIResponse, STORAGE_KEYS.status]);
  await clearFormHighlightsSilently();
  renderStatus();
  renderPreview();
  showToast("Draft cleared.");
}

function renderPreview() {
  const previewList = $("previewList");
  const warnings = $("warnings");
  const rawToggleBtn = $("rawToggleBtn");
  const rawResponsePanel = $("rawResponsePanel");
  const answers = state.draft?.answers || [];
  const warningItems = state.draft?.warnings || [];
  const rawResponse = String(state.draft?.rawResponse || state.rawAIResponse || "");

  $("previewCount").textContent = answers.length ? `${answers.length} answer(s)` : "No answers";
  rawToggleBtn.classList.toggle("hidden", !rawResponse);
  rawToggleBtn.textContent = state.rawResponseVisible ? "Hide raw AI response" : "Show raw AI response";
  rawResponsePanel.classList.toggle("hidden", !rawResponse || !state.rawResponseVisible);
  rawResponsePanel.value = rawResponse ? rawResponse.slice(0, 12000) : "";

  if (warningItems.length) {
    warnings.classList.remove("hidden");
    warnings.innerHTML = warningItems.map((warning) => `<div class="warning-card">${escapeHtml(warning)}</div>`).join("");
  } else {
    warnings.classList.add("hidden");
    warnings.innerHTML = "";
  }

  if (!answers.length) {
    previewList.innerHTML = rawResponse
      ? `<div class="empty-state">AI returned a response that could not be parsed as the expected JSON. Use Show raw AI response for debugging.</div>`
      : `<div class="empty-state">Generated answers will appear here before anything is filled.</div>`;
    return;
  }

  const questionsById = new Map((state.form?.questions || []).map((question) => [question.id, question]));
  previewList.innerHTML = answers
    .map((answer, index) => renderPreviewCard(answer, questionsById.get(answer.questionId), index))
    .join("");
}

function renderPreviewCard(answer, question, index) {
  const sensitive = Boolean(question?.sensitive);
  const confidence = clampConfidence(answer.confidence);
  const safe = answer.safeToFill === true && !sensitive && confidence >= 0.6 && !isEmptyAnswer(answer.answer);
  const skipped = answer.safeToFill === false || sensitive || isEmptyAnswer(answer.answer);
  const badges = [
    `<span class="badge ${safe ? "safe" : "blocked"}">${safe ? "Safe" : skipped ? "Skipped" : "Review"}</span>`,
    sensitive ? `<span class="badge blocked">Sensitive</span>` : "",
    answer.manualEdited ? `<span class="badge safe">Manual</span>` : "",
    confidence < 0.6 && !answer.manualEdited ? `<span class="badge blocked">Low confidence</span>` : "",
    `<span class="badge">Confidence ${Math.round(confidence * 100)}%</span>`,
    `<span class="badge">${escapeHtml(question?.type || answer.type || "unknown")}</span>`
  ]
    .filter(Boolean)
    .join("");

  return `
    <article class="preview-card" data-answer-index="${index}">
      <div class="preview-card-head">
        <p class="preview-question">${escapeHtml(answer.questionText || question?.questionText || "Question")}</p>
        <div class="badge-row">${badges}</div>
      </div>
      ${renderAnswerEditor(answer, question, index)}
      ${renderOptionsMeta(question)}
      <p class="reason">${escapeHtml(answer.reason || "No reason provided")}</p>
      <div class="preview-card-actions">
        <button class="mini-button" type="button" data-action="use" data-answer-index="${index}">Use</button>
        <button class="mini-button" type="button" data-action="skip" data-answer-index="${index}">Skip</button>
        <button class="mini-button" type="button" data-action="highlight" data-answer-index="${index}">Highlight on form</button>
      </div>
    </article>
  `;
}

function renderAnswerEditor(answer, question, index) {
  const type = question?.type || answer.type || "unknown";
  const options = Array.isArray(question?.options) ? question.options : [];
  const value = answer.answer;

  if (type === "checkbox" && options.length > 0) {
    const selected = new Set(arrayAnswer(value).map(normalizeComparable));
    return `
      <div class="checkbox-editor" data-answer-index="${index}">
        ${options
          .map((option, optionIndex) => {
            const checked = selected.has(normalizeComparable(option)) ? "checked" : "";
            return `
              <label class="checkbox-option">
                <input type="checkbox" data-editor="checkbox" data-answer-index="${index}" value="${escapeAttr(option)}" ${checked}>
                <span>${escapeHtml(option)}</span>
              </label>
            `;
          })
          .join("")}
      </div>
    `;
  }

  if (["radio", "select", "scale"].includes(type) && options.length > 0) {
    const selected = scalarAnswer(value);
    return `
      <select class="preview-answer-editor" data-editor="select" data-answer-index="${index}">
        <option value="">Skip / empty</option>
        ${options
          .map((option) => {
            const isSelected = normalizeComparable(option) === normalizeComparable(selected) ? "selected" : "";
            return `<option value="${escapeAttr(option)}" ${isSelected}>${escapeHtml(option)}</option>`;
          })
          .join("")}
      </select>
    `;
  }

  if (type === "textarea" || String(scalarAnswer(value)).length > 90) {
    return `<textarea class="preview-answer-editor" data-editor="text" data-answer-index="${index}" rows="3">${escapeHtml(scalarAnswer(value))}</textarea>`;
  }

  return `<input class="preview-answer-editor" data-editor="text" data-answer-index="${index}" type="text" value="${escapeAttr(scalarAnswer(value))}">`;
}

function renderOptionsMeta(question) {
  const options = Array.isArray(question?.options) ? question.options : [];

  if (!options.length) {
    return "";
  }

  return `<p class="options-meta">Options: ${escapeHtml(options.join(", "))}</p>`;
}

function handlePreviewEdit(event) {
  const target = event.target;
  const index = Number(target?.dataset?.answerIndex);

  if (!Number.isInteger(index) || !state.draft?.answers?.[index]) {
    return;
  }

  const answer = state.draft.answers[index];

  if (target.dataset.editor === "checkbox") {
    const card = target.closest(".preview-card");
    answer.answer = Array.from(card.querySelectorAll('[data-editor="checkbox"]:checked')).map((input) => input.value);
  } else if (target.dataset.editor === "select" || target.dataset.editor === "text") {
    answer.answer = target.value;
  } else {
    return;
  }

  markAnswerManuallyEdited(answer);
  state.editedAnswers[answer.questionId] = true;
  persistDraft().catch((error) => console.warn("Draft save failed:", error));

  if (event.type === "change") {
    renderPreview();
  }

  schedulePreviewHighlights();
}

function handlePreviewAction(event) {
  const button = event.target.closest("[data-action]");

  if (!button) {
    return;
  }

  const index = Number(button.dataset.answerIndex);
  const answer = state.draft?.answers?.[index];

  if (!answer) {
    return;
  }

  if (button.dataset.action === "use") {
    markAnswerManuallyEdited(answer);
    persistDraft().catch((error) => console.warn("Draft save failed:", error));
    renderPreview();
    schedulePreviewHighlights();
    showToast("Answer marked for fill.");
  }

  if (button.dataset.action === "skip") {
    answer.safeToFill = false;
    answer.manualEdited = false;
    answer.reason = "Skipped by user";
    persistDraft().catch((error) => console.warn("Draft save failed:", error));
    renderPreview();
    schedulePreviewHighlights();
    showToast("Answer skipped.");
  }

  if (button.dataset.action === "highlight") {
    previewAnswersOnForm();
    showToast("Preview highlighted on the Google Form.");
  }
}

function markAnswerManuallyEdited(answer) {
  answer.manualEdited = true;
  answer.safeToFill = true;
  answer.confidence = Math.max(Number(answer.confidence) || 0, 0.9);
  answer.reason = "Manually edited by user";
}

function schedulePreviewHighlights() {
  clearTimeout(state.highlightTimer);
  state.highlightTimer = setTimeout(() => {
    previewAnswersOnForm().catch((error) => console.warn("Preview highlight update failed:", error));
  }, 250);
}

async function persistDraft() {
  await chromeSet({
    [STORAGE_KEYS.draft]: state.draft,
    [STORAGE_KEYS.rawAIResponse]: state.draft?.rawResponse || state.rawAIResponse || "",
    [STORAGE_KEYS.status]: state.status
  });
}

function toggleRawResponse() {
  state.rawResponseVisible = !state.rawResponseVisible;
  renderPreview();
}

function renderStatus() {
  $("formStatus").textContent = state.status.formStatus;
  $("questionsFound").textContent = String(state.status.questionsFound);
  $("aiStatus").textContent = state.status.aiStatus;
  $("fillStatus").textContent = state.status.fillStatus;
}

function setStatus(nextStatus) {
  state.status = {
    ...state.status,
    ...nextStatus
  };
  renderStatus();
}

async function runBusy(task) {
  setBusy(true);

  try {
    await task();
  } catch (error) {
    if (/AI|Alem|localConfig|response/i.test(error?.message || "")) {
      setStatus({ aiStatus: "Error" });
    }
    showToast(error?.message || "Something went wrong.");
    console.error(error);
  } finally {
    setBusy(false);
    await chromeSet({
      [STORAGE_KEYS.status]: state.status
    });
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  $("busyIndicator").classList.toggle("hidden", !isBusy);

  for (const id of ["saveProfileBtn", "analyzeBtn", "generateBtn", "previewBtn", "fillBtn", "fillAllBtn", "clearBtn"]) {
    $(id).disabled = isBusy;
  }
}

function getProfileFromForm() {
  return PROFILE_FIELDS.reduce((profile, field) => {
    profile[field] = $(field).value.trim();
    return profile;
  }, {});
}

function setProfileFormValues(profile) {
  for (const field of PROFILE_FIELDS) {
    $(field).value = profile[field] || "";
  }
}

function getPreferencesFromForm() {
  return {
    preferredLanguage: $("preferredLanguage").value,
    tone: $("tone").value
  };
}

function setPreferencesFormValues(preferences) {
  $("preferredLanguage").value = preferences.preferredLanguage || "Auto";
  $("tone").value = preferences.tone || "Professional";
}

function hasPreviewAnswers() {
  return Array.isArray(state.draft?.answers) && state.draft.answers.length > 0;
}

async function clearFormHighlightsSilently() {
  try {
    await sendToActiveTab({ type: "CLEAR_FORM_HIGHLIGHTS" });
  } catch {
    // Ignore missing content script while clearing local state.
  }
}

function chromeGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

function chromeSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function chromeRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs?.[0] || null);
    });
  });
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(`${error.message}. Reload the Google Form after loading the extension.`));
        return;
      }
      resolve(response);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(`${error.message}. Reload the extension in chrome://extensions and reopen the popup.`));
        return;
      }
      resolve(response);
    });
  });
}

function isGoogleFormUrl(url) {
  return /^https:\/\/docs\.google\.com\/forms\//i.test(url);
}

function scalarAnswer(value) {
  return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
}

function arrayAnswer(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isEmptyAnswer(value) {
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => !String(item || "").trim());
  }

  return !String(value || "").trim();
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeComparable(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function showToast(message) {
  const root = $("toastRoot");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  root.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3600);
}

function $(id) {
  return document.getElementById(id);
}
