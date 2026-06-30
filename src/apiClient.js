import { LOCAL_AI_CONFIG } from "./localConfig.js";

const REQUEST_TIMEOUT_MS = 60000;
const CHOICE_TYPES = new Set(["radio", "checkbox", "select", "scale"]);

const SYSTEM_PROMPT = `
You are an AI assistant for filling Google Forms.

Return ONLY valid JSON.
No markdown.
No explanations outside JSON.
No code fences.

Expected JSON schema:
{
  "answers": [
    {
      "questionId": "q_1",
      "questionText": "Question text",
      "type": "text | textarea | radio | checkbox | select | scale | date | unknown",
      "answer": "answer text or selected option",
      "confidence": 0.0,
      "reason": "short reason",
      "safeToFill": true
    }
  ],
  "warnings": []
}

Rules:
- Return one answer for every questionId.
- Use user profile when the question asks about the user.
- If the form asks for LinkedIn or GitHub, use the provided profile URLs.
- Do not claim content from LinkedIn or GitHub profiles unless explicitly provided in profile text.
- If optional instructions include random / randomly / \u0440\u0430\u043d\u0434\u043e\u043c / \u0441\u043b\u0443\u0447\u0430\u0439\u043d\u043e, enable RANDOM_SURVEY_MODE and treat fillUnknownBehavior as "fill_all_non_sensitive".
- In RANDOM_SURVEY_MODE:
  - For radio/select/scale questions, choose one valid option from provided options.
  - For checkbox questions, choose 1-3 valid options from provided options.
  - For rating scale 1-5 or 1-10, choose one available numeric option.
  - Mark safeToFill true for non-sensitive survey questions.
  - Use confidence 0.75 for randomly selected safe survey answers.
  - Reason: "Randomly selected as requested by optional instructions".
- If fillUnknownBehavior is "skip":
  - If data is missing, answer may be empty.
  - Use safeToFill false for missing/unknown answers.
- If fillUnknownBehavior is "fill_all_non_sensitive":
  - Do not skip harmless survey questions.
  - For non-sensitive text questions, provide a short plausible answer.
  - For non-sensitive radio/select/scale questions, choose one valid option.
  - For non-sensitive checkbox questions, choose 1-3 valid options.
  - Use confidence at least 0.7 for generated survey answers.
  - Use safeToFill true.
  - Only skip sensitive questions.
- Answer length:
  - short: 1 short phrase or sentence.
  - normal: 1-2 natural sentences.
  - detailed: 2-4 sentences when the question is open-ended.
  - For simple fields like name, age, email, phone, use exact profile value only.
- For text questions with no profile data:
  - If fillUnknownBehavior is "fill_all_non_sensitive" and the question is harmless, provide a short plausible answer.
  - If not enough data and fillUnknownBehavior is "skip", return empty string and safeToFill false.
- For choice questions, answer must match one of the provided options exactly.
- Never answer sensitive questions: passwords, card data, CVV, passport, IIN, banking details, exact private address.
- Sensitive questions must have answer "", confidence 0, safeToFill false.
`;

export async function generateAnswersWithAlem(payload) {
  const config = loadLocalAIConfig();

  console.log("[AI Form Filler] Using model:", config.model);
  console.log("[AI Form Filler] API URL:", `${config.baseUrl}/chat/completions`);

  let rawContent = "";

  try {
    rawContent = await requestChatCompletion(config, payload, true);
  } catch (error) {
    if (error?.retryWithoutResponseFormat) {
      console.warn("[AI Form Filler] Retrying without response_format");
      rawContent = await requestChatCompletion(config, payload, false);
    } else {
      throw error;
    }
  }

  try {
    return parseAndNormalizeAIContent(rawContent, payload);
  } catch (firstParseError) {
    console.warn("[AI Form Filler] First JSON parse failed. Trying repair retry.", firstParseError);

    const repairedContent = await requestJsonRepair(config, rawContent, payload);

    try {
      return parseAndNormalizeAIContent(repairedContent, payload);
    } catch (secondParseError) {
      throw createUserError(
        "AI returned a response that could not be parsed as the expected JSON. Click Show raw AI response for debugging.",
        {
          cause: secondParseError,
          rawResponse: repairedContent || rawContent
        }
      );
    }
  }
}

