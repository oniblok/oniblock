"""Shared paths, RPC helper (batching + backoff + endpoint rotation), Binance mid lookup, feature/label helpers.

Feature definitions mirror services/src/features.ts (computeFeatures) and the keeper (services/src/keeper.ts):
the keeper observes block b (pool price after b, CEX mid at b's timestamp, swaps up to b, realized vol of the
per-block mid history of up to 120 samples) and posts a score for block b+1. The label mirrors services/src/settler.ts
(SETTLER_LABEL_MID=cex): block t's arb-direction swaps are "informed" (y=1) iff their net markout vs the CEX mid at
t's timestamp (after the fee, which is inside the executed amounts) is > 0.
"""
import json, os, shutil, time, random
from pathlib import Path
import numpy as np, pandas as pd, requests

ML = Path(__file__).resolve().parents[1]
RAW = ML / "raw"
DATA = ML / "data"
MODELS = ML / "models"
REPO = ML.parent
for p in (RAW, DATA, MODELS):
    p.mkdir(parents=True, exist_ok=True)

WINDOW_BLOCKS = 20  # features.ts default windowBlocks
VOL_SAMPLES = 120   # keeper MidHistory(120)
BLOCK_SECONDS = 12


def disk_free_gb(path="/System/Volumes/Data"):
    return shutil.disk_usage(path).free / 1e9


class Rpc:
    """JSON-RPC client with batching, exponential backoff and endpoint rotation (public endpoints only)."""

    def __init__(self, urls, batch=50, timeout=60):
        self.urls = list(urls)
        self.batch = batch
        self.timeout = timeout
        self.i = 0
        self.s = requests.Session()
        self.s.headers.update({"content-type": "application/json", "user-agent": "oniblock-ml/0.1"})

    def _post(self, body):
        last = None
        for att in range(10):
            url = self.urls[self.i % len(self.urls)]
            try:
                r = self.s.post(url, data=json.dumps(body), timeout=self.timeout)
                if r.status_code in (429, 403, 502, 503, 504, 500, 520, 525):
                    raise RuntimeError(f"http {r.status_code}")
                r.raise_for_status()
                out = r.json()
                if isinstance(out, dict) and "error" in out and isinstance(body, list):
                    raise RuntimeError(str(out["error"])[:200])
                return out
            except Exception as e:  # noqa
                last = e
                self.i += 1
                time.sleep(min(30, 0.5 * 2 ** att) + random.random())
        raise RuntimeError(f"rpc failed: {last}")

    def call(self, method, params):
        out = self._post({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if "error" in out:
            raise RuntimeError(str(out["error"])[:300])
        return out["result"]

    def batch_call(self, method, params_list):
        res = []
        for k in range(0, len(params_list), self.batch):
            chunk = params_list[k:k + self.batch]
            for att in range(6):
                out = self._post([{"jsonrpc": "2.0", "id": j, "method": method, "params": p} for j, p in enumerate(chunk)])
                byid = {o.get("id"): o for o in out} if isinstance(out, list) else {}
                if len(byid) == len(chunk) and all("result" in byid[j] and byid[j]["result"] is not None for j in range(len(chunk))):
                    res.extend(byid[j]["result"] for j in range(len(chunk)))
                    break
                self.i += 1
                time.sleep(1 + att)
            else:
                raise RuntimeError(f"batch failed for {method} at {chunk[0]}")
        return res


class Mids:
    """ETH mid in USDC per ETH at a unix second, from Binance ETHUSDT 1s closes / USDCUSDT 1m closes.
    midAt semantics (services/src/cex.ts): close of the kline whose openTime <= ts (latest such)."""

    def __init__(self, tags_1s, tags_1m):
        d = RAW / "binance"
        e = pd.concat([pd.read_parquet(d / f"ETHUSDT-1s-{t}.parquet") for t in tags_1s if (d / f"ETHUSDT-1s-{t}.parquet").exists()])
        e = e.drop_duplicates("ts").sort_values("ts")
        self.ts = e.ts.to_numpy(np.int64)
        self.px = e.close.to_numpy(np.float64)
        u = pd.concat([pd.read_parquet(d / f"USDCUSDT-1m-{t}.parquet") for t in tags_1m if (d / f"USDCUSDT-1m-{t}.parquet").exists()])
        u = u.drop_duplicates("ts").sort_values("ts")
        self.uts = u.ts.to_numpy(np.int64)
        self.upx = u.close.to_numpy(np.float64)
        c = d / "coinbase_USDTUSD-1h.parquet"
        if c.exists():
            cc = pd.read_parquet(c)
            self.cts, self.cpx = cc.ts.to_numpy(np.int64), cc.close.to_numpy(np.float64)
        else:
            self.cts = self.cpx = None

    def eth_usdt(self, t):
        t = np.asarray(t, dtype=np.int64)
        i = np.searchsorted(self.ts, t, side="right") - 1
        ok = (i >= 0) & (np.abs(t - self.ts[np.clip(i, 0, None)]) <= 5)  # tolerate <=5 s holes in the 1s series
        out = np.where(ok, self.px[np.clip(i, 0, None)], np.nan)
        return out

    def usdc_usdt(self, t):
        t = np.asarray(t, dtype=np.int64)
        i = np.searchsorted(self.uts, t, side="right") - 1
        ok = (i >= 0) & (np.abs(t - self.uts[np.clip(i, 0, None)]) <= 180)
        out = np.where(ok, self.upx[np.clip(i, 0, None)], np.nan)
        if np.isnan(out).any() and self.cts is not None:
            # Binance USDCUSDT was delisted during the BUSD auto-conversion (2022-09-29 .. 2023-03-12):
            # fall back to 1 / Coinbase USDT-USD hourly close (assumes USDC = USD, true on Coinbase at 1:1).
            j = np.searchsorted(self.cts, t, side="right") - 1
            okc = (j >= 0) & (np.abs(t - self.cts[np.clip(j, 0, None)]) <= 7200)
            fb = np.where(okc, 1.0 / self.cpx[np.clip(j, 0, None)], np.nan)
            out = np.where(np.isnan(out), fb, out)
        return out

    def mid(self, t):
        """USDC per ETH = ETHUSDT / USDCUSDT (corrects the USDC/USDT basis, e.g. the March 2023 USDC depeg)."""
        return self.eth_usdt(t) / self.usdc_usdt(t)

    def vol_bps(self, t, n=VOL_SAMPLES, step=BLOCK_SECONDS):
        """Realized vol like the keeper: stdev (ddof=1) of log returns of the last n per-block mids, bps."""
        t = np.asarray(t, dtype=np.int64)
        grid = t[:, None] - step * np.arange(n - 1, -1, -1)[None, :]
        m = self.eth_usdt(grid.ravel()).reshape(grid.shape)
        r = np.diff(np.log(m), axis=1)
        return np.nanstd(r, axis=1, ddof=1) * 1e4


def ece(p, y, bins=10):
    p = np.asarray(p); y = np.asarray(y)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    e = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return e
