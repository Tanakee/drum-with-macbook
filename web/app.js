'use strict';

// ---------- settings ----------
const STORE_KEY = 'macbook-drum-v2'; // v2: accel+gyro features (v1 calibration is incompatible)
const OLD_STORE_KEY = 'macbook-drum-v1';
const CAL_SAMPLES = 40;    // hits recorded per pad during calibration
const CAL_APPEND = 20;     // extra hits per "追加" press, e.g. for a spot that is misread
const NOISE_SECONDS = 10;  // duration of typing/trackpad noise recording
const NOISE_MAX = 80;
const INPUT_GUARD_MS = 200; // ignore vibrations this soon after a key/trackpad event
const NOISE = -1;          // class id for rejected (non-tap) vibrations
const ACC_N = 10;          // accel samples after onset in the feature (~12 ms at 800 Hz)
const GYRO_N = 10;         // gyro samples after onset in the feature
const GYRO_SCALE = 40;     // brings gyro (deg/s) to roughly the accel feature's range
const FEAT_DIM = (ACC_N + 1) * 3 + GYRO_N * 3;
const GRAVITY_TAU = 0.05;  // seconds; low-pass time constant for gravity removal
const COV_SHRINK = 0.1;    // covariance shrinkage for the whitening
const KNN_K = 5;
const MASK_TAU = 0.1;      // seconds; decay of the retrigger mask
const PEAK_WINDOW = 0.03;  // seconds after onset over which the hit peak is tracked

const PADS = [
  { name: '左パームレスト', key: 'a', sound: 'kick' },
  { name: '右パームレスト', key: 'l', sound: 'snare' },
  { name: '手前の縁', key: ' ', sound: 'hihat' },
];

const state = {
  threshold: 0.02,
  refractory: 90, // ms
  mask: 1.2,       // retrigger mask strength (x last hit peak)
  sounds: PADS.map(p => p.sound),
  cal: PADS.map(() => []), // per pad: array of feature vectors
  noise: [],               // feature vectors of typing/trackpad vibrations
};

function load() {
  try {
    let saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    // Keep settings from v1 but drop its calibration, whose feature layout no longer matches.
    if (!saved) saved = { ...JSON.parse(localStorage.getItem(OLD_STORE_KEY) || 'null'), cal: null, noise: null };
    if (typeof saved.threshold === 'number') state.threshold = saved.threshold;
    if (typeof saved.refractory === 'number') state.refractory = saved.refractory;
    if (typeof saved.mask === 'number') state.mask = saved.mask;
    if (Array.isArray(saved.sounds)) saved.sounds.forEach((s, i) => { if (i < PADS.length) state.sounds[i] = s; });
    if (Array.isArray(saved.cal)) saved.cal.forEach((c, i) => { if (i < PADS.length && Array.isArray(c)) state.cal[i] = c.filter(x => x.length === FEAT_DIM); });
    if (Array.isArray(saved.noise)) state.noise = saved.noise.filter(x => x.length === FEAT_DIM);
  } catch (_) { /* storage unavailable */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
}

// ---------- audio ----------
let ctx = null;
let noiseBuf = null;
let master = null;

function initAudio() {
  if (ctx) return ctx.resume();
  ctx = new AudioContext({ latencyHint: 'interactive' });
  master = ctx.createDynamicsCompressor();
  master.threshold.value = -10;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx.resume();
}

function env(gain, t, peak, decay, attack = 0.001) {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function noise(t, dur) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur);
  return src;
}
function tone(type, t, f0, f1, sweep, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  o.start(t);
  o.stop(t + dur);
  return o;
}
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  nodes[nodes.length - 1].connect(master);
}
function filter(type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  return f;
}

