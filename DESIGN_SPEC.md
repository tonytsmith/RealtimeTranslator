# Realtime Translator v1 Design Spec

## Goal
Build a single installable web app (PWA) for Windows + Android Chrome that captures room microphone audio and translates Mandarin, Russian, or Korean speech to English in near-real time, with both text and audio output.

## Product scope (v1)
- Single-user local app.
- Manual source-language selection only.
- One-way translation only: Mandarin/Russian/Korean -> English.
- Start/Pause/Stop controls.
- Pause behavior: continue microphone capture but suppress translation/output.
- No transcript persistence.
- Session-only cost estimate display.
- Accuracy prioritized over latency (acceptable up to ~5s).

## Architecture
- Frontend: static PWA (`public/*`) running in Chrome.
- Backend: Node.js Express API (`server.js`) for OpenAI calls.
- Transport: `MediaRecorder` chunk upload (`audio/webm;codecs=opus`) every 2-4 seconds.

## Data flow
1. User presses Start.
2. Browser requests microphone and starts `MediaRecorder`.
3. Each chunk posts to `/api/translate-chunk` with selected source language.
4. Backend pipeline per chunk:
   - Transcribe source speech.
   - Translate transcription to English.
   - Synthesize English speech.
5. Frontend appends translated text and queues audio playback.
6. Backend returns cumulative session estimate; UI updates cost.

## API design
- `POST /api/translate-chunk`
  - multipart fields: `audio`, `language`, `sessionId`
  - header: `x-openai-api-key`
  - returns: `sourceText`, `translatedText`, `audioBase64`, `usage`
- `POST /api/reset-session`
  - JSON: `sessionId`
  - clears in-memory session totals.

## Model choices (configurable)
- Transcription: `gpt-4o-transcribe`
- Translation: `gpt-4.1-mini`
- TTS: `gpt-4o-mini-tts` with `alloy` voice

## Latency strategy
- Default chunk size 3000ms for smoother TTS cadence.
- Parallel in-flight chunk handling on frontend.
- Audio playback queue with small inter-chunk buffer to reduce choppiness.

## Cost tracking
- Cumulative in-memory per-session estimate from token usage + character count.
- No persistence between sessions.
- Pricing coefficients are environment-variable configurable.

## Security and privacy
- API key entered in UI and sent per request.
- Key saved in browser localStorage (single-user convenience tradeoff).
- No transcript/history storage on server.

## PWA/installability
- `manifest.webmanifest` with standalone display mode.
- Service worker caches app shell assets for install/start reliability.
- Translation still requires network.

## v2 roadmap
- Auto language detection with manual override.
- Multi-user auth and per-user usage dashboards.
- WebSocket or Realtime API streaming to reduce latency.
- Optional offline fallback STT package for degraded mode.
- Better TTS prosody and phrase-level buffering.
