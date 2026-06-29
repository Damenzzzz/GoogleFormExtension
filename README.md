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
  baseUrl: "YOUR_ALEM_API_BASE_URL",
  model: "YOUR_MODEL_NAME",
  apiKey: "YOUR_LOCAL_API_KEY"
};
```

4. Do not commit `src/localConfig.js`. It is already listed in `.gitignore`.

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

## Local Config Example

`src/localConfig.example.js` contains placeholder values:

```js
export const LOCAL_AI_CONFIG = {
  baseUrl: "https://YOUR_ALEM_API_BASE_URL",
  model: "YOUR_MODEL_NAME",
  apiKey: "PASTE_YOUR_API_KEY_HERE"
};
```

Copy it to `src/localConfig.js` and replace the values locally.

## Permissions

The extension uses:

- `storage` to save the local profile and draft state in Chrome Storage.
- `activeTab` and `scripting` for interaction with the current Google Forms tab.
- `https://docs.google.com/forms/*` for the Google Forms content script.
- `https://*/*` for the OpenAI-compatible Alem API endpoint configured in `src/localConfig.js`.

For stricter local permissions, replace `https://*/*` in `manifest.json` with the exact Alem API host used by your `baseUrl`, for example:

```json
"https://api.example.com/*"
```

## Safety Behavior

The extension is intentionally conservative:

- It does not show or store API keys in the popup UI.
- It does not submit forms.
- It does not bypass CAPTCHA, login screens, access controls, or site restrictions.
- It skips sensitive fields such as passwords, card data, CVV, passport data, IIN, banking details, Kaspi card details, and exact private addresses.
- It fills only answers with `safeToFill: true`, non-sensitive questions, confidence `>= 0.6`, and non-empty answers.
- It previews every generated answer before filling.

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
```

## Troubleshooting

If Generate Answers fails:

- Confirm `src/localConfig.js` exists.
- Confirm `baseUrl`, `model`, and `apiKey` are set.
- Confirm the Alem API is OpenAI-compatible at:

```txt
POST {baseUrl}/chat/completions
```

- If the API host is blocked by extension permissions, update `manifest.json` host permissions and reload the extension in `chrome://extensions`.

If Analyze Form fails:

- Make sure the active tab is a Google Forms page under `https://docs.google.com/forms/`.
- Reload the form page after loading the extension.

"# GoogleFormExtension" 