const SOUNDS = {
  kick: { label: 'キック', play(t, v) {
    const g = ctx.createGain(); env(g, t, v, 0.45);
    chain(tone('sine', t, 160, 42, 0.12, 0.5), g);
    const cg = ctx.createGain(); env(cg, t, v * 0.4, 0.02);
    chain(noise(t, 0.03), filter('lowpass', 3000), cg);
  } },
  snare: { label: 'スネア', play(t, v) {
    const g = ctx.createGain(); env(g, t, v * 0.8, 0.2);
    chain(noise(t, 0.25), filter('highpass', 1200), g);
    const b = ctx.createGain(); env(b, t, v * 0.6, 0.1);
    chain(tone('triangle', t, 220, 160, 0.08, 0.15), b);
  } },
  hihat: { label: 'ハイハット', play(t, v) {
    const g = ctx.createGain(); env(g, t, v * 0.5, 0.05);
    chain(noise(t, 0.08), filter('highpass', 7500), g);
  } },
  openhat: { label: 'オープンハット', play(t, v) {
    const g = ctx.createGain(); env(g, t, v * 0.45, 0.35);
    chain(noise(t, 0.4), filter('highpass', 7000), g);
  } },
  tom: { label: 'タム', play(t, v) {
    const g = ctx.createGain(); env(g, t, v * 0.9, 0.35);
    chain(tone('sine', t, 220, 95, 0.25, 0.4), g);
  } },
  floortom: { label: 'フロアタム', play(t, v) {
    const g = ctx.createGain(); env(g, t, v, 0.5);
    chain(tone('sine', t, 130, 65, 0.35, 0.55), g);
  } },
  clap: { label: 'クラップ', play(t, v) {
    [0, 0.012, 0.024].forEach((dt, i) => {
      const g = ctx.createGain(); env(g, t + dt, v * 0.7, i === 2 ? 0.15 : 0.02);
      chain(noise(t + dt, 0.2), filter('bandpass', 1400, 1.2), g);
    });
  } },
  crash: { label: 'クラッシュ', play(t, v) {
    const g = ctx.createGain(); env(g, t, v * 0.45, 1.3);
    chain(noise(t, 1.4), filter('highpass', 4000), g);
  } },
  cowbell: { label: 'カウベル', play(t, v) {
    const g = ctx.createGain(); env(g, t, v * 0.35, 0.3);
    const bp = filter('bandpass', 700, 2);
    tone('square', t, 540, 0, 0, 0.35).connect(bp);
    tone('square', t, 800, 0, 0, 0.35).connect(bp);
    chain(bp, g);
  } },
};

// ---------- hit handling ----------
const zones = [...document.querySelectorAll('.pad-zone')];

function trigger(pad, velocity) {
  if (ctx && ctx.state === 'running') {
    const v = 0.2 + 0.8 * Math.min(1, Math.max(0, velocity));
    SOUNDS[state.sounds[pad]].play(ctx.currentTime, v);
  }
  const z = zones.find(el => Number(el.dataset.pad) === pad);
  if (z) {
    z.classList.remove('hit');
    void z.offsetWidth;
    z.classList.add('hit');
    clearTimeout(z._t);
    z._t = setTimeout(() => z.classList.remove('hit'), 90);
  }
}

// ---------- classification ----------
// Each side produces several distinct vibration patterns depending on where exactly it is
// tapped, so a single-mean model (LDA) underfits. kNN in a whitened space (pooled
// within-class covariance) handles that: on a recording with varied tap positions it reached
// ~97% left/right with 40 calibration taps per side, vs ~85% for LDA with 10.

function calibratedPads() {
  return state.cal.map((c, i) => (c.length >= 2 ? i : -1)).filter(i => i >= 0);
}

function invert(m) {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c] || 1e-12;
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c || !a[r][c]) continue;
      const f = a[r][c];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map(row => row.slice(n));
}

// Lower-triangular L with m = L L^T.
function cholesky(m) {
  const n = m.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
  }
  return L;
}

let model = null; // rebuilt lazily whenever calibration data changes
function invalidateModel() { model = null; }

