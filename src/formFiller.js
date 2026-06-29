(function () {
  const MIN_CONFIDENCE = 0.6;
  const HIGHLIGHT_STYLE_ID = "ai-form-filler-highlight-style";
  const HIGHLIGHT_CLASS = "ai-form-filler-highlight";
  const HIGHLIGHT_SAFE_CLASS = "ai-form-filler-highlight-safe";
  const HIGHLIGHT_WARN_CLASS = "ai-form-filler-highlight-warn";
  const HIGHLIGHT_BLOCKED_CLASS = "ai-form-filler-highlight-blocked";
  const BADGE_CLASS = "ai-form-filler-badge";

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
      const label = normalizeComparable(input.getAttribute("aria-label") || input.placeholder || input.name || "");

      if (dateParts) {
        if (/(day|день|күн)/i.test(label)) setNativeValue(input, dateParts.day);
        else if (/(month|месяц|ай)/i.test(label)) setNativeValue(input, dateParts.month);
        else if (/(year|год|жыл)/i.test(label)) setNativeValue(input, dateParts.year);
      }

      if (timeParts) {
        if (/(hour|час|сағат)/i.test(label)) setNativeValue(input, timeParts.hour);
        else if (/(minute|минута|минут|мин|minute)/i.test(label)) setNativeValue(input, timeParts.minute);
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
    const option = findMatchingElement(visibleOptions, wanted, false);

    if (!option) {
      closeOpenPopup(trigger);
      return { ok: false, warning: `No matching dropdown option for "${wanted}"` };
    }

    clickElement(option);
    return { ok: true };
  }

  function fillNativeSelect(select, value) {
    const option = findMatchingElement(Array.from(select.options || []), value, false);

    if (!option) {
      return { ok: false, warning: `No matching native select option for "${value}"` };
    }

    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  function findMatchingOption(item, role, wanted, numericOnly) {
    return findMatchingElement(Array.from(item.querySelectorAll(`[role="${role}"]`)), wanted, numericOnly);
  }

  function findMatchingElement(elements, wanted, numericOnly) {
    const normalizedWanted = normalizeComparable(numericOnly ? extractNumber(wanted) : wanted);

    if (!normalizedWanted) {
      return null;
    }

    const visibleElements = elements.filter(isVisible);
    const exact = visibleElements.find((element) => {
      const labels = getElementLabels(element, numericOnly);
      return labels.some((label) => normalizeComparable(label) === normalizedWanted);
    });

    if (exact) {
      return exact;
    }

    return (
      visibleElements.find((element) => {
        const labels = getElementLabels(element, numericOnly);
        return labels.some((label) => {
          const normalizedLabel = normalizeComparable(label);
          return normalizedLabel.includes(normalizedWanted) || normalizedWanted.includes(normalizedLabel);
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

  function previewAnswersOnForm({ answers = [], questions = [] }) {
    injectHighlightStyles();
    clearFormHighlights();

    const questionItems = getQuestionItems();
    const answersById = new Map(answers.map((answer) => [answer.questionId, answer]));

    for (const question of questions) {
      const item = questionItems[question.domIndex];
      const answer = answersById.get(question.id);

      if (!item || !answer) {
        continue;
      }

      const state = getHighlightState(question, answer);
      item.classList.add(HIGHLIGHT_CLASS, state.className);
      item.dataset.aiFormFillerHighlighted = "true";

      const badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      badge.textContent = `AI: ${formatBadgeAnswer(answer.answer) || "Skipped"}`;
      item.appendChild(badge);
    }

    return { highlightedCount: answers.length };
  }

  function clearFormHighlights() {
    for (const badge of document.querySelectorAll(`.${BADGE_CLASS}`)) {
      badge.remove();
    }

    for (const item of document.querySelectorAll("[data-ai-form-filler-highlighted='true']")) {
      item.classList.remove(HIGHLIGHT_CLASS, HIGHLIGHT_SAFE_CLASS, HIGHLIGHT_WARN_CLASS, HIGHLIGHT_BLOCKED_CLASS);
      item.removeAttribute("data-ai-form-filler-highlighted");
    }
  }

  function injectHighlightStyles() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        position: relative !important;
        outline: 2px solid rgba(255,255,255,0.55) !important;
        box-shadow: 0 0 0 4px rgba(0,0,0,0.05) !important;
        border-radius: 12px !important;
      }
      .${HIGHLIGHT_SAFE_CLASS} {
        outline-color: rgba(120, 255, 180, 0.72) !important;
      }
      .${HIGHLIGHT_WARN_CLASS} {
        outline-color: rgba(255, 198, 92, 0.78) !important;
      }
      .${HIGHLIGHT_BLOCKED_CLASS} {
        outline-color: rgba(255, 112, 112, 0.82) !important;
      }
      .${BADGE_CLASS} {
        position: absolute !important;
        top: 8px !important;
        right: 8px !important;
        z-index: 9999 !important;
        background: #0f0f0f !important;
        color: #fff !important;
        border: 1px solid rgba(255,255,255,0.25) !important;
        border-radius: 999px !important;
        padding: 5px 9px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        max-width: 220px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function getHighlightState(question, answer) {
    if (question.sensitive) {
      return { className: HIGHLIGHT_BLOCKED_CLASS };
    }

    if (answer.safeToFill === true && Number(answer.confidence) >= MIN_CONFIDENCE && !isEmptyAnswer(answer.answer)) {
      return { className: HIGHLIGHT_SAFE_CLASS };
    }

    return { className: HIGHLIGHT_WARN_CLASS };
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

  function getElementLabels(element, numericOnly) {
    const labels = [
      element.getAttribute("data-value"),
      element.getAttribute("aria-label"),
      element.innerText,
      element.textContent
    ].filter(Boolean);

    if (!numericOnly) {
      return labels;
    }

    return labels.map(extractNumber).filter(Boolean);
  }

  function extractNumber(value) {
    const match = String(value || "").match(/(?:^|\b)(10|[1-9])(?:\b|$)/);
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

  function formatBadgeAnswer(value) {
    const text = Array.isArray(value) ? value.join(", ") : String(value || "");
    return text.length > 42 ? `${text.slice(0, 39)}...` : text;
  }

  function closeOpenPopup(trigger) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    trigger.blur();
  }

  function normalizeComparable(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim()
      .toLowerCase();
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
    clearFormHighlights
  };
})();
