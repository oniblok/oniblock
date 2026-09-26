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
