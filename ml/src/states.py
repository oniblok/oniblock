"""Python ports of services/src/features.ts featuresToState (text state for Jev/Kev) and
services/src/model/heuristic.ts scoreHeuristic, byte-compatible with the TypeScript versions for plain pools
(no hook k -> base-fee wording)."""
import math

KEV_QUESTION = {
    "type": "noul",
    "instructions": "Is this block's arbitrage-direction flow informed, i.e. will the swaps that move the pool toward the Binance mid be profitable against the Binance mid at swap time after paying the pool fee?",
    "criteria": {
        "true": "informed / toxic: arbitrage-direction swaps profit against the CEX mid after the fee (LPs lose)",
        "false": "benign: arbitrage-direction swaps do not profit against the CEX mid after the fee",
    },
}


def _fx(x, d):
    # JS Number.prototype.toFixed: exact binary value, ties away from zero
    from decimal import Decimal, ROUND_HALF_UP
    r = Decimal(float(x)).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP)
    out = f"{r:.{d}f}"
    return out[1:] if x == 0 and out.startswith("-") else out  # JS: (-0).toFixed -> "0", (-0.0001).toFixed(3) -> "-0.000"


def features_to_state(f, base_is_token0=False):
    base = "token1 (ETH)" if base_is_token0 is False else "token0 (ETH)"
    gs = f["gapSign"]
    pool_vs = "above" if gs > 0 else "below" if gs < 0 else "equal to"
    gap_pct = _fx(f["gapPips"] / 1e4, 3)
    fee_pct = _fx(f["baseFee"] / 1e4, 2)
    if f.get("arbFeePips") is not None:
        k = f.get("kBps", 0) / 1e4
        thr = f.get("arbThresholdPips")
        law = (f"(base + k x (gap - {_fx(thr / 1e4, 2)}% arb threshold), base only below the threshold, k = {_fx(k, 2)})" if thr
               else f"(base + k x gap, k = {_fx(k, 2)})")
        fee_lines = [
            f"price_gap: pool price is {pool_vs} the Binance mid by {gap_pct}% ({int(f['gapPips'])} pips); base swap fee {fee_pct}%, and swaps toward the Binance mid pay {_fx(f['arbFeePips'] / 1e4, 3)}% {law}.",
            f"arb_edge: gap minus the fee for swaps toward the mid = {_fx((f['gapPips'] - f['arbFeePips']) / 1e4, 3)}% (positive means arbitrage is profitable after fees).",
        ]
    else:
        fee_lines = [
            f"price_gap: pool price is {pool_vs} the Binance mid by {gap_pct}% ({int(f['gapPips'])} pips); base swap fee {fee_pct}%.",
            f"arb_edge: gap minus base fee = {_fx((f['gapPips'] - f['baseFee']) / 1e4, 3)}% (positive means arbitrage is profitable).",
        ]
    lines = [
        "Uniswap v4 ETH/USDC pool, per-block regime snapshot (past data only).",
        *fee_lines,
        f"flow_imbalance: {_fx(f['imbalance'], 3)} on [-1,1] (+1 = all recent swaps bought {base}, -1 = all sold).",
        f"recent_swaps: {int(f['nSwaps'])} in last blocks, {_fx(f['arbShare'] * 100, 0)}% moved the pool toward the Binance mid.",
        f"size_to_depth: average swap is {_fx(f['sizeToDepth'] * 100, 3)}% of pool depth.",
        f"cex_volatility: {_fx(f['realizedVolBps'], 2)} bps per interval (stdev of log returns).",
        f"oracle_age: {int(f['attestationAge'])} blocks since last price attestation.",
    ]
    return "\n".join(lines)


def row_features(r):
    """Dataset row -> features dict with features.ts rounding."""
    return {
        "gapPips": int(r["gapPips"]), "gapSign": int(r["gapSign"]), "imbalance": round(float(r["imbalance"]), 4),
        "sizeToDepth": round(float(r["sizeToDepth"]), 6), "realizedVolBps": round(float(r["realizedVolBps"]), 3),
        "attestationAge": int(r["attestationAge"]), "nSwaps": int(r["nSwaps"]), "arbShare": round(float(r["arbShare"]), 3),
        "baseFee": int(r["baseFee"]),
    }


def heuristic_p(f):
    sig = lambda z: 1 / (1 + math.exp(-z))
    base = max(1, f["baseFee"])
    cost = max(1, f.get("arbFeePips") or f["baseFee"])
    edge = (f["gapPips"] - cost) / cost
    z = (-1.0 + 2.2 * max(-1.5, min(3, edge)) + 0.9 * abs(f["imbalance"]) * (1 if f["gapPips"] > base / 2 else -0.5)
         + 0.8 * min(1, f["realizedVolBps"] / 5) + 0.6 * f["arbShare"] + 3.0 * min(0.2, f["sizeToDepth"]))
    return round(sig(z) * 10_000) / 10_000  # pToxicBps resolution


def _sg(x, d):
    s = _fx(x, d)
    return s if s.startswith("-") else "+" + s


def features_to_state_kev2(f, base_is_token0=False):
    """State text format 'kev2' (services/src/features.ts featuresToState(f, {format: 'kev2'})): the 8 base-fee lines of
    features_to_state (hook fee fields ignored, byte-identical to the v1 training text) + 3 lines from the past-only
    CEX features edgeSigma, vol5mBps, ret12Bps, ret36Bps, ret900Bps (read as given; not recomputed)."""
    base = {k: v for k, v in f.items() if k not in ("arbFeePips", "kBps", "arbThresholdPips")}
    lines = [
        features_to_state(base, base_is_token0),
        f"edge_in_volatility: arb edge at the base fee is {_sg(f['edgeSigma'], 2)} typical 12 s Binance moves.",
        f"cex_volatility_5m: {_fx(f['vol5mBps'], 2)} bps per interval over the last 5 minutes.",
        f"cex_trend: Binance moved {_sg(f['ret12Bps'], 2)} bps over 12 s, {_sg(f['ret36Bps'], 2)} bps over 36 s and {_sg(f['ret900Bps'], 2)} bps over 15 min in the arbitrage direction (positive = the gap is widening).",
    ]
    return "\n".join(lines)
