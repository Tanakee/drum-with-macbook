# MacBook Drum

Tap the palm rests on either side of the trackpad to play drums, using the MacBook's built-in accelerometer and gyroscope (Apple Silicon, `AppleSPUHIDDevice`).

```sh
cd bridge && swift build -c release && .build/release/drum-bridge --web ../web
open http://localhost:8787
```

1. Click "音を有効にして開始" to enable audio.
2. Adjust the threshold (around 0.02 g) so the waveform stays below the red line while idle.
3. Under "パッド & キャリブレーション", record each side by tapping it 40 times, varying the position and strength. If a spot keeps being misread, use "追加 +20" to add more samples for it.

## How it works

- `bridge/`: Swift bridge that streams the accelerometer and gyroscope (800 Hz each) over WebSocket. See `PROTOCOL.md`.
- `web/`: Browser app.
  - Hit detection uses gravity removal plus a decaying retrigger mask, so a tap's ~120 ms ringing is not counted as a second hit.
  - Position is classified by kNN on whitened accel and gyro waveforms (~12 ms after onset).
  - Hits are muted right after key or trackpad input, and while the page is unfocused.
  - Sounds are synthesized with Web Audio.
- `tools/`: Data collection and offline analysis.
  - `record.mjs` records labeled taps with spoken cues: `node tools/record.mjs out.json`.
  - `analyze.py`, `analyze_gyro.py` and `retrigger.py` evaluate detection and classification on a recording.
