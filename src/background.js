import { generateAnswersWithAlem } from "./apiClient.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GENERATE_ANSWERS") {
    return false;
  }

  generateAnswersWithAlem(message.payload)
    .then((result) => {
      sendResponse({
        ok: true,
        result
      });
    })
    .catch((error) => {
      console.error("Generate answers failed:", error);
      sendResponse({
        ok: false,
        error: serializeError(error)
      });
    });

  Chrome.runtime.onMessage.removeLis
  return true;
});

function serializeError(error) {
  return {
    message: error?.message || "Unknown error",
    status: error?.status || null,
    rawResponse: error?.rawResponse || null
  };
}
