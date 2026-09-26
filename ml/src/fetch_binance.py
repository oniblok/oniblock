"""Download Binance spot klines from data.binance.vision (public bulk data) and store compact parquet.

ETHUSDT 1s klines (monthly files; daily files for the current month) and USDCUSDT 1m klines, for the months used by
datasets A (2021-05..2023-11) and B (2026-07..2026-09). Output: ml/raw/binance/{SYM}-{INT}-{YYYY-MM[-DD]}.parquet with
columns ts (int64, open time in seconds) and close (float32/float64). Zips are deleted after conversion.
Binance switched spot timestamps to microseconds on 2025-01-01; both are handled.

usage: python fetch_binance.py A|B|O23
"""
import io, os, sys, time, zipfile, datetime as dt
import numpy as np, pandas as pd, requests
from common import RAW, disk_free_gb

OUT = RAW / "binance"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/spot"


def months(a, b):
    y, m = a
    while (y, m) <= b:
        yield f"{y:04d}-{m:02d}"
        m += 1
        if m == 13:
            y, m = y + 1, 1


def fetch(kind, sym, interval, tag):
    out = OUT / f"{sym}-{interval}-{tag}.parquet"
    if out.exists():
        return out
    if disk_free_gb() < 8:
        sys.exit("disk < 8 GB free, stopping")
    url = f"{BASE}/{kind}/klines/{sym}/{interval}/{sym}-{interval}-{tag}.zip"
    for att in range(6):
        try:
            r = requests.get(url, timeout=300)
            if r.status_code == 404:
                print("404", url, flush=True)
                return None
            r.raise_for_status()
            break
        except Exception as e:  # noqa
            print("retry", url, e, flush=True)
            time.sleep(2 ** att)
    else:
        return None
    z = zipfile.ZipFile(io.BytesIO(r.content))
    with z.open(z.namelist()[0]) as f:
        df = pd.read_csv(f, header=None, usecols=[0, 4], names=["open_time", "close"])
    if df.open_time.dtype == object:  # header row present in some files
        df = df[pd.to_numeric(df.open_time, errors="coerce").notna()].astype({"open_time": "int64", "close": "float64"})
    ot = df.open_time.to_numpy(np.int64)
    ts = np.where(ot > 10 ** 14, ot // 1_000_000, ot // 1000)
    close = df.close.to_numpy(np.float64)
    pd.DataFrame({"ts": ts, "close": close.astype(np.float32 if interval == "1s" else np.float64)}).to_parquet(out, index=False)
    print("ok", out.name, len(ts), flush=True)
    return out


def run(which):
    if which == "A":
        ms = list(months((2021, 5), (2023, 11)))
        for m in ms:
            fetch("monthly", "USDCUSDT", "1m", m)
        for m in ms:
            fetch("monthly", "ETHUSDT", "1s", m)
    elif which == "B":
        for m in ["2026-07", "2026-08"]:
            fetch("monthly", "ETHUSDT", "1s", m)
            fetch("monthly", "USDCUSDT", "1m", m)
        d = dt.date(2026, 9, 1)
        while d <= dt.date(2026, 9, 26):
            fetch("daily", "ETHUSDT", "1s", d.isoformat())
            fetch("daily", "USDCUSDT", "1m", d.isoformat())
            d += dt.timedelta(days=1)


if __name__ == "__main__":
    run(sys.argv[1])