function buildModel() {
  const classes = calibratedPads().map(i => ({ id: i, xs: state.cal[i] }));
  if (classes.length < 2) return null;
  if (state.noise.length >= 3) classes.push({ id: NOISE, xs: state.noise });
  const dim = FEAT_DIM;
  for (const c of classes) c.xs = c.xs.filter(x => x.length === dim);

  const S = Array.from({ length: dim }, () => new Array(dim).fill(0));
  let n = 0;
  for (const c of classes) {
    const mu = new Array(dim).fill(0);
    for (const x of c.xs) for (let i = 0; i < dim; i++) mu[i] += x[i] / c.xs.length;
    for (const x of c.xs) {
      for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) S[i][j] += (x[i] - mu[i]) * (x[j] - mu[j]);
      n++;
    }
  }
  const denom = Math.max(1, n - classes.length);
  let trace = 0;
  for (let i = 0; i < dim; i++) trace += S[i][i] / denom;
  for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) {
    S[i][j] = (1 - COV_SHRINK) * S[i][j] / denom + (i === j ? COV_SHRINK * trace / dim : 0);
  }
  // Mahalanobis distance = |L^T x|^2 where S^-1 = L L^T, so whiten every training vector once.
  const L = cholesky(invert(S));
  const whiten = x => {
    const z = new Array(dim).fill(0);
    for (let j = 0; j < dim; j++) {
      let s = 0;
      for (let i = j; i < dim; i++) s += L[i][j] * x[i];
      z[j] = s;
    }
    return z;
  };
  const train = [];
  for (const c of classes) for (const x of c.xs) train.push({ id: c.id, z: whiten(x) });
  return { whiten, train };
}

function classify(feat) {
  if (!model) model = buildModel();
  if (!model) {
    // Uncalibrated guess: the chassis rocks towards the tapped side, which shows up as
    // the x component flipping sign between the start and end of the impulse.
    let early = 0, late = 0;
    for (let i = 0; i < 6; i++) (i < 3 ? (early += feat[i * 3]) : (late += feat[i * 3]));
    return late - early < 0 ? 0 : 1;
  }
  const z = model.whiten(feat);
  const near = model.train.map(t => {
    let d = 0;
    for (let i = 0; i < z.length; i++) d += (t.z[i] - z[i]) ** 2;
    return [d, t.id];
  }).sort((a, b) => a[0] - b[0]).slice(0, KNN_K);
  const votes = new Map();
  for (const [, id] of near) votes.set(id, (votes.get(id) || 0) + 1);
  const top = Math.max(...votes.values());
  return near.find(([, id]) => votes.get(id) === top)[1]; // ties go to the nearest
}

let recordingPad = -1;
let recordTarget = CAL_SAMPLES; // stop recording once the pad has this many samples
let recordingNoiseUntil = 0;
let rejected = 0;
let lastInputAt = -Infinity;

function onHit(feat, peak, marker) {
  const velocity = Math.log(peak / state.threshold) / Math.log(15);
  if (performance.now() < recordingNoiseUntil) {
    if (state.noise.length < NOISE_MAX) state.noise.push(feat);
    marker.noise = true;
    renderPads();
    return;
  }
  if (recordingPad >= 0) {
    const p = recordingPad;
    state.cal[p].push(feat);
    trigger(p, velocity);
    if (state.cal[p].length >= recordTarget) {
      recordingPad = -1;
      save();
    }
    invalidateModel();
    renderPads();
    return;
  }
  // Typing and trackpad use are known directly from input events, so gate on them
  // instead of relying on the classifier; also stay silent while the page is in the background.
  if (!document.hasFocus() || performance.now() - lastInputAt < INPUT_GUARD_MS) {
    marker.noise = true;
    rejectedEl.textContent = ++rejected;
    return;
  }
  const pad = classify(feat);
  if (pad === NOISE) {
    marker.noise = true;
    rejectedEl.textContent = ++rejected;
    return;
  }
  trigger(pad, velocity);
}

// ---------- detector ----------
const SCOPE_LEN = 1600;
const scope = new Float32Array(SCOPE_LEN);
let scopeHead = 0;
let sampleCount = 0;
const scopeHits = []; // { n: sampleCount at the hit, noise: rejected as non-tap }

const det = {
  lp: null, lastT: 0, lastHit: -1, hitPeak: 0, capture: null, prev: [0, 0, 0],
  rateHz: 800, rateCount: 0, rateT0: 0, peakSeen: 0,
};