function loadLocalAIConfig() {
  const config = LOCAL_AI_CONFIG;

  if (!config || typeof config !== "object") {
    throw createUserError("src/localConfig.js must export LOCAL_AI_CONFIG.");
  }

  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(config.model || "").trim();
  const apiKey = String(config.apiKey || "").trim();

  if (!baseUrl || !model || !apiKey) {
    throw createUserError("LOCAL_AI_CONFIG requires non-empty baseUrl, model, and apiKey values.");
  }

  return { baseUrl, model, apiKey };
}

async function requestChatCompletion(config, payload, includeResponseFormat) {
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) }
    ],
    temperature: shouldUseRandom(payload) ? 0.8 : getEffectiveFillUnknownBehavior(payload) === "fill_all_non_sensitive" ? 0.45 : 0.2
  };

  if (includeResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  const responseText = await postToChatCompletions(config, body);
  const apiJson = safeJsonParse(responseText);
  const content = apiJson?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }

  throw createUserError("Alem API response did not include choices[0].message.content.", {
    rawResponse: responseText
  });
}

async function requestJsonRepair(config, badContent, originalPayload) {
  const repairPrompt = `
Convert the following model output into the exact required JSON schema.
Return ONLY valid JSON.
No markdown.
No explanations.

Required schema:
{
  "answers": [
    {
      "questionId": "q_1",
      "questionText": "Question text",
      "type": "text | textarea | radio | checkbox | select | scale | date | unknown",
      "answer": "answer text or selected option",
      "confidence": 0.0,
      "reason": "short reason",
      "safeToFill": true
    }
  ],
  "warnings": []
}

Original form questions:
${JSON.stringify(originalPayload.form?.questions || [])}

Bad model output:
${badContent}
`;

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: "You repair invalid AI output into strict JSON. Return only valid JSON." },
      { role: "user", content: repairPrompt }
    ],
    temperature: 0
  };

  try {
    const responseText = await postToChatCompletions(config, body);
    const apiJson = safeJsonParse(responseText);
    const content = apiJson?.choices?.[0]?.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (content && typeof content === "object") {
      return JSON.stringify(content);
    }

    return responseText;
  } catch (error) {
    console.error("[AI Form Filler] JSON repair failed:", error);
    return badContent;
  }
}

async function postToChatCompletions(config, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const responseText = await response.text();

    if (!response.ok) {
      const error = createUserError(
        `Alem API request failed with HTTP ${response.status}. ${extractErrorMessage(responseText)}`,
        {
          status: response.status,
          rawResponse: responseText
        }
      );

      if (
        body.response_format &&
        (response.status === 400 ||
          response.status === 404 ||
          response.status === 422 ||
          /response_format/i.test(responseText))
      ) {
        error.retryWithoutResponseFormat = true;
      }

      throw error;
    }

    return responseText;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createUserError("Alem API request timed out after 60 seconds.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseAndNormalizeAIContent(content, payload) {
  const parsed = parseJsonObjectFromText(content);

  if (!parsed || !Array.isArray(parsed.answers)) {
    throw createUserError("AI response JSON must contain an answers array.", {
      rawResponse: content
    });
  }

  const context = {
    answerLength: getAnswerLength(payload),
    fillUnknownBehavior: getEffectiveFillUnknownBehavior(payload),
    profile: payload?.profile || {},
    randomMode: shouldUseRandom(payload)
  };
  const questions = Array.isArray(payload?.form?.questions) ? payload.form.questions : [];
  const answersById = new Map(parsed.answers.map((answer) => [String(answer?.questionId || ""), answer]));
  const normalizedAnswers = questions.map((question) => normalizeAnswer(answersById.get(question.id), question, context));

  return {
    answers: normalizedAnswers,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []
  };
}

function parseJsonObjectFromText(text) {
  const trimmed = String(text || "").trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const withoutCodeFence = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutCodeFence);
  } catch {}

  const start = withoutCodeFence.indexOf("{");
  const end = withoutCodeFence.lastIndexOf("}");

  if (start !== -1 && end > start) {
    return JSON.parse(withoutCodeFence.slice(start, end + 1));
  }

  throw createUserError("AI response was not valid JSON.", {
    rawResponse: text
  });
}

