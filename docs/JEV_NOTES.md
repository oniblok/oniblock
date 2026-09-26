# Jev (typesafe-ai/jev) via Vercel AI Gateway — findings

Measured 2026-09-26 from `services/` (`pnpm -C services jev:probe`). Client: `services/src/model/jev.ts`.

## What it is
`GET https://ai-gateway.vercel.sh/v1/models` lists `typesafe-ai/jev` with `"type": "evaluation"`:
"TypeSafe AI System One evaluation model. Accepts shared state and typed questions, returning choices,
scores, and boolean probabilities." Context 32k tokens (state + longest question), 64k per request.
Pricing: input $0.042 / 1M tokens, output free (~410 input tokens per call for us ≈ $0.000017/call).

## Endpoints (verified)
| Endpoint | Result |
|---|---|
| `POST /v1/chat/completions` (OpenAI-compatible) | **400** `ModelTypeMismatchError`: "is an evaluation model, not a language model. Use the evaluation generation API instead." |
| `POST /v1/evaluate` | **200** — the one we use (AI SDK `experimental_evaluate` shape) |
| `POST /typesafe/v1/systemone` | **200** — TypeSafe-native shape (`noul` instead of `boolean`, snake_case usage) |

Auth: `Authorization: Bearer $AI_GATEWAY_API_KEY`.

## Request (`/v1/evaluate`)
```json
{
  "model": "typesafe-ai/jev",
  "state": "<text; may also be an object/array>",
  "questions": {
    "toxic":  { "type": "boolean", "instructions": "...", "criteria": { "true": "...", "false": "..." } },
    "regime": { "type": "choice",  "instructions": "...", "criteria": { "informed": "...", "dump": "...", "unknown": "..." } }
  }
}
```
Third type: `score` with `criteria: [label0, label1, ...]` (ordered low→high).

## Response
```json
{
  "answers": {
    "toxic":  { "type": "boolean", "probability": 0.7 },
    "regime": { "type": "choice", "choice": "dump",
                "probabilities": { "dump": 0.71, "unknown": 0.03, "informed": 0.26 }, "confidence": 0.57 }
  },
  "model": "typesafe-ai/jev",
  "providerMetadata": { "typesafe": { "confidence": { "regime": 0.57 } }, "gateway": { "routing": {...}, "cost": "0", ... } },
  "usage": { "inputTokens": 410, "outputTokens": 70 }
}
```
- `boolean` answers have **no** `confidence`; `choice` and `score` answers carry a native `confidence` (also mirrored in `providerMetadata.typesafe.confidence`). A `score` answer: `{score: 0.94, probabilities: {"0":..}, confidence}`.
- Errors: `{"message": "...", "error_type": "invalid_request"}` style (TypeSafe endpoint) / `{"error": {...}}` (gateway).

## Our mapping (typed head only — the model never outputs a fee)
- `pToxicBps = round(answers.toxic.probability * 1e4)`
- `cls = answers.regime.choice` ∈ {informed, dump, unknown}
- `confidenceBps = round(answers.regime.confidence * 1e4)` (fallback `|2p−1|` if absent)
- Two questions per call (cheap). Timeout 2.5 s (`JEV_TIMEOUT_MS`); any error/timeout/malformed → `null` → heuristic fallback. Optional state-keyed cache (`JevCache`, can persist to disk for the benchmark).

## Latency (12 sequential calls, from this machine, 2 questions, ~410 input tokens)
**p50 524 ms, p95 751 ms, min 490 ms, max 751 ms, 0 failures.** (Earlier single calls: ~1.0 s wall incl. TLS setup.)
Gateway routing showed provider attempt ~200 ms; the rest is gateway + network overhead.
Fits a 12 s Sepolia block easily; on anvil with 1 s blocks the keeper still posts every block (tx lands next block; contract tolerates `block.number-1`).

## Behaviour on our states (sanity sweep, base fee 0.30%)
| gap (bps) | 0 | 5 | 10 | 20 | 30 | 50 | 80 | 120 | 200 | 400 |
|---|---|---|---|---|---|---|---|---|---|---|
| pToxic | 0.05 | 0.10 | 0.10 | 0.11 | 0.15 | 0.83 | 0.83 | 0.84 | 0.86 | 0.87 |

Jev reads the natural-language state and flips to "informed" once the gap exceeds the fee — monotone and sensible.
**Tip:** natural-language state (`featuresToState`) works much better than a terse JSON object: `{"gapPips":10000,"baseFee":3000}` gave p=0.41 for a 1% gap, while the same situation in prose gives ~0.84.

## v4 prompt: "should this pool charge an extra fee?" (2026-09-26)

v4 asks Jev every block and makes its probability the fee decision (`k = kMax·p·c`, kMin 0, no gap threshold; docs/review/V4_AI_DECIDES.md). Two changes to the prompt (`JEV_QUESTIONS_V4` + `featuresToState(..., { format: 'v4' })`; `JEV_PROMPT=v1` restores the old texts, and v4 answers are cached under a namespaced key so the v1–v3 caches stay valid):

- **k-free state.** The edge is stated against the BASE fee (`arb_edge_at_base_fee`), never against the fee at the current k. A k-dependent edge would feed the model's own answer back into its input (high k → edge < 0 → "calm" → k = 0 → edge > 0 → "toxic" ...).
- **The question says what the answer does**: the extra fee is proportional to the probability; if `arb_edge_at_base_fee` is zero or negative the probability must be near 0.

Sweep (`pnpm -C services jev:probe:v4`, ETH/USDC, base 0.30%, 3 recent swaps, low/high 1 s volatility; p and c in bps, `pc = p·c/1e4` is what the hook multiplies kMax by):

