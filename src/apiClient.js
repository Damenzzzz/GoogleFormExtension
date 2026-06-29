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
- If optional instructions include random / randomly / рандом / рандомно / случайно, enable RANDOM_SURVEY_MODE.
- In RANDOM_SURVEY_MODE:
  - For radio/select/scale questions, choose one valid option from provided options.
  - For checkbox questions, choose 1-3 valid options from provided options.
  - For rating scale 1-5 or 1-10, choose one available numeric option.
  - Mark safeToFill true for non-sensitive survey questions.
  - Use confidence 0.75 for randomly selected safe survey answers.
  - Reason: "Randomly selected as requested by optional instructions".
- For text questions with no profile data:
  - If random mode is on and the question is harmless, provide a short plausible answer.
  - If not enough data and random mode is off, return empty string and safeToFill false.
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
    temperature: shouldUseRandom(payload) ? 0.8 : 0.2
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

  const randomMode = shouldUseRandom(payload);
  const questions = Array.isArray(payload?.form?.questions) ? payload.form.questions : [];
  const answersById = new Map(parsed.answers.map((answer) => [String(answer?.questionId || ""), answer]));
  const normalizedAnswers = questions.map((question) =>
    normalizeAnswer(answersById.get(question.id), question, randomMode)
  );

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

function normalizeAnswer(answer, question, randomMode) {
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

  if (!answer) {
    normalized.reason = "No answer returned by AI";
    return normalized;
  }

  if (question?.sensitive) {
    return {
      ...normalized,
      answer: "",
      confidence: 0,
      reason: "Sensitive question skipped",
      safeToFill: false
    };
  }

  if (CHOICE_TYPES.has(questionType)) {
    normalized.answer = coerceChoiceAnswer(normalized.answer, question, questionType);

    if (isEmptyAnswer(normalized.answer)) {
      normalized.safeToFill = false;
      normalized.confidence = 0;
      normalized.reason = normalized.reason || "No matching option selected";
    }
  }

  if (randomMode && !question?.sensitive && CHOICE_TYPES.has(questionType) && !isEmptyAnswer(normalized.answer)) {
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
    return values.map((item) => matchOption(item, options)).filter(Boolean);
  }

  return matchOption(Array.isArray(value) ? value[0] : value, options) || "";
}

function matchOption(value, options) {
  const normalizedValue = normalizeComparable(value);

  if (!normalizedValue) {
    return "";
  }

  return (
    options.find((option) => normalizeComparable(option) === normalizedValue) ||
    options.find((option) => {
      const normalizedOption = normalizeComparable(option);
      return normalizedOption.includes(normalizedValue) || normalizedValue.includes(normalizedOption);
    }) ||
    ""
  );
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

function shouldUseRandom(payload) {
  return /random|randomly|рандом|рандомно|случайн/i.test(payload?.optionalInstructions || "");
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
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim()
    .toLowerCase();
}

function createUserError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}
