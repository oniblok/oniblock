# Oniblock E2E report: live Sepolia app (http://localhost:3001)

> Note (later change): the `minSamples` probation ("unseasoned") described in this historic document has since been removed from the hook; the calibration gate is now the pool allowlist + Brier demotion only, and a model with no calibration record is active.

- Date: 2026-09-27, Sepolia blocks ~11788305 to 11788375. Hook `0x8dAcd25138e902D7755E75d91cE1AEA12f5C75C3` (deploy block 11788205).
- Tooling: Playwright 1.x with headless Chromium (installed OK), Node scripts, `cast` against the `.env` RPC (ethereum-sepolia-rpc.publicnode.com), curl.
- Scripts and screenshots: `/private/tmp/claude-501/-Users-akshat-Desktop-et/8ca8eb79-529b-467f-8e6c-a45c8e6238bc/scratchpad/e2e/` (`pages.js`, `swapui.js`, `judge.js`, `invalid.js`, `mobile.js`, `api.py`, `verify.sh`, `ens.sh`, `shots/`).
- 6 swaps were sent from the demo swapper `0x6cc4…70c1`. Its balance went from 0.0537 to 0.0526 ETH.

## Summary

| Case | Result | Notes |
|---|---|---|
| A. Pages load, key elements | **FAIL** (partial) | `/`, `/classic` and `/receipt/<tx>` are fine. `/models` fails intermittently: `/api/models` returns 500 on 20–25% of calls, and when the first poll fails the page shows only "HTTP request failed." (F2). |
| B1. Sell 0.05 mWETH | PASS | Tx landed. The row showed up at the inclusion block. The fee and direction match the on-chain Receipt. |
| B2. Buy with 100 mUSDC | PASS | Same as B1 (counter-trend, base fee). |
| B3. Above cap | PASS | The UI disables Swap and shows "Demo limit: max 3 mWETH / 10,000 mUSDC". The API returns 400 `max 3 per swap` / `max 10000 per swap`. A forced click sends no request. |
| B4. Zero / negative / non-numeric | **FAIL** (partial) | The UI blocks 0, -1, "abc" and "1e". The API rejects 0, -1, "abc", null, missing and "Infinity" with 400. But a tiny amount (`amount: 1e-30`) passes validation, rounds to `amountIn = 0` and sends a real no-op tx (F4). Malformed JSON returns 500 instead of 400 (F7). |
| B5. Rate limit | PASS (UI), **FAIL** (security) | A second UI swap within 10 s gets 429 "one swap every 10 s — try again in 5 s", shown in the modal. But the limit is keyed on a client-supplied `X-Forwarded-For`, so it can be bypassed trivially (F3). |
| B6. Row, fee, direction vs chain | PASS | All 5 real swaps: feed `feePips`/`arbDir`/`kBps`/`gapPips` equal the decoded hook `Receipt` event. The row appears in the tx list on the inclusion block (0-block latency after the feed sees it, about 10–23 s after submit). |
| C. Judgement modal (own swap) | **FAIL** | Opening the modal as soon as the swap lands (which the toast invites) gives a persistent RPC error in "Who judged it" (F1). When it does load: P(toxic)/Confidence can come from an attestation mined *after* the swap (F5), and Calibration shows a misleading "Brier 0.000 · hit 0% · n " with a blank n (F6). Fee formula, probation status, ENS role check, EIP-712 check and both links are correct. |
| C. Judgement modal (arb-bot swap) | BLOCKED | The arb bot has made no swaps since deploy (gap about 8–11 bps, below the 30 bps base fee). The retail bot fails every swap (see Ops). Every Receipt on the pool is ours. |
| D. Probation exit and k > 0 fee | SKIPPED | Skipped on request. Observed: calibration n = 0 for every model, `isDemoted(poolId, jev-v1) = true` (unseasoned), ENS `status = probation`, k = 0. The settler logs `nothing_labelled` ("every graded block fell inside the dead band"), so n will not grow without real flow. |
| E. APIs | **FAIL** (partial) | `/api/state`, `/api/feed`, `/api/history`, `/api/verdicts` and `/api/ens` return 200 JSON with no NaN/undefined/Infinity strings. Blocks advance across polls and every verdict attack type is in the allowed set (only `none` seen). `/api/models` returns 500 intermittently (F2). |
| F. ENS via UniversalResolverV2 | PASS | `text(status)` on jev-v1.live = "probation"; `text(k)` on weth-usdc.live = "0", equal to `/api/state` kBps 0. `reverse(quoter, 60)` = quoter.oniblock.eth and `reverse(settler, 60)` = settler.oniblock.eth. Resolver 0x90E9EFd687ebB54ee62187ab0578C148EaBB70eD. |
| G. Responsive at 390 px | **FAIL** | The page scrolls sideways (scrollWidth 434 vs 390) because the header Swap button overflows. The Swap modal itself fits (358 px wide) and is usable (F8). |

