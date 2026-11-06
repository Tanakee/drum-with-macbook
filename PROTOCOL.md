# Bridge ⇄ Web protocol

The native bridge (`bridge/`, Swift) reads the MacBook's built-in accelerometer
(IOKit HID, `AppleSPUHIDDevice`, usage page `0xFF00`, usage `3`) and serves:

- `GET /…` on `http://localhost:8787` — static files from `web/`
- `ws://localhost:8787/ws` — sensor stream

## Messages (server → client, JSON text frames)

```json
{"type":"hello","device":"AppleSPUHIDDevice","rateHz":800}
{"type":"accel","samples":[[t, x, y, z], ...]}
{"type":"gyro","samples":[[t, x, y, z], ...]}
{"type":"error","message":"..."}
```

- `t`: seconds (double, monotonic clock, same clock for accel and gyro)
- `accel` `x, y, z`: acceleration in g (double). Device usage `3`.
- `gyro` `x, y, z`: angular rate, raw Int32 / 65536 (appears to be deg/s; ~800 Hz). Device usage `9`, same 22-byte report layout as the accelerometer.
- Samples are batched; one `accel` and one `gyro` message roughly every 10 ms (a type is omitted when it has no new samples).

Hit detection and left/right classification are done in the browser so they can be tuned without rebuilding the bridge.
