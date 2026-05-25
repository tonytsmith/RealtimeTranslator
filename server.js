import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = process.env.PORT || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPassword = process.env.APP_PASSWORD || "Translate";
const authCookieName = "translator_session";
const authSessions = new Map();
const serverOpenAiApiKey = process.env.OPENAI_API_KEY || "";
const monthlyUsageLimitUsd = Number.isFinite(Number(process.env.MONTHLY_USAGE_LIMIT_USD))
  ? Number(process.env.MONTHLY_USAGE_LIMIT_USD)
  : 20;
const monthlyUsage = {
  monthKey: currentMonthKey(),
  estimatedUsd: 0
};

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function passwordMatches(value) {
  const provided = Buffer.from(String(value || ""));
  const expected = Buffer.from(appPassword);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function isSecureRequest(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `${authCookieName}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`
  ];

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function createAuthSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  authSessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return token;
}

function isAuthenticated(req) {
  const token = parseCookies(req)[authCookieName];
  const expiresAt = token ? authSessions.get(token) : null;

  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    authSessions.delete(token);
    return false;
  }

  return true;
}

function loginPage(showError = false) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Translator Login</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        align-items: center;
        background: linear-gradient(160deg, #000 0%, #111 48%, #2a2a2a 100%);
        color: #fff;
        display: flex;
        font-family: "Segoe UI", "Aptos", system-ui, sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 16px;
      }
      form {
        background: #181818;
        border: 1px solid #3f3f3f;
        border-radius: 14px;
        box-shadow: 0 8px 34px rgba(0, 0, 0, 0.35);
        display: grid;
        gap: 12px;
        max-width: 360px;
        padding: 18px;
        width: 100%;
      }
      h1 { font-size: 1.4rem; margin: 0; }
      label { color: #fff; font-size: 0.9rem; }
      input, button {
        background: #242424;
        border: 1px solid #3f3f3f;
        border-radius: 10px;
        color: #fff;
        font: inherit;
        padding: 11px;
        width: 100%;
      }
      button {
        background: #3aa7ff;
        cursor: pointer;
        font-weight: 700;
      }
      .error { color: #ff6b6b; margin: 0; }
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>Translator Login</h1>
      ${showError ? '<p class="error">Incorrect password.</p>' : ""}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <button type="submit">Enter</button>
    </form>
  </body>
</html>`;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentication required." });
  }

  return res.redirect("/login");
}

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) {
    return res.redirect("/");
  }

  res.type("html").send(loginPage(req.query.error === "1"));
});

app.post("/login", (req, res) => {
  if (!passwordMatches(req.body.password)) {
    return res.redirect("/login?error=1");
  }

  const token = createAuthSession();
  res.setHeader("Set-Cookie", sessionCookie(req, token, 7 * 24 * 60 * 60));
  return res.redirect("/");
});

app.post("/api/login", (req, res) => {
  if (!passwordMatches(req.body.password)) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const token = createAuthSession();
  res.setHeader("Set-Cookie", sessionCookie(req, token, 7 * 24 * 60 * 60));
  return res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const token = parseCookies(req)[authCookieName];
  if (token) authSessions.delete(token);
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  res.json({ ok: true });
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
});

const supportedLanguages = {
  english: "en",
  mandarin: "zh",
  russian: "ru",
  korean: "ko",
  spanish: "es",
  french: "fr",
  japanese: "ja",
  german: "de",
  portuguese: "pt",
  italian: "it",
  greek: "el"
};

const languageNames = {
  english: "English",
  mandarin: "Mandarin Chinese",
  russian: "Russian",
  korean: "Korean",
  spanish: "Spanish",
  french: "French",
  japanese: "Japanese",
  german: "German",
  portuguese: "Portuguese",
  italian: "Italian",
  greek: "Greek"
};

const supportedOutputModes = new Set(["text-only", "text-and-speech", "speech-only"]);
const supportedSpeechSpeeds = new Set([1, 1.25, 1.5, 1.75]);
const voiceByGender = {
  male: process.env.TTS_MALE_VOICE || "cedar",
  female: process.env.TTS_FEMALE_VOICE || "marin"
};

const sessionTotals = new Map();

function currentMonthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentMonthlyUsage() {
  const monthKey = currentMonthKey();
  if (monthlyUsage.monthKey !== monthKey) {
    monthlyUsage.monthKey = monthKey;
    monthlyUsage.estimatedUsd = 0;
  }

  return monthlyUsage;
}

function getSessionTotals(sessionId) {
  if (!sessionTotals.has(sessionId)) {
    sessionTotals.set(sessionId, {
      transcriptionTokens: 0,
      translationInputTokens: 0,
      translationOutputTokens: 0,
      ttsCharacters: 0,
      estimatedUsd: 0,
      monthlyEstimatedUsd: currentMonthlyUsage().estimatedUsd,
      monthlyLimitUsd: monthlyUsageLimitUsd
    });
  }

  const totals = sessionTotals.get(sessionId);
  totals.monthlyEstimatedUsd = currentMonthlyUsage().estimatedUsd;
  totals.monthlyLimitUsd = monthlyUsageLimitUsd;
  return totals;
}

function estimateCostUsd(usage, ttsChars) {
  // Approximate pricing constants; adjust from OpenAI pricing page as needed.
  const transcriptionPer1MInput = Number(process.env.PRICE_TRANSCRIBE_INPUT_PER_1M || 6.0);
  const translationInPer1M = Number(process.env.PRICE_TRANSLATE_INPUT_PER_1M || 0.4);
  const translationOutPer1M = Number(process.env.PRICE_TRANSLATE_OUTPUT_PER_1M || 1.6);
  const ttsPer1MChars = Number(process.env.PRICE_TTS_PER_1M_CHARS || 15.0);

  const transcription = ((usage.transcriptionInputTokens || 0) / 1_000_000) * transcriptionPer1MInput;
  const translationIn = ((usage.translationInputTokens || 0) / 1_000_000) * translationInPer1M;
  const translationOut = ((usage.translationOutputTokens || 0) / 1_000_000) * translationOutPer1M;
  const tts = (ttsChars / 1_000_000) * ttsPer1MChars;

  return transcription + translationIn + translationOut + tts;
}

function asNumber(value) {
  return typeof value === "number" ? value : 0;
}

function selectedSpeechSpeed(value) {
  const speed = Number(value);
  if (supportedSpeechSpeeds.has(speed)) return speed;
  return 1.5;
}

function selectedVoice(value) {
  return voiceByGender[value] || voiceByGender.male;
}

function ttsInstructions(outputLanguageName) {
  return `Speak clearly in ${outputLanguageName}. Keep the pace natural and easy to understand.`;
}

function realtimeInstructions({ inputLanguageName, outputLanguageName, outputMode, speechSpeed }) {
  const speechInstruction =
    outputMode === "text-only"
      ? "Return text only. Do not produce audio."
      : `Produce clear spoken audio output and a text transcript when available. Speak at about ${speechSpeed}x normal speed while staying understandable.`;

  return [
    `You are a realtime interpreter.`,
    `Listen to ${inputLanguageName} speech and translate it into ${outputLanguageName}.`,
    `Output only the translation. Do not answer questions, add commentary, or explain.`,
    `Preserve names, numbers, dates, and technical terms as accurately as possible.`,
    `Keep the translation natural and coherent across sentence boundaries.`,
    speechInstruction
  ].join(" ");
}

function realtimeVoice(value) {
  return selectedVoice(value);
}

app.post("/api/realtime-session", express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }), async (req, res) => {
  try {
    if (currentMonthlyUsage().estimatedUsd >= monthlyUsageLimitUsd) {
      return res.status(402).json({ error: `Monthly usage limit reached ($${monthlyUsageLimitUsd.toFixed(2)}).` });
    }

    if (!serverOpenAiApiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY server environment variable." });
    }

    const selectedLanguage = String(req.query.inputLanguage || "mandarin").toLowerCase();
    const selectedOutputLanguage = String(req.query.outputLanguage || "english").toLowerCase();
    const inputLanguageName = languageNames[selectedLanguage];
    const outputLanguageName = languageNames[selectedOutputLanguage];
    const outputMode = supportedOutputModes.has(req.query.outputMode) ? req.query.outputMode : "text-and-speech";
    const speechSpeed = Math.min(selectedSpeechSpeed(req.query.speechSpeed), 1.5);
    const voice = realtimeVoice(req.query.voiceGender);

    if (!inputLanguageName || !outputLanguageName) {
      return res.status(400).json({ error: "Unsupported realtime language selection." });
    }

    if (!req.body) {
      return res.status(400).json({ error: "Missing WebRTC SDP offer." });
    }

    const sessionConfig = JSON.stringify({
      type: "realtime",
      model: process.env.REALTIME_MODEL || "gpt-realtime-2",
      instructions: realtimeInstructions({ inputLanguageName, outputLanguageName, outputMode, speechSpeed }),
      output_modalities: outputMode === "text-only" ? ["text"] : ["audio"],
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: false
          }
        },
        output: {
          voice,
          speed: speechSpeed
        }
      }
    });

    const form = new FormData();
    form.set("sdp", req.body);
    form.set("session", sessionConfig);

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverOpenAiApiKey}`
      },
      body: form
    });

    const answer = await response.text();
    if (!response.ok) {
      return res.status(response.status).send(answer);
    }

    res.type("application/sdp").send(answer);
  } catch (error) {
    console.error("realtime-session failed:", error);
    res.status(500).json({ error: error?.message || "Failed to create realtime session." });
  }
});

