"""Grid-search the decaying retrigger mask on recordings.
Usage: python3 tools/retrigger.py recording.json recording2.json
"""
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import analyze as A  # noqa: E402


def detect_masked(t, mag, thr, refr, k, tau, peak_win=0.03):
    """Hit when mag exceeds max(thr, k * lastPeak * exp(-(t - tHit)/tau)) outside the refractory time."""
    hits, t_hit, peak = [], -1e9, 0.0
    for i in range(len(t)):
        dt = t[i] - t_hit
        if dt < peak_win:
            peak = max(peak, mag[i])
        if dt < refr:
            continue
        if mag[i] > max(thr, k * peak * np.exp(-dt / tau)):
            hits.append(i)
            t_hit, peak = t[i], mag[i]
    return np.array(hits)


def main(paths):
    data = []
    for p in paths:
        s, ph = A.load(p)
        t = s[:, 0]
        data.append((p, t, np.linalg.norm(A.dynamic(s), axis=1), ph))
    print("params -> per file: taps detected per phase (short = interval<250ms)")
    for refr, k, tau in [(0.09, 0, 1), (0.12, 0, 1), (0.09, 0.6, 0.08), (0.09, 0.8, 0.1), (0.09, 1.0, 0.1), (0.07, 1.0, 0.12), (0.09, 1.2, 0.1), (0.06, 1.5, 0.08)]:
        row = []
        for p, t, mag, ph in data:
            h = detect_masked(t, mag, A.THRESHOLD, refr, k, tau)
            for lab in ("left", "right", "alternate"):
                hh = h[A.in_phase(t, ph, lab)[h]]
                iv = np.diff(t[hh])
                row.append(f"{lab[0]}={len(hh)}/{int((iv < 0.25).sum())}")
        print(f"refr={refr * 1000:.0f}ms k={k} tau={tau * 1000:.0f}ms | " + "  ".join(row))


if __name__ == "__main__":
    main(sys.argv[1:])