function normalizeAnswer(answer, question, context) {
  const confidenceNumber = Number(answer?.confidence);
  const questionType = String(question?.type || answer?.type || "unknown");
  const normalized = {
    questionId: String(question?.id || answer?.questionId || ""),
    questionText: String(question?.questionText || answer?.questionText || ""),
    type: questionType,
    answer: normalizeAnswerValue(answer?.answer),
    confidence: Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0,
    reason: String(answer?.reason || ""),
    safeToFill: Boolean(answer?.safeToFill)
  };

  if (question?.sensitive) {
    return {
      ...normalized,
      answer: "",
      confidence: 0,
      reason: "Sensitive question skipped",
      safeToFill: false
    };
  }

  if (!answer) {
    normalized.reason = "No answer returned by AI";
  }

  if (CHOICE_TYPES.has(questionType)) {
    normalized.answer = coerceChoiceAnswer(normalized.answer, question, questionType);

    if (isEmptyAnswer(normalized.answer)) {
      normalized.safeToFill = false;
      normalized.confidence = 0;
      normalized.reason = normalized.reason || "No matching option selected";
    }
  }

  if (context.fillUnknownBehavior === "fill_all_non_sensitive") {
    if (isEmptyAnswer(normalized.answer)) {
      const fallback = createFallbackAnswer(question, questionType, context);

      if (!isEmptyAnswer(fallback.answer)) {
        normalized.answer = fallback.answer;
        normalized.reason = fallback.reason;
      }
    }

    if (!isEmptyAnswer(normalized.answer)) {
      normalized.safeToFill = true;
      normalized.confidence = Math.max(normalized.confidence || 0, context.randomMode ? 0.75 : 0.7);
      normalized.reason =
        normalized.reason ||
        (context.randomMode
          ? "Randomly selected as requested by optional instructions"
          : "Generated for non-sensitive question as requested");
    }
  }

  if (context.randomMode && CHOICE_TYPES.has(questionType) && !isEmptyAnswer(normalized.answer)) {
    normalized.safeToFill = true;
    normalized.confidence = Math.max(normalized.confidence || 0, 0.75);
    normalized.reason = "Randomly selected as requested";
  }

  return normalized;
}

function coerceChoiceAnswer(value, question, type) {
  const options = Array.isArray(question?.options) ? question.options : [];

  if (options.length === 0) {
    return value;
  }

  if (type === "checkbox") {
    const values = Array.isArray(value)
      ? value
      : String(value || "")
          .split(/[,;\n]/)
          .map((item) => item.trim())
          .filter(Boolean);
    return values.map((item) => matchOption(item, options, type)).filter(Boolean);
  }

  return matchOption(Array.isArray(value) ? value[0] : value, options, type) || "";
}

function matchOption(value, options, type = "") {
  const normalizedValue = normalizeOptionText(value);

  if (!normalizedValue) {
    return "";
  }

  const numericValue = extractScaleNumber(value);

  return (
    options.find((option) => normalizeOptionText(option) === normalizedValue) ||
    (numericValue
      ? options.find((option) => extractScaleNumber(option) === numericValue || normalizeOptionText(option) === numericValue)
      : "") ||
    (type === "scale" && numericValue
      ? options.find((option) => normalizeOptionText(option).startsWith(`${numericValue} `))
      : "") ||
    options.find((option) => {
      const normalizedOption = normalizeOptionText(option);
      return normalizedOption.includes(normalizedValue) || normalizedValue.includes(normalizedOption);
    }) ||
    ""
  );
}

function createFallbackAnswer(question, questionType, context) {
  const profileAnswer = getProfileFallbackAnswer(question, context.profile);

  if (profileAnswer) {
    return {
      answer: profileAnswer,
      reason: "Used matching profile value"
    };
  }

  const options = Array.isArray(question?.options) ? question.options.filter((option) => String(option || "").trim()) : [];
  const reason = context.randomMode
    ? "Randomly selected as requested by optional instructions"
    : "Generated for non-sensitive question as requested";

  if (["radio", "select", "scale"].includes(questionType) && options.length > 0) {
    return {
      answer: pickSingleOption(options, questionType, context.randomMode),
      reason
    };
  }

  if (questionType === "checkbox" && options.length > 0) {
    return {
      answer: pickCheckboxOptions(options, context.randomMode),
      reason
    };
  }

  if (["text", "textarea", "unknown"].includes(questionType) && !looksLikeExactProfileField(question?.questionText || "")) {
    return {
      answer: createNeutralTextAnswer(context.answerLength),
      reason
    };
  }

  return {
    answer: "",
    reason: "No safe fallback answer available"
  };
}

