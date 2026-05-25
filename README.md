# High Accuracy Live Translator (PWA)

Installable web app for Windows + Android Chrome that listens to microphone input and translates speech into text and/or audio in the selected output language.

## Requirements
- Node.js 20+
- OpenAI API key
- Chrome/Edge on Windows; Chrome on Android for install + microphone use

## Setup
```bash
npm install
npm run dev
```
Open `http://localhost:8787`. The default page is High Accuracy Live.

## Use
### High Accuracy Live
Open `/` or `/accuracy` after logging in.

This mode is designed for speeches. It records continuously, waits for natural pauses or a maximum segment length, transcribes each segment, sends recent transcript context with the new segment, then translates with the selected response configuration.

Default controls:
- Input Language: `Mandarin`
- Output Language: `English`
- Output: `Text and Speech`
- Response: `Fast`
- Quality / Delay: `More Realtime`
- Speech Speed: `1.25`
- Voice: `Male`

Response configurations:
- `Fast`: `gpt-4.1-mini`
- `Balanced`: `gpt-4.1`
- `Best Accuracy`: `gpt-5.5`

Use this mode when accuracy matters more than the lowest possible delay.

### Stable chunk translator
Open `/stable` after logging in.

1. Log in with the app password.
2. Enter your OpenAI API key.
3. Select input and output languages.
4. Select output mode: `Text Only`, `Text and Speech`, or `Speech Only`.
5. Select speech speed and voice when speech output is enabled.
6. Press `Start`.
7. Press `Pause` to keep listening but suppress translation/output.
8. Press `Resume` to continue translation.
9. Press `Stop` to end the session and reset session-cost totals.

## Access password
- Default password: `Translate`
- Override for hosting: set `APP_PASSWORD` in your host environment variables.
- Login uses an HTTP-only session cookie.

## Cost estimate behavior
- Shows running session estimate only.
- Estimate is computed from usage tokens when available plus TTS characters.
- Stops translation when estimated monthly usage reaches the configured monthly limit.
- Default monthly usage limit: `$50`.
- Pricing constants can be tuned via env vars:
  - `PRICE_TRANSCRIBE_INPUT_PER_1M`
  - `PRICE_TRANSLATE_INPUT_PER_1M`
  - `PRICE_TRANSLATE_OUTPUT_PER_1M`
  - `PRICE_TTS_PER_1M_CHARS`
  - `MONTHLY_USAGE_LIMIT_USD`

## Model env overrides
- `TRANSCRIBE_MODEL` (default `gpt-4o-transcribe`)
- `TRANSLATE_MODEL` (default `gpt-4.1-mini`)
- `TRANSLATE_FAST_MODEL` (default `gpt-4.1-mini`)
- `TRANSLATE_BALANCED_MODEL` (default `gpt-4.1`)
- `TRANSLATE_BEST_MODEL` (default `gpt-5.5`)
- `TTS_MODEL` (default `gpt-4o-mini-tts`)
- `TTS_VOICE` (optional override for all voices)
- `TTS_MALE_VOICE` (default `cedar`)
- `TTS_FEMALE_VOICE` (default `marin`)
- `APP_PASSWORD` (default `Translate`)
- `MONTHLY_USAGE_LIMIT_USD` (default `50`)

High Accuracy Live pricing overrides:
- `PRICE_TRANSLATE_FAST_INPUT_PER_1M`
- `PRICE_TRANSLATE_FAST_OUTPUT_PER_1M`
- `PRICE_TRANSLATE_BALANCED_INPUT_PER_1M`
- `PRICE_TRANSLATE_BALANCED_OUTPUT_PER_1M`
- `PRICE_TRANSLATE_BEST_INPUT_PER_1M`
- `PRICE_TRANSLATE_BEST_OUTPUT_PER_1M`

## Notes
- Supported input/output languages: English, Mandarin, Russian, Korean, Spanish, French, Japanese, German, Portuguese, Italian, Greek.
- The app does not save transcript history.
- The app is optimized for accuracy over minimum latency.
- PWA install: in Chrome, open app menu and choose `Install`.
