import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UtteranceDetector, isStopCommand, createVoiceApp } = require('../web/app.js');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (data, ok = true) => ({ ok, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness(fetchOverride) {
  const nodes = new Map(), requests = [], intervals = new Map(), timeouts = new Map(), recorders = [], streams = [], contexts = [];
  let clock = 0, timerId = 0, rms = 0;
  class Node {
    constructor() { this.style = { setProperty() {} }; this.dataset = {}; this.events = {}; this.children = []; this.value = ''; this.checked = true; this.files = []; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    emit(name, event = {}) { for (const callback of this.events[name] || []) callback(event); }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    click() { this.emit('click'); }
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  node('language').value = 'auto';
  const stream = () => {
    const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
    const value = { getTracks: () => [track], track }; streams.push(value); return value;
  };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.events = {}; this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      queueMicrotask(() => {
        for (const callback of this.events.dataavailable || []) callback({ data: new Blob(['recorded-audio']) });
        for (const callback of this.events.stop || []) callback();
      });
    }
  }
  class AudioContext {
    constructor() { this.closed = false; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(samples) { samples.fill(rms); } }; }
  }
  const synthesis = {
    voices: [{ lang: 'en-US', localService: true }], utterance: null,
    getVoices() { return this.voices; }, addEventListener() {}, cancel() {},
    speak(utterance) { this.utterance = utterance; },
  };
  const env = {
    document: { getElementById: node, createElement: () => new Node(), querySelectorAll: () => [], body: new Node(), documentElement: new Node() },
    navigator: { mediaDevices: { getUserMedia: async () => stream() } },
    isSecureContext: true, MediaRecorder: Recorder, AudioContext, AbortController,
    performance: { now: () => clock },
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {},
    speechSynthesis: synthesis, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: id => timeouts.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetchOverride) return fetchOverride(url, options);
      if (url.startsWith('/api/transcribe')) return response({ text: 'Jarvis, what time is it?', language: 'en' });
      if (url === '/api/chat') return response({ reply: 'It is 10:30.', mode: 'rules', language: 'en', tasks: [], notes: [] });
      return response({ voice_ready: true, agent_mode: 'rules', tasks: [], notes: [] });
    },
  };
  const app = createVoiceApp(env, { autoRefresh: false });
  app.state.connected = true; app.state.voiceReady = true;
  function tick(duration, level = 0) {
    rms = level;
    for (let elapsed = 0; elapsed < duration; elapsed += 50) {
      clock += 50;
      for (const callback of [...intervals.values()]) callback();
      for (const [id, timer] of [...timeouts]) if (timer.at <= clock) { timeouts.delete(id); timer.callback(); }
    }
  }
  return { app, env, node, requests, recorders, streams, contexts, tick, stream, synthesis, intervals, timeouts };
}

test('silence and brief clicks are discarded without submitting an utterance', () => {
  const silent = new UtteranceDetector();
  assert.equal(silent.sample(0.002, 5000).action, 'rearm');
  const click = new UtteranceDetector();
  click.sample(0.15, 50);
  assert.equal(click.sample(0.002, 1150).action, 'discard');
});

test('a real utterance closes once, after the silence gap', () => {
  const detector = new UtteranceDetector();
  for (let time = 50; time <= 300; time += 50) detector.sample(0.08, time);
  assert.equal(detector.sample(0.003, 1350).action, null);
  assert.equal(detector.sample(0.003, 1400).action, 'submit');
  assert.equal(detector.sample(0.08, 1500).action, null);
});

test('continuous speech is capped at 30 seconds and noise threshold stays bounded', () => {
  const detector = new UtteranceDetector();
  for (let time = 50; time < 30000; time += 50) assert.equal(detector.sample(0.09, time).action, null);
  assert.equal(detector.sample(0.09, 30000).action, 'submit');
  const noisy = new UtteranceDetector();
  for (let time = 50; time < 5000; time += 50) noisy.sample(0.018, time);
  assert.ok(noisy.threshold() >= 0.02 && noisy.threshold() <= 0.07);
});

test('spoken stop phrases are recognized in both languages without matching note text', () => {
  for (const command of ['Jarvis, stop listening.', 'Jarvis, stop.', 'Stop.', 'Pause.', 'Pause Jarvis!', 'Жарвис аа, зогс.', 'сонсохоо зогсоо']) assert.equal(isStopCommand(command), true);
  assert.equal(isStopCommand('Remember to stop listening to loud music'), false);
});

test('an idle session records from the beginning, rearms bounded silence and makes no requests', async () => {
  const h = harness(); await h.app.startSession();
  assert.equal(h.recorders[0].state, 'recording');
  h.tick(5000); await settle();
  assert.equal(h.recorders.length, 2);
  assert.equal(h.requests.length, 0);
  h.app.stopSession();
  assert.equal(h.streams[0].track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.intervals.size, 0);
});

test('one spoken utterance automatically executes once, pauses for TTS and then listens again', async () => {
  const h = harness(); await h.app.startSession();
  h.tick(350, 0.08); h.tick(1100); await settle();
  assert.deepEqual(h.requests.map(request => request.url), ['/api/transcribe?language=auto', '/api/chat']);
  assert.equal(JSON.parse(h.requests[1].options.body).text, 'Jarvis, what time is it?');
  assert.equal(h.node('live-transcript').textContent, 'Jarvis, what time is it?');
  assert.equal(h.app.state.phase, 'speaking');
  assert.equal(h.recorders[0].state, 'inactive');
  h.tick(4000, 0.12); await settle();
  assert.equal(h.requests.length, 2, 'speaker output must not become another command');
  h.synthesis.utterance.onend(); await settle(); h.tick(400); await settle();
  assert.equal(h.app.state.phase, 'listening');
  assert.equal(h.recorders.length, 2);
  h.app.stopSession();
});

