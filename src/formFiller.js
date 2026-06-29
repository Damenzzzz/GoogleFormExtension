(function () {
  const MIN_CONFIDENCE = 0.6;

  async function fillSafeAnswers({ answers = [], questions = [] }) {
    const questionItems = getQuestionItems();
    const questionsById = new Map(questions.map((question) => [question.id, question]));
    const result = {
      filled: 0,
      skipped: 0,
      attempted: 0,
      details: []
    };

    for (const answer of answers) {
      const question = questionsById.get(answer.questionId);
      const eligibility = getFillEligibility(answer, question);

      if (!eligibility.ok) {
        result.skipped += 1;
        result.details.push({
          questionId: answer.questionId,
          status: "skipped",
          reason: eligibility.reason
        });
        continue;
      }

      const item = questionItems[question.domIndex];

      if (!item) {
        result.skipped += 1;
        result.details.push({
          questionId: answer.questionId,
          status: "skipped",
          reason: "Question DOM node was not found"
        });
        continue;
      }

      result.attempted += 1;

      try {
        const didFill = await fillQuestion(item, question, answer.answer);

        if (didFill) {
          result.filled += 1;
          result.details.push({
            questionId: answer.questionId,
            status: "filled",
            reason: "Filled safely"
          });
        } else {
          result.skipped += 1;
          result.details.push({
            questionId: answer.questionId,
            status: "skipped",
            reason: "No matching field or option found"
          });
        }
      } catch (error) {
        console.warn("Failed to fill question:", question, error);
        result.skipped += 1;
        result.details.push({
          questionId: answer.questionId,
          status: "skipped",
          reason: error?.message || "Fill failed"
        });
      }
    }

    return result;
  }

  function getFillEligibility(answer, question) {
    if (!question) {
      return { ok: false, reason: "Question metadata was not found" };
    }

    if (question.sensitive) {
      return { ok: false, reason: "Question is sensitive" };
    }

    if (!answer || answer.safeToFill !== true) {
      return { ok: false, reason: "AI did not mark the answer as safe to fill" };
    }

    if (Number(answer.confidence) < MIN_CONFIDENCE) {
      return { ok: false, reason: "Confidence is below 0.6" };
    }

    if (isEmptyAnswer(answer.answer)) {
      return { ok: false, reason: "Answer is empty" };
    }

    return { ok: true };
  }

  async function fillQuestion(item, question, value) {
    switch (question.type) {
      case "text":
        return fillTextInput(item, value);
      case "textarea":
        return fillTextarea(item, value);
      case "date":
        return fillDateOrTime(item, value);
      case "radio":
        return fillRadio(item, value);
      case "checkbox":
        return fillCheckboxes(item, value);
      case "select":
        return fillSelect(item, value);
      default:
        return false;
    }
  }

  function fillTextInput(item, value) {
    const input = getVisibleInputs(item).find((element) =>
      ["text", "email", "tel", "number", "url", "search"].includes((element.type || "text").toLowerCase())
    );

    if (!input) {
      return false;
    }

    setNativeValue(input, scalarAnswer(value));
    return true;
  }

  function fillTextarea(item, value) {
    const textarea = Array.from(item.querySelectorAll("textarea")).find(isVisible);

    if (!textarea) {
      return false;
    }

    setNativeValue(textarea, scalarAnswer(value));
    return true;
  }

  function fillDateOrTime(item, value) {
    const inputs = getVisibleInputs(item);

    if (inputs.length === 0) {
      return false;
    }

    const scalar = scalarAnswer(value);

    if (inputs.length === 1) {
      setNativeValue(inputs[0], scalar);
      return true;
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

    return Boolean(dateParts || timeParts);
  }

  function fillRadio(item, value) {
    const option = findMatchingOption(item, "radio", scalarAnswer(value));

    if (!option) {
      return false;
    }

    if (option.getAttribute("aria-checked") !== "true") {
      option.click();
    }

    return true;
  }

  function fillCheckboxes(item, value) {
    const values = arrayAnswer(value);
    let filled = 0;

    for (const candidate of values) {
      const option = findMatchingOption(item, "checkbox", candidate);

      if (!option) {
        continue;
      }

      if (option.getAttribute("aria-checked") !== "true") {
        option.click();
      }

      filled += 1;
    }

    return filled > 0;
  }

  async function fillSelect(item, value) {
    const trigger = item.querySelector('[role="listbox"], [aria-haspopup="listbox"], select');

    if (!trigger) {
      return false;
    }

    const wanted = scalarAnswer(value);

    if (trigger.tagName === "SELECT") {
      return fillNativeSelect(trigger, wanted);
    }

    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    trigger.click();
    await wait(180);

    const option = findMatchingElement(Array.from(document.querySelectorAll("[role='option']")), wanted);

    if (!option) {
      closeOpenPopup(trigger);
      return false;
    }

    option.click();
    return true;
  }

  function fillNativeSelect(select, value) {
    const option = findMatchingElement(Array.from(select.options || []), value);

    if (!option) {
      return false;
    }

    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function findMatchingOption(item, role, wanted) {
    return findMatchingElement(Array.from(item.querySelectorAll(`[role="${role}"]`)), wanted);
  }

  function findMatchingElement(elements, wanted) {
    const normalizedWanted = normalizeComparable(wanted);

    if (!normalizedWanted) {
      return null;
    }

    const visibleElements = elements.filter(isVisible);
    const exact = visibleElements.find((element) => normalizeComparable(getElementLabel(element)) === normalizedWanted);

    if (exact) {
      return exact;
    }

    return (
      visibleElements.find((element) => {
        const label = normalizeComparable(getElementLabel(element));
        return label.includes(normalizedWanted) || normalizedWanted.includes(label);
      }) || null
    );
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    element.focus();

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, String(value));
    } else {
      element.value = String(value);
    }

    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
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

    if (!match) {
      return null;
    }

    return { hour: match[1], minute: match[2] };
  }

  function getVisibleInputs(item) {
    return Array.from(item.querySelectorAll("input")).filter((input) => {
      const type = (input.type || "text").toLowerCase();
      return !["hidden", "submit", "button", "reset"].includes(type) && isVisible(input);
    });
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

    if (selectors.some((selector) => item.querySelector(selector)?.textContent?.trim())) {
      return true;
    }

    return Boolean(
      (item.innerText || "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !/^(your answer|ваш ответ|choose|select|выберите|required|\*)$/i.test(line))
    );
  }

  function getElementLabel(element) {
    return (
      element.getAttribute("aria-label") ||
      element.getAttribute("data-value") ||
      element.innerText ||
      element.textContent ||
      ""
    ).trim();
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
    fillSafeAnswers
  };
})();