const GYRO_BUF = 400;
const gyroBuf = []; // recent [t, x, y, z]
let lastGyroT = -Infinity;

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}

function processGyro(t, x, y, z) {
  gyroBuf.push([t, x, y, z]);
  if (gyroBuf.length > GYRO_BUF) gyroBuf.shift();
  lastGyroT = t;
}

// Feature = unit-normalised accel waveform (prev + ACC_N samples) followed by the
// bias-removed gyro waveform (GYRO_N samples from the onset), scaled to a similar range.
function tryFinishCapture() {
  const c = det.capture;
  if (!c || c.samples.length < ACC_N + 1) return;
  const gyroLive = det.lastT - lastGyroT < 0.5;
  const after = gyroBuf.filter(g => g[0] >= c.t0);
  if (gyroLive && after.length < GYRO_N) return; // gyro batch for this window not here yet
  det.capture = null;

  const feat = [];
  for (const s of c.samples) feat.push(s[0], s[1], s[2]);
  const norm = Math.hypot(...feat) || 1;
  for (let i = 0; i < feat.length; i++) feat[i] /= norm;

  const before = gyroBuf.filter(g => g[0] >= c.t0 - 0.2 && g[0] < c.t0 - 0.01);
  const bias = [1, 2, 3].map(a => median(before.map(g => g[a])));
  for (let i = 0; i < GYRO_N; i++) {
    const g = gyroLive ? after[i] : null;
    for (let a = 0; a < 3; a++) feat.push(g ? (g[a + 1] - bias[a]) / GYRO_SCALE : 0);
  }
  onHit(feat, c.peak, c.marker);
}

function processSample(t, x, y, z) {
  if (!det.lp) { det.lp = [x, y, z]; det.lastT = t; det.rateT0 = t; return; }
  const dt = Math.max(1e-5, t - det.lastT);
  det.lastT = t;

  det.rateCount++;
  if (t - det.rateT0 >= 1) {
    det.rateHz = det.rateCount / (t - det.rateT0);
    det.rateCount = 0; det.rateT0 = t;
    rateEl.textContent = `${Math.round(det.rateHz)} Hz${det.lastT - lastGyroT < 0.5 ? ' + gyro' : ''}`;
  }

  const d = [x - det.lp[0], y - det.lp[1], z - det.lp[2]];
  const m = Math.hypot(d[0], d[1], d[2]);
  scope[scopeHead] = m;
  scopeHead = (scopeHead + 1) % SCOPE_LEN;
  sampleCount++;
  if (m > det.peakSeen) det.peakSeen = m;

  const since = t - det.lastHit;
  if (since < PEAK_WINDOW && m > det.hitPeak) det.hitPeak = m;

  if (det.capture) {
    if (det.capture.samples.length < ACC_N + 1) {
      det.capture.samples.push(d);
      if (m > det.capture.peak) det.capture.peak = m;
    }
    tryFinishCapture();
  } else if (since * 1000 > state.refractory && m > retriggerThreshold(since)) {
    det.lastHit = t;
    det.hitPeak = m;
    const marker = { n: sampleCount, noise: false };
    det.capture = { t0: t, samples: [det.prev, d], peak: m, marker };
    scopeHits.push(marker);
    if (scopeHits.length > 64) scopeHits.shift();
  }

  // Freeze the gravity estimate while a hit is being captured.
  if (!det.capture) {
    const a = 1 - Math.exp(-dt / GRAVITY_TAU);
    det.lp[0] += a * d[0]; det.lp[1] += a * d[1]; det.lp[2] += a * d[2];
  }
  det.prev = d;
}

// A tap keeps the chassis ringing for ~120 ms; without this mask the tail re-triggers
// right after the refractory time. The mask scales with the last hit's peak and decays.
function retriggerThreshold(since) {
  return Math.max(state.threshold, state.mask * det.hitPeak * Math.exp(-since / MASK_TAU));
}

// ---------- websocket ----------
const connEl = document.getElementById('conn');
const connText = document.getElementById('connText');
const rateEl = document.getElementById('rate');

function wsUrl() {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  return 'ws://localhost:8787/ws';
}