## Failures

### F1: Judgement modal shows "Invalid parameters were provided to the RPC method." for a freshly landed swap (HIGH)
- **Repro:** press Swap and submit. When the toast says "Your swap landed. Click it…", click the row right away.
- **Expected:** "Who judged it" rows load.
- **Actual:** `/api/receipt/<tx>` returns 500 and the modal shows the raw error. It never retries, so the error stays until the modal is closed and reopened about 2 blocks later. Reproduced on B1 and B2: tx `0x41dd…83d2` and `0x111a…057f` both got 500 on first open and 200 a few blocks later.
- **Root cause:** `app/src/lib/server/receipt.ts:261` asks for `toBlock: BigInt(block + 2)`. publicnode rejects any log range past its head. Verified directly:
  - `eth_getLogs toBlock=head+1` returns `{"code":-32602,"message":"block range extends beyond current head block"}`
  - `toBlock=head` returns 200.
- **Fix:** clamp to `min(block + 2, head)`. Also add a retry in `app/src/components/live/JudgementModal.tsx:18`, which fetches once only.
- Screenshot: `shots/B2-judgement.png` (and `B1-judgement.png`).

### F2: `/api/models` returns 500 "HTTP request failed." on about 20–25% of calls; `/models` page is blank on a failed first poll (MEDIUM)
- **Evidence:**
  - 12 sequential calls gave 3 × 500.
  - 20 calls gave 4 × 500.
  - A Playwright run of `/models` got two 500s in 9 s and rendered only "HTTP request failed." (`shots/A-models.png`). An earlier run rendered fine.
  - Other endpoints never failed in the same period.
- **Suspected cause:**
  - `app/src/lib/server/models.ts:88-89` runs two uncached full-range `getContractEvents` from `deployBlock` to head on every 4 s poll. `live.ts` uses an incremental store instead.
  - The page polls every 4 s (`app/(legacy)/models/page.tsx:9`).
  - It is also exposed to the same head-lag race if the RPC load balancer lands on a node behind `getBlockNumber()`.
  - Suggested fix: reuse `loadStore`, or cache and retry.
- The page only renders an error if the first poll fails (`models/page.tsx:11`).

### F3: Swap rate limit can be bypassed with a spoofed X-Forwarded-For (MEDIUM, security/abuse)
- **Repro:**
  ```
  curl -XPOST :3001/api/swap -d '{"pay":"quote","amount":50}'
  curl -XPOST :3001/api/swap -H 'x-forwarded-for: 203.0.113.7' -d '{"pay":"quote","amount":50}'
  ```
