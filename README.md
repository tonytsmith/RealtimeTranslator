# Realtime Translator (PWA)

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
Open `http://localhost:8787`.

## Use
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
- Default monthly usage limit: `$20`.
- Pricing constants can be tuned via env vars:
  - `PRICE_TRANSCRIBE_INPUT_PER_1M`
  - `PRICE_TRANSLATE_INPUT_PER_1M`
  - `PRICE_TRANSLATE_OUTPUT_PER_1M`
  - `PRICE_TTS_PER_1M_CHARS`
  - `MONTHLY_USAGE_LIMIT_USD`

## Model env overrides
- `TRANSCRIBE_MODEL` (default `gpt-4o-transcribe`)
- `TRANSLATE_MODEL` (default `gpt-4.1-mini`)
- `TTS_MODEL` (default `gpt-4o-mini-tts`)
- `TTS_VOICE` (optional override for all voices)
- `TTS_MALE_VOICE` (default `cedar`)
- `TTS_FEMALE_VOICE` (default `marin`)
- `APP_PASSWORD` (default `Translate`)
- `MONTHLY_USAGE_LIMIT_USD` (default `20`)

## Notes
- Supported input/output languages: English, Mandarin, Russian, Korean, Spanish, French, Japanese, German, Portuguese, Italian, Greek.
- Translation uses the previous transcript chunk as context while translating the current chunk.
- The app does not save transcript history.
- The app is optimized for accuracy over minimum latency.
- PWA install: in Chrome, open app menu and choose `Install`.
