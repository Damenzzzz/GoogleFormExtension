chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "ANALYZE_FORM") {
    handleAnalyzeForm(sendResponse);
    return true;
  }

  if (message.type === "FILL_SAFE_ANSWERS") {
    handleFillAnswers(message, "safe", sendResponse);
    return true;
  }

  if (message.type === "FILL_ALL_PREVIEWED") {
    handleFillAnswers(message, "all", sendResponse);
    return true;
  }

  if (message.type === "PREVIEW_ANSWERS_ON_FORM") {
    handlePreviewAnswersOnForm(message, sendResponse);
    return true;
  }

  if (message.type === "CLEAR_FORM_PREVIEW" || message.type === "CLEAR_FORM_HIGHLIGHTS") {
    handleClearFormPreview(sendResponse);
    return true;
  }

  return false;
});

async function handleAnalyzeForm(sendResponse) {
  try {
    if (!window.LocalAIFormParser) {
      throw new Error("Form parser is not loaded.");
    }

    const form = await window.LocalAIFormParser.parseGoogleForm();

    sendResponse({
      ok: true,
      form
    });
  } catch (error) {
    console.error("Analyze form failed:", error);
    sendResponse({
      ok: false,
      error: error?.message || "Failed to analyze form."
    });
  }
}

async function handleFillAnswers(message, mode, sendResponse) {
  try {
    if (!window.LocalAIFormFiller) {
      throw new Error("Form filler is not loaded.");
    }

    const method = mode === "all" ? "fillAllPreviewed" : "fillSafeAnswers";
    const result = await window.LocalAIFormFiller[method]({
      answers: message.answers || [],
      questions: message.questions || []
    });

    sendResponse({
      ok: true,
      result
    });
  } catch (error) {
    console.error("Fill answers failed:", error);
    sendResponse({
      ok: false,
      error: error?.message || "Failed to fill answers."
    });
  }
}

function handlePreviewAnswersOnForm(message, sendResponse) {
  try {
    if (!window.LocalAIFormFiller) {
      throw new Error("Form filler is not loaded.");
    }

    const result = window.LocalAIFormFiller.previewAnswersOnForm({
      answers: message.payload?.answers || [],
      questions: message.payload?.questions || []
    });

    sendResponse({
      ok: true,
      result
    });
  } catch (error) {
    console.error("Preview answers on form failed:", error);
    sendResponse({
      ok: false,
      error: error?.message || "Failed to preview answers on form."
    });
  }
}

function handleClearFormPreview(sendResponse) {
  try {
    const clearPreview = window.LocalAIFormFiller?.clearFormPreview || window.LocalAIFormFiller?.clearFormHighlights;
    clearPreview?.();
    sendResponse({ ok: true });
  } catch (error) {
    console.error("Clear form preview failed:", error);
    sendResponse({
      ok: false,
      error: error?.message || "Failed to clear form preview."
    });
  }
}