test('stopping during transcription prevents a late recognized command from executing', async () => {
  const waiting = deferred(), h = harness(url => url.startsWith('/api/transcribe') ? waiting.promise : response({ reply: 'unexpected' }));
  h.node('speak-reply').checked = false;
  const operation = h.app.transcribeAndExecute(new Blob(['audio']), 'auto'); await settle();
  const signal = h.requests[0].options.signal;
  h.app.stopSession();
  assert.equal(signal.aborted, true);
  waiting.resolve(response({ text: 'Remember to create an unwanted note', language: 'en' }));
  await operation;
  assert.equal(h.requests.length, 1);
  assert.equal(h.app.state.phase, 'idle');
  assert.equal(h.node('messages').children.length, 0);
});

test('stopping before microphone permission resolves stops the late stream', async () => {
  const h = harness(), waiting = deferred();
  h.env.navigator.mediaDevices.getUserMedia = () => waiting.promise;
  const start = h.app.startSession(); h.app.stopSession();
  const stream = h.stream(); waiting.resolve(stream); await start;
  assert.equal(stream.track.stopped, true);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.app.state.active, false);
});

test('recognition failure allows the next utterance without requiring another start click', async () => {
  const h = harness(() => response({ message: 'Recognition unavailable temporarily' }, false));
  await h.app.startSession(); h.tick(350, 0.08); h.tick(1100); await settle(); h.tick(400); await settle();
  assert.equal(h.app.state.active, true);
  assert.equal(h.app.state.busy, false);
  assert.equal(h.app.state.phase, 'listening');
  assert.equal(h.recorders.length, 2);
  assert.match(h.node('error-message').textContent, /Recognition unavailable/);
  h.app.stopSession();
});

test('uploaded audio automatically transcribes and executes without the Send button', async () => {
  const h = harness(); h.node('speak-reply').checked = false;
  h.node('audio-file').files = [new Blob(['file'], { type: 'audio/wav' })];
  h.node('audio-file').emit('change'); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.node('latest-reply').textContent, 'It is 10:30.');
  assert.equal(h.app.state.busy, false);
});

test('a spoken stop command closes the session without calling the command API', async () => {
  const h = harness(() => response({ text: 'Жарвис аа, зогс.', language: 'mn' }));
  await h.app.startSession(); h.tick(350, 0.08); h.tick(1100); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.app.state.active, false);
  assert.equal(h.streams[0].track.stopped, true);
  assert.match(h.node('latest-reply').textContent, /Микрофон унтарсан/);
});

test('missing Mongolian voice and remote-only voices display text instead of speaking with a wrong voice', async () => {
  const h = harness(url => response(url.startsWith('/api/transcribe') ? { text: 'Цаг хэд болж байна?', language: 'mn' } : { reply: 'Одоо 10:30 цаг болж байна.', language: 'mn', tasks: [], notes: [] }));
  h.synthesis.voices = [{ lang: 'en-US', localService: true }, { lang: 'mn-MN', localService: false }];
  await h.app.transcribeAndExecute(new Blob(['audio']), 'auto');
  assert.equal(h.synthesis.utterance, null);
  assert.match(h.node('tts-hint').textContent, /Монгол хэлний/);
  assert.equal(h.app.state.busy, false);
  assert.equal(h.node('latest-reply').textContent, 'Одоо 10:30 цаг болж байна.');
});

test('Stop during a spoken reply releases the microphone and a late speech end cannot reopen it', async () => {
  const h = harness(); await h.app.startSession(); h.tick(350, 0.08); h.tick(1100); await settle();
  const utterance = h.synthesis.utterance;
  assert.equal(h.app.state.phase, 'speaking');
  h.app.stopSession(); utterance.onend(); await settle(); h.tick(1000); await settle();
  assert.equal(h.app.state.active, false);
  assert.equal(h.app.state.phase, 'idle');
  assert.equal(h.streams[0].track.stopped, true);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.timeouts.size, 0);
});

test('an old ASR response cannot disturb a new voice session after Stop and restart', async () => {
  const waiting = deferred(), h = harness(() => waiting.promise);
  const operation = h.app.transcribeAndExecute(new Blob(['old-audio']), 'auto'); await settle();
  h.app.stopSession(); await h.app.startSession();
  waiting.resolve(response({ text: 'Remember a stale command', language: 'en' })); await operation;
  assert.equal(h.requests.length, 1);
  assert.equal(h.app.state.active, true);
  assert.equal(h.app.state.busy, false);
  assert.equal(h.app.state.phase, 'listening');
  assert.equal(h.recorders[0].state, 'recording');
  h.app.stopSession();
});

test('speech playback error resumes listening and shows a useful explanation', async () => {
  const h = harness(); await h.app.startSession(); h.tick(350, 0.08); h.tick(1100); await settle();
  h.synthesis.utterance.onerror(); await settle(); h.tick(400); await settle();
  assert.equal(h.app.state.phase, 'listening');
  assert.equal(h.app.state.active, true);
  assert.match(h.node('tts-hint').textContent, /playback failed/);
  assert.equal(h.recorders.length, 2);
  h.app.stopSession();
});

test('missing speech end event times out and resumes listening', async () => {
  const h = harness(); await h.app.startSession(); h.tick(350, 0.08); h.tick(1100); await settle();
  h.tick(12000); await settle(); h.tick(400); await settle();
  assert.equal(h.app.state.phase, 'listening');
  assert.match(h.node('tts-hint').textContent, /timed out/);
  assert.equal(h.recorders.length, 2);
  h.app.stopSession();
});