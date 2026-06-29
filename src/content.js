chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "ANALYZE_FORM") {
    handleAnalyzeForm(sendResponse);
    return true;
  }

  if (message.type === "FILL_SAFE_ANSWERS") {
    handleFillSafeAnswers(message, sendResponse);
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

async function handleFillSafeAnswers(message, sendResponse) {
  try {
    if (!window.LocalAIFormFiller) {
      throw new Error("Form filler is not loaded.");
    }

    const result = await window.LocalAIFormFiller.fillSafeAnswers({
      answers: message.answers || [],
      questions: message.questions || []
    });

    sendResponse({
      ok: true,
      result
    });
  } catch (error) {
    console.error("Fill safe answers failed:", error);
    sendResponse({
      ok: false,
      error: error?.message || "Failed to fill safe answers."
    });
  }
}