function getProfileFallbackAnswer(question, profile = {}) {
  const text = normalizeOptionText(`${question?.questionText || ""} ${question?.description || ""}`);
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  const mappings = [
    { pattern: /\blinkedin\b/, value: profile.linkedinUrl },
    { pattern: /\bgithub\b|\bgit hub\b/, value: profile.githubUrl },
    { pattern: /\u043b\u0438\u043d\u043a\u0435\u0434\u0438\u043d|\u043b\u0438\u043d\u043a\u0434\u0438\u043d/i, value: profile.linkedinUrl },
    { pattern: /\u0433\u0438\u0442\u0445\u0430\u0431/i, value: profile.githubUrl },
    { pattern: /\b(full name|name and surname)\b/, value: fullName },
    { pattern: /\u0444\u0438\u043e|\u043f\u043e\u043b\u043d\u043e\u0435\s+\u0438\u043c\u044f/i, value: fullName },
    { pattern: /\bfirst name\b/, value: profile.firstName },
    { pattern: /\b\u0438\u043c\u044f\b/i, value: profile.firstName },
    { pattern: /\blast name\b|\bsurname\b/, value: profile.lastName },
    { pattern: /\u0444\u0430\u043c\u0438\u043b\u0438\u044f/i, value: profile.lastName },
    { pattern: /\bemail\b|\be-mail\b/, value: profile.email },
    { pattern: /\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u043d\u043d\u0430\u044f\s+\u043f\u043e\u0447\u0442\u0430|\b\u043f\u043e\u0447\u0442\u0430\b/i, value: profile.email },
    { pattern: /\bphone\b|\bmobile\b|\btelephone\b/, value: profile.phone },
    { pattern: /\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043c\u043e\u0431\u0438\u043b\u044c\u043d/i, value: profile.phone },
    { pattern: /\bcity\b/, value: profile.city },
    { pattern: /\u0433\u043e\u0440\u043e\u0434/i, value: profile.city },
    { pattern: /\bcountry\b/, value: profile.country },
    { pattern: /\u0441\u0442\u0440\u0430\u043d\u0430/i, value: profile.country },
    { pattern: /\bage\b/, value: profile.age },
    { pattern: /\u0432\u043e\u0437\u0440\u0430\u0441\u0442/i, value: profile.age },
    { pattern: /\b(occupation|role|job title|profession)\b/, value: profile.occupation },
    { pattern: /\u0434\u043e\u043b\u0436\u043d\u043e\u0441\u0442\u044c|\u0440\u043e\u043b\u044c|\u043f\u0440\u043e\u0444\u0435\u0441\u0441\u0438\u044f/i, value: profile.occupation },
    { pattern: /\b(university|company|school|organization|organisation)\b/, value: profile.universityOrCompany },
    { pattern: /\u0443\u043d\u0438\u0432\u0435\u0440\u0441\u0438\u0442\u0435\u0442|\u043a\u043e\u043c\u043f\u0430\u043d\u0438\u044f|\u0448\u043a\u043e\u043b\u0430|\u043e\u0440\u0433\u0430\u043d\u0438\u0437\u0430\u0446/i, value: profile.universityOrCompany },
    { pattern: /\beducation\b/, value: profile.education },
    { pattern: /\u043e\u0431\u0440\u0430\u0437\u043e\u0432\u0430\u043d\u0438\u0435/i, value: profile.education },
    { pattern: /\bskills?\b/, value: profile.skills },
    { pattern: /\u043d\u0430\u0432\u044b\u043a/i, value: profile.skills },
    { pattern: /\bexperience\b/, value: profile.experience },
    { pattern: /\u043e\u043f\u044b\u0442/i, value: profile.experience },
    { pattern: /\blanguages?\b/, value: profile.languages },
    { pattern: /\u044f\u0437\u044b\u043a/i, value: profile.languages },
    { pattern: /\b(bio|about you|about me)\b/, value: profile.shortBio },
    { pattern: /\u043e\s+\u0441\u0435\u0431\u0435|\u0431\u0438\u043e/i, value: profile.shortBio },
    { pattern: /\b(motivation|why are you interested)\b/, value: profile.motivation },
    { pattern: /\u043c\u043e\u0442\u0438\u0432\u0430\u0446|\u043f\u043e\u0447\u0435\u043c\u0443\s+\u0432\u044b\s+\u0437\u0430\u0438\u043d\u0442\u0435\u0440\u0435\u0441\u043e\u0432\u0430\u043d/i, value: profile.motivation }
  ];

  const match = mappings.find((item) => item.pattern.test(text) && String(item.value || "").trim());
  return match ? String(match.value).trim() : "";
}

