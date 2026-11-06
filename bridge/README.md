# drum-bridge

The native macOS bridge reads the built-in AppleSPUHIDDevice accelerometer
(~800 Hz) and serves the browser client at `http://localhost:8787`
(loopback only).

```sh
cd bridge
swift build -c release
.build/release/drum-bridge --web ../web
```

On an M5 MacBook running macOS 26.5 the device opened without `sudo`. If you see a
"Could not open AppleSPUHIDDevice" error, retry with `sudo`.

To inspect raw samples without starting the web server:

```sh
.build/release/drum-bridge --dump
```

The default web directory is `web` relative to the process working directory;
use `--web <directory>` to select another location.
