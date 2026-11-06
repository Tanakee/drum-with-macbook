"""Offline analysis of a recording made with tools/record.mjs.

Replays the browser detector, reports false triggers per phase, and compares
left/right classification for several feature variants.
Usage: python3 tools/analyze.py recording.json
"""
import json
import sys

import numpy as np

THRESHOLD = 0.02
REFRACTORY = 0.09
GRAVITY_TAU = 0.05


def load(path):
    d = json.load(open(path))
    s = np.array(d["samples"], dtype=float)
    phases = {}
    for t, kind, label in d["marks"]:
        phases.setdefault(label, [0, 0])[0 if kind == "start" else 1] = t
    return s, phases


def dynamic(s):
    """Gravity-removed signal, same filter as web/app.js (not frozen during hits)."""
    t, xyz = s[:, 0], s[:, 1:]
    lp = xyz[0].copy()
    out = np.zeros_like(xyz)
    for i in range(len(t)):
        d = xyz[i] - lp
        out[i] = d
        dt = max(1e-5, t[i] - t[i - 1]) if i else 1e-3
        lp += (1 - np.exp(-dt / GRAVITY_TAU)) * d
    return out


def detect(t, dyn, thr=THRESHOLD, refr=REFRACTORY):
    mag = np.linalg.norm(dyn, axis=1)
    hits, last = [], -1e9
    for i in range(1, len(t)):
        if mag[i] > thr and t[i] - last > refr:
            hits.append(i)
            last = t[i]
    return hits, mag


def in_phase(t, phases, label, margin=0.0):
    a, b = phases[label]
    return (t >= a + margin) & (t < b)


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n else v


FEATURES = {
    # current app: prev sample + ~6 samples after onset, flattened & normalised
    "current(8ms wave)": lambda d, i: unit(d[i - 1:i + 6].ravel()),
    "wave 20ms": lambda d, i: unit(d[i - 1:i + 16].ravel()),
    "wave 40ms": lambda d, i: unit(d[i - 1:i + 32].ravel()),
    "peak dir (10ms)": lambda d, i: unit(d[i + np.argmax(np.linalg.norm(d[i:i + 8], axis=1))]),
    "mean 0-10ms dir": lambda d, i: unit(d[i:i + 8].mean(0)),
    "mean 10-40ms dir": lambda d, i: unit(d[i + 8:i + 32].mean(0)),
    "abs-sum per axis 20ms": lambda d, i: unit(np.abs(d[i:i + 16]).sum(0)),
}


def knn(train_x, train_y, x, k=3):
    sims = train_x @ x
    idx = np.argsort(-sims)[:k]
    return np.bincount(train_y[idx], minlength=2).argmax()


def centroid(train_x, train_y, x):
    c = [unit(train_x[train_y == c].mean(0)) for c in (0, 1)]
    return int(np.argmax([ci @ x for ci in c]))


def main(path):
    s, phases = load(path)
    t = s[:, 0]
    rate = (len(t) - 1) / (t[-1] - t[0])
    dyn = dynamic(s)
    hits, mag = detect(t, dyn)
    hits = np.array([i for i in hits if i + 40 < len(t)])
    print(f"samples={len(t)} rate={rate:.0f}Hz phases={list(phases)}")

    print("\n== noise floor / triggers per phase (threshold %.3f g) ==" % THRESHOLD)
    for label in phases:
        m = in_phase(t, phases, label)
        n = int(m[hits].sum())
        dur = phases[label][1] - phases[label][0]
        print(f"{label:10s} triggers={n:3d} ({n / dur:4.1f}/s)  p50={np.percentile(mag[m], 50):.4f}"
              f" p99={np.percentile(mag[m], 99):.4f} max={mag[m].max():.4f}")
        if label in ("typing", "trackpad", "speaker", "idle") and n:
            peaks = sorted(mag[hits[m[hits]]].round(4))[-8:]
            print(f"{'':10s} top hit mags: {peaks}")

    for label in ("left", "right"):
        hm = hits[in_phase(t, phases, label)[hits]]
        pk = [mag[i:i + 8].max() for i in hm]
        print(f"{label} tap peak mags: min={min(pk):.4f} p10={np.percentile(pk, 10):.4f} median={np.median(pk):.4f}")

    # Ground truth hits: left phase -> 0, right phase -> 1, alternate -> alternating from left
    L = hits[in_phase(t, phases, "left")[hits]]
    R = hits[in_phase(t, phases, "right")[hits]]
    A = hits[in_phase(t, phases, "alternate")[hits]] if "alternate" in phases else np.array([], int)
    A_y = np.arange(len(A)) % 2
    print(f"\nhits: left={len(L)} right={len(R)} alternate={len(A)}")

    print("\n== classification (train: first 8 of each side, test: rest + alternate) ==")
    for name, f in FEATURES.items():
        X = lambda idx: np.array([f(dyn, i) for i in idx])
        tr_x = np.vstack([X(L[:8]), X(R[:8])])
        tr_y = np.array([0] * 8 + [1] * 8)
        te_x = np.vstack([X(L[8:]), X(R[8:])])
        te_y = np.array([0] * len(L[8:]) + [1] * len(R[8:]))
        for cname, clf in (("knn3", knn), ("centroid", centroid)):
            pred = np.array([clf(tr_x, tr_y, x) for x in te_x])
            acc = (pred == te_y).mean()
            alt = ""
            if len(A):
                pa = np.array([clf(tr_x, tr_y, f(dyn, i)) for i in A])
                alt = f"  alternate={(pa == A_y).mean():.0%} ({''.join('LR'[p] for p in pa)})"
            print(f"{name:24s} {cname:8s} test={acc:.0%}{alt}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "recording.json")