function looksLikeExactProfileField(questionText) {
  return /\b(first name|last name|surname|full name|email|e-mail|phone|mobile|telephone|age|linkedin|github|city|country)\b|\u0444\u0438\u043e|\u0438\u043c\u044f|\u0444\u0430\u043c\u0438\u043b\u0438\u044f|\u044d\u043b\u0435\u043a\u0442\u0440\u043e\u043d\u043d\u0430\u044f\s+\u043f\u043e\u0447\u0442\u0430|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u0432\u043e\u0437\u0440\u0430\u0441\u0442|\u0433\u043e\u0440\u043e\u0434|\u0441\u0442\u0440\u0430\u043d\u0430|\u043b\u0438\u043d\u043a\u0435\u0434\u0438\u043d|\u0433\u0438\u0442\u0445\u0430\u0431/i.test(
    questionText || ""
  );
}

function createNeutralTextAnswer(answerLength) {
  if (answerLength === "detailed") {
    return "I do not have a strong preference. Overall, it seems useful, clear, and easy to engage with.";
  }

  if (answerLength === "short") {
    return "No strong preference.";
  }

  return "I do not have a strong preference, but overall it seems useful and clear.";
}

function pickSingleOption(options, type, randomMode) {
  if (randomMode) {
    return options[Math.floor(Math.random() * options.length)] || "";
  }

  if (type === "scale") {
    return options[Math.floor((options.length - 1) / 2)] || options[0] || "";
  }

  return options[0] || "";
}

function pickCheckboxOptions(options, randomMode) {
  const maxCount = Math.min(3, options.length);
  const count = randomMode ? Math.max(1, Math.ceil(Math.random() * maxCount)) : Math.min(2, maxCount);

  if (!randomMode) {
    return options.slice(0, count);
  }

  return [...options].sort(() => Math.random() - 0.5).slice(0, count);
}

function normalizeAnswerValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function isEmptyAnswer(value) {
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => !String(item || "").trim());
  }

  return !String(value || "").trim();
}

function getEffectiveFillUnknownBehavior(payload) {
  if (shouldUseRandom(payload)) {
    return "fill_all_non_sensitive";
  }

  return payload?.preferences?.fillUnknownBehavior === "fill_all_non_sensitive" ? "fill_all_non_sensitive" : "skip";
}

function getAnswerLength(payload) {
  const value = payload?.preferences?.answerLength;
  return ["short", "normal", "detailed"].includes(value) ? value : "normal";
}

function shouldUseRandom(payload) {
  return /random|randomly|\u0440\u0430\u043d\u0434\u043e\u043c|\u0441\u043b\u0443\u0447\u0430\u0439\u043d/i.test(
    payload?.optionalInstructions || ""
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createUserError("Alem API returned a non-JSON HTTP response.", {
      cause: error,
      rawResponse: text
    });
  }
}

function extractErrorMessage(responseText) {
  if (!responseText) return "";

  try {
    const json = JSON.parse(responseText);
    return json?.error?.message || json?.message || responseText.slice(0, 400);
  } catch {
    return responseText.slice(0, 400);
  }
}

function normalizeComparable(value) {
  return normalizeOptionText(value);
}

function normalizeOptionText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/g, "");
}

function extractScaleNumber(value) {
  const match = String(value || "").match(/(?:^|\b)(10|[0-9])(?:\b|$)/);
  return match ? match[1] : "";
}

function createUserError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}
