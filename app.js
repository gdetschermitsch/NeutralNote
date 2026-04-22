(function () {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  const STORAGE_KEY = 'neutralnote_settings_v1';
  const SESSION_DRAFT_KEY = 'neutralnote_session_draft_v1';
  const AUTOSAVE_INTERVAL_MS = 8000;
  const PCM_RETENTION_PADDING_MS = 2000;
  const MIN_PCM_RETENTION_MS = 45000;
  const DB_NAME = 'neutralnote_autosave_db';
  const DB_VERSION = 1;
  const BITES_STORE = 'bites';

  const els = {
    topicTitle: document.getElementById('topicTitle'),
    speakersPresent: document.getElementById('speakersPresent'),
    audioDeviceSelect: document.getElementById('audioDeviceSelect'),
    languageSelect: document.getElementById('languageSelect'),
    refreshDevicesBtn: document.getElementById('refreshDevicesBtn'),
    runSystemCheckBtn: document.getElementById('runSystemCheckBtn'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    exportBtn: document.getElementById('exportBtn'),
    clearBtn: document.getElementById('clearBtn'),
    sessionStatus: document.getElementById('sessionStatus'),
    recognitionStatus: document.getElementById('recognitionStatus'),
    meterCanvas: document.getElementById('meterCanvas'),
    liveBox: document.getElementById('liveBox'),
    bitesList: document.getElementById('bitesList'),
    biteCount: document.getElementById('biteCount'),
    biteTemplate: document.getElementById('biteTemplate'),
    controlsPanel: document.querySelector('.controls-panel'),
    captureBody: document.getElementById('captureBody'),
    toggleCaptureBtn: document.getElementById('toggleCaptureBtn'),
    aboutBtn: document.getElementById('aboutBtn'),
    aboutModal: document.getElementById('aboutModal'),
    closeAboutBtn: document.getElementById('closeAboutBtn'),
    aboutBackdrop: document.getElementById('aboutBackdrop'),
    browserStatus: document.getElementById('browserStatus'),
    secureContextStatus: document.getElementById('secureContextStatus'),
    microphoneApiStatus: document.getElementById('microphoneApiStatus'),
    speechApiStatus: document.getElementById('speechApiStatus'),
    permissionStatus: document.getElementById('permissionStatus'),
    browserRecommendation: document.getElementById('browserRecommendation'),
    systemMessage: document.getElementById('systemMessage'),
    permissionHelp: document.getElementById('permissionHelp')
  };

  const state = {
    running: false,
    sessionStartedAt: null,
    sessionEndedAt: null,
    stream: null,
    recognition: null,
    audioContext: null,
    analyser: null,
    meterRAF: null,
    captureSource: null,
    meterSource: null,
    captureProcessor: null,
    captureSink: null,
    captureWorkletLoaded: false,
    pcmChunks: [],
    pcmSampleRate: 0,
    pcmChannelCount: 1,
    pcmTotalSamples: 0,
    pendingInterim: '',
    lastFinalCommitAt: null,
    bites: [],
    stopRequested: false,
    preferredDeviceId: '',
    currentSessionId: null,
    autosaveTimer: null,
    autosaveInFlight: false,
    lastAutosaveAt: 0,
    restoredDraft: false
  };

  function setStatus(text) { els.sessionStatus.textContent = text; }
  function setRecognitionStatus(text) { els.recognitionStatus.textContent = text; }

  function formatDateTime(ts) {
    return new Date(ts).toLocaleString();
  }

  function formatClock(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getBrowserInfo() {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return { name: 'Edge', chromiumBased: true };
    if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return { name: 'Chrome', chromiumBased: true };
    if (/Firefox\//.test(ua)) return { name: 'Firefox', chromiumBased: false };
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return { name: 'Safari', chromiumBased: false };
    return { name: 'Unknown browser', chromiumBased: false };
  }

  function setFeatureStatus(el, text, tone) {
    el.textContent = text;
    el.classList.remove('status-ok', 'status-warn', 'status-bad');
    if (tone) el.classList.add(tone);
  }

  function updateSystemMessage(message, tone) {
    els.systemMessage.textContent = message;
    els.systemMessage.style.borderColor = '';
    els.systemMessage.style.background = '';
    els.systemMessage.style.color = '';

    if (tone === 'bad') {
      els.systemMessage.style.background = 'rgba(248,113,113,0.08)';
      els.systemMessage.style.borderColor = 'rgba(248,113,113,0.28)';
      els.systemMessage.style.color = '#ffd1d1';
    } else if (tone === 'warn') {
      els.systemMessage.style.background = 'rgba(251,191,36,0.08)';
      els.systemMessage.style.borderColor = 'rgba(251,191,36,0.28)';
      els.systemMessage.style.color = '#fde8b0';
    }
  }



  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn(`Could not save ${key}`, err);
    }
  }

  function safeLocalStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      console.warn(`Could not read ${key}`, err);
      return null;
    }
  }

  function sanitizeBiteForStorage(bite) {
    return {
      id: bite.id,
      text: bite.text,
      speaker: bite.speaker,
      startAt: bite.startAt,
      endAt: bite.endAt,
      sessionId: bite.sessionId || null,
      sessionStartedAt: bite.sessionStartedAt || bite.startAt,
      addedAt: bite.addedAt || Date.now(),
      hasAudio: Boolean(bite.audioBlob)
    };
  }

  function getEarliestNeededAudioTime() {
    const candidates = [];
    if (state.lastFinalCommitAt) candidates.push(state.lastFinalCommitAt);
    if (state.sessionStartedAt) candidates.push(state.sessionStartedAt);
    if (!candidates.length) return 0;
    return Math.max(0, Math.min(...candidates) - PCM_RETENTION_PADDING_MS);
  }

  function trimPCMBuffer() {
    if (!state.pcmChunks.length) return;
    const earliestNeeded = getEarliestNeededAudioTime();
    const newestEndAt = state.pcmChunks[state.pcmChunks.length - 1].endAt;
    const fallbackStartAt = Math.max(0, newestEndAt - MIN_PCM_RETENTION_MS);
    const keepFrom = Math.min(earliestNeeded || fallbackStartAt, fallbackStartAt);
    state.pcmChunks = state.pcmChunks.filter((chunk) => chunk.endAt >= keepFrom);
  }

  function startAutosaveTimer() {
    stopAutosaveTimer();
    state.autosaveTimer = window.setInterval(() => {
      autosaveSessionDraft();
    }, AUTOSAVE_INTERVAL_MS);
  }

  function stopAutosaveTimer() {
    if (state.autosaveTimer) {
      window.clearInterval(state.autosaveTimer);
      state.autosaveTimer = null;
    }
  }

  function openAutosaveDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BITES_STORE)) {
          db.createObjectStore(BITES_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open autosave database.'));
    });
  }

  async function replaceAutosavedBites(records) {
    const db = await openAutosaveDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BITES_STORE, 'readwrite');
      const store = tx.objectStore(BITES_STORE);
      const clearReq = store.clear();
      clearReq.onerror = () => reject(clearReq.error || new Error('Could not clear autosaved bites.'));
      clearReq.onsuccess = () => {
        records.forEach((record) => store.put(record));
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Could not write autosaved bites.'));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('Autosave transaction aborted.'));
      };
    });
  }

  async function readAutosavedBites() {
    const db = await openAutosaveDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BITES_STORE, 'readonly');
      const store = tx.objectStore(BITES_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve(req.result || []);
      };
      req.onerror = () => {
        db.close();
        reject(req.error || new Error('Could not read autosaved bites.'));
      };
    });
  }

  async function clearAutosaveStorage() {
    safeLocalStorageSet(SESSION_DRAFT_KEY, '');
    if (!window.indexedDB) return;
    try {
      await replaceAutosavedBites([]);
    } catch (err) {
      console.warn('Could not clear autosaved bites', err);
    }
  }

  async function autosaveSessionDraft() {
    if (state.autosaveInFlight) return;
    state.autosaveInFlight = true;
    try {
      const draft = {
        topicTitle: els.topicTitle.value.trim(),
        speakersPresent: els.speakersPresent.value.trim(),
        language: els.languageSelect.value,
        preferredDeviceId: els.audioDeviceSelect.value || state.preferredDeviceId || '',
        running: state.running,
        sessionStartedAt: state.sessionStartedAt,
        sessionEndedAt: state.sessionEndedAt,
        currentSessionId: state.currentSessionId,
        pendingInterim: state.pendingInterim,
        lastFinalCommitAt: state.lastFinalCommitAt,
        biteCount: state.bites.length,
        lastAutosaveAt: Date.now(),
        bites: state.bites.map(sanitizeBiteForStorage)
      };
      safeLocalStorageSet(SESSION_DRAFT_KEY, JSON.stringify(draft));
      if (window.indexedDB) {
        const biteRecords = state.bites.map((bite) => ({
          ...sanitizeBiteForStorage(bite),
          audioBlob: bite.audioBlob || null
        }));
        await replaceAutosavedBites(biteRecords);
      }
      state.lastAutosaveAt = Date.now();
    } catch (err) {
      console.warn('Autosave failed', err);
    } finally {
      state.autosaveInFlight = false;
    }
  }

  async function restoreSessionDraft() {
    const raw = safeLocalStorageGet(SESSION_DRAFT_KEY);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      if (draft.topicTitle) els.topicTitle.value = draft.topicTitle;
      if (draft.speakersPresent) els.speakersPresent.value = draft.speakersPresent;
      if (draft.language) els.languageSelect.value = draft.language;
      if (draft.preferredDeviceId) state.preferredDeviceId = draft.preferredDeviceId;
      state.sessionStartedAt = draft.sessionStartedAt || null;
      state.sessionEndedAt = draft.sessionEndedAt || null;
      state.currentSessionId = draft.currentSessionId || null;
      state.pendingInterim = draft.pendingInterim || '';
      state.lastFinalCommitAt = draft.lastFinalCommitAt || draft.sessionStartedAt || null;

      let bites = draft.bites || [];
      if (window.indexedDB) {
        try {
          const stored = await readAutosavedBites();
          if (stored && stored.length) bites = stored;
        } catch (err) {
          console.warn('Could not restore bite blobs from autosave database', err);
        }
      }

      state.bites = bites.map((bite) => {
        const audioUrl = bite.audioBlob ? URL.createObjectURL(bite.audioBlob) : '';
        return {
          id: bite.id || crypto.randomUUID(),
          text: bite.text || '',
          speaker: bite.speaker || 'Unassigned',
          startAt: bite.startAt,
          endAt: bite.endAt,
          sessionId: bite.sessionId || null,
          sessionStartedAt: bite.sessionStartedAt || bite.startAt,
          addedAt: bite.addedAt || Date.now(),
          audioBlob: bite.audioBlob || null,
          audioUrl
        };
      });

      if (state.bites.length || draft.running || draft.pendingInterim) {
        state.restoredDraft = true;
        renderBites();
        setStatus(draft.running ? 'Recovered (restart needed)' : 'Recovered');
        setRecognitionStatus('Not running');
        els.liveBox.textContent = draft.pendingInterim ? `Recovered draft text: ${draft.pendingInterim}` : 'Recovered autosaved session.';
        updateSystemMessage('Recovered your last autosaved session data. Because the page was reloaded or closed, microphone capture is stopped and must be started again manually.', 'warn');
      }
    } catch (err) {
      console.warn('Could not restore autosaved session draft', err);
    }
  }


  function revokeAllBiteUrls() {
    state.bites.forEach((bite) => {
      if (bite.audioUrl) URL.revokeObjectURL(bite.audioUrl);
    });
  }

  function teardownRecognition() {
    if (state.recognition) {
      try { state.recognition.stop(); } catch (err) { console.error(err); }
      state.recognition = null;
    }
    setRecognitionStatus('Stopped');
  }

  function teardownStreamAndAudio() {
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }

    if (state.captureProcessor) {
      try { state.captureProcessor.port && state.captureProcessor.port.close && state.captureProcessor.port.close(); } catch (err) {}
      try { state.captureProcessor.disconnect(); } catch (err) {}
      state.captureProcessor.onaudioprocess = null;
      state.captureProcessor = null;
    }
    if (state.captureSource) {
      try { state.captureSource.disconnect(); } catch (err) {}
      state.captureSource = null;
    }
    if (state.captureSink) {
      try { state.captureSink.disconnect(); } catch (err) {}
      state.captureSink = null;
    }

    stopMeter();

    if (state.audioContext) {
      state.audioContext.close().catch(() => {});
      state.audioContext = null;
    }
  }

  function resetSessionStateForFailure() {
    state.running = false;
    state.stopRequested = false;
    state.stream = null;
    state.pendingInterim = '';
    state.sessionStartedAt = null;
    state.sessionEndedAt = null;
    state.currentSessionId = null;
    state.lastFinalCommitAt = null;
    stopAutosaveTimer();
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    setStatus('Idle');
    els.liveBox.textContent = 'Awaiting session start…';
  }

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        topicTitle: els.topicTitle.value,
        speakersPresent: els.speakersPresent.value,
        language: els.languageSelect.value,
        preferredDeviceId: els.audioDeviceSelect.value || state.preferredDeviceId || ''
      }));
    } catch (err) {
      console.warn('Could not save preferences', err);
    }
  }

  function loadPreferences() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.topicTitle) els.topicTitle.value = saved.topicTitle;
      if (saved.speakersPresent) els.speakersPresent.value = saved.speakersPresent;
      if (saved.language) els.languageSelect.value = saved.language;
      if (saved.preferredDeviceId) state.preferredDeviceId = saved.preferredDeviceId;
    } catch (err) {
      console.warn('Could not load preferences', err);
    }
  }

  function buildPermissionError(err) {
    const name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone access was blocked. Click the padlock/site settings icon in your browser, allow microphone access, then run the check again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found. Plug in a microphone and run the check again.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The microphone is busy in another app. Close the other app and try again.';
    }
    return 'Microphone access is required to list and use audio devices.';
  }

  async function ensureDevicePermission() {
    let tempStream;
    try {
      tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return tempStream;
    } catch (err) {
      throw new Error(buildPermissionError(err));
    } finally {
      if (tempStream) tempStream.getTracks().forEach(t => t.stop());
    }
  }

  function chooseBestDevice(audioInputs) {
    if (!audioInputs.length) return '';
    const exact = audioInputs.find(device => device.deviceId === state.preferredDeviceId);
    if (exact) return exact.deviceId;
    const defaultLike = audioInputs.find(device => /default/i.test(device.label || ''));
    return (defaultLike || audioInputs[0]).deviceId;
  }

  async function loadDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      els.audioDeviceSelect.innerHTML = '<option value="">Audio devices unavailable</option>';
      return;
    }

    try {
      await ensureDevicePermission();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      els.audioDeviceSelect.innerHTML = '';
      if (!audioInputs.length) {
        const opt = document.createElement('option');
        opt.textContent = 'No audio inputs found';
        opt.value = '';
        els.audioDeviceSelect.appendChild(opt);
        return;
      }

      audioInputs.forEach((device, index) => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Audio Input ${index + 1}`;
        els.audioDeviceSelect.appendChild(opt);
      });

      const selected = chooseBestDevice(audioInputs);
      els.audioDeviceSelect.value = selected;
      state.preferredDeviceId = selected;
      savePreferences();
    } catch (err) {
      console.error(err);
      els.audioDeviceSelect.innerHTML = '<option value="">Microphone permission denied</option>';
      updateSystemMessage(err.message, 'bad');
      els.permissionHelp.hidden = false;
    }
  }

  async function startMeter(stream) {
    if (!AudioContextClass) return;
    if (!state.audioContext) state.audioContext = new AudioContextClass();
    if (state.audioContext.state === 'suspended') {
      try { await state.audioContext.resume(); } catch (err) { console.error(err); }
    }

    if (state.meterSource) {
      try { state.meterSource.disconnect(); } catch (err) {}
      state.meterSource = null;
    }

    const source = state.audioContext.createMediaStreamSource(stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 1024;
    source.connect(state.analyser);
    state.meterSource = source;

    const canvas = els.meterCanvas;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(state.analyser.frequencyBinCount);

    function draw() {
      if (!state.analyser) return;
      state.analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length / 255;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#12202d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(0, 0, canvas.width * avg, canvas.height);
      ctx.strokeStyle = '#5eead4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const y = canvas.height * (1 - avg);
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      state.meterRAF = requestAnimationFrame(draw);
    }

    draw();
  }

  function stopMeter() {
    if (state.meterRAF) cancelAnimationFrame(state.meterRAF);
    state.meterRAF = null;
    state.analyser = null;
    if (state.meterSource) {
      try { state.meterSource.disconnect(); } catch (err) {}
      state.meterSource = null;
    }
    const ctx = els.meterCanvas.getContext('2d');
    ctx.clearRect(0, 0, els.meterCanvas.width, els.meterCanvas.height);
  }

  function appendPCMChunk(input) {
    if (!state.running || !input || !input.length) return;
    const copy = new Float32Array(input.length);
    copy.set(input);
    const sessionBase = state.sessionStartedAt || Date.now();
    const chunkStartAt = sessionBase + (state.pcmTotalSamples / state.pcmSampleRate) * 1000;
    state.pcmTotalSamples += copy.length;
    const chunkEndAt = sessionBase + (state.pcmTotalSamples / state.pcmSampleRate) * 1000;
    state.pcmChunks.push({
      startAt: chunkStartAt,
      endAt: chunkEndAt,
      samples: copy
    });
    trimPCMBuffer();
  }

  async function ensureRecorderWorkletLoaded() {
    if (!state.audioContext || !state.audioContext.audioWorklet) return false;
    if (state.captureWorkletLoaded) return true;
    await state.audioContext.audioWorklet.addModule('./recorderWorklet.js');
    state.captureWorkletLoaded = true;
    return true;
  }

  async function startAudioRecorder(stream) {
    if (!AudioContextClass) throw new Error('Web Audio is not supported in this browser.');
    if (!state.audioContext) state.audioContext = new AudioContextClass({ latencyHint: 'interactive' });
    if (state.audioContext.state === 'suspended') await state.audioContext.resume();

    state.pcmChunks = [];
    state.pcmSampleRate = state.audioContext.sampleRate;
    state.pcmChannelCount = 1;
    state.pcmTotalSamples = 0;

    const source = state.audioContext.createMediaStreamSource(stream);
    const sink = state.audioContext.createGain();
    sink.gain.value = 0;

    let processor;

    if (state.audioContext.audioWorklet && window.AudioWorkletNode) {
      await ensureRecorderWorkletLoaded();
      processor = new AudioWorkletNode(state.audioContext, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      });
      processor.port.onmessage = (event) => {
        appendPCMChunk(event.data);
      };
      processor.port.onmessageerror = (event) => {
        console.error('Recorder worklet message error', event);
      };
    } else {
      processor = state.audioContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        appendPCMChunk(event.inputBuffer.getChannelData(0));
      };
      console.warn('AudioWorkletNode not available. Falling back to deprecated ScriptProcessorNode.');
    }

    source.connect(processor);
    processor.connect(sink);
    sink.connect(state.audioContext.destination);

    state.captureSource = source;
    state.captureProcessor = processor;
    state.captureSink = sink;
  }

  function preprocessAudioForPlayback(samples, sampleRate) {
    if (!samples || !samples.length) return samples;
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      const av = Math.abs(v);
      if (av > peak) peak = av;
      sumSq += v * v;
    }
    if (peak < 0.00001) return samples;

    const rms = Math.sqrt(sumSq / samples.length);
    const targetPeak = 0.92;
    const targetRms = 0.18;
    const peakGain = targetPeak / peak;
    const rmsGain = rms > 0 ? targetRms / rms : 1;
    const gain = Math.max(1, Math.min(peakGain, rmsGain, 4));
    const fadeSamples = Math.min(Math.floor(sampleRate * 0.012), Math.floor(samples.length / 8));
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let v = samples[i] * gain;
      if (fadeSamples > 0 && i < fadeSamples) v *= i / fadeSamples;
      if (fadeSamples > 0 && i >= samples.length - fadeSamples) v *= (samples.length - i - 1) / fadeSamples;
      out[i] = Math.max(-0.98, Math.min(0.98, v));
    }
    return out;
  }

  function encodeWavFromFloat32(samples, sampleRate) {
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * bytesPerSample, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  function createBiteAudioBlob(startAt, endAt) {
    if (!state.pcmChunks.length || !state.pcmSampleRate) return null;
    const padMs = 160;
    const paddedStartAt = Math.max(state.sessionStartedAt || startAt, startAt - padMs);
    const paddedEndAt = endAt + padMs;
    const selected = [];
    for (const chunk of state.pcmChunks) {
      if (chunk.endAt <= paddedStartAt || chunk.startAt >= paddedEndAt) continue;
      selected.push(chunk);
    }
    if (!selected.length) return null;

    let totalLength = 0;
    for (const chunk of selected) {
      const chunkDurationMs = chunk.endAt - chunk.startAt;
      if (chunkDurationMs <= 0) continue;
      const chunkStartOffset = Math.max(0, Math.floor(((paddedStartAt - chunk.startAt) / chunkDurationMs) * chunk.samples.length));
      const chunkEndOffset = Math.min(chunk.samples.length, Math.ceil(((paddedEndAt - chunk.startAt) / chunkDurationMs) * chunk.samples.length));
      const len = Math.max(0, chunkEndOffset - chunkStartOffset);
      if (len > 0) totalLength += len;
    }
    if (!totalLength) return null;

    const merged = new Float32Array(totalLength);
    let writeOffset = 0;
    for (const chunk of selected) {
      const chunkDurationMs = chunk.endAt - chunk.startAt;
      if (chunkDurationMs <= 0) continue;
      const chunkStartOffset = Math.max(0, Math.floor(((paddedStartAt - chunk.startAt) / chunkDurationMs) * chunk.samples.length));
      const chunkEndOffset = Math.min(chunk.samples.length, Math.ceil(((paddedEndAt - chunk.startAt) / chunkDurationMs) * chunk.samples.length));
      const slice = chunk.samples.subarray(chunkStartOffset, chunkEndOffset);
      merged.set(slice, writeOffset);
      writeOffset += slice.length;
    }

    const prepared = preprocessAudioForPlayback(merged, state.pcmSampleRate);
    return encodeWavFromFloat32(prepared, state.pcmSampleRate);
  }

  function addBite(text, startAt, endAt, speaker) {
    const cleaned = (text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return;

    const audioBlob = createBiteAudioBlob(startAt, endAt);
    const audioUrl = audioBlob ? URL.createObjectURL(audioBlob) : '';
    const bite = {
      id: crypto.randomUUID(),
      text: cleaned,
      speaker: speaker || 'Unassigned',
      startAt,
      endAt,
      sessionId: state.currentSessionId || null,
      sessionStartedAt: state.sessionStartedAt || startAt,
      addedAt: Date.now(),
      audioBlob,
      audioUrl
    };
    state.bites.push(bite);
    state.lastFinalCommitAt = endAt;
    trimPCMBuffer();
    renderBites();
    autosaveSessionDraft();
  }

  function renderBites() {
    els.bitesList.innerHTML = '';
    state.bites.forEach((bite) => {
      const frag = els.biteTemplate.content.cloneNode(true);
      const timeEl = frag.querySelector('.bite-time');
      const rangeEl = frag.querySelector('.bite-range');
      const speakerSelect = frag.querySelector('.speaker-select');
      const textArea = frag.querySelector('.bite-text');
      const audio = frag.querySelector('.bite-audio');
      const dlBtn = frag.querySelector('.download-bite-btn');
      const delBtn = frag.querySelector('.delete-bite-btn');

      timeEl.textContent = formatDateTime(bite.startAt);
      const sessionBase = bite.sessionStartedAt || bite.startAt;
      rangeEl.textContent = `${formatClock(bite.startAt - sessionBase)} → ${formatClock(bite.endAt - sessionBase)}`;
      speakerSelect.value = bite.speaker;
      textArea.value = bite.text;

      if (bite.audioUrl) {
        audio.src = bite.audioUrl;
      } else {
        audio.removeAttribute('controls');
        audio.outerHTML = '<div class="helper-text">No audio clip captured for this bite.</div>';
      }

      speakerSelect.addEventListener('change', () => {
        bite.speaker = speakerSelect.value;
        autosaveSessionDraft();
      });
      textArea.addEventListener('input', () => {
        bite.text = textArea.value;
        autosaveSessionDraft();
      });
      dlBtn.addEventListener('click', () => {
        if (!bite.audioBlob) return;
        const a = document.createElement('a');
        a.href = bite.audioUrl;
        a.download = `bite_${formatClock(bite.startAt - ((bite.sessionStartedAt || bite.startAt))).replace(/:/g, '-')}.wav`;
        a.click();
      });
      delBtn.addEventListener('click', () => {
        if (bite.audioUrl) URL.revokeObjectURL(bite.audioUrl);
        state.bites = state.bites.filter(b => b.id !== bite.id);
        renderBites();
        autosaveSessionDraft();
      });

      els.bitesList.appendChild(frag);
    });

    els.biteCount.textContent = `${state.bites.length} bite${state.bites.length === 1 ? '' : 's'}`;
  }

  function startRecognition() {
    if (!SpeechRecognitionClass) {
      throw new Error('Speech recognition is not supported in this browser. Use Chrome or Edge for best results.');
    }

    state.recognition = new SpeechRecognitionClass();
    state.recognition.lang = els.languageSelect.value;
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.maxAlternatives = 1;

    state.pendingInterim = '';
    let segmentStartedAt = Date.now();

    state.recognition.onstart = () => {
      setRecognitionStatus('Listening');
    };

    state.recognition.onresult = (event) => {
      let interimText = '';
      let finalizedText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0] ? result[0].transcript : '';
        if (result.isFinal) finalizedText += text + ' ';
        else interimText += text + ' ';
      }

      state.pendingInterim = interimText.trim();
      const liveDisplay = [finalizedText.trim(), state.pendingInterim].filter(Boolean).join(' ');
      els.liveBox.textContent = liveDisplay || 'Listening…';

      if (finalizedText.trim()) {
        const now = Date.now();
        addBite(finalizedText.trim(), segmentStartedAt, now, 'Unassigned');
        segmentStartedAt = now;
        state.pendingInterim = '';
        els.liveBox.textContent = 'Listening…';
      }
    };

    state.recognition.onerror = (event) => {
      console.error('Recognition error', event.error);
      if (event.error === 'not-allowed') {
        setRecognitionStatus('Blocked');
        updateSystemMessage('Speech recognition permission was blocked. Chrome or Edge is recommended.', 'bad');
      } else if (event.error === 'no-speech') {
        setRecognitionStatus('No speech detected');
      } else {
        setRecognitionStatus(`Error: ${event.error}`);
      }
    };

    state.recognition.onend = () => {
      if (state.running && !state.stopRequested) {
        setRecognitionStatus('Restarting');
        try {
          state.recognition.start();
        } catch (err) {
          console.error('Recognition restart failed', err);
          setRecognitionStatus('Restart failed');
        }
      } else {
        setRecognitionStatus('Stopped');
      }
    };

    state.recognition.start();
  }

  async function runSystemCheck() {
    const browser = getBrowserInfo();
    setFeatureStatus(els.browserStatus, browser.name, browser.chromiumBased ? 'status-ok' : 'status-warn');
    setFeatureStatus(els.browserRecommendation, browser.chromiumBased ? 'Recommended' : 'Use Chrome or Edge', browser.chromiumBased ? 'status-ok' : 'status-warn');
    setFeatureStatus(els.secureContextStatus, window.isSecureContext ? 'Yes' : 'No', window.isSecureContext ? 'status-ok' : 'status-bad');
    setFeatureStatus(els.microphoneApiStatus, navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'Available' : 'Missing', navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? 'status-ok' : 'status-bad');
    setFeatureStatus(els.speechApiStatus, SpeechRecognitionClass ? 'Available' : 'Missing', SpeechRecognitionClass ? 'status-ok' : 'status-bad');
    els.permissionHelp.hidden = true;

    els.startBtn.disabled = false;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setFeatureStatus(els.permissionStatus, 'Unavailable', 'status-bad');
      els.startBtn.disabled = true;
      updateSystemMessage('This browser does not expose the microphone APIs NeutralNote needs.', 'bad');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      setFeatureStatus(els.permissionStatus, 'Granted', 'status-ok');
      if (!SpeechRecognitionClass) {
        els.startBtn.disabled = true;
        updateSystemMessage('Microphone access is working, but speech recognition is missing here. Start Session is disabled. Use Chrome or Edge.', 'warn');
      } else if (!window.isSecureContext) {
        updateSystemMessage('Microphone access is working, but secure context detection is off.', 'warn');
      } else if (!browser.chromiumBased) {
        updateSystemMessage('System check passed, but this browser is not the preferred one for transcription reliability. Chrome or Edge is strongly recommended.', 'warn');
      } else {
        updateSystemMessage('System check passed. Device selection controls bite audio capture and the input meter. Live transcription still depends on the browser speech engine.', 'ok');
      }
      await loadDevices();
    } catch (err) {
      console.error(err);
      els.startBtn.disabled = true;
      setFeatureStatus(els.permissionStatus, 'Blocked', 'status-bad');
      updateSystemMessage(buildPermissionError(err), 'bad');
      els.permissionHelp.hidden = false;
    }
  }

  async function startSession() {
    if (state.running) return;
    const selectedDeviceId = els.audioDeviceSelect.value;
    if (!selectedDeviceId) {
      updateSystemMessage('Select an audio input device first, then start the session.', 'warn');
      return;
    }
    if (!SpeechRecognitionClass) {
      updateSystemMessage('Speech recognition is not available here. Use Chrome or Edge to start a session.', 'bad');
      els.startBtn.disabled = true;
      return;
    }

    savePreferences();
    els.startBtn.disabled = true;
    els.stopBtn.disabled = true;
    setStatus('Starting…');
    setRecognitionStatus('Starting…');
    els.liveBox.textContent = 'Starting session…';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: selectedDeviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000
        }
      });

      state.stream = stream;
      state.sessionStartedAt = Date.now();
      state.sessionEndedAt = null;
      state.lastFinalCommitAt = state.sessionStartedAt;
      state.currentSessionId = crypto.randomUUID();
      state.running = true;
      state.stopRequested = false;

      await startAudioRecorder(stream);
      await startMeter(stream);
      startRecognition();

      startAutosaveTimer();
      autosaveSessionDraft();
      setStatus('Running');
      els.stopBtn.disabled = false;
      els.liveBox.textContent = 'Listening…';
      updateSystemMessage('Session started. NeutralNote is capturing bite audio from the selected input and running live transcription through the browser speech engine.', 'ok');
    } catch (err) {
      console.error(err);
      teardownRecognition();
      teardownStreamAndAudio();
      resetSessionStateForFailure();
      const message = err && err.message ? err.message : 'Could not start session.';
      updateSystemMessage(`Could not start session: ${message}`, 'bad');
      els.permissionHelp.hidden = false;
    }
  }

  function stopSession() {
    if (!state.running) return;
    state.running = false;
    state.stopRequested = true;
    state.sessionEndedAt = Date.now();
    setStatus('Stopped');
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;

    if (state.pendingInterim.trim()) {
      addBite(state.pendingInterim.trim(), state.lastFinalCommitAt || state.sessionStartedAt || Date.now(), Date.now(), 'Unassigned');
      state.pendingInterim = '';
    }

    stopAutosaveTimer();
    teardownRecognition();
    teardownStreamAndAudio();
    autosaveSessionDraft();

    els.liveBox.textContent = 'Session stopped.';
    updateSystemMessage('Session stopped cleanly. You can export the JSON or start a new session.', 'ok');
  }

  function clearSession() {
    stopSession();
    revokeAllBiteUrls();
    state.bites = [];
    state.pcmChunks = [];
    state.pcmSampleRate = 0;
    state.pcmChannelCount = 1;
    state.pcmTotalSamples = 0;
    state.pendingInterim = '';
    state.sessionStartedAt = null;
    state.sessionEndedAt = null;
    state.currentSessionId = null;
    els.liveBox.textContent = 'Awaiting session start…';
    renderBites();
    setStatus('Idle');
    setRecognitionStatus('Not started');
    updateSystemMessage('Session data cleared. Saved topic and speaker fields were kept for convenience.', 'warn');
    clearAutosaveStorage();
  }

  async function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function exportSession() {
    const folderName = (els.topicTitle.value || 'neutralnote_session').trim().replace(/[^a-z0-9_-]+/gi, '_');
    const metadata = {
      topicTitle: els.topicTitle.value.trim(),
      speakersPresent: els.speakersPresent.value.trim(),
      exportedAt: new Date().toISOString(),
      sessionStartedAt: state.sessionStartedAt ? new Date(state.sessionStartedAt).toISOString() : null,
      sessionEndedAt: state.sessionEndedAt ? new Date(state.sessionEndedAt).toISOString() : null,
      biteCount: state.bites.length,
      browser: getBrowserInfo().name,
      sessions: [],
      bites: []
    };

    const sessionsMap = new Map();
    state.bites.forEach((bite) => {
      const key = bite.sessionId || `legacy_${bite.sessionStartedAt || bite.startAt}`;
      const existing = sessionsMap.get(key) || {
        sessionId: bite.sessionId || null,
        sessionStartedAtISO: bite.sessionStartedAt ? new Date(bite.sessionStartedAt).toISOString() : new Date(bite.startAt).toISOString(),
        firstBiteStartAtISO: new Date(bite.startAt).toISOString(),
        lastBiteEndAtISO: new Date(bite.endAt).toISOString(),
        biteCount: 0
      };
      existing.firstBiteStartAtISO = new Date(Math.min(new Date(existing.firstBiteStartAtISO).getTime(), bite.startAt)).toISOString();
      existing.lastBiteEndAtISO = new Date(Math.max(new Date(existing.lastBiteEndAtISO).getTime(), bite.endAt)).toISOString();
      existing.biteCount += 1;
      sessionsMap.set(key, existing);
    });
    metadata.sessions = Array.from(sessionsMap.values()).sort((a, b) => new Date(a.firstBiteStartAtISO) - new Date(b.firstBiteStartAtISO));

    for (let i = 0; i < state.bites.length; i++) {
      const bite = state.bites[i];
      metadata.bites.push({
        index: i + 1,
        speaker: bite.speaker,
        text: bite.text,
        startAtISO: new Date(bite.startAt).toISOString(),
        endAtISO: new Date(bite.endAt).toISOString(),
        sessionId: bite.sessionId || null,
        sessionStartedAtISO: bite.sessionStartedAt ? new Date(bite.sessionStartedAt).toISOString() : null,
        sessionRangeStart: formatClock(bite.startAt - ((bite.sessionStartedAt || bite.startAt))),
        sessionRangeEnd: formatClock(bite.endAt - ((bite.sessionStartedAt || bite.startAt))),
        audioMimeType: bite.audioBlob ? bite.audioBlob.type : null,
        audioFileName: bite.audioBlob ? `bite_${String(i + 1).padStart(3, '0')}_${formatClock(bite.startAt - ((bite.sessionStartedAt || bite.startAt))).replace(/:/g, '-')}.wav` : null
      });
    }

    const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folderName || 'neutralnote_session'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    updateSystemMessage(`Exported ${metadata.biteCount} bite${metadata.biteCount === 1 ? '' : 's'} to a lightweight JSON manifest without embedding audio blobs.`, 'ok');
  }

  function setCaptureMinimized(minimized) {
    els.controlsPanel.classList.toggle('minimized', minimized);
    els.toggleCaptureBtn.textContent = minimized ? 'Expand' : 'Minimize';
    els.toggleCaptureBtn.setAttribute('aria-expanded', minimized ? 'false' : 'true');
  }

  function openAbout() {
    els.aboutModal.hidden = false;
  }

  function closeAbout() {
    els.aboutModal.hidden = true;
  }


  function attachPersistence() {
    ['input', 'change'].forEach(eventName => {
      els.topicTitle.addEventListener(eventName, () => { savePreferences(); autosaveSessionDraft(); });
      els.speakersPresent.addEventListener(eventName, () => { savePreferences(); autosaveSessionDraft(); });
      els.languageSelect.addEventListener(eventName, () => { savePreferences(); autosaveSessionDraft(); });
      els.audioDeviceSelect.addEventListener(eventName, () => {
        state.preferredDeviceId = els.audioDeviceSelect.value;
        savePreferences();
        autosaveSessionDraft();
      });
    });
  }

  els.toggleCaptureBtn.addEventListener('click', () => {
    const minimized = !els.controlsPanel.classList.contains('minimized');
    setCaptureMinimized(minimized);
  });
  els.aboutBtn.addEventListener('click', openAbout);
  els.closeAboutBtn.addEventListener('click', closeAbout);
  els.aboutBackdrop.addEventListener('click', closeAbout);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.aboutModal.hidden) closeAbout();
  });

  els.refreshDevicesBtn.addEventListener('click', loadDevices);
  els.runSystemCheckBtn.addEventListener('click', runSystemCheck);
  els.startBtn.addEventListener('click', startSession);
  els.stopBtn.addEventListener('click', stopSession);
  els.exportBtn.addEventListener('click', exportSession);
  els.clearBtn.addEventListener('click', () => {
    if (confirm('Clear the current session and all stored bites?')) clearSession();
  });

  window.addEventListener('beforeunload', () => {
    try { safeLocalStorageSet(SESSION_DRAFT_KEY, JSON.stringify({
      topicTitle: els.topicTitle.value.trim(),
      speakersPresent: els.speakersPresent.value.trim(),
      language: els.languageSelect.value,
      preferredDeviceId: els.audioDeviceSelect.value || state.preferredDeviceId || '',
      running: state.running,
      sessionStartedAt: state.sessionStartedAt,
      sessionEndedAt: Date.now(),
      currentSessionId: state.currentSessionId,
      pendingInterim: state.pendingInterim,
      lastFinalCommitAt: state.lastFinalCommitAt,
      biteCount: state.bites.length,
      lastAutosaveAt: Date.now(),
      bites: state.bites.map(sanitizeBiteForStorage)
    })); } catch (err) {}
    stopSession();
    revokeAllBiteUrls();
  });

  loadPreferences();
  attachPersistence();
  setCaptureMinimized(false);
  restoreSessionDraft().finally(() => {
    renderBites();
    runSystemCheck();
  });
})();