app.post("/api/translate-chunk", upload.single("audio"), async (req, res) => {
  try {
    if (currentMonthlyUsage().estimatedUsd >= monthlyUsageLimitUsd) {
      return res.status(402).json({
        error: `Monthly usage limit reached ($${monthlyUsageLimitUsd.toFixed(2)}).`,
        usage: getSessionTotals(req.body.sessionId || "default")
      });
    }

    const apiKey = req.header("x-openai-api-key");
    if (!apiKey) {
      return res.status(400).json({ error: "Missing OpenAI API key." });
    }

    const sessionId = req.body.sessionId || "default";
    const selectedLanguage = String(req.body.language || "").toLowerCase();
    const languageCode = supportedLanguages[selectedLanguage];
    const selectedOutputLanguage = String(req.body.outputLanguage || "english").toLowerCase();
    const outputLanguageName = languageNames[selectedOutputLanguage];
    const outputMode = supportedOutputModes.has(req.body.outputMode) ? req.body.outputMode : "text-and-speech";
    const wantsText = outputMode !== "speech-only";
    const wantsSpeech = outputMode !== "text-only";
    const speechSpeed = selectedSpeechSpeed(req.body.speechSpeed);
    const ttsVoice = selectedVoice(req.body.voiceGender);

    if (!languageCode) {
      return res.status(400).json({ error: "Unsupported language selection." });
    }

    if (!outputLanguageName) {
      return res.status(400).json({ error: "Unsupported output language selection." });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({ error: "Missing audio chunk." });
    }

    const client = new OpenAI({ apiKey });

    const originalName = req.file.originalname || "chunk.webm";
    const audioType = req.file.mimetype || "application/octet-stream";
    const audioFile = await toFile(req.file.buffer, originalName, { type: audioType });

    const transcription = await client.audio.transcriptions.create({
      model: process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe",
      file: audioFile,
      language: languageCode,
      response_format: "json"
    });

    const sourceText = (transcription.text || "").trim();
    if (!sourceText) {
      return res.json({
        sourceText: "",
        translatedText: "",
        audioBase64: "",
        outputMode,
        usage: getSessionTotals(sessionId)
      });
    }

    const translation = await client.responses.create({
      model: process.env.TRANSLATE_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            `Translate the transcript into faithful natural ${outputLanguageName}. Do not summarize, shorten, or omit details. Keep names, numbers, and technical terms intact. If the input is a partial sentence, translate only what is present. Return only the ${outputLanguageName} translation.`
        },
        {
          role: "user",
          content: `Translate to ${outputLanguageName}:\n\n${sourceText}`
        }
      ]
    });

    const translatedText = (translation.output_text || "").trim();

    let audioBase64 = "";
    if (translatedText && wantsSpeech) {
      const speech = await client.audio.speech.create({
        model: process.env.TTS_MODEL || "gpt-4o-mini-tts",
        voice: process.env.TTS_VOICE || ttsVoice,
        input: translatedText,
        instructions: ttsInstructions(outputLanguageName),
        format: "mp3",
        speed: speechSpeed
      });
      const speechBuffer = Buffer.from(await speech.arrayBuffer());
      audioBase64 = speechBuffer.toString("base64");
    }

    const totals = getSessionTotals(sessionId);

    const transcriptionInputTokens = asNumber(transcription.usage?.input_tokens);
    const translationInputTokens = asNumber(translation.usage?.input_tokens);
    const translationOutputTokens = asNumber(translation.usage?.output_tokens);
    const ttsChars = wantsSpeech ? translatedText.length : 0;

    totals.transcriptionTokens += transcriptionInputTokens;
    totals.translationInputTokens += translationInputTokens;
    totals.translationOutputTokens += translationOutputTokens;
    totals.ttsCharacters += ttsChars;

    const estimatedChunkCost = estimateCostUsd(
      {
        transcriptionInputTokens,
        translationInputTokens,
        translationOutputTokens
      },
      ttsChars
    );
    const monthUsage = currentMonthlyUsage();

    totals.estimatedUsd += estimatedChunkCost;
    monthUsage.estimatedUsd += estimatedChunkCost;
    totals.monthlyEstimatedUsd = monthUsage.estimatedUsd;
    totals.monthlyLimitUsd = monthlyUsageLimitUsd;

    res.json({
      sourceText,
      translatedText: wantsText ? translatedText : "",
      audioBase64,
      outputMode,
      usage: totals
    });
  } catch (error) {
    console.error("translate-chunk failed:", error);
    const message = error?.message || "Unexpected server error";
    res.status(500).json({ error: message });
  }
});

app.post("/api/reset-session", (req, res) => {
  const sessionId = req.body?.sessionId;
  if (sessionId && sessionTotals.has(sessionId)) {
    sessionTotals.delete(sessionId);
  }

  res.json({ ok: true });
});

app.get("/realtime", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "realtime.html"));
});

app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("server middleware failed:", error);
  res.status(500).json({ error: error?.message || "Unexpected server error" });
});

app.listen(port, () => {
  console.log(`Translator app listening on http://localhost:${port}`);
});
