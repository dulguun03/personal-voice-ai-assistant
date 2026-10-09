"use strict";

// Capture starts with an explicit user gesture. A complete utterance is sent
// exactly once through transcription, command execution and spoken response.
class UtteranceDetector {
  constructor(now = 0) {
    this.started = now;
    this.lastSample = now;
    this.lastVoice = null;
    this.voicedMs = 0;
    this.noise = 0.003;
    this.finished = false;
  }
  threshold() {
    return Math.max(0.02, Math.min(0.07, this.noise * 3.2));
  }
  sample(rms, now) {
    if (this.finished)
      return {
        action: null,
        voiced: false,
        threshold: this.threshold()
      };
    const dt = Math.max(0, Math.min(now - this.lastSample, 120));
    this.lastSample = now;
    const threshold = this.threshold(), voiced = rms > threshold;
    if (voiced) {
      this.lastVoice = now;
      this.voicedMs += dt;
    }
    else this.noise = this.noise * 0.97 + Math.min(rms, threshold * 0.75) * 0.03;
    const silence = this.lastVoice === null ? 0 : now - this.lastVoice;
    let action = null;
    if (this.lastVoice !== null && silence >= 1100)
      action = this.voicedMs >= 250 ? "submit" : "discard";
    else if (now - this.started >= 30000)
      action = this.voicedMs >= 250 ? "submit" : "discard";
    else if (this.lastVoice === null && now - this.started >= 5000)
      action = "rearm";
    if (action)
      this.finished = true;
    return {
      action,
      voiced,
      threshold
    };
  }
}

function isStopCommand(text) {
  const clean = text.toLowerCase().replace(/[.,!?;:]/g, "").replace(/\s+/g, " ").trim();
  return /^(?:jarvis |жарвис (?:аа )?)?(?:stop|pause|stop listening|stop the voice session|stop voice session|stop jarvis|pause jarvis|зогс|зогсоо|сонсохоо зогсоо|дуут горимыг зогсоо)$/.test(clean);
}

