const els = {
  language: document.getElementById("language"),
  outputLanguage: document.getElementById("outputLanguage"),
  outputMode: document.getElementById("outputMode"),
  speechSpeed: document.getElementById("speechSpeed"),
  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  pauseIcon: document.getElementById("pauseIcon"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  transcript: document.getElementById("transcript"),
  usage: document.getElementById("usage"),
  remoteAudio: document.getElementById("remoteAudio")
};

const state = {
  pc: null,
  dataChannel: null,
  stream: null,
  running: false,
  paused: false,
  liveSegment: null,
  liveText: ""
};

function selectedVoiceGender() {
  return document.querySelector('input[name="voiceGender"]:checked')?.value || "male";
}

function setStatus(text) {
  els.status.textContent = text;
}

function setPauseButton(paused) {
  els.pauseBtn.setAttribute("aria-label", paused ? "Resume" : "Pause");
  els.pauseBtn.setAttribute("title", paused ? "Resume" : "Pause");
  els.pauseIcon.textContent = paused ? "\u25b6" : "\u275a\u275a";
}

function setControlsDisabled(disabled) {
  for (const control of [els.language, els.outputLanguage, els.outputMode, els.speechSpeed]) {
    control.disabled = disabled;
  }

  document.querySelectorAll('input[name="voiceGender"]').forEach((input) => {
    input.disabled = disabled;
  });
}

function addSegment(text, live = false) {
  const trimmed = text.trim();
  if (!trimmed && !live) return null;

  const wrap = document.createElement("div");
  wrap.className = live ? "segment live-segment" : "segment";

  const label = document.createElement("small");
  label.textContent = new Date().toLocaleTimeString();

  const p = document.createElement("div");
  p.textContent = trimmed;

  wrap.append(label, p);
  els.transcript.prepend(wrap);
  return { wrap, p };
}

function beginLiveSegment() {
  if (state.liveSegment) return;
  state.liveText = "";
  state.liveSegment = addSegment("", true);
}

function appendLiveText(delta) {
  if (els.outputMode.value === "speech-only") return;
  if (!delta) return;

  beginLiveSegment();
  state.liveText += delta;
  if (state.liveSegment?.p) {
    state.liveSegment.p.textContent = state.liveText.trimStart();
  }
}

function finishLiveText(finalText = "") {
  if (els.outputMode.value === "speech-only") {
    state.liveText = "";
    state.liveSegment = null;
    return;
  }

  const text = (finalText || state.liveText).trim();
  if (!text) {
    state.liveSegment?.wrap?.remove();
  } else if (state.liveSegment?.p) {
    state.liveSegment.p.textContent = text;
    state.liveSegment.wrap.classList.remove("live-segment");
  } else {
    addSegment(text);
  }

  state.liveText = "";
  state.liveSegment = null;
}

function updateUsage(event) {
  const usage = event?.response?.usage || event?.usage;
  if (!usage) return;

  const total = usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
  if (Number.isFinite(total)) {
    els.usage.textContent = `Realtime usage: ${total.toLocaleString()} tokens reported for latest response.`;
  }
}

function handleRealtimeEvent(event) {
  switch (event.type) {
    case "session.created":
    case "session.updated":
      setStatus("Realtime session ready. Speak when ready.");
      break;
    case "input_audio_buffer.speech_started":
      setStatus("Listening...");
      break;
    case "input_audio_buffer.speech_stopped":
      setStatus("Translating...");
      break;
    case "response.output_text.delta":
    case "response.text.delta":
    case "response.output_audio_transcript.delta":
      appendLiveText(event.delta);
      break;
    case "response.output_text.done":
    case "response.text.done":
      finishLiveText(event.text);
      break;
    case "response.output_audio_transcript.done":
      finishLiveText(event.transcript);
      break;
    case "response.done":
      updateUsage(event);
      setStatus(state.paused ? "Paused." : "Realtime translation running.");
      break;
    case "error":
      setStatus(`Error: ${event.error?.message || "Realtime API error"}`);
      break;
    default:
      break;
  }
}

function closeCurrentSession() {
  if (state.dataChannel) {
    state.dataChannel.close();
  }

  if (state.pc) {
    state.pc.getSenders().forEach((sender) => sender.track?.stop());
    state.pc.close();
  }

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }

  els.remoteAudio.srcObject = null;
  state.pc = null;
  state.dataChannel = null;
  state.stream = null;
  state.running = false;
  state.paused = false;
  state.liveSegment = null;
  state.liveText = "";
  setPauseButton(false);
  setControlsDisabled(false);
}

async function assertBackendReachable() {
  const response = await fetch("/api/health", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Backend health check returned ${response.status}`);
  }
}

async function start() {
  if (state.running) return;

  try {
    await assertBackendReachable();

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });

    state.pc = new RTCPeerConnection();
    state.pc.ontrack = (event) => {
      els.remoteAudio.srcObject = event.streams[0];
      els.remoteAudio.play().catch(() => {});
    };

    state.pc.onconnectionstatechange = () => {
      if (!state.pc) return;
      if (["failed", "disconnected", "closed"].includes(state.pc.connectionState)) {
        setStatus(`Realtime connection ${state.pc.connectionState}.`);
      }
    };

    for (const track of state.stream.getTracks()) {
      state.pc.addTrack(track, state.stream);
    }

    state.dataChannel = state.pc.createDataChannel("oai-events");
    state.dataChannel.addEventListener("open", () => {
      setStatus("Realtime connection open. Speak when ready.");
    });
    state.dataChannel.addEventListener("message", (message) => {
      try {
        handleRealtimeEvent(JSON.parse(message.data));
      } catch {
        // Ignore non-JSON diagnostic messages.
      }
    });

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);

    const params = new URLSearchParams({
      inputLanguage: els.language.value,
      outputLanguage: els.outputLanguage.value,
      outputMode: els.outputMode.value,
      speechSpeed: els.speechSpeed.value,
      voiceGender: selectedVoiceGender()
    });

    setStatus("Connecting to realtime translation...");
    const response = await fetch(`/api/realtime-session?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp
    });

    const answerSdp = await response.text();
    if (!response.ok) {
      throw new Error(answerSdp || "Failed to create realtime session.");
    }

    await state.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    state.running = true;
    state.paused = false;
    setPauseButton(false);
    setControlsDisabled(true);
    setStatus("Realtime translation running.");
  } catch (error) {
    closeCurrentSession();
    setStatus(`Error: ${error.message}`);
  }
}

function pauseToggle() {
  if (!state.running || !state.stream) return;

  state.paused = !state.paused;
  state.stream.getAudioTracks().forEach((track) => {
    track.enabled = !state.paused;
  });
  setPauseButton(state.paused);
  setStatus(state.paused ? "Paused." : "Realtime translation running.");
}

function stop() {
  if (!state.running && !state.pc) return;
  closeCurrentSession();
  setStatus("Stopped.");
}

function clearText() {
  els.transcript.textContent = "";
}

function init() {
  els.startBtn.addEventListener("click", start);
  els.pauseBtn.addEventListener("click", pauseToggle);
  els.stopBtn.addEventListener("click", stop);
  els.clearBtn.addEventListener("click", clearText);
}

init();
