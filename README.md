# local-ai-google-form-filler

Local Chrome Extension Manifest V3 for previewing and safely filling Google Forms with an OpenAI-compatible Alem API endpoint.

The extension is designed for personal local use. It does not include an API key field in the UI. API credentials stay in `src/localConfig.js`, which is ignored by Git.

## Setup

1. Clone or open this project folder.

2. Create a local file:

```txt
src/localConfig.js
```

3. Add your local Alem API configuration:

```js
export const LOCAL_AI_CONFIG = {
  baseUrl: "https://llm.alem.ai/v1",
  model: "alemllm",
  apiKey: "YOUR_LOCAL_API_KEY"
};
```

4. Do not commit `src/localConfig.js`. It is listed in `.gitignore`.

5. Open Chrome:

```txt
chrome://extensions
```

6. Enable Developer Mode.

7. Click Load unpacked.

8. Select this project folder.

9. Open a Google Form.

10. Click the extension icon.

11. Fill the profile once and click Save Profile.

12. Use the flow:

```txt
Analyze Form -> Generate Answers -> Preview Answers -> Fill Safe Answers
```

The extension never submits the form automatically.

## Permissions

The extension uses:

- `storage` to save the local profile and draft state in Chrome Storage.
- `activeTab` and `scripting` for interaction with the current Google Forms tab.
- `https://docs.google.com/forms/*` for the Google Forms content script.
- `https://llm.alem.ai/*` for the Alem API endpoint.

The background service worker is an ES module:

```json
"background": {
  "service_worker": "src/background.js",
  "type": "module"
}
```

## Safety Behavior

The extension is intentionally conservative:

- It does not show or store API keys in the popup UI.
- It never logs the API key.
- It does not submit forms.
- It does not bypass CAPTCHA, login screens, access controls, or site restrictions.
- It skips sensitive fields such as passwords, card data, CVV, passport data, IIN, banking details, Kaspi card details, and exact private addresses.
- It fills only answers with `safeToFill: true`, non-sensitive questions, confidence `>= 0.6`, and non-empty answers.
- It previews every generated answer before filling.

## Editing Answers Before Fill

1. Generate answers.
2. Review cards in Preview.
3. Edit any answer manually.
4. Preview highlights update on the Google Form.
5. Click Fill Safe Answers or Fill All Previewed.

Manual edits are saved into the current draft. Manually edited answers are treated as user-approved non-sensitive preview answers.

## Fill Modes

- Safe Answers: fills only high-confidence safe answers.
- All Previewed: fills all non-sensitive answers currently visible in preview, including manually edited and random survey answers.

## Troubleshooting

After changing `src/localConfig.js`, `src/apiClient.js`, `src/background.js`, or `manifest.json`:

1. Open `chrome://extensions`.
2. Find this extension.
3. Click Reload.
4. Refresh the Google Form page.
5. Open the popup again.

If you see `Could not establish connection`:

- Refresh the Google Form page after reloading the extension.
- Make sure the URL starts with `https://docs.google.com/forms/`.

If you see a config error:

- Check that `src/localConfig.js` exists.
- Check that it exports exactly `LOCAL_AI_CONFIG`.
- Check that `baseUrl`, `model`, and `apiKey` are non-empty.
- Check that `background.js` is loaded with `"type": "module"` in `manifest.json`.

If you see an API error:

- Check `baseUrl: "https://llm.alem.ai/v1"`.
- Check `model: "alemllm"`.
- Check your API key.
- Check host permission `"https://llm.alem.ai/*"` in `manifest.json`.
- Open the extension service worker console and verify that these logs appear:

```txt
[AI Form Filler] Background service worker loaded
[AI Form Filler] GENERATE_ANSWERS received
```

If AI returns invalid JSON:

- The popup shows `Show raw AI response` in the Preview section.
- Open it to inspect the raw model output.
- Adjust optional instructions to ask for strict JSON only.

If answers are not filled:

- Open the extension service worker console and check warnings.
- Refresh the Google Form page after reloading the extension.
- Run Analyze Form again, then Generate Answers again.

If `src/localConfig.js` changed:

- Reload the extension in `chrome://extensions`.
- Reopen the popup so the module service worker uses the new local config.

## File Structure

```txt
manifest.json
.gitignore
README.md
src/popup.html
src/popup.css
src/popup.js
src/content.js
src/background.js
src/apiClient.js
src/formParser.js
src/formFiller.js
src/localConfig.example.js
src/localConfig.js
```
