"""Left/right separability using the gyroscope (recording made with tools/record.mjs).
Usage: python3 tools/analyze_gyro.py recording.json
"""
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import analyze as A  # noqa: E402


def gyro_window(gt, g, t0, a, b):
    """Bias-removed gyro samples in [t0+a, t0+b)."""
    pre = g[(gt >= t0 - 0.2) & (gt < t0 - 0.01)]
    bias = np.median(pre, axis=0) if len(pre) else 0
    return g[(gt >= t0 + a) & (gt < t0 + b)] - bias


def main(path):
    d = json.load(open(path))
    s, ph = A.load(path)
    gy = np.array(d["gyro"], dtype=float)
    gt, g = gy[:, 0], gy[:, 1:]
    t = s[:, 0]
    dyn = A.dynamic(s)
    hits, mag = A.detect(t, dyn)
    hits = np.array([i for i in hits if i + 40 < len(t)])
    sel = lambda lab: hits[A.in_phase(t, ph, lab)[hits]]
    L, R, Al = sel("left"), sel("right"), sel("alternate")
    idx = np.concatenate([L, R, Al])
    y = np.concatenate([[0] * len(L), [1] * len(R), np.arange(len(Al)) % 2])
    print(f"gyro rate={(len(gt) - 1) / (gt[-1] - gt[0]):.0f}Hz hits L={len(L)} R={len(R)} alt={len(Al)}")
    print(f"gyro idle std per axis={g[(gt > ph['idle'][0]) & (gt < ph['idle'][1])].std(0).round(3)}")

    windows = {"0-10ms": (0, 0.01), "0-20ms": (0, 0.02), "0-40ms": (0, 0.04), "-5-15ms": (-0.005, 0.015)}
    feats = {}
    for name, (a, b) in windows.items():
        feats[f"int {name}"] = np.array([gyro_window(gt, g, t[i], a, b).sum(0) / 800 for i in idx])
    feats["peak|.| 0-20ms signed"] = np.array([
        (lambda w: w[np.abs(w).argmax(0), range(3)])(gyro_window(gt, g, t[i], 0, 0.02)) for i in idx])

    print("\n== single-axis sign rule (no calibration): best threshold accuracy ==")
    for name, F in feats.items():
        for ax in range(3):
            v = F[:, ax]
            best = max(((v > th) == y).mean() for th in np.unique(v))
            best = max(best, max(((v < th) == y).mean() for th in np.unique(v)))
            ml, mr = np.median(v[y == 0]), np.median(v[y == 1])
            print(f"{name:24s} axis {'xyz'[ax]}  acc={best:.0%}  median L={ml:+.4f} R={mr:+.4f}")

    print("\n== LDA with 10 calibration taps per side (30 random splits) ==")
    acc_feat = np.array([A.unit(dyn[i - 1:i + 6].ravel()) for i in idx])
    rng = np.random.default_rng(0)
    for name, F in list(feats.items()) + [("accel only", None), ("accel + int 0-20ms", "combo")]:
        if F is None:
            X = acc_feat
        elif isinstance(F, str):
            G = feats["int 0-20ms"]
            X = np.hstack([acc_feat, G / (np.abs(G).mean() + 1e-9) * 0.3])
        else:
            X = F
        accs = []
        for _ in range(30):
            li = rng.permutation(np.where(y[:len(L)] == 0)[0])
            ri = rng.permutation(np.arange(len(L), len(L) + len(R)))
            tr = np.concatenate([li[:10], ri[:10]])
            te = np.setdiff1d(np.arange(len(idx)), tr)
            mu = [X[tr][y[tr] == c].mean(0) for c in (0, 1)]
            C = np.vstack([X[tr][y[tr] == c] - mu[c] for c in (0, 1)])
            S = C.T @ C / (len(C) - 2)
            S = 0.9 * S + 0.1 * np.trace(S) / len(S) * np.eye(len(S))
            Si = np.linalg.inv(S)
            pred = np.array([np.argmin([(x - m) @ Si @ (x - m) for m in mu]) for x in X[te]])
            accs.append((pred == y[te]).mean())
        print(f"{name:24s} acc={np.mean(accs):.1%} (min {np.min(accs):.0%})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "recording.json")
