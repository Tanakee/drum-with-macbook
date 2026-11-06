// Records labelled raw accelerometer data from a running drum-bridge, with spoken cues.
// Usage: node tools/record.mjs [out.json]
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'recording.json';
const kickWav = new URL('./kick.wav', import.meta.url).pathname;

const PHASES = [
  { label: 'idle', sec: 5, say: '何も触らないでください' },
  { label: 'left', sec: 25, say: '左のパームレストを、1秒に1回くらい叩いてください。叩く位置や強さを少しずつ変えて' },
  { label: 'right', sec: 25, say: '右のパームレストを、同じように叩いてください' },
  { label: 'alternate', sec: 24, say: '左、右、左、右と、ゆっくり交互に叩いてください。左から' },
];

function writeKickWav(path) {
  const rate = 44100, beat = 0.5, n = Math.round(rate * beat);
  const one = new Int16Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 42 + 118 * Math.exp(-t / 0.04);
    phase += (2 * Math.PI * f) / rate;
    one[i] = Math.round(Math.sin(phase) * Math.exp(-t / 0.12) * 32000);
  }
  const data = Buffer.alloc(n * 2 * 12);
  for (let k = 0; k < 12; k++) for (let i = 0; i < n; i++) data.writeInt16LE(one[i], (k * n + i) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const samples = [];
const gyro = [];
const marks = [];
const ws = new WebSocket('ws://localhost:8787/ws');
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === 'accel') samples.push(...m.samples);
  if (m.type === 'gyro') gyro.push(...m.samples);
  if (m.type === 'error') console.error('bridge error:', m.message);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('drum-bridge が起動していません')); });
writeKickWav(kickWav);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastT = () => (samples.length ? samples[samples.length - 1][0] : 0);

for (const p of PHASES) {
  console.log(`>> ${p.label}: ${p.say}`);
  execFileSync('say', ['-v', 'Kyoko', p.say]); // blocks; cue audio stays outside the phase
  await sleep(300);
  marks.push([lastT(), 'start', p.label]);
  if (p.play) spawn('afplay', [kickWav]);
  await sleep(p.sec * 1000);
  marks.push([lastT(), 'end', p.label]);
  execFileSync('afplay', ['/System/Library/Sounds/Tink.aiff']);
}
execFileSync('say', ['-v', 'Kyoko', '終わりです']);
ws.close();
writeFileSync(out, JSON.stringify({ samples, gyro, marks }));
console.log(`saved ${samples.length} accel / ${gyro.length} gyro samples to ${out}`);
