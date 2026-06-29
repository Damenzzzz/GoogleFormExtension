const SYSTEM_PROMPT = `You are an AI assistant that helps fill Google Forms.

Use only the user's profile, form questions, available options, and optional instructions.
Do not invent important facts.
If you do not know the answer, return an empty string.
For choice questions, select only from the provided options.
Do not answer sensitive questions such as passwords, card data, passport data, IIN, banking details, or private address.
Return only valid JSON. Do not use markdown.`;

const REQUEST_TIMEOUT_MS = 60000;

export async function generateAnswersWithAlem(payload) {
  const config = await loadLocalAIConfig();

  try {
    return await requestChatCompletion(config, payload, true);
  } catch (error) {
    if (error && error.retryWithoutResponseFormat) {
      console.warn("Alem API rejected response_format. Retrying without response_format.");
      return requestChatCompletion(config, payload, false);
    }
    throw error;
  }
}

async function loadLocalAIConfig() {
  let module;

  try {
    module = await import("./localConfig.js");
  } catch (error) {
    throw createUserError(
      "Missing src/localConfig.js. Create it from src/localConfig.example.js and set baseUrl, model, and apiKey.",
      { cause: error }
    );
  }

  const config = module.LOCAL_AI_CONFIG;

  if (!config || typeof config !== "object") {
    throw createUserError("src/localConfig.js must export LOCAL_AI_CONFIG.");
  }

  const baseUrl = String(config.baseUrl || "").trim();
  const model = String(config.model || "").trim();
  const apiKey = String(config.apiKey || "").trim();

  if (!baseUrl || !model || !apiKey) {
    throw createUserError("LOCAL_AI_CONFIG requires non-empty baseUrl, model, and apiKey values.");
  }

  return { baseUrl: stripTrailingSlashes(baseUrl), model, apiKey };
}

async function requestChatCompletion(config, payload, includeResponseFormat) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const body = {
    model: config.model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ],
    temperature: 0.2
  };

  if (includeResponseFormat) {
    body.response_format = {
      type: "json_object"
    };
  }

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
      const error = createHttpError(response, responseText);

      if (
        includeResponseFormat &&
        (response.status === 400 ||
          response.status === 404 ||
          response.status === 422 ||
          /response_format/i.test(responseText))
      ) {
        error.retryWithoutResponseFormat = true;
      }

      throw error;
    }

    return parseCompletionResponse(responseText);
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw createUserError("Alem API request timed out after 60 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseCompletionResponse(responseText) {
  let apiJson;

  try {
    apiJson = JSON.parse(responseText);
  } catch (error) {
    console.error("Alem API returned non-JSON HTTP response:", responseText);
    throw createUserError("Alem API returned a non-JSON HTTP response.", {
      cause: error,
      rawResponse: responseText
    });
  }

  const rawContent = apiJson?.choices?.[0]?.message?.content;
  const content =
    typeof rawContent === "string" ? rawContent : rawContent ? JSON.stringify(rawContent) : "";

  if (!content) {
    console.error("Alem API response did not include choices[0].message.content:", apiJson);
    throw createUserError("Alem API response did not include generated content.");
  }

  const parsed = parseJsonObjectFromModelContent(content);

  if (!parsed || !Array.isArray(parsed.answers)) {
    console.error("AI response content is not the expected JSON shape:", content);
    throw createUserError("AI response JSON must contain an answers array.", {
      rawResponse: content
    });
  }

  return {
    answers: parsed.answers.map(normalizeAnswer),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []
  };
}

function parseJsonObjectFromModelContent(content) {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch (firstError) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start !== -1 && end > start) {
      const candidate = trimmed.slice(start, end + 1);

      try {
        return JSON.parse(candidate);
      } catch (secondError) {
        console.error("AI response was not valid JSON:", content);
        throw createUserError("AI response was not valid JSON. Check the console for the raw response.", {
          cause: secondError,
          rawResponse: content
        });
      }
    }

    console.error("AI response was not valid JSON:", content);
    throw createUserError("AI response was not valid JSON. Check the console for the raw response.", {
      cause: firstError,
      rawResponse: content
    });
  }
}

function normalizeAnswer(answer) {
  const confidenceNumber = Number(answer?.confidence);

  return {
    questionId: String(answer?.questionId || ""),
    questionText: String(answer?.questionText || ""),
    type: String(answer?.type || "unknown"),
    answer: normalizeAnswerValue(answer?.answer),
    confidence: Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0,
    reason: String(answer?.reason || ""),
    safeToFill: Boolean(answer?.safeToFill)
  };
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

function createHttpError(response, responseText) {
  const message = `Alem API request failed with HTTP ${response.status}. ${extractErrorMessage(responseText)}`;
  return createUserError(message.trim(), {
    status: response.status,
    rawResponse: responseText
  });
}

function extractErrorMessage(responseText) {
  if (!responseText) {
    return "";
  }

  try {
    const json = JSON.parse(responseText);
    return json?.error?.message || json?.message || responseText.slice(0, 400);
  } catch {
    return responseText.slice(0, 400);
  }
}

function createUserError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}
