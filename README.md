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
### Stable chunk translator
1. Log in with the app password.
2. Enter your OpenAI API key.
3. Select input and output languages.
4. Select output mode: `Text Only`, `Text and Speech`, or `Speech Only`.
5. Select speech speed and voice when speech output is enabled.
6. Press `Start`.
7. Press `Pause` to keep listening but suppress translation/output.
8. Press `Resume` to continue translation.
9. Press `Stop` to end the session and reset session-cost totals.

### Realtime beta
Open `/realtime` after logging in.

This separate version keeps the stable translator intact, but streams microphone audio through OpenAI Realtime over WebRTC. It should usually produce smoother sentence boundaries because the model hears the live stream instead of isolated audio chunks.

Requirements for the realtime beta:
- Set `OPENAI_API_KEY` in the server or Render environment variables.
- Optional: set `REALTIME_MODEL` to override the default `gpt-realtime-2`.
- Use HTTPS when hosted so mobile browsers allow microphone access.

Current realtime beta limits:
- It uses the server-side API key, not the browser API key field.
- It shows reported realtime token usage when available, but does not yet convert realtime usage into a dollar estimate.
- The monthly usage cap blocks starting a new realtime session only if the existing tracked monthly total is already over the limit.

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
- `OPENAI_API_KEY` (required for `/realtime`)
- `REALTIME_MODEL` (default `gpt-realtime-2`)
- `APP_PASSWORD` (default `Translate`)
- `MONTHLY_USAGE_LIMIT_USD` (default `20`)

## Notes
- Supported input/output languages: English, Mandarin, Russian, Korean, Spanish, French, Japanese, German, Portuguese, Italian, Greek.
- The app does not save transcript history.
- The app is optimized for accuracy over minimum latency.
- PWA install: in Chrome, open app menu and choose `Install`.
