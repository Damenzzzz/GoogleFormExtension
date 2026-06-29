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
  rawAIResponse: "",
  rawResponseVisible: false,
  status: { ...DEFAULT_STATUS },
  busy: false
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
  $("previewBtn").addEventListener("click", renderPreview);
  $("fillBtn").addEventListener("click", fillSafeAnswers);
  $("clearBtn").addEventListener("click", clearDraft);
  $("rawToggleBtn").addEventListener("click", toggleRawResponse);
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
  state.rawAIResponse = stored[STORAGE_KEYS.rawAIResponse] || "";
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

    const response = await sendToActiveTab({
      type: "ANALYZE_FORM"
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not analyze this Google Form.");
    }

    state.form = response.form;
    state.draft = null;

    setStatus({
      formStatus: "Analyzed",
      questionsFound: response.form?.questions?.length || 0,
      aiStatus: "Idle",
      fillStatus: "Not filled"
    });

    await chromeSet({
      [STORAGE_KEYS.form]: state.form,
      [STORAGE_KEYS.draft]: null,
      [STORAGE_KEYS.status]: state.status
    });

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
      const message = response?.error?.message || "AI generation failed.";
      if (response?.error?.rawResponse) {
        state.rawAIResponse = String(response.error.rawResponse);
        state.rawResponseVisible = false;
        await chromeSet({
          [STORAGE_KEYS.rawAIResponse]: state.rawAIResponse
        });
        renderPreview();
        console.error("Raw AI response:", response.error.rawResponse);
      }
      throw new Error(message);
    }

    state.draft = response.result;
    state.rawAIResponse = "";
    setStatus({
      aiStatus: "Generated"
    });

    await chromeSet({
      [STORAGE_KEYS.draft]: state.draft,
      [STORAGE_KEYS.rawAIResponse]: "",
      [STORAGE_KEYS.status]: state.status
    });

    renderPreview();
    showToast("Answers generated. Review the preview before filling.");
  });
}

async function fillSafeAnswers() {
  await runBusy(async () => {
    if (!state.form || !state.draft) {
      throw new Error("Generate and preview answers before filling.");
    }

    const response = await sendToActiveTab({
      type: "FILL_SAFE_ANSWERS",
      answers: state.draft.answers || [],
      questions: state.form.questions || []
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not fill safe answers.");
    }

    const result = response.result || {};
    const fillStatus = result.filled > 0 && result.skipped === 0 ? "Filled" : result.filled > 0 ? "Filled partially" : "Not filled";

    setStatus({
      fillStatus
    });

    await chromeSet({
      [STORAGE_KEYS.status]: state.status
    });

    showToast(`Filled ${result.filled || 0} safe answer(s). Skipped ${result.skipped || 0}.`);
  });
}

async function clearDraft() {
  state.form = null;
  state.draft = null;
  state.status = { ...DEFAULT_STATUS };

  await chromeRemove([STORAGE_KEYS.form, STORAGE_KEYS.draft, STORAGE_KEYS.rawAIResponse, STORAGE_KEYS.status]);
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
  const rawResponse = String(state.rawAIResponse || "");

  $("previewCount").textContent = answers.length ? `${answers.length} answer(s)` : "No answers";
  rawToggleBtn.classList.toggle("hidden", !rawResponse);
  rawToggleBtn.textContent = state.rawResponseVisible ? "Hide raw AI response" : "Show raw AI response";
  rawResponsePanel.classList.toggle("hidden", !rawResponse || !state.rawResponseVisible);
  rawResponsePanel.textContent = rawResponse ? rawResponse.slice(0, 12000) : "";

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
    .map((answer) => {
      const question = questionsById.get(answer.questionId);
      const sensitive = Boolean(question?.sensitive);
      const confidence = clampConfidence(answer.confidence);
      const answerValue = formatAnswer(answer.answer);
      const safe = answer.safeToFill === true && !sensitive && confidence >= 0.6 && answerValue;
      const badges = [
        `<span class="badge ${safe ? "safe" : "blocked"}">${safe ? "Safe" : "Skipped"}</span>`,
        sensitive ? `<span class="badge blocked">Sensitive</span>` : "",
        confidence < 0.6 ? `<span class="badge blocked">Low confidence</span>` : "",
        `<span class="badge">Confidence ${Math.round(confidence * 100)}%</span>`
      ]
        .filter(Boolean)
        .join("");

      return `
        <article class="preview-card">
          <p class="preview-question">${escapeHtml(answer.questionText || question?.questionText || "Question")}</p>
          <p class="preview-answer">${escapeHtml(answerValue || "Empty answer")}</p>
          <div class="preview-meta">${badges}</div>
          <p class="reason">${escapeHtml(answer.reason || "No reason provided")}</p>
        </article>
      `;
    })
    .join("");
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

  for (const id of ["saveProfileBtn", "analyzeBtn", "generateBtn", "previewBtn", "fillBtn", "clearBtn"]) {
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

function formatAnswer(answer) {
  if (Array.isArray(answer)) {
    return answer.join(", ");
  }

  return String(answer || "").trim();
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
