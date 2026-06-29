(function () {
  const SENSITIVE_PATTERNS = [
    /\bpassword\b/i,
    /\bcard\b/i,
    /\bcvv\b/i,
    /\bpassport\b/i,
    /\biin\b/i,
    /\bbank\b/i,
    /\bkaspi\b/i,
    /\bkaspi\s+gold\b/i,
    /\b(private|home|residential|street|exact|full)\s+address\b/i,
    /\baddress\s+(line|of residence|where you live)\b/i,
    /пароль/i,
    /карта/i,
    /cvv/i,
    /паспорт/i,
    /удостоверение/i,
    /иин/i,
    /банк/i,
    /kaspi/i,
    /kaspi\s+gold/i,
    /номер\s+карты/i,
    /точный\s+адрес/i,
    /адрес\s+проживания/i,
    /домашний\s+адрес/i
  ];

  const SKIP_OPTION_TEXT = new Set([
    "choose",
    "select",
    "clear selection",
    "выберите",
    "очистить выбор",
    "таңдаңыз"
  ]);

  async function parseGoogleForm() {
    const questionItems = getQuestionItems();
    const questions = [];

    for (const [index, item] of questionItems.entries()) {
      const questionText = extractQuestionText(item);

      if (!questionText) {
        continue;
      }

      const type = detectQuestionType(item, questionText);
      const options = await extractOptions(item, type);
      const description = extractDescription(item, questionText, options);

      questions.push({
        id: `q_${questions.length + 1}`,
        questionText,
        description,
        type,
        options,
        required: detectRequired(item),
        sensitive: isSensitiveQuestion(`${questionText} ${description}`),
        domIndex: index
      });
    }

    return {
      url: window.location.href,
      title: extractFormTitle(),
      questions
    };
  }

  function getQuestionItems() {
    const listItems = Array.from(document.querySelectorAll('div[role="listitem"]'));
    const candidates = listItems.length
      ? listItems
      : Array.from(document.querySelectorAll("[data-params], .Qr7Oae"));

    return candidates.filter((item) => {
      if (!isVisible(item)) {
        return false;
      }

      return Boolean(extractQuestionText(item)) && hasQuestionControl(item);
    });
  }

  function extractFormTitle() {
    const selectors = [
      'div[role="heading"][aria-level="1"]',
      "h1",
      ".F9yp7e",
      ".freebirdFormviewerViewHeaderTitle"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = cleanText(element?.innerText || element?.textContent || "");

      if (text) {
        return text;
      }
    }

    return document.title || "Google Form";
  }

  function extractQuestionText(item) {
    const selectors = [
      '[role="heading"][aria-level="3"]',
      ".M7eMe",
      ".freebirdFormviewerComponentsQuestionBaseTitle",
      "[data-params] [role='heading']"
    ];

    for (const selector of selectors) {
      const element = item.querySelector(selector);
      const text = cleanQuestionText(element?.innerText || element?.textContent || "");

      if (text && !isInstructionText(text)) {
        return text;
      }
    }

    const lines = getVisibleTextLines(item);
    return cleanQuestionText(lines.find((line) => !isInstructionText(line)) || "");
  }

  function extractDescription(item, questionText, options) {
    const optionSet = new Set(options.map(normalizeComparable));
    const questionComparable = normalizeComparable(questionText);
    const lines = getVisibleTextLines(item);

    for (const line of lines) {
      const comparable = normalizeComparable(line);

      if (!comparable || comparable === questionComparable || optionSet.has(comparable)) {
        continue;
      }

      if (isInstructionText(line) || looksLikeGeneratedControlText(line)) {
        continue;
      }

      return line;
    }

    return "";
  }

  function detectQuestionType(item, questionText) {
    const comparable = normalizeComparable(questionText);
    const inputs = getVisibleInputs(item);

    if (item.querySelector('[role="radio"]')) {
      return "radio";
    }

    if (item.querySelector('[role="checkbox"]')) {
      return "checkbox";
    }

    if (item.querySelector("textarea")) {
      return "textarea";
    }

    if (hasDateOrTimeSignals(item, comparable)) {
      return "date";
    }

    if (item.querySelector('[role="listbox"], [aria-haspopup="listbox"], select')) {
      return "select";
    }

    if (
      inputs.some((input) =>
        ["text", "email", "tel", "number", "url", "search"].includes((input.type || "text").toLowerCase())
      )
    ) {
      return "text";
    }

    return "unknown";
  }

  async function extractOptions(item, type) {
    if (type === "radio" || type === "checkbox") {
      const role = type === "radio" ? "radio" : "checkbox";
      return unique(
        Array.from(item.querySelectorAll(`[role="${role}"]`))
          .map(getElementLabel)
          .map(cleanOptionText)
          .filter(Boolean)
      );
    }

    if (type === "select") {
      const localOptions = unique(
        Array.from(item.querySelectorAll("option, [role='option']"))
          .map(getElementLabel)
          .map(cleanOptionText)
          .filter(Boolean)
      );

      if (localOptions.length > 0) {
        return localOptions;
      }

      return readDropdownOptions(item);
    }

    return [];
  }

  async function readDropdownOptions(item) {
    const trigger = item.querySelector('[role="listbox"], [aria-haspopup="listbox"], select');

    if (!trigger || trigger.tagName === "SELECT") {
      return [];
    }

    const beforeOpen = new Set(Array.from(document.querySelectorAll("[role='option']")).map((el) => el));

    try {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      trigger.click();
      await wait(180);

      const options = Array.from(document.querySelectorAll("[role='option']"))
        .filter((option) => !beforeOpen.has(option) || isVisible(option))
        .map(getElementLabel)
        .map(cleanOptionText)
        .filter(Boolean);

      closeOpenPopup(trigger);
      return unique(options);
    } catch (error) {
      console.warn("Failed to read dropdown options:", error);
      closeOpenPopup(trigger);
      return [];
    }
  }

  function detectRequired(item) {
    const text = item.innerText || "";

    if (/\*\s*$/.test(text.split("\n")[0] || "")) {
      return true;
    }

    if (/(required|обязательн|міндетті)/i.test(text)) {
      return true;
    }

    return Boolean(
      item.querySelector(
        '[aria-label*="Required"], [aria-label*="required"], [aria-label*="Обяз"], [aria-label*="обяз"]'
      )
    );
  }

  function hasQuestionControl(item) {
    return Boolean(
      item.querySelector(
        "input, textarea, select, [role='radio'], [role='checkbox'], [role='listbox'], [aria-haspopup='listbox']"
      )
    );
  }

  function getVisibleInputs(item) {
    return Array.from(item.querySelectorAll("input")).filter((input) => {
      const type = (input.type || "text").toLowerCase();
      return !["hidden", "submit", "button", "reset"].includes(type) && isVisible(input);
    });
  }

  function hasDateOrTimeSignals(item, questionComparable) {
    const inputs = getVisibleInputs(item);

    if (inputs.some((input) => ["date", "time", "datetime-local", "month"].includes((input.type || "").toLowerCase()))) {
      return true;
    }

    const ariaLabels = inputs.map((input) => normalizeComparable(input.getAttribute("aria-label") || "")).join(" ");
    const combined = `${questionComparable} ${ariaLabels}`;

    return /(date|day|month|year|time|hour|minute|дата|день|месяц|год|время|час|минута|күн|ай|жыл|уақыт)/i.test(
      combined
    );
  }

  function getVisibleTextLines(element) {
    return unique(
      (element?.innerText || "")
        .split("\n")
        .map(cleanText)
        .filter(Boolean)
    );
  }

  function getElementLabel(element) {
    if (!element) {
      return "";
    }

    const ariaLabel = element.getAttribute("aria-label");

    if (ariaLabel) {
      return ariaLabel;
    }

    return element.innerText || element.textContent || "";
  }

  function isSensitiveQuestion(text) {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text || ""));
  }

  function closeOpenPopup(trigger) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    trigger.blur();
  }

  function cleanQuestionText(text) {
    return cleanText(text)
      .replace(/\s+\*\s*$/, "")
      .replace(/^\*\s+/, "")
      .trim();
  }

  function cleanOptionText(text) {
    const cleaned = cleanText(text)
      .replace(/\s+\(.*required.*\)$/i, "")
      .trim();
    const comparable = normalizeComparable(cleaned);

    if (!cleaned || SKIP_OPTION_TEXT.has(comparable)) {
      return "";
    }

    return cleaned;
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();
  }

  function normalizeComparable(text) {
    return cleanText(text).toLowerCase();
  }

  function isInstructionText(text) {
    return /^(your answer|ваш ответ|мой ответ|choose|select|выберите|ответ|required|\*)$/i.test(cleanText(text));
  }

  function looksLikeGeneratedControlText(text) {
    return /^(other|другое|submit|отправить|clear form|очистить форму|next|назад|back|далее)$/i.test(cleanText(text));
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function unique(values) {
    const seen = new Set();
    const result = [];

    for (const value of values) {
      const cleaned = cleanText(value);
      const key = normalizeComparable(cleaned);

      if (!cleaned || seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(cleaned);
    }

    return result;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  window.LocalAIFormParser = {
    parseGoogleForm,
    isSensitiveQuestion
  };
})();