function connect() {
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch (_) { setTimeout(connect, 1500); return; }
  ws.onopen = () => { connEl.className = 'dot on'; connText.textContent = 'センサー接続中'; };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'accel') {
      for (const s of msg.samples) processSample(s[0], s[1], s[2], s[3]);
    } else if (msg.type === 'gyro') {
      for (const s of msg.samples) processGyro(s[0], s[1], s[2], s[3]);
      tryFinishCapture();
    } else if (msg.type === 'hello') {
      if (msg.rateHz) det.rateHz = msg.rateHz;
      connText.textContent = `センサー接続中 (${msg.device || 'accelerometer'})`;
    } else if (msg.type === 'error') {
      connText.textContent = `ブリッジエラー: ${msg.message}`;
    }
  };
  ws.onclose = () => {
    connEl.className = 'dot off';
    connText.textContent = 'ブリッジ未接続（drum-bridge を起動してください）';
    rateEl.textContent = '';
    det.lp = null; det.capture = null; gyroBuf.length = 0;
    setTimeout(connect, 1500);
  };
}

// ---------- scope drawing ----------
const canvas = document.getElementById('scope');
const g2 = canvas.getContext('2d');
const peakEl = document.getElementById('peak');
const rejectedEl = document.getElementById('rejected');

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const maxV = Math.max(state.threshold * 4, 0.02);
  const yOf = v => h - 4 - Math.min(1, v / maxV) * (h - 8);

  g2.strokeStyle = css.getPropertyValue('--accent');
  g2.setLineDash([4, 4]);
  g2.beginPath(); g2.moveTo(0, yOf(state.threshold)); g2.lineTo(w, yOf(state.threshold)); g2.stroke();
  g2.setLineDash([]);

  g2.strokeStyle = css.getPropertyValue('--fg');
  g2.lineWidth = 1;
  g2.beginPath();
  for (let i = 0; i < SCOPE_LEN; i++) {
    const v = scope[(scopeHead + i) % SCOPE_LEN];
    const px = (i / (SCOPE_LEN - 1)) * w;
    if (i === 0) g2.moveTo(px, yOf(v)); else g2.lineTo(px, yOf(v));
  }
  g2.stroke();

  for (const hit of scopeHits) {
    const age = sampleCount - hit.n;
    if (age >= SCOPE_LEN) continue;
    const px = ((SCOPE_LEN - 1 - age) / (SCOPE_LEN - 1)) * w;
    g2.fillStyle = css.getPropertyValue(hit.noise ? '--muted' : '--ok');
    g2.fillRect(px - 1, 0, 2, 8);
  }

  peakEl.textContent = det.peakSeen.toFixed(3);
  det.peakSeen *= 0.97;
  requestAnimationFrame(draw);
}

// ---------- UI ----------
const padsEl = document.getElementById('pads');
const calState = document.getElementById('calState');

