"""Score test_3k.jsonl against hosted Jev (Vercel AI Gateway) and emit kev-benchmark-shaped output.

Writes <out>/rows.json + <out>/report.json so ml/train_kev4b/score_kev.py can read it unchanged.
The question text is taken verbatim from the dataset; only the type name is mapped noul -> boolean,
which is Jev's protocol for a yes/no probability.

API key is read from AI_GATEWAY_API_KEY and never written to disk.
Partial results stream to <out>/raw.jsonl so an interrupted run can resume.
"""
import argparse, json, os, statistics, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

JEV_URL = os.environ.get("JEV_URL", "https://ai-gateway.vercel.sh/v1/evaluate")
JEV_MODEL = "typesafe-ai/jev"


def ask(state, question, key, timeout, retries=4):
    body = json.dumps({
        "model": JEV_MODEL,
        "state": state,
        "questions": {"informed": question},
    }).encode()
    last = None
    for attempt in range(retries):
        t0 = time.perf_counter()
        try:
            req = urllib.request.Request(
                JEV_URL, data=body,
                headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
                method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = json.loads(r.read().decode())
            dt = (time.perf_counter() - t0) * 1000
            p = (raw.get("answers", {}).get("informed", {}) or {}).get("probability")
            if isinstance(p, (int, float)) and 0.0 <= p <= 1.0:
                return float(p), dt, None
            return None, dt, f"bad answer: {json.dumps(raw)[:200]}"
        except urllib.error.HTTPError as e:
            detail = e.read()[:200].decode(errors="replace")
            last = f"HTTP {e.code}: {detail}"
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(min(2 ** attempt, 15))
                continue
            return None, (time.perf_counter() - t0) * 1000, last
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
            time.sleep(min(2 ** attempt, 15))
    return None, 0.0, last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    key = os.environ.get("AI_GATEWAY_API_KEY")
    if not key:
        sys.exit("AI_GATEWAY_API_KEY not set")

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    recs = [json.loads(l) for l in open(a.data)]
    if a.limit:
        recs = recs[:a.limit]

    rawp = out / "raw.jsonl"
    done = {}
    if rawp.exists():
        for line in open(rawp):
            try:
                d = json.loads(line); done[d["i"]] = d
            except Exception:
                pass
        print(f"resuming: {len(done)} already scored", flush=True)

    fh = open(rawp, "a")
    lock = Lock()
    counter = {"n": len(done), "err": 0}

    def work(i):
        if i in done:
            return done[i]
        r = recs[i]
        q = r["questions"]["informed"]
        # verbatim question text; only the type name is mapped to Jev's protocol
        question = {"type": "boolean", "instructions": q["instructions"], "criteria": q["criteria"]}
        p, dt, err = ask(r["state"], question, key, a.timeout)
        d = {"i": i, "p": p, "latency_ms": dt, "label": 1 if q["label"] else 0, "err": err}
        with lock:
            fh.write(json.dumps(d) + "\n"); fh.flush()
            counter["n"] += 1
            if err:
                counter["err"] += 1
                if counter["err"] <= 5:
                    print(f"  err[{i}]: {err}", flush=True)
            if counter["n"] % 100 == 0:
                print(f"scored {counter['n']}/{len(recs)} (errors {counter['err']})", flush=True)
        return d

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.concurrency) as ex:
        results = list(ex.map(work, range(len(recs))))
    fh.close()

    ok = [d for d in results if d["p"] is not None]
    rows = [{
        "id": f"custom/{d['i']}", "group": f"custom/{d['i']}", "question": "informed",
        "source": "custom", "task": "custom_noul", "type": "noul", "variant": "clean",
        "keys": ["false", "true"], "label": d["label"], "control_id": None, "pair_id": None,
        "sibling": None, "parent": f"custom/{d['i']}", "p": [1.0 - d["p"], d["p"]],
    } for d in ok]
    json.dump(rows, open(out / "rows.json", "w"))

    lat = sorted(d["latency_ms"] for d in ok)
    report = {
        "model": JEV_MODEL, "url": JEV_URL, "data": a.data,
        "latency_ms": {
            "median": statistics.median(lat) if lat else None,
            "p95": lat[int(len(lat) * 0.95)] if lat else None,
        },
        "coverage": {
            "requested_records": len(recs), "evaluated_records": len(ok),
            "failed_records": len(recs) - len(ok),
        },
        "wall_seconds": time.time() - t0,
        "concurrency": a.concurrency,
    }
    json.dump(report, open(out / "report.json", "w"), indent=1)
    print(json.dumps(report, indent=1), flush=True)


if __name__ == "__main__":
    main()