| gap (bps) | edge at base | p (low vol / high vol) | c | p·c | class |
|---|---|---|---|---|---|
| 0 | −0.30% | 300 / 300 | 5200 / 7000 | 156 / 210 | dump |
| 5–29 | −0.29 … −0.01% | 300–400 | 2500–3800 | 81–152 | dump / unknown |
| 33 | +0.03% | 9300 / 9100 | 6600 / 6800 | 6138 / 6188 | informed |
| 40 | +0.10% | 9300 / 9200 | 7400 / 6900 | 6882 / 6348 | informed |
| 60 | +0.30% | 9300 / 9200 | 7500 / 6800 | 6975 / 6256 | informed |
| 120 | +0.90% | 9600 / 9600 | 7700 / 7800 | 7392 / 7488 | informed |

Reading: below the base fee Jev answers p ≈ 0.03–0.04 with low confidence, so `k = 0.8·p·c ≈ 0.006–0.012` (a 0.20% gap adds ~0.002% to the base fee: indistinguishable from vanilla); at or above the base fee p ≈ 0.91–0.96, `k ≈ 0.50–0.60`. The old v1 prompt's "calm" answers were p ≈ 0.10–0.15 with c ≈ 0.40 (p·c ≈ 0.05 → k ≈ 0.04), so the wording change, not a contract dead-zone, is what lets "calm" reach ~0. Volatility barely moves the answer; the gap-vs-base-fee comparison dominates, as in v1–v3.


## v6 prompt: one malicious score + one attack type (2026-09-27)

v5 asked two independent booleans (`toxic`, `jit`) and attested both. v6 (`JEV_QUESTIONS_V6`, the keeper default;
`JEV_PROMPT=v5|v4|v1` restores the older texts, cache keys are namespaced `[jev-prompt:v6]`, the state text is the
v5 text unchanged) asks Jev **one** question about the block and **one** about its kind, and the keeper maps the pair
onto the same two attested numbers. No contract change: `pToxicBps` still becomes k, `pJitBps` still becomes the JIT
window, and the settler grades them exactly as before.

- `malicious` (boolean): *Will the next block bring flow that costs this pool's liquidity providers money? …
  Answer with the probability that the next block contains such an exploit. If arb_edge_at_base_fee is zero or
  negative AND recent liquidity stayed, the probability must be near 0.*
- `attack` (choice): *Which kind of flow is most likely in the next block?* over `none`, `cex_dex_arbitrage`,
  `split_arbitrage`, `backrun`, `jit_liquidity`, `sandwich` (label only: not defended by this hook), `unknown`, with
  a pointer per type to the state line that carries the evidence (`liquidity_recent`/`liquidity_shape` for
  jit_liquidity, `arb_edge_at_base_fee` and `cex_volatility` for the arbitrage types, `recent_swaps` for
  split_arbitrage/backrun).

### Mapping (`mapV6` in `services/src/model/types.ts`, applied in `parseJev`)

```
p      = answers.malicious.probability                      (pMaliciousBps = round(p·1e4))
P(t)   = answers.attack.probabilities[t], missing keys = 0
denom  = max(1 − P(none) − P(unknown), 0.05)                (the mass that names an attack type)
pPriceShare = min(1, (P(cex_dex_arbitrage) + P(split_arbitrage) + P(backrun)) / denom)
pJitShare   = min(1, P(jit_liquidity) / denom)
pToxicBps   = clamp(p · pPriceShare · 1e4)    → k = kMax · pToxic · c
pJitBps     = clamp(p · pJitShare · 1e4)      → JIT window = min + (max − min) · pJit · c   (after the keeper's churn blend)
c           = answers.attack.confidence (fallback |2p − 1|);  cls = 'informed' for the three price types, else 'unknown'
```

Rationale: **one score is the magnitude, the type allocates it across the two defenses.** Jev is much better at
"is something bad coming" than at two separately calibrated bad things, and a single score cannot double-count: a
block that is 0.8 malicious and 70/30 arbitrage/JIT charges k for 0.56 and widens the window for 0.24, never both at
0.8. `none` and `unknown` are removed from the denominator so a hesitant answer ("0.3 malicious, mostly none, a bit
of backrun") still puts the whole 0.3 behind the one defense it named; the 0.05 floor keeps a near-zero named mass
from blowing up (share is capped at 1 anyway). `sandwich` mass goes to neither knob: the hook cannot defend it, the
label is for the dashboard. A missing `attack` answer falls back to v5 behaviour (`pToxic = p`, `pJit = 0`); a missing
`malicious` answer is a parse failure (heuristic fallback, as before). The heuristic fills the same fields
(`attack` = jit_liquidity if churn ≥ 0.5 and no edge, cex_dex_arbitrage if edge > 0, else none; 0.7 on the choice;
`pMalicious = max(pToxic, pJit)`), but its two heads stay independent — they are not passed through `mapV6`.

**Known limit — and why the JIT knob still blends observed churn.** A single-choice type cannot express two attacks
in the same block: if a JIT position is minted around an arbitrage swap, the distribution splits and each knob gets
only its share of `p`. The keeper therefore keeps `blendPJit` (v5): `pJitBps` posted = (1 − w)·mapped + w·churn, so a
pool whose recent liquidity is being pulled again keeps a wide window even when the type head is busy naming the
arbitrage. The attested log line carries the whole chain (`pMalicious`, `attack`, `attackProbs`, `pPriceShare`,
`pJitShare`, `pJitModel`, `pJitChurn`, `pJitBps`, `jevPrompt`), and every posted attestation is appended to
`.runtime/verdicts.<chainId>.jsonl` (`VERDICTS_FILE` overrides; last 5000 lines) for the app's `/api/verdicts`,
the `/classic` status strip ("Model verdict: malicious 0.83 · most likely: split arbitrage (0.71)") and the receipt page.
