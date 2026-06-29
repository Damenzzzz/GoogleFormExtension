import { generateAnswersWithAlem } from "./apiClient.js";

console.log("[AI Form Filler] Background service worker loaded");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GENERATE_ANSWERS") {
    return false;
  }

  console.log("[AI Form Filler] GENERATE_ANSWERS received");

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

  return true;
});

function serializeError(error) {
  return {
    message: error?.message || "Unknown error",
    status: error?.status || null,
    rawResponse: error?.rawResponse || null,
    stack: error?.stack || null
  };
}