function createVoiceApp(env = globalThis, options = {}) {
  const document = env.document, $ = (id) => document.getElementById(id);
  const put = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  const controls = {
    text: $("request-text"), send: $("send-button"), session: $("session-button"), stop: $("stop-button"),
    file: $("audio-file"), language: $("language"), speak: $("speak-reply"),
  };
  const state = {
    connected: false,
    voiceReady: false,
    mode: "rules",
    active: false,
    busy: false,
    phase: "idle",
    generation: 0,
    stream: null,
    recorder: null,
    context: null,
    analyser: null,
    source: null,
    monitor: null,
    resumeTimer: null,
    operation: null,
    speechFinish: null,
    spokenLanguage: "en",
    capture: null,
  };

  const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

  const modeNames = {
    rules: "Local command agent",
    openai: "OpenAI agent",
    ollama: "Ollama agent"
  };

  const phases = {
    idle: ["STANDBY", "Start a voice session, then speak naturally."],
    listening: ["LISTENING", "Speak a command. I act automatically when you finish."],
    transcribing: ["HEARING YOU", "Recognizing your words locally…"],
    thinking: ["PROCESSING", "Working on your request…"],
    speaking: ["RESPONDING", "Microphone capture pauses while I speak."],
    error: ["ATTENTION", "Check the message below, then try again."],
  };
  const current = (generation) => generation === state.generation;
  const now = () => env.performance.now();
  function error(message) {
    put("error-message", message || "");
    if ($("error-message")) $("error-message").hidden = !message;
  }

  function announce(message) {
    put("action-status", message || "");
  }

  function setPhase(phase, detail) {
    state.phase = phase; document.body.dataset.state = phase;
    put("stage-label", phases[phase][0]); put("stage-detail", detail || phases[phase][1]); syncControls();
  }
  function setLevel(rms = 0) {
    const level = Math.min(1, rms * 9);
    if ($("level-fill")) $("level-fill").style.transform = "scaleX(" + level + ")";
    document.documentElement.style.setProperty("--voice-level", String(level));
    put("mic-level", state.active ? Math.round(level * 100) + "%" : "OFF");
  }
  function syncControls() {
    controls.session.disabled = state.active || state.busy || !state.connected || !state.voiceReady;
    controls.stop.disabled = !state.active && !state.busy;
    controls.session.setAttribute("aria-pressed", String(state.active));
    put("session-label", state.active ? "Voice session active" : "Start voice session");
    controls.send.disabled = !state.connected || state.busy || state.active;
    controls.text.disabled = state.busy || state.active;
    controls.file.disabled = !state.connected || !state.voiceReady || state.busy || state.active;
    controls.language.disabled = state.active || state.busy;
    if ($("upload-label")) {
      $("upload-label").setAttribute("aria-disabled", String(controls.file.disabled));
      $("upload-label").disabled = controls.file.disabled;
    }
    document.querySelectorAll(".suggestion").forEach((button) => {
      button.disabled = state.active || state.busy || !state.connected;
    });
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await env.fetch(path, options);
    }
    catch (e) {
      if (e.name === "AbortError")
        throw e;
      throw new Error("Cannot reach the local assistant. Keep its server running and refresh status.");
    }
    let data;
    try {
      data = await response.json();
    }
    catch (_) {
      throw new Error("The assistant returned an unreadable response. Restart it and try again.");
    }
    if (!response.ok) throw new Error(data.message || data.error || "The request could not be completed.");
    return data;
  }
  function formatDate(value) {
    if (!value || Number.isNaN(new Date(value).valueOf()))
      return "";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ulaanbaatar",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",hour12: false
    }).format(new Date(value));
  }

  function displayData(data) {
    for (const type of ["tasks", "notes"]) {
      const items = Array.isArray(data[type]) ? data[type] : [], list = $(type + "-list");
      list.replaceChildren();
      put(type === "tasks" ? "task-count" : "note-count", String(items.length));
      $(type + "-empty").hidden = items.length > 0;
      for (const item of [...items].reverse()) {
        const li = document.createElement("li");
        li.className = "data-item" + (item.done ? " done" : "");
        const content = document.createElement("p");
        content.textContent = typeof item === "string" ? item : item.title || item.content || "";
        li.append(content);
        if (typeof item === "object") {
          const meta = document.createElement("div"); meta.className = "item-meta";
          const id = document.createElement("span"); id.textContent = item.id != null ? "#" + item.id : "";
          const status = document.createElement("span"); status.className = "item-state";
          status.textContent = type === "tasks" ? (item.done ? "Complete" : "Pending") : formatDate(item.created_at);
          meta.append(id, status); li.append(meta);
        }
        list.append(li);
      }
    }
  }
  function appendMessage(text, role, mode) {
    const article = document.createElement("article");
    article.className = "message " + (role === "user" ? "user-message" : "assistant-message");
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "YOU" : "J";
    avatar.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "message-content";
    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = role === "user" ? "You" : "JARVIS";
    const body = document.createElement("p");
    body.textContent = text; content.append(label, body);
    if (mode) {
      const badge = document.createElement("span");
      badge.className = "message-mode";
      badge.textContent = modeNames[mode] || mode;
      content.append(badge);
    }
    article.append(avatar, content);
    $("messages").append(article);
    $("messages").scrollTop = $("messages").scrollHeight;
  }

  async function refreshStatus() {
    $("refresh-status").disabled = true;
    try {
      const data = await api("/api/status");
      state.connected = true;
      state.voiceReady = Boolean(data.voice_ready);
      state.mode = data.agent_mode || "rules";
      if ($("connection-dot"))
        $("connection-dot").className = "status-dot connected";
      put("connection-label", "LOCAL SYSTEM ONLINE");
      put("agent-status", modeNames[state.mode] || state.mode);
      put("speech-status", state.voiceReady ? "Whisper ready" : "Not configured");
      put("service-message", state.mode === "rules" ? "Local commands: time, date, tasks and notes. Connect an AI provider for open-ended conversation." : (data.message || "Agent ready."));
      put("voice-hint", state.voiceReady ? "Finish speaking to execute • 30-second utterance limit" : "Voice recognition needs setup. See the README.");
      displayData(data); if (!state.active && !state.busy) error("");
    } catch (e) {
      state.connected = false; state.voiceReady = false;
      if ($("connection-dot"))
        $("connection-dot").className = "status-dot error";
      put("connection-label", "LOCAL SYSTEM OFFLINE");
      put("agent-status", "Offline");
      put("speech-status", "Offline");
      put("service-message", e.message); error(e.message);
      if (state.active) stopSession("Connection lost. Refresh status before starting again.");
    } finally {
      syncControls();
      $("refresh-status").disabled = false;
    }
  }

  function detachRecorder() {
    if (state.monitor) {
      env.clearInterval(state.monitor);
      state.monitor = null;
    }
    if (state.capture)
      state.capture.submit = false;
    state.capture = null;
    const recorder = state.recorder;
    state.recorder = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      }
      catch (_) {} 
    }
    setLevel();
  }
  function releaseMicrophone() {
    detachRecorder();
    if (state.resumeTimer) {
      env.clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop()); state.stream = null;
    if (state.source) {
      try {
        state.source.disconnect();
      } catch (_) {} 
    }
    state.source = null;
    state.analyser = null;
    if (state.context) {
      state.context.close().catch(() => {});
      state.context = null;
    }
  }

  function stopSession(detail = "Voice session stopped. The microphone is off.") {
    state.generation += 1; state.active = false;
    state.busy = false;
    if (state.operation)
      state.operation.abort();
    state.operation = null;
    releaseMicrophone();
    if (state.speechFinish)
      state.speechFinish();
    if (env.speechSynthesis) env.speechSynthesis.cancel(); state.speechFinish = null;
    setLevel();
    setPhase("idle", detail);
    announce(detail);
  }

  function microphoneError(e) {
    return ({
      NotAllowedError: "Microphone permission was denied. Allow the microphone in this page's permissions, then start again.",
      NotFoundError: "No microphone was found. Connect one and start again, or use an audio file.",
      NotReadableError: "The microphone is unavailable. Close another app using it and start again.",
      SecurityError: "Microphone access is blocked. Open this app at http://127.0.0.1:8766 in Chrome or Edge.",
    })[e.name] || "Could not start the microphone. Check the device and browser permissions, then try again.";
  }

  async function startSession() {
    if (state.active || state.busy || !state.connected || !state.voiceReady) return;
    error("");
    announce("");
    if (!env.isSecureContext || !env.navigator.mediaDevices?.getUserMedia || !env.MediaRecorder || !(env.AudioContext || env.webkitAudioContext)) {
      error("Use Chrome or Edge at http://127.0.0.1:8766 and allow microphone access. Audio files are also supported.");
      setPhase("error"); return;
    }
    const generation = ++state.generation;
    state.active = true;
    setPhase("listening", "Allow microphone access when your browser asks…");
    try {
      const stream = await env.navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } });
      if (!current(generation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      state.stream = stream;
      const AudioContext = env.AudioContext || env.webkitAudioContext;
      state.context = new AudioContext();
      await state.context.resume();
      if (!current(generation)) return;
      state.source = state.context.createMediaStreamSource(stream);
      state.analyser = state.context.createAnalyser();
      state.analyser.fftSize = 1024;
      state.source.connect(state.analyser);
      stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
        if (current(generation) && state.active) {
          stopSession("Microphone disconnected. Connect it and start again.");
          error("The microphone stopped or was disconnected.");
        }
      }, { once: true }));
      beginListening(generation);
    } catch (e) { if (current(generation)) { stopSession(); error(microphoneError(e)); setPhase("error"); } }
  }
  function beginListening(generation) {
    try { armListening(generation); }
    catch (_) {
      if (current(generation)) {
        stopSession();
        error("Audio capture could not restart. Check your microphone and start the voice session again.");
        setPhase("error");
      }
    }
  }

  function armListening(generation) {
    if (!current(generation) || !state.active || !state.stream || state.busy) return;
    detachRecorder();
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => env.MediaRecorder.isTypeSupported(type));
    const recorder = new env.MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    const capture = { recorder, chunks: [], submit: false, language: controls.language.value, generation };
    state.recorder = recorder; state.capture = capture;
    const detector = new UtteranceDetector(now()), samples = new Float32Array(state.analyser.fftSize);
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) capture.chunks.push(event.data); });
    recorder.addEventListener("stop", () => {
      if (!current(generation) || !state.active) return;
      if (capture.submit) transcribeAndExecute(new Blob(capture.chunks, { type: recorder.mimeType || "audio/webm" }), capture.language, generation, true);
      else if (state.capture === capture && !state.busy) beginListening(generation);
    }, { once: true });
    recorder.addEventListener("error", () => {
      if (current(generation)) { stopSession(); error("Audio capture failed. Check your microphone and start the voice session again."); setPhase("error"); }
    }, { once: true });
    recorder.start(250); setPhase("listening");
    state.monitor = env.setInterval(() => {
      if (!current(generation) || !state.active || state.capture !== capture) return;
      state.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length), result = detector.sample(rms, now()); setLevel(rms);
      if (result.voiced) put("stage-detail", "Hearing your voice… finish speaking to send your command.");
      if (result.action) {
        env.clearInterval(state.monitor); state.monitor = null; capture.submit = result.action === "submit";
        if (capture.submit) setPhase("transcribing");
        try { recorder.stop(); }
        catch (_) { stopSession(); error("Audio capture could not finish. Check your microphone and start again."); setPhase("error"); }
      }
    }, 50);
  }
  function replyLanguage(text, detected) {
    if (/[\u0400-\u04ff]/.test(text)) return "mn";
    if (/[a-zA-Z]/.test(text)) return "en";
    return detected === "mn" ? "mn" : "en";
  }
  function matchingVoice(language) {
    return env.speechSynthesis?.getVoices().find((voice) => voice.localService !== false && voice.lang.toLowerCase().split(/[-_]/)[0] === language) || null;
  }
  function updateTts(language = state.spokenLanguage) {
    controls.speak.disabled = !env.speechSynthesis;
    const voice = matchingVoice(language);
    put("tts-hint", !env.speechSynthesis ? "This browser cannot speak replies." : voice ? "" : language === "mn" ? "Монгол хэлний унших хоолой энэ төхөөрөмжид алга. Хариу дэлгэцэд харагдаж, микрофон дахин сонсоно." : "No English speaking voice is installed. Replies appear on screen.");
  }
  async function speakReply(text, language, generation) {
    state.spokenLanguage = replyLanguage(text, language); updateTts();
    const voice = matchingVoice(state.spokenLanguage);
    if (!current(generation) || !text || !controls.speak.checked || !voice || !env.SpeechSynthesisUtterance) return;
    setPhase("speaking");
    await new Promise((resolve) => {
      const utterance = new env.SpeechSynthesisUtterance(text); utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = 1;
      let timer, finished = false;
      const finish = () => {
        if (finished) return; finished = true; env.clearTimeout(timer);
        if (state.speechFinish === finish) state.speechFinish = null; resolve();
      };
      state.speechFinish = finish; utterance.onend = finish;
      utterance.onerror = () => { if (current(generation)) put("tts-hint", "Voice playback failed. The reply is shown on screen."); finish(); };
      timer = env.setTimeout(() => {
        if (current(generation)) { env.speechSynthesis.cancel(); put("tts-hint", "Voice playback timed out. Ready for your next command."); } finish();
      }, Math.min(90000, Math.max(12000, text.length * 100)));
      try { env.speechSynthesis.cancel(); env.speechSynthesis.speak(utterance); } catch (_) { finish(); }
    });
  }
  function beginOperation(generation) {
    if (!current(generation)) return null;
    const controller = new env.AbortController(); state.operation = controller; state.busy = true; syncControls(); return controller;
  }
  function finishOperation(generation, controller, resume) {
    if (!current(generation)) return;
    if (state.operation === controller) state.operation = null;
    state.busy = false; syncControls();
    if (resume && state.active) {
      setPhase("listening", "Ready for your next command…");
      // Allow the speaker tail to settle before the next capture.
      state.resumeTimer = env.setTimeout(() => { state.resumeTimer = null; beginListening(generation); }, 400);
    } else if (state.phase !== "error") setPhase("idle", "Ready. Start a voice session to speak your next command.");
  }
  async function executeText(text, language, generation, controller) {
    if (!current(generation)) return;
    put("live-transcript", text); appendMessage(text, "user");
    if (isStopCommand(text)) {
      const reply = /[\u0400-\u04ff]/.test(text) ? "Дуут горим зогслоо. Микрофон унтарсан." : "Voice session stopped. Microphone off.";
      put("latest-reply", reply); appendMessage(reply, "assistant"); stopSession(reply); return;
    }
    setPhase("thinking"); announce("Executing your request…");
    const data = await api("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: controller.signal });
    if (!current(generation)) return;
    const reply = data.reply || "Request completed.";
    put("latest-reply", reply); appendMessage(reply, "assistant", data.mode || state.mode); displayData(data); controls.text.value = ""; announce("Request completed.");
    await speakReply(reply, data.language || language, generation);
  }
  async function transcribeAndExecute(audio, language, generation = state.generation, resume = false) {
    if (!current(generation) || state.busy) return;
    if (!audio.size || audio.size > MAX_AUDIO_BYTES) {
      error(!audio.size ? "The recording is empty. Try speaking again." : "Audio is larger than 10 MB. Choose a shorter recording.");
      if (resume && state.active) beginListening(generation); return;
    }
    const controller = beginOperation(generation); error(""); setPhase("transcribing"); announce("Recognizing speech, then executing automatically…");
    try {
      const typeByExtension = { wav: "audio/wav", mp3: "audio/mpeg", webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac" };
      const extension = typeof audio.name === "string" ? audio.name.split(".").pop().toLowerCase() : "";
      const data = await api("/api/transcribe?language=" + encodeURIComponent(language), { method: "POST", headers: { "Content-Type": typeByExtension[extension] || audio.type || "application/octet-stream" }, body: audio, signal: controller.signal });
      if (!current(generation)) return;
      const text = (data.text || "").trim();
      if (!text) { announce("No speech recognized. Try a clearer command."); put("stage-detail", "No speech recognized. Ready to listen again."); return; }
      await executeText(text, data.language || language, generation, controller);
    } catch (e) {
      if (!current(generation) || e.name === "AbortError") return;
      error(e.message); announce("Request failed. Your voice session can listen again."); if (!resume) setPhase("error");
    } finally { finishOperation(generation, controller, resume); }
  }
  $("composer").addEventListener("submit", async (event) => {
    event.preventDefault(); const text = controls.text.value.trim();
    if (!text || state.busy || state.active || !state.connected) return;
    const generation = ++state.generation, controller = beginOperation(generation); error("");
    try { await executeText(text, controls.language.value, generation, controller); }
    catch (e) { if (current(generation) && e.name !== "AbortError") { error(e.message); setPhase("error"); } }
    finally { finishOperation(generation, controller, false); }
  });
  document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => { controls.text.value = button.dataset.prompt; $("composer").requestSubmit(); }));
  controls.session.addEventListener("click", startSession); controls.stop.addEventListener("click", () => stopSession());
  $("refresh-status").addEventListener("click", refreshStatus);
  $("upload-label").addEventListener("click", () => { if (!controls.file.disabled) controls.file.click(); });
  controls.file.addEventListener("change", () => {
    const file = controls.file.files[0]; controls.file.value = "";
    if (file && !state.active && !state.busy) transcribeAndExecute(file, controls.language.value, ++state.generation, false);
  });
  controls.language.addEventListener("change", () => {
    state.spokenLanguage = controls.language.value === "mn" ? "mn" : "en";
    try { env.localStorage.setItem("jarvis-language", controls.language.value); } catch (_) {} updateTts();
  });
  controls.speak.addEventListener("change", () => { if (!controls.speak.checked && env.speechSynthesis) { env.speechSynthesis.cancel(); if (state.speechFinish) state.speechFinish(); } });
  if (env.speechSynthesis) env.speechSynthesis.addEventListener("voiceschanged", () => updateTts());
  env.addEventListener("pagehide", () => stopSession());
  try { const stored = env.localStorage.getItem("jarvis-language"); if (["auto", "en", "mn"].includes(stored)) controls.language.value = stored; } catch (_) {}
  updateTts(); setPhase("idle"); setLevel(); if (options.autoRefresh !== false) refreshStatus();
  return { state, startSession, stopSession, transcribeAndExecute, refreshStatus };
}

if (typeof module !== "undefined" && module.exports) module.exports = { UtteranceDetector, isStopCommand, createVoiceApp };
if (typeof document !== "undefined") createVoiceApp(globalThis);
s