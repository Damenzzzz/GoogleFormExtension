(function () {
  const MIN_CONFIDENCE = 0.6;
  const PREVIEW_STYLE_ID = "ai-form-filler-preview-style";
  const QUESTION_PREVIEW_CLASS = "ai-form-filler-question-preview";
  const QUESTION_SKIPPED_CLASS = "ai-form-filler-question-preview-skipped";
  const QUESTION_SENSITIVE_CLASS = "ai-form-filler-question-preview-sensitive";
  const OPTION_PREVIEW_CLASS = "ai-form-filler-option-preview";
  const OPTION_CHECKBOX_PREVIEW_CLASS = "ai-form-filler-option-preview-checkbox";
  const GHOST_ANSWER_CLASS = "ai-form-filler-ghost-answer";
  const LEGACY_BADGE_CLASS = "ai-form-filler-badge";
  const LEGACY_HIGHLIGHT_CLASSES = [
    "ai-form-filler-highlight",
    "ai-form-filler-highlight-safe",
    "ai-form-filler-highlight-warn",
    "ai-form-filler-highlight-blocked"
  ];

  async function fillSafeAnswers({ answers = [], questions = [] }) {
    return fillAnswers({ answers, questions, mode: "safe" });
  }

  async function fillAllPreviewed({ answers = [], questions = [] }) {
    return fillAnswers({ answers, questions, mode: "all" });
  }

  async function fillAnswers({ answers = [], questions = [], mode = "safe" }) {
    const questionItems = getQuestionItems();
    const questionsById = new Map(questions.map((question) => [question.id, question]));
    const result = {
      filledCount: 0,
      skippedCount: 0,
      warnings: [],
      details: []
    };

    for (const answer of answers) {
      const question = questionsById.get(answer.questionId);
      const eligibility = getFillEligibility(answer, question, mode);

      if (!eligibility.ok) {
        recordSkip(result, answer.questionId, eligibility.reason);
        continue;
      }

      const item = questionItems[question.domIndex];

      if (!item) {
        recordSkip(result, answer.questionId, "Question DOM node was not found");
        continue;
      }

      try {
        const fillResult = await fillQuestion(item, question, answer.answer);

        if (fillResult.ok) {
          result.filledCount += 1;
          result.details.push({
            questionId: answer.questionId,
            status: "filled",
            reason: "Filled"
          });
        } else {
          recordSkip(result, answer.questionId, fillResult.warning || "No matching field or option found");
        }
      } catch (error) {
        console.warn("Failed to fill question:", question, error);
        recordSkip(result, answer.questionId, error?.message || "Fill failed");
      }
    }

    result.filled = result.filledCount;
    result.skipped = result.skippedCount;
    return result;
  }

  function getFillEligibility(answer, question, mode) {
    if (!question) {
      return { ok: false, reason: "Question metadata was not found" };
    }

    if (question.sensitive) {
      return { ok: false, reason: "Question is sensitive" };
    }

    if (isEmptyAnswer(answer?.answer)) {
      return { ok: false, reason: "Answer is empty" };
    }

    if (mode === "all") {
      if (answer?.safeToFill === false && answer?.manualEdited !== true) {
        return { ok: false, reason: "Answer is explicitly marked unsafe" };
      }

      return { ok: true };
    }

    if (!answer || answer.safeToFill !== true) {
      return { ok: false, reason: "AI did not mark the answer as safe to fill" };
    }

    if (Number(answer.confidence) < MIN_CONFIDENCE) {
      return { ok: false, reason: "Confidence is below 0.6" };
    }

    return { ok: true };
  }

  function recordSkip(result, questionId, warning) {
    result.skippedCount += 1;
    result.warnings.push(warning);
    result.details.push({
      questionId,
      status: "skipped",
      reason: warning
    });
  }

  async function fillQuestion(item, question, value) {
    switch (question.type) {
      case "text":
        return fillTextInput(item, value);
      case "textarea":
        return fillTextarea(item, value);
      case "date":
        return fillDateOrTime(item, value);
      case "scale":
        return fillRadio(item, value, true);
      case "radio":
        return fillRadio(item, value, false);
      case "checkbox":
        return fillCheckboxes(item, value);
      case "select":
        return fillSelect(item, value);
      default:
        return { ok: false, warning: "Unknown question type" };
    }
  }

  function fillTextInput(item, value) {
    const input = getVisibleInputs(item).find((element) =>
      ["text", "email", "tel", "number", "url", "search"].includes((element.type || "text").toLowerCase())
    );

    if (!input) {
      return { ok: false, warning: "Text input was not found" };
    }

    setNativeValue(input, scalarAnswer(value));
    return { ok: true };
  }

  function fillTextarea(item, value) {
    const textarea = Array.from(item.querySelectorAll("textarea")).find(isVisible);

    if (!textarea) {
      return { ok: false, warning: "Textarea was not found" };
    }

    setNativeValue(textarea, scalarAnswer(value));
    return { ok: true };
  }

  function fillDateOrTime(item, value) {
    const inputs = getVisibleInputs(item);

    if (inputs.length === 0) {
      return { ok: false, warning: "Date/time input was not found" };
    }

    const scalar = scalarAnswer(value);

    if (inputs.length === 1) {
      setNativeValue(inputs[0], scalar);
      return { ok: true };
    }

    const dateParts = parseDateParts(scalar);
    const timeParts = parseTimeParts(scalar);

    for (const input of inputs) {
      const label = normalizeOptionText(input.getAttribute("aria-label") || input.placeholder || input.name || "");

      if (dateParts) {
        if (/(day|\u0434\u0435\u043d\u044c|\u043a\u04af\u043d)/i.test(label)) setNativeValue(input, dateParts.day);
        else if (/(month|\u043c\u0435\u0441\u044f\u0446|\u0430\u0439)/i.test(label)) setNativeValue(input, dateParts.month);
        else if (/(year|\u0433\u043e\u0434|\u0436\u044b\u043b)/i.test(label)) setNativeValue(input, dateParts.year);
      }

      if (timeParts) {
        if (/(hour|\u0447\u0430\u0441|\u0441\u0430\u0493\u0430\u0442)/i.test(label)) setNativeValue(input, timeParts.hour);
        else if (/(minute|\u043c\u0438\u043d\u0443\u0442\u0430|\u043c\u0438\u043d\u0443\u0442|\u043c\u0438\u043d)/i.test(label)) {
          setNativeValue(input, timeParts.minute);
        }
      }
    }

    return dateParts || timeParts ? { ok: true } : { ok: false, warning: "Could not parse date/time answer" };
  }

  function fillRadio(item, value, numericOnly) {
    const option = findMatchingOption(item, "radio", scalarAnswer(value), numericOnly);

    if (!option) {
      return { ok: false, warning: `No matching option for "${scalarAnswer(value)}"` };
    }

    if (option.getAttribute("aria-checked") !== "true") {
      clickElement(option);
    }

    return { ok: true };
  }

  function fillCheckboxes(item, value) {
    const values = arrayAnswer(value);
    let filled = 0;

    for (const candidate of values) {
      const option = findMatchingOption(item, "checkbox", candidate, false);

      if (!option) {
        continue;
      }

      if (option.getAttribute("aria-checked") !== "true") {
        clickElement(option);
      }

      filled += 1;
    }

    return filled > 0
      ? { ok: true }
      : { ok: false, warning: `No matching checkbox options for "${values.join(", ")}"` };
  }

  async function fillSelect(item, value) {
    const trigger = item.querySelector('[role="listbox"], [aria-haspopup="listbox"], select');

    if (!trigger) {
      return { ok: false, warning: "Dropdown trigger was not found" };
    }

    const wanted = scalarAnswer(value);

    if (trigger.tagName === "SELECT") {
      return fillNativeSelect(trigger, wanted);
    }

    clickElement(trigger);
    await wait(180);

    const visibleOptions = Array.from(document.querySelectorAll("[role='option']")).filter(isVisible);
    const option = findMatchingElement(visibleOptions, wanted, false, { requireVisible: true });

    if (!option) {
      closeOpenPopup(trigger);
      return { ok: false, warning: `No matching dropdown option for "${wanted}"` };
    }

    clickElement(option);
    return { ok: true };
  }

  function fillNativeSelect(select, value) {
    const option = findMatchingElement(Array.from(select.options || []), value, false, { requireVisible: false });

    if (!option) {
      return { ok: false, warning: `No matching native select option for "${value}"` };
    }

    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function findMatchingOption(item, role, wanted, numericOnly) {
    return findMatchingElement(Array.from(item.querySelectorAll(`[role="${role}"]`)), wanted, numericOnly, {
      requireVisible: true
    });
  }

  function findMatchingElement(elements, wanted, numericOnly = false, options = {}) {
    const { requireVisible = true } = options;
    const wantedNumber = extractNumber(wanted);
    const normalizedWanted = normalizeOptionText(numericOnly ? wantedNumber || wanted : wanted);

    if (!normalizedWanted && !wantedNumber) {
      return null;
    }

    const candidates = requireVisible ? elements.filter(isVisible) : elements;
    const exact = candidates.find((element) => {
      const labels = getElementLabels(element);
      return labels.some((label) => normalizeOptionText(label) === normalizedWanted);
    });

    if (exact) {
      return exact;
    }

    if (wantedNumber) {
      const numeric = candidates.find((element) => {
        const labels = getElementLabels(element);
        return labels.some((label) => extractNumber(label) === wantedNumber || normalizeOptionText(label) === wantedNumber);
      });

      if (numeric) {
        return numeric;
      }
    }

    return (
      candidates.find((element) => {
        const labels = getElementLabels(element);
        return labels.some((label) => {
          const normalizedLabel = normalizeOptionText(label);
          return (
            normalizedLabel &&
            normalizedWanted &&
            (normalizedLabel.includes(normalizedWanted) || normalizedWanted.includes(normalizedLabel))
          );
        });
      }) || null
    );
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const stringValue = String(value);

    element.focus();

    if (descriptor?.set) {
      descriptor.set.call(element, stringValue);
    } else {
      element.value = stringValue;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  function previewAnswersOnForm(input = {}, maybeAnswers) {
    const payload = Array.isArray(input)
      ? { questions: input, answers: Array.isArray(maybeAnswers) ? maybeAnswers : [] }
      : input || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const questions = Array.isArray(payload.questions) ? payload.questions : [];

    injectPreviewStyles();
    clearFormPreview();

    const questionItems = getQuestionItems();
    const answersById = new Map(answers.map((answer) => [answer.questionId, answer]));
    let highlightedCount = 0;

    for (const question of questions) {
      const item = questionItems[question.domIndex];
      const answer = answersById.get(question.id);

      if (!item || !answer) {
        continue;
      }

      const previewState = getPreviewState(question, answer);
      item.classList.add(previewState.className);
      item.dataset.aiFormFillerPreviewed = "true";
      highlightedCount += 1;

      if (previewState.kind !== "answer") {
        continue;
      }

      if (["text", "textarea", "unknown"].includes(question.type)) {
        applyGhostTextPreview(item, answer);
      } else if (["radio", "checkbox", "scale", "select"].includes(question.type)) {
        applyChoicePreview(item, question, answer);
      }
    }

    return { highlightedCount };
  }

  function clearFormPreview() {
    for (const badge of document.querySelectorAll(`.${LEGACY_BADGE_CLASS}`)) {
      badge.remove();
    }

    for (const ghost of document.querySelectorAll(`.${GHOST_ANSWER_CLASS}`)) {
      ghost.remove();
    }

    for (const option of document.querySelectorAll(`.${OPTION_PREVIEW_CLASS}, .${OPTION_CHECKBOX_PREVIEW_CLASS}`)) {
      option.classList.remove(OPTION_PREVIEW_CLASS, OPTION_CHECKBOX_PREVIEW_CLASS);
      option.removeAttribute("data-ai-form-filler-option-preview");
    }

    for (const item of document.querySelectorAll("[data-ai-form-filler-previewed='true'], [data-ai-form-filler-highlighted='true']")) {
      item.classList.remove(QUESTION_PREVIEW_CLASS, QUESTION_SKIPPED_CLASS, QUESTION_SENSITIVE_CLASS, ...LEGACY_HIGHLIGHT_CLASSES);
      item.removeAttribute("data-ai-form-filler-previewed");
      item.removeAttribute("data-ai-form-filler-highlighted");
    }
  }

  function applyGhostTextPreview(questionElement, answer) {
    const text = scalarAnswer(answer?.answer ?? answer);

    if (!text) {
      return false;
    }

    const control = findTextPreviewControl(questionElement);

    if (!control) {
      return false;
    }

    const ghost = document.createElement("div");
    ghost.className = GHOST_ANSWER_CLASS;
    ghost.textContent = text;
    control.insertAdjacentElement("afterend", ghost);
    return true;
  }

  function applyChoicePreview(questionElement, question, answer) {
    const values = question.type === "checkbox" ? arrayAnswer(answer.answer) : [scalarAnswer(answer.answer)];
    let matchedCount = 0;

    for (const value of values) {
      const option = findOptionElement(questionElement, value, question.type);

      if (!option) {
        continue;
      }

      const target = getOptionPreviewTarget(option);
      target.classList.add(question.type === "checkbox" ? OPTION_CHECKBOX_PREVIEW_CLASS : OPTION_PREVIEW_CLASS);
      target.dataset.aiFormFillerOptionPreview = "true";
      matchedCount += 1;
    }

    if (matchedCount === 0 && question.type === "select") {
      const trigger = questionElement.querySelector('[role="listbox"], [aria-haspopup="listbox"], select');

      if (trigger && isVisible(trigger)) {
        trigger.classList.add(OPTION_PREVIEW_CLASS);
        trigger.dataset.aiFormFillerOptionPreview = "true";
        matchedCount = 1;
      }
    }

    return matchedCount;
  }

  function findOptionElement(questionElement, optionText, questionType = "") {
    const numericOnly = questionType === "scale";
    const selector =
      questionType === "checkbox"
        ? '[role="checkbox"]'
        : questionType === "radio" || questionType === "scale"
          ? '[role="radio"]'
          : '[role="radio"], [role="checkbox"], [role="option"], option';

    return findMatchingElement(Array.from(questionElement.querySelectorAll(selector)), optionText, numericOnly, {
      requireVisible: true
    });
  }

  function getPreviewState(question, answer) {
    if (question.sensitive) {
      return { kind: "sensitive", className: QUESTION_SENSITIVE_CLASS };
    }

    if (!answer || answer.safeToFill === false || isEmptyAnswer(answer.answer)) {
      return { kind: "skipped", className: QUESTION_SKIPPED_CLASS };
    }

    return { kind: "answer", className: QUESTION_PREVIEW_CLASS };
  }

  function injectPreviewStyles() {
    if (document.getElementById(PREVIEW_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = PREVIEW_STYLE_ID;
    style.textContent = `
      .${QUESTION_PREVIEW_CLASS} {
        outline: 2px solid rgba(70, 255, 160, 0.45) !important;
        box-shadow: 0 0 0 4px rgba(70, 255, 160, 0.08) !important;
        border-radius: 14px !important;
      }
      .${QUESTION_SKIPPED_CLASS} {
        outline: 2px solid rgba(255, 190, 80, 0.55) !important;
        box-shadow: 0 0 0 4px rgba(255, 190, 80, 0.08) !important;
        border-radius: 14px !important;
      }
      .${QUESTION_SENSITIVE_CLASS} {
        outline: 2px solid rgba(255, 102, 102, 0.55) !important;
        box-shadow: 0 0 0 4px rgba(255, 102, 102, 0.08) !important;
        border-radius: 14px !important;
      }
      .${GHOST_ANSWER_CLASS} {
        margin-top: 8px !important;
        color: rgba(60, 60, 60, 0.68) !important;
        font-size: 15px !important;
        line-height: 1.45 !important;
        white-space: pre-wrap !important;
        pointer-events: none !important;
        border-bottom: 1px dashed rgba(0, 0, 0, 0.18) !important;
        padding-bottom: 6px !important;
        max-width: 100% !important;
        word-break: break-word !important;
      }
      .${OPTION_PREVIEW_CLASS} {
        outline: 2px solid rgba(70, 255, 160, 0.85) !important;
        box-shadow: 0 0 0 4px rgba(70, 255, 160, 0.12) !important;
        border-radius: 999px !important;
      }
      .${OPTION_CHECKBOX_PREVIEW_CLASS} {
        outline: 2px solid rgba(70, 255, 160, 0.85) !important;
        box-shadow: 0 0 0 4px rgba(70, 255, 160, 0.12) !important;
        border-radius: 10px !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function findTextPreviewControl(item) {
    const textarea = Array.from(item.querySelectorAll("textarea")).find(isVisible);

    if (textarea) {
      return textarea;
    }

    return getVisibleInputs(item).find((element) =>
      ["text", "email", "tel", "number", "url", "search"].includes((element.type || "text").toLowerCase())
    );
  }

  function getOptionPreviewTarget(element) {
    const label = element.closest("label");

    if (label && isVisible(label)) {
      return label;
    }

    const parent = element.parentElement;
    return parent && isVisible(parent) ? parent : element;
  }

  function parseDateParts(value) {
    const trimmed = String(value || "").trim();
    const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    const local = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);

    if (iso) {
      return { year: iso[1], month: iso[2], day: iso[3] };
    }

    if (local) {
      return { day: local[1], month: local[2], year: local[3] };
    }

    return null;
  }

  function parseTimeParts(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})/);
    return match ? { hour: match[1], minute: match[2] } : null;
  }

  function getQuestionItems() {
    const listItems = Array.from(document.querySelectorAll('div[role="listitem"]'));
    const candidates = listItems.length
      ? listItems
      : Array.from(document.querySelectorAll("[data-params], .Qr7Oae"));

    return candidates.filter((item) => isVisible(item) && hasQuestionControl(item) && hasQuestionText(item));
  }

  function hasQuestionControl(item) {
    return Boolean(
      item.querySelector(
        "input, textarea, select, [role='radio'], [role='checkbox'], [role='listbox'], [aria-haspopup='listbox']"
      )
    );
  }

  function hasQuestionText(item) {
    const selectors = [
      '[role="heading"][aria-level="3"]',
      ".M7eMe",
      ".freebirdFormviewerComponentsQuestionBaseTitle",
      "[data-params] [role='heading']"
    ];

    return selectors.some((selector) => item.querySelector(selector)?.textContent?.trim()) || Boolean(item.innerText);
  }

  function getVisibleInputs(item) {
    return Array.from(item.querySelectorAll("input")).filter((input) => {
      const type = (input.type || "text").toLowerCase();
      return !["hidden", "submit", "button", "reset"].includes(type) && isVisible(input);
    });
  }

  function getElementLabels(element) {
    return [
      element.getAttribute("data-value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.value,
      element.innerText,
      element.textContent,
      element.closest("label")?.innerText,
      element.parentElement?.innerText
    ].filter(Boolean);
  }

  function extractNumber(value) {
    const match = String(value || "").match(/(?:^|\b)(10|[0-9])(?:\b|$)/);
    return match ? match[1] : "";
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

  function closeOpenPopup(trigger) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    trigger.blur();
  }

  function normalizeOptionText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.,!?;:]+$/g, "");
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  window.LocalAIFormFiller = {
    fillSafeAnswers,
    fillAllPreviewed,
    previewAnswersOnForm,
    clearFormPreview,
    clearFormHighlights: clearFormPreview,
    applyGhostTextPreview,
    applyChoicePreview,
    findOptionElement
  };
})();
