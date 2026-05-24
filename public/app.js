const els = {
  apiKey: document.getElementById("apiKey"),
  language: document.getElementById("language"),
  chunkMs: document.getElementById("chunkMs"),
  outputMode: document.getElementById("outputMode"),
  speechSpeed: document.getElementById("speechSpeed"),
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
  inFlight: 0,
  segmentTimer: null,
  pcmChunks: [],
  overlapTail: null,
  audioQueue: [],
  playing: false
};

const API_KEY_STORAGE = "translator_openai_api_key";

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

function addSegment(text) {
  const wrap = document.createElement("div");
  wrap.className = "segment";

  const label = document.createElement("small");
  label.textContent = new Date().toLocaleTimeString();

  const p = document.createElement("div");
  p.textContent = text;

  wrap.append(label, p);
  els.transcript.prepend(wrap);
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
      // Ignore playback failures to keep stream moving.
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

async function sendChunk(blob) {
  if (!state.running || state.paused) return;

  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("Missing API key. Add it and press Start again.");
    return;
  }

  const formData = new FormData();
  formData.append("sessionId", state.sessionId);
  formData.append("language", els.language.value);
  formData.append("outputMode", els.outputMode.value);
  formData.append("speechSpeed", els.speechSpeed.value);
  formData.append("voiceGender", selectedVoiceGender());
  formData.append("audio", blob, "chunk.wav");

  state.inFlight += 1;
  setStatus(`Translating... (${state.inFlight} chunk${state.inFlight > 1 ? "s" : ""} in flight)`);

  try {
    const response = await fetch("/api/translate-chunk", {
      method: "POST",
      headers: {
        "x-openai-api-key": apiKey
      },
      body: formData
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.usage) {
        setCost(data.usage);
      }
      throw new Error(data.error || "Translation request failed");
    }

    if (data.translatedText && data.outputMode !== "speech-only") {
      addSegment(data.translatedText);
    }

    if (data.audioBase64) {
      state.audioQueue.push(`data:audio/mp3;base64,${data.audioBase64}`);
      playAudioQueue();
    }

    setCost(data.usage);
    setStatus(state.paused ? "Paused (listening only, output suppressed)." : "Listening and translating...");
  } catch (error) {
    const message =
      error instanceof TypeError
        ? "Cannot reach the Node server. Confirm `npm.cmd run dev` is running, then reload http://localhost:8787."
        : error.message;
    setStatus(`Error: ${message}`);
  } finally {
    state.inFlight -= 1;
  }
}

function clearSegmentTimer() {
  if (state.segmentTimer) {
    clearInterval(state.segmentTimer);
    state.segmentTimer = null;
  }
}

function flushPcmSegment() {
  if (!state.running) return;
  if (state.pcmChunks.length === 0) return;

  const fresh = mergePcmChunks(state.pcmChunks);
  const segment = state.overlapTail
    ? (() => {
        const merged = new Float32Array(state.overlapTail.length + fresh.length);
        merged.set(state.overlapTail, 0);
        merged.set(fresh, state.overlapTail.length);
        return merged;
      })()
    : fresh;
  state.pcmChunks = [];

  const sampleRate = state.audioContext?.sampleRate || 48000;
  const overlapSamples = Math.floor(sampleRate * 1.2);
  state.overlapTail = segment.slice(Math.max(0, segment.length - overlapSamples));
  const wav = encodeWav(segment, sampleRate);
  const blob = new Blob([wav], { type: "audio/wav" });
  sendChunk(blob);
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

    state.processorNode.onaudioprocess = (event) => {
      if (!state.running) return;
      const input = event.inputBuffer.getChannelData(0);
      state.pcmChunks.push(new Float32Array(input));
    };

    state.sourceNode.connect(state.processorNode);
    state.processorNode.connect(state.silentGain);
    state.silentGain.connect(state.audioContext.destination);

    state.running = true;
    state.paused = false;
    state.pcmChunks = [];
    state.overlapTail = null;

    const duration = Math.max(2000, Number(els.chunkMs.value) || 3000);
    state.segmentTimer = setInterval(flushPcmSegment, duration);

    setStatus(`Listening and translating... (wav @ ${state.audioContext.sampleRate}Hz)`);
  } catch (error) {
    setStatus(`Microphone error: ${error.message}`);
  }
}

async function pauseToggle() {
  if (!state.running) return;
  state.paused = !state.paused;
  setPauseButton(state.paused);
  setStatus(state.paused ? "Paused (listening only, output suppressed)." : "Listening and translating...");
}

async function stop() {
  if (!state.running) return;

  state.running = false;
  state.paused = false;
  setPauseButton(false);

  clearSegmentTimer();
  state.pcmChunks = [];
  state.overlapTail = null;

  if (state.processorNode) state.processorNode.disconnect();
  if (state.sourceNode) state.sourceNode.disconnect();
  if (state.silentGain) state.silentGain.disconnect();
  if (state.audioContext) {
    await state.audioContext.close().catch(() => {});
  }

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
  }

  state.audioContext = null;
  state.sourceNode = null;
  state.processorNode = null;
  state.silentGain = null;
  state.stream = null;
  state.audioQueue = [];
  state.playing = false;
  state.inFlight = 0;

  try {
    await fetch("/api/reset-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId })
    });
  } catch {
    // Best effort only.
  }

  state.sessionId = crypto.randomUUID();
  setCost({ estimatedUsd: 0 });
  setStatus("Stopped.");
}

function clearText() {
  els.transcript.textContent = "";
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
  }

  if ("caches" in window) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
}

init();
