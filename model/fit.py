"""Minimal, dependency-light model fitting: ridge logistic regression (Newton-Raphson),
ridge linear regression, and the evaluation metrics the calibration report needs.

numpy only, so the GitHub Actions refresh stays fast and reproducible.
"""
from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------- logistic ---

def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 200, tol: float = 1e-8,
                 prior: np.ndarray | None = None):
    """Ridge-penalised logistic regression. X is (n, k) *standardised* features,
    y in {0,1}. The penalty is l2 * ||w - prior||² (prior = zeros by default);
    the intercept gets a tenth of the penalty so tiny samples cannot run away.
    Damped Newton-Raphson (step halving on the penalised log-loss), so it
    converges from any start. Returns (coef[k], intercept)."""
    n, k = X.shape
    Xb = np.hstack([X, np.ones((n, 1))])
    w0 = np.zeros(k + 1) if prior is None else np.asarray(prior, dtype=float)
    w = w0.copy()
    pen = np.full(k + 1, l2, dtype=float)
    pen[-1] = l2 * 0.1

    def objective(wv):
        z = Xb @ wv
        # log(1 + exp(z)) - y z, computed stably
        ll = np.sum(np.logaddexp(0.0, z) - y * z)
        return ll + 0.5 * np.sum(pen * (wv - w0) ** 2)

    f = objective(w)
    for _ in range(iters):
        z = Xb @ w
        p = _sigmoid(z)
        g = Xb.T @ (p - y) + pen * (w - w0)
        s = np.maximum(p * (1 - p), 1e-9)
        H = (Xb * s[:, None]).T @ Xb + np.diag(pen)
        try:
            step = np.linalg.solve(H, g)
        except np.linalg.LinAlgError:
            step = g / (np.diag(H) + 1e-9)
        t = 1.0
        while t > 1e-6:
            w_new = w - t * step
            f_new = objective(w_new)
            if f_new <= f:
                break
            t *= 0.5
        if t <= 1e-6:
            break
        moved = np.max(np.abs(w_new - w))
        w, f = w_new, f_new
        if moved < tol:
            break
    return w[:-1], w[-1]


def predict_logistic(coef: np.ndarray, intercept: float, X: np.ndarray) -> np.ndarray:
    return _sigmoid(X @ coef + intercept)


# ------------------------------------------------------------------ linear ---

def fit_ridge(X: np.ndarray, y: np.ndarray, l2: float = 1.0, prior: np.ndarray | None = None):
    """Ridge linear regression on standardised X, penalty l2 * ||w - prior||².
    Returns (coef, intercept)."""
    n, k = X.shape
    Xb = np.hstack([X, np.ones((n, 1))])
    w0 = np.zeros(k + 1) if prior is None else np.asarray(prior, dtype=float)
    pen = np.full(k + 1, l2, dtype=float)
    pen[-1] = l2 * 0.1
    w = np.linalg.solve(Xb.T @ Xb + np.diag(pen), Xb.T @ y + pen * w0)
    return w[:-1], w[-1]


def predict_ridge(coef: np.ndarray, intercept: float, X: np.ndarray) -> np.ndarray:
    return X @ coef + intercept


# ----------------------------------------------------------------- metrics ---

def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def log_loss(p: np.ndarray, y: np.ndarray, eps: float = 1e-9) -> float:
    p = np.clip(p, eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc(p: np.ndarray, y: np.ndarray) -> float:
    """Rank-based AUC (Mann-Whitney), ties get half credit."""
    pos = p[y == 1]
    neg = p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    gt = (pos[:, None] > neg[None, :]).sum()
    eq = (pos[:, None] == neg[None, :]).sum()
    return float((gt + 0.5 * eq) / (len(pos) * len(neg)))


def reliability(p: np.ndarray, y: np.ndarray, bins: int = 10):
    """Calibration table: for each probability bin, mean predicted vs observed rate."""
    edges = np.linspace(0, 1, bins + 1)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo) & (p <= hi)
        if m.sum() == 0:
            continue
        out.append({"lo": float(lo), "hi": float(hi), "n": int(m.sum()),
                    "pred": float(p[m].mean()), "obs": float(y[m].mean())})
    return out


def expected_calibration_error(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    rows = reliability(p, y, bins)
    n = sum(r["n"] for r in rows)
    return float(sum(r["n"] / n * abs(r["pred"] - r["obs"]) for r in rows)) if n else float("nan")


def kfold_indices(n: int, k: int = 5, seed: int = 7):
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    folds = np.array_split(idx, k)
    for i in range(k):
        test = folds[i]
        train = np.concatenate([folds[j] for j in range(k) if j != i])
        yield train, test


def cv_logistic(X: np.ndarray, y: np.ndarray, l2: float, k: int = 5, seed: int = 7,
                prior: np.ndarray | None = None) -> np.ndarray:
    """Out-of-fold probabilities, so metrics are honest rather than in-sample."""
    oof = np.zeros(len(y))
    for tr, te in kfold_indices(len(y), k, seed):
        c, b = fit_logistic(X[tr], y[tr], l2=l2, prior=prior)
        oof[te] = predict_logistic(c, b, X[te])
    return oof


def cv_ridge(X: np.ndarray, y: np.ndarray, l2: float, k: int = 5, seed: int = 7,
             prior: np.ndarray | None = None) -> np.ndarray:
    oof = np.zeros(len(y))
    for tr, te in kfold_indices(len(y), k, seed):
        c, b = fit_ridge(X[tr], y[tr], l2=l2, prior=prior)
        oof[te] = predict_ridge(c, b, X[te])
    return oof