function renderPads() {
  padsEl.innerHTML = '';
  PADS.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pad-row';

    const name = document.createElement('span');
    name.textContent = p.name;

    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${p.name} の音色`);
    for (const [id, s] of Object.entries(SOUNDS)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = s.label;
      if (id === state.sounds[i]) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { state.sounds[i] = sel.value; save(); renderZones(); };

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = recordingPad === i ? `${state.cal[i].length} / ${recordTarget}` : `${state.cal[i].length} 回`;

    const start = (append) => {
      initAudio();
      if (recordingPad === i) { recordingPad = -1; save(); renderPads(); return; }
      if (!append) state.cal[i] = [];
      recordingPad = i;
      recordTarget = state.cal[i].length + (append ? CAL_APPEND : CAL_SAMPLES);
      invalidateModel();
      renderPads();
    };
    const rec = document.createElement('button');
    rec.textContent = recordingPad === i ? '停止' : '記録';
    if (recordingPad === i) rec.classList.add('recording');
    rec.onclick = () => start(false);
    const add = document.createElement('button');
    add.textContent = `追加 +${CAL_APPEND}`;
    add.disabled = recordingPad === i || !state.cal[i].length;
    add.onclick = () => start(true);

    row.append(name, sel, count, rec, add);
    padsEl.appendChild(row);
  });
  padsEl.appendChild(noiseRow());
  renderZones();

  const n = calibratedPads().length;
  const noiseOn = state.noise.length >= 3;
  calState.textContent = noiseRecording()
    ? `キーボードで普通にタイピングしたり、トラックパッドを操作したりしてください（${state.noise.length} 件）`
    : recordingPad >= 0
      ? `「${PADS[recordingPad].name}」を、位置や強さを変えながら叩いてください（${state.cal[recordingPad].length}/${recordTarget}）`
      : n >= 2
        ? `学習済み：${n} 箇所${noiseOn ? ' + ノイズ除外' : '（ノイズも記録するとタイピングで鳴りにくくなります）'}。`
        : '未学習：左右は簡易推定です。左右それぞれ記録すると精度が上がります。';
}

function noiseRecording() {
  return performance.now() < recordingNoiseUntil;
}

function noiseRow() {
  const row = document.createElement('div');
  row.className = 'pad-row';
  const name = document.createElement('span');
  name.textContent = 'ノイズ（タイピング等）';
  const note = document.createElement('span');
  note.className = 'count';
  note.textContent = '鳴らさない';
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${state.noise.length} 件`;
  const rec = document.createElement('button');
  const active = noiseRecording();
  rec.textContent = active ? '記録中…' : `記録（${NOISE_SECONDS}秒）`;
  if (active) rec.classList.add('recording');
  rec.onclick = () => {
    if (noiseRecording()) { recordingNoiseUntil = 0; finishNoise(); return; }
    recordingPad = -1;
    state.noise = [];
    recordingNoiseUntil = performance.now() + NOISE_SECONDS * 1000;
    clearTimeout(noiseRow.timer);
    noiseRow.timer = setTimeout(finishNoise, NOISE_SECONDS * 1000);
    rec.blur();
    renderPads();
  };
  row.append(name, note, count, rec, document.createElement('span'));
  return row;
}

function finishNoise() {
  clearTimeout(noiseRow.timer);
  save();
  invalidateModel();
  renderPads();
}

function renderZones() {
  const n = calibratedPads().length;
  zones.forEach(z => {
    const i = Number(z.dataset.pad);
    z.querySelector('.pad-name').textContent = PADS[i].name;
    z.querySelector('.pad-sound').textContent = SOUNDS[state.sounds[i]].label;
    // The front edge can only be told apart once it has been calibrated.
    z.classList.toggle('disabled', i >= 2 && !(n >= 2 && state.cal[i].length));
  });
}

function bindSlider(id, key, fmt) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + 'Out');
  el.value = state[key];
  out.textContent = fmt(state[key]);
  el.oninput = () => { state[key] = Number(el.value); out.textContent = fmt(state[key]); save(); };
}

document.getElementById('start').onclick = async e => {
  await initAudio();
  e.target.textContent = '音声 ON';
  e.target.disabled = true;
};
document.getElementById('calReset').onclick = () => {
  state.cal = PADS.map(() => []);
  state.noise = [];
  recordingPad = -1;
  recordingNoiseUntil = 0;
  invalidateModel();
  save();
  renderPads();
};
zones.forEach(z => z.addEventListener('pointerdown', () => { initAudio(); trigger(Number(z.dataset.pad), 0.8); }));
for (const type of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'wheel']) {
  window.addEventListener(type, () => { lastInputAt = performance.now(); }, { capture: true, passive: true });
}
window.addEventListener('keydown', e => {
  if (e.repeat || noiseRecording() || e.target.closest('select, input')) return;
  const i = PADS.findIndex(p => p.key === e.key.toLowerCase());
  if (i >= 0) { e.preventDefault(); initAudio(); trigger(i, 0.8); }
});

load();
document.getElementById('calN').textContent = CAL_SAMPLES;
bindSlider('threshold', 'threshold', v => `${v.toFixed(3)} g`);
bindSlider('refractory', 'refractory', v => `${v} ms`);
bindSlider('mask', 'mask', v => `×${v.toFixed(1)}`);
renderPads();
connect();
requestAnimationFrame(draw);
