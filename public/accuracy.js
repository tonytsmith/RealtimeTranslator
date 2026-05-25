const els = {
  apiKey: document.getElementById("apiKey"),
  language: document.getElementById("language"),
  outputLanguage: document.getElementById("outputLanguage"),
  outputMode: document.getElementById("outputMode"),
  responseConfig: document.getElementById("responseConfig"),
  speechSpeed: document.getElementById("speechSpeed"),
  showSource: document.getElementById("showSource"),
  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  pauseIcon: document.getElementById("pauseIcon"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  transcript: document.getElementById("transcript"),
  cost: document.getElementById("cost")
};

const state = {
  sessionId: crypto.randomUUID(),
  stream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  silentGain: null,
  running: false,
  paused: false,
  pcmChunks: [],
  voiceStarted: false,
  segmentStartAt: 0,
  lastVoiceAt: 0,
  lastTrimAt: 0,
  inFlight: 0,
  nextSegmentNumber: 1,
  nextOutputNumber: 1,
  pendingResults: new Map(),
  sourceHistory: [],
  translationHistory: [],
  audioQueue: [],
  playing: false
};

const API_KEY_STORAGE = "translator_openai_api_key";
const SILENCE_MS = 1400;
const MIN_SEGMENT_MS = 4500;
const MAX_SEGMENT_MS = 18000;
const PRE_ROLL_MS = 900;
const MIN_AUDIO_MS_TO_SEND = 1000;
const VOICE_RMS_THRESHOLD = 0.011;
const CONTEXT_CHARS = 6000;

function selectedVoiceGender() {
  return document.querySelector('input[name="voiceGender"]:checked')?.value || "male";
}

function setPauseButton(paused) {
  els.pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
  els.pauseBtn.setAttribute("title", paused ? "Resume" : "Pause");
  els.pauseIcon.textContent = paused ? "\u25b6" : "\u275a\u275a";
}

function setStatus(text) {
  els.status.textContent = text;
}

function setCost(usage) {
  const sessionAmount = Number(usage?.estimatedUsd || 0);
  const monthlyAmount = Number(usage?.monthlyEstimatedUsd || 0);
  const monthlyLimit = Number(usage?.monthlyLimitUsd || 20);
  els.cost.textContent = `Estimated session cost: $${sessionAmount.toFixed(2)} | Monthly usage: $${monthlyAmount.toFixed(2)} / $${monthlyLimit.toFixed(2)}`;
}

function updateListeningStatus() {
  if (!state.running) return;
  if (state.paused) {
    setStatus("Paused.");
    return;
  }

  const queueText = state.inFlight > 0 ? ` ${state.inFlight} segment${state.inFlight > 1 ? "s" : ""} translating.` : "";
  setStatus(state.voiceStarted ? `Listening for a pause.${queueText}` : `Listening for speech.${queueText}`);
}

function setControlsDisabled(disabled) {
  for (const control of [els.language, els.outputLanguage, els.outputMode, els.responseConfig, els.speechSpeed]) {
    control.disabled = disabled;
  }

  document.querySelectorAll('input[name="voiceGender"]').forEach((input) => {
    input.disabled = disabled;
  });
}

function addSegment(text, sourceText = "", meta = "") {
  const hasTranslation = Boolean(text?.trim());
  const hasSource = Boolean(sourceText?.trim());
  if (!hasTranslation && !hasSource) return;

  const wrap = document.createElement("div");
  wrap.className = "segment";

  const label = document.createElement("small");
  label.textContent = meta ? `${new Date().toLocaleTimeString()} · ${meta}` : new Date().toLocaleTimeString();

  wrap.append(label);

  if (hasTranslation && els.outputMode.value !== "speech-only") {
    const p = document.createElement("div");
    p.textContent = text;
    wrap.append(p);
  }

  if (hasSource) {
    const source = document.createElement("div");
    source.className = "source-text";
    source.textContent = sourceText;
    wrap.append(source);
  }

  els.transcript.prepend(wrap);
}

function addSystemSegment(text) {
  const wrap = document.createElement("div");
  wrap.className = "segment system-segment";
  wrap.textContent = text;
  els.transcript.prepend(wrap);
}

function pushHistory(history, text) {
  const clean = String(text || "").trim();
  if (!clean) return;

  history.push(clean);
  while (history.join("\n").length > CONTEXT_CHARS && history.length > 1) {
    history.shift();
  }
}

function historyText(history) {
  return history.join("\n").slice(-CONTEXT_CHARS);
}

function mergePcmChunks(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  floatTo16BitPCM(view, 44, samples);

  return buffer;
}

function rms(samples) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples.length; i += 4) {
    sum += samples[i] * samples[i];
    count += 1;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function trimPreRoll(now) {
  if (now - state.lastTrimAt < 300 || state.pcmChunks.length === 0) return;
  state.lastTrimAt = now;

  const sampleRate = state.audioContext?.sampleRate || 48000;
  const keepSamples = Math.floor((sampleRate * PRE_ROLL_MS) / 1000);
  const merged = mergePcmChunks(state.pcmChunks);
  state.pcmChunks = [merged.slice(Math.max(0, merged.length - keepSamples))];
}

function currentSegmentDurationMs(sampleRate) {
  const samples = state.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return (samples / sampleRate) * 1000;
}

async function playAudioQueue() {
  if (state.playing || state.audioQueue.length === 0) return;
  state.playing = true;

  while (state.audioQueue.length) {
    const src = state.audioQueue.shift();
    try {
      await new Promise((resolve) => {
        const audio = new Audio(src);
        audio.onended = () => setTimeout(resolve, 120);
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
    } catch {
      // Ignore playback failures so the translation queue keeps moving.
    }
  }

  state.playing = false;
}

async function assertBackendReachable() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Backend health check returned ${response.status}`);
    }
  } catch {
    throw new Error("Cannot reach the Node server. Make sure `npm.cmd run dev` is still running and open the app at http://localhost:8787.");
  }
}

async function sendSegment(blob, segmentNumber) {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("Missing API key. Add it and press Start again.");
    return;
  }

  const formData = new FormData();
  formData.append("sessionId", state.sessionId);
  formData.append("language", els.language.value);
  formData.append("outputLanguage", els.outputLanguage.value);
  formData.append("outputMode", els.outputMode.value);
  formData.append("responseConfig", els.responseConfig.value);
  formData.append("speechSpeed", els.speechSpeed.value);
  formData.append("voiceGender", selectedVoiceGender());
  formData.append("sourceContext", historyText(state.sourceHistory));
  formData.append("translationContext", historyText(state.translationHistory));
  formData.append("audio", blob, `segment-${segmentNumber}.wav`);

  state.inFlight += 1;
  updateListeningStatus();

  try {
    const response = await fetch("/api/high-accuracy-segment", {
      method: "POST",
      headers: {
        "x-openai-api-key": apiKey
      },
      body: formData
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.usage) setCost(data.usage);
      throw new Error(data.error || "High accuracy translation request failed");
    }

    state.pendingResults.set(segmentNumber, { ok: true, data });
  } catch (error) {
    const message =
      error instanceof TypeError
        ? "Cannot reach the Node server. Confirm `npm.cmd run dev` is running, then reload http://localhost:8787/accuracy."
        : error.message;
    state.pendingResults.set(segmentNumber, { ok: false, error: message });
  } finally {
    state.inFlight -= 1;
    deliverReadySegments();
    updateListeningStatus();
  }
}

function deliverReadySegments() {
  while (state.pendingResults.has(state.nextOutputNumber)) {
    const result = state.pendingResults.get(state.nextOutputNumber);
    state.pendingResults.delete(state.nextOutputNumber);
    state.nextOutputNumber += 1;

    if (!result.ok) {
      addSystemSegment(`Segment error: ${result.error}`);
      continue;
    }

    const data = result.data;
    const contextText = data.contextText || data.translatedText || "";

    if (data.sourceText) {
      pushHistory(state.sourceHistory, data.sourceText);
    }
    if (contextText) {
      pushHistory(state.translationHistory, contextText);
    }

    if (data.translatedText || (els.showSource.checked && data.sourceText)) {
      addSegment(data.translatedText, data.sourceText, data.responseConfig || "");
    }

    if (data.audioBase64) {
      state.audioQueue.push(`data:audio/mp3;base64,${data.audioBase64}`);
      playAudioQueue();
    }

    setCost(data.usage);
  }
}

function flushPcmSegment(reason = "pause") {
  if (state.pcmChunks.length === 0) return;

  const sampleRate = state.audioContext?.sampleRate || 48000;
  const durationMs = currentSegmentDurationMs(sampleRate);
  if (durationMs < MIN_AUDIO_MS_TO_SEND && reason !== "stop") return;

  const segment = mergePcmChunks(state.pcmChunks);
  state.pcmChunks = [];
  state.voiceStarted = false;
  state.segmentStartAt = 0;
  state.lastVoiceAt = 0;

  const wav = encodeWav(segment, sampleRate);
  const blob = new Blob([wav], { type: "audio/wav" });
  const segmentNumber = state.nextSegmentNumber;
  state.nextSegmentNumber += 1;
  sendSegment(blob, segmentNumber);
}

function handleAudioProcess(event) {
  if (!state.running || state.paused) return;

  const now = performance.now();
  const input = event.inputBuffer.getChannelData(0);
  const copy = new Float32Array(input);
  state.pcmChunks.push(copy);

  const level = rms(input);
  if (level >= VOICE_RMS_THRESHOLD) {
    if (!state.voiceStarted) {
      state.voiceStarted = true;
      state.segmentStartAt = now - PRE_ROLL_MS;
    }
    state.lastVoiceAt = now;
  }

  if (!state.voiceStarted) {
    trimPreRoll(now);
    return;
  }

  const segmentAge = now - state.segmentStartAt;
  const silenceAge = now - state.lastVoiceAt;
  if ((segmentAge >= MIN_SEGMENT_MS && silenceAge >= SILENCE_MS) || segmentAge >= MAX_SEGMENT_MS) {
    flushPcmSegment(segmentAge >= MAX_SEGMENT_MS ? "max" : "pause");
  }
}

async function start() {
  if (state.running) return;

  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("Enter an OpenAI API key first.");
    return;
  }

  localStorage.setItem(API_KEY_STORAGE, apiKey);

  try {
    await assertBackendReachable();

    state.sessionId = crypto.randomUUID();
    state.pcmChunks = [];
    state.voiceStarted = false;
    state.segmentStartAt = 0;
    state.lastVoiceAt = 0;
    state.lastTrimAt = 0;
    state.inFlight = 0;
    state.nextSegmentNumber = 1;
    state.nextOutputNumber = 1;
    state.pendingResults = new Map();
    state.sourceHistory = [];
    state.translationHistory = [];
    state.audioQueue = [];
    state.playing = false;
    setCost({ estimatedUsd: 0 });

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000
      }
    });

    state.audioContext = new AudioContext();
    state.sourceNode = state.audioContext.createMediaStreamSource(state.stream);
    state.processorNode = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.silentGain = state.audioContext.createGain();
    state.silentGain.gain.value = 0;

    state.processorNode.onaudioprocess = handleAudioProcess;
    state.sourceNode.connect(state.processorNode);
    state.processorNode.connect(state.silentGain);
    state.silentGain.connect(state.audioContext.destination);

    state.running = true;
    state.paused = false;
    setPauseButton(false);
    setControlsDisabled(true);
    setStatus(`Listening for speech. Response: ${els.responseConfig.options[els.responseConfig.selectedIndex].text}.`);
  } catch (error) {
    setStatus(`Microphone error: ${error.message}`);
    stopCapture();
  }
}

function pauseToggle() {
  if (!state.running) return;

  if (!state.paused && state.voiceStarted) {
    flushPcmSegment("pause");
  }

  state.paused = !state.paused;
  setPauseButton(state.paused);
  updateListeningStatus();
}

function stopCapture() {
  if (state.processorNode) state.processorNode.disconnect();
  if (state.sourceNode) state.sourceNode.disconnect();
  if (state.silentGain) state.silentGain.disconnect();
  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
  }

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }

  state.audioContext = null;
  state.sourceNode = null;
  state.processorNode = null;
  state.silentGain = null;
  state.stream = null;
}

function stop() {
  if (!state.running) return;

  if (state.voiceStarted) {
    flushPcmSegment("stop");
  }

  state.running = false;
  state.paused = false;
  state.pcmChunks = [];
  state.voiceStarted = false;
  setPauseButton(false);
  setControlsDisabled(false);
  stopCapture();
  setStatus(state.inFlight > 0 ? "Stopped listening. Finishing queued translations..." : "Stopped.");
}

function clearText() {
  els.transcript.textContent = "";
}

function updateSourceVisibility() {
  els.transcript.classList.toggle("show-source", els.showSource.checked);
}

function init() {
  const savedKey = localStorage.getItem(API_KEY_STORAGE);
  if (savedKey) {
    els.apiKey.value = savedKey;
  }

  els.startBtn.addEventListener("click", start);
  els.pauseBtn.addEventListener("click", pauseToggle);
  els.stopBtn.addEventListener("click", stop);
  els.clearBtn.addEventListener("click", clearText);
  els.showSource.addEventListener("change", updateSourceVisibility);
  updateSourceVisibility();
}

init();