- **Actual:** both returned 200 and both landed in the same block 11788358:
  - [0x0711…8fd9](https://sepolia.etherscan.io/tx/0x071120b356e1d20a7f591c9d69cbd2f07c474163c3bdbc8c970966b549ff8fd9)
  - [0x492b…1f9a](https://sepolia.etherscan.io/tx/0x492bdfb7e9dd655de7824a83e8017e442a27d6e23bc50a4d904f51f8f6d21f9a)
- **Cause:** `app/src/app/api/swap/route.ts:10` trusts `x-forwarded-for` from the client. The app is served directly, with no proxy stripping it.
- **Impact:** anyone can drain the swapper's test ETH (0.05) at the pace of the `busy` lock. Also, every visitor without the header shares the single `'local'` bucket.

### F4: A tiny amount passes validation, rounds to zero and sends a no-op tx (LOW–MEDIUM)
- **Repro:** POST `{"pay":"quote","amount":1e-30}`, or in the UI pay 0.0000001 mUSDC (the button is enabled).
- **Actual:**
  - Returns 200 [0x19e4…cb68](https://sepolia.etherscan.io/tx/0x19e4fd4e44a4398caf6d0a1fc59bfc3ea079e4d618d476c87354c3986998cb68).
  - Status 1, 33,168 gas, no Receipt event.
  - `/api/receipt` says "This transaction emitted no Oniblock Receipt…".
  - The UI would show a pending row that never resolves.
- **Cause:** `app/src/lib/server/swap.ts:71` can produce `amountIn = 0n`. There is no `amountIn > 0` check after rounding; only `req.amount > 0` is checked, at line 60.
- Combined with F3, it is a cheap gas-drain vector.

### F5: Feed/Judgement P(toxic) and Confidence can come from an attestation mined after the swap (MEDIUM, correctness)
- **Evidence (B1):**
  - Swap 0x41dd…83d2 is in block 11788328 at logIndex 193.
  - AttestationPosted events: block 11788326 log 119 (attBlock 325, p 60, **c 9700**); block 11788328 log **233** (attBlock 327, p 60, **c 9800**), i.e. after the swap in the same block.
  - The feed row and modal show Confidence 98%. `/api/receipt` (and the full receipt page) correctly show the in-force attestation, c 97%.
  - The score also uses the wrong value.
- **Cause:**
  - `app/src/lib/server/feed.ts:70` `inForce(atts, r.block)` and `live.ts:456-468` use `mined <= block` and ignore log order.
  - `receipt.ts:266` does it correctly (logIndex < first swap log).
  - `markout` via `firstAfter` (`feed.ts:101`) is affected the same way: it skips the next attestation.
- **Related:** the receipt's `verdict` (`receipt.ts:331`, `findVerdict({block})`) returned the verdict with target 11788328 (pToxic 400), which was mined in 11788329. That is not the one in force (pToxic 60).

### F6: Judgement "Calibration (ENS records)" is misleading when records are empty (LOW)
- **Actual:** it shows `Brier 0.000 · hit 0% · n ` with a blank n while the model has no calibration yet: n = 0 and every ENS `calibration.*` record is `""`.
- **Cause:**
  - `JudgementModal.tsx:38` `brierTxt` treats `""` as 0, because `Number("") === 0`. That renders as a perfect Brier score.
  - `JudgementModal.tsx:137` `ens['calibration.n'] ?? …` does not fall back on `""`.
- **Expected:** "—" or "no calibration yet (n 0 / 3)".

### F7: Malformed JSON body to `/api/swap` gives 500 (LOW)
- `notjson` returns HTTP 500 `Unexpected token 'o'…`. It should be 400.
- Cause: `app/src/app/api/swap/route.ts:9`.
- Minor: an unknown `pay` value (e.g. `"foo"`) is silently treated as `base`.

### F8: Horizontal scroll at 390 px (LOW–MEDIUM, mobile)
- **Actual:** `document.documentElement.scrollWidth = 434` on a 390 px viewport. The header Swap button's right edge is at 434 px, because the header `flex items-center gap-4` (logo + chain pill + Swap) never wraps or shrinks (`app/src/app/page.tsx:77`).
- The Swap modal fits (x 16–374) and its submit button is enabled.
- Screenshots: `shots/G-home-390.png`, `shots/G-swapmodal-390.png`.

## Verified checks

- **Pages (A):** checks passed and screenshots saved as `shots/A-*.png`.
  - `/`: 200 with chart SVG, Live swaps list and header Swap button; "Ethereum Sepolia #block" shown.
  - `/classic`: status strip with Attested k (0.00 unseasoned → kDefault), JIT window (10 blk), Model verdict (malicious 0.03, most likely none), resolver 0x90E9…70eD (not "not deployed"), and primary names quoter.oniblock.eth / settler.oniblock.eth.
  - `/models`, when it loads: jev-v1, heuristic-v1 and kev-v1 rows with JIT head, "unseasoned (n < 3)", the ENS card and the primary names.
  - `/receipt/0x41dd…83d2`: 200 with the fee law check, "✓ verified at post time" and quoter ENS match.
  - None of the pages had console errors, page errors or a Next error overlay, apart from the 500s in F1/F2.
- **Chain-verified swaps (B6):** `cast receipt` plus a decode of the hook `Receipt` event.

  | Tx | Block | Dir | arbDir | gapPips | kBps | feePips | Feed/UI |
  |---|---|---|---|---|---|---|---|
  | [0x41ddb717…83d2](https://sepolia.etherscan.io/tx/0x41ddb71774808d864be1f8c07f8709516abf666fa6b2f48761c429dd14d783d2) (B1 sell 0.05 mWETH) | 11788328 | 0→1 | true | 1058 | 0 | 3000 | 0.30%, "Clean" 0.01, arb dir ✓ |
  | [0x111a19ee…057f](https://sepolia.etherscan.io/tx/0x111a19eebbdca6bdd6d6b28920d2e831de432983c66a6d298ef211ce0656057f) (B2 buy with 100 mUSDC) | 11788343 | 1→0 | false | 0 | 0 | 3000 | 0.30%, "Counter-trend" ✓ |
  | [0x44fcd7bd…308c](https://sepolia.etherscan.io/tx/0x44fcd7bdd5d0219c420e725f3989212bf53f788e84978b4c0d609a4710f8308c) (B5 first, 100 mUSDC) | 11788351 | 1→0 | false | 0 | 0 | 3000 | ✓ |
  | [0x071120b3…8fd9](https://sepolia.etherscan.io/tx/0x071120b356e1d20a7f591c9d69cbd2f07c474163c3bdbc8c970966b549ff8fd9) (API, 50 mUSDC) | 11788358 | 1→0 | false | 0 | 0 | 3000 | ✓ |
  | [0x492bdfb7…1f9a](https://sepolia.etherscan.io/tx/0x492bdfb7e9dd655de7824a83e8017e442a27d6e23bc50a4d904f51f8f6d21f9a) (API spoofed XFF, 50 mUSDC) | 11788358 | 1→0 | false | 0 | 0 | 3000 | ✓ |
  | [0x19e4fd4e…cb68](https://sepolia.etherscan.io/tx/0x19e4fd4e44a4398caf6d0a1fc59bfc3ea079e4d618d476c87354c3986998cb68) (API amount 1e-30) | 11788359 | — | — | — | — | — | no Receipt (F4) |

- **Judgement modal (C), B1:**
  - Fee formula: `fee = base 0.30% + k·(gap) = 0.30%` with k 0.00 and gap 10.6 bps. Recomputed: 3000 + 1058·0 = 3000 ✓.
  - Status "On probation" matches `isDemoted(poolId, jev-v1) = true`, with calibration n 0 < minSamples 3 ✓.
  - "Posted by quoter.oniblock.eth · ENS role ✓", and "Signed by attestor 0x923d…0966 · EIP-712 ✓", matching the deployment attestor ✓.
  - Links: Etherscan `https://sepolia.etherscan.io/tx/<tx>` returns 200. Full receipt `/receipt/<tx>` returns 200 with no page errors.
- **ENS (F), UR `0x5d25…03e3` `resolve` / `reverse`:**
  - jev-v1.live: status = "probation", calibration.n = "0", demoted = "true".
  - current.live: status = "probation".
  - weth-usdc.live: k = "0", p-toxic = "0", fee-zero-for-one = "3000".
  - `/api/state`: kBps 0, pToxic 0, feeZeroForOne 3000, unseasoned true.
  - reverse(0x05116e…F49D8b, 60) = quoter.oniblock.eth; reverse(0xc9020f…957A3B, 60) = settler.oniblock.eth; both are forward-verified.
- **Minor semantic note:** ENS `demoted = "true"` (it follows `isDemoted`, probation included). `/api/state.status.demoted = false` and `/classic` "not demoted" mean "Brier-demoted" only. Both are consistent with their own docs but read as contradictory side by side.

## Ops observations (not app bugs)
- **Retail bot** `0x6476…4132`:
  - Only 0.000058 ETH. `approve` failed at start with "total cost exceeds the balance".
  - Every swap since then reverts with **ERC20InsufficientAllowance (0xfb8f41b2)** or 0xe450d38c (ERC20InsufficientBalance).
  - See `.runtime/logs/sepolia/retail.log`.
- **Arb bot** `0x0f2c…95d3`: 0.0024 ETH and idle since start. The pool/CEX gap (about 8–11 bps) is below the 30 bps base fee, so no arb is profitable.
- As a result, **the only swaps on the pool are the ones from this test run**. The settler has nothing to grade (`nothing_labelled`), calibration n stays 0 and the model stays on probation (k = 0). That is why case D could not have completed on its own.

## Screenshots
All paths are under `/private/tmp/claude-501/-Users-akshat-Desktop-et/8ca8eb79-529b-467f-8e6c-a45c8e6238bc/scratchpad/e2e/shots/`:
- **A:** `A-home.png`, `A-classic.png`, `A-models.png` (error state, F2), `A-receipt.png`.
- **B:** `B1-1-modal.png`, `B1-1-after.png`, `B1-row.png`, `B1-judgement.png`, `B1-fullreceipt.png`; `B2-1-modal.png`, `B2-1-after.png`, `B2-row.png`, `B2-judgement.png` (F1 error); `B3-quote-10001.png`, `B3-quote-10000.png`, `B3-base-3.5.png`; `B4-base-0.png`, `B4-base-neg.png`, `B4-base-abc.png`, `B4-base-e.png`; `B5-1-modal.png`, `B5-1-after.png`, `B5-2-modal.png`, `B5-2-after.png` (429 message), `B5-row.png`, `B5-judgement.png`.
- **G:** `G-home-390.png`, `G-swapmodal-390.png`.
