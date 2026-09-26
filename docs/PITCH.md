# Oniblock: pitch, demo script, judge Q&A

## 60-second pitch

> When the price moves on Binance, a Uniswap pool is wrong until someone trades it. That someone is an arbitrageur, and the LPs pay for it. That is LVR, not sandwiches. Private routing already cut sandwich extraction to about $2.5M a month, while non-atomic arbitrage is more than a quarter of top-DEX volume.
>
> Oniblock is a Uniswap v4 hook with a public fee law. Only swaps that move the pool toward the real price pay extra, proportional to the gap. Retail going the other way pays the base fee. The gap is anchored per block, so splitting a trade does not help. If data is stale, we charge a conservative fee and never revert.
>
> How hard to lean on the gap, `k`, comes from an AI model behind the hook, attested every block. But the model does not get trusted for free. A settler scores every decision against markouts and writes the model's calibration to ENSv2, where only the settler can write it. Bad calibration clamps `k` automatically. Revoking one ENS role kills the quoter instantly.
>
> The product is "the AI decides, the gate guarantees": there is no hard-coded threshold, the model's per-block judgement sets the premium, and a model that has not earned trust, or has lost it, has no power at all: the pool charges exactly the base fee, like a vanilla pool. Our benchmarks are honest about the economics: next to a vanilla pool the effects are tens of dollars an hour on a $20M pool, and we say so. What we ship is the accountability loop: the system notices a bad model by itself, in public, on a pool anyone can LP into.

## 3-minute demo script

Setup before going on stage: `./scripts/demo-local.sh` on http://localhost:3000. It replays a volatile window of real Binance klines, so arbs happen by themselves. For the ENS segment, run `./scripts/demo-fork.sh` in a second terminal (app on :3001; allow about 2 minutes to set up). Headless dry runs: `DEMO_DURATION=180 ./scripts/demo-local.sh` and `DEMO_DURATION=200 ./scripts/demo-fork.sh`.

| time | screen | say |
|---|---|---|
| 0:00–0:20 | `/` split screen: Vanilla v4 vs Oniblock, same bot, same flow | "Two identical pools with the same arbitrageur and the same retail flow. Left is a static 0.30% fee; right is our hook. Watch LP value minus HODL." |
| 0:20–0:45 | Regime map + status strip. Model is **unseasoned**, k = kDefault (0.5) | "Each cell is a block, colored by the attested k. Right now the model is on probation. It has fewer than `minSamples` scored samples, so it has no power, and k sits at the default. A new model name can't skip this." |
| 0:45–1:15 | Press **Execute swap** (arb direction), then open its `/receipt/<tx>` | "The fee is this block's gap times k, in the arb direction only. The receipt shows gap, k, fee, the model resolved from ENS, the verified attestor signature, and the running calibration." |
| 1:15–1:40 | Model turns **seasoned** (settler posted n ≥ 3); k starts following the model | "The settler has scored enough blocks against the CEX mid. The model has earned power, and k now moves within bounds, step-limited." |
| 1:40–2:10 | Press **Degrade model**; `/models` shows the Brier climbing toward the 0.25 line | "Now I make the model lie by inverting its predictions. Watch: it briefly grabs power and k jumps. Then the settler's Brier score crosses 0.25, and the model is **demoted**: k snaps back to the default. Nobody touched the contract." |
| 2:10–2:45 | Fork app (:3001): press **Revoke quoter** (ENS `revokeRoles`) → status turns stale, fee = 0.50% → **Grant backup** | "This is real ENSv2 on a Sepolia fork. The quoter's power is an EAC role on `quoter.oniblock.eth`. I revoke it: the next attestation fails, the pool goes stale and charges the conservative fee. It doesn't revert and doesn't drop the fee. Grant a backup keeper, and attestations resume." |
| 2:45–3:00 | README benchmark table | "We benchmarked this against a vanilla pool next door with real Binance ticks and routing competition. Honest answer: the LP effect is small, tens of dollars an hour on a $20M pool, and we publish the CIs. What we ship is the loop: the AI decides the premium every block, bounded power, public receipts, automatic demotion to a plain vanilla pool, instant revocation, so any model can be plugged in safely." |

Fallbacks:
- If arbs are sparse (live price source), use **Execute swap** to open a gap.
- If Jev is slow, the keeper falls back to the heuristic model, and the receipt shows which model node posted.
- `pnpm -C services story` prints the unseasoned → seasoned → demoted timeline from chain events if the UI is not cooperating.

## Top-5 judge Q&A

**1. "How is this not Detox-Hook?"**
The gap fee is Detox-Hook's idea, and we credit it; Detox-style is literally pool 2 in our benchmark. Four things are different:
- **Direction.** Only toward-oracle swaps pay `k·gap`. Detox-style pricing taxes retail too, which shows up as 44–57 bps of retail cost against our 40–43 bps.
- **Split resistance.** A per-block, per-direction high-water anchor makes splitting a trade into many sub-swaps useless. Fuzzed and benchmarked, with identical LVR at split = 1 and split = 5.
- **Attested, bounded `k`,** from a model behind the hook. The model never outputs a fee.
- **The accountability loop, which is the new part.** Receipts are scored against markouts, calibration is published on ENSv2 by a settler-only role, the model is automatically demoted on-chain, and a role revoke acts as the kill switch.

**2. "Does the model beat constant k?"**
Not in v1 (single pool, captive flow), and the README says so. v2–v4 add a vanilla pool next door (routing competition); the v4 "AI decides" comparison against a hard-coded threshold and against vanilla is in `docs/review/V4_AI_DECIDES.md`. The v1 numbers: The benchmark replays real Binance 1-second klines on five pools, with 95% block-bootstrap CIs, using the same labelling and fee-aware model state as the live services. The model consistently chooses a *lower* k than 0.5 (mean 0.25–0.33). Model k minus constant k:

| window | LP − HODL | retail cost |
|---|---|---|
| volatile | -$510 [-903, -133] | -$102 [-157, -49] |
| volatile, 5-way split arbs | -$629 [-1,099, -182] | -$105 [-153, -58] |
| volatile, 2× retail | -$553 [-959, -177] | -$385 [-503, -270] |
| calm | -$113 [-148, -81] | -$120 [-153, -91] |

So on this data the model moves value from LPs to retail; it does not reduce LVR (no significant LVR difference in any run). The v1 "fee law beats a fixed fee" result holds only without routing competition: with a vanilla pool next door (v2/v3) the law's LP effect is tens of dollars an hour either way, and we say so.

**What we ship: the AI decides, the gate guarantees.** No hard-coded threshold; `k = kMax·p·c` from the model every block, with `kDefault = 0`, so a model that is unseasoned or demoted has no power and the pool is exactly a vanilla pool. A degraded model was demoted 40–140 steps after it went bad in every v1 run, and the gate separated honest from degraded by 31 pp (54 pp in volatile hours) in v3.

**Follow-up: "Then why have a model at all?"** Because the fee law has a real tuning knob (retail cost vs LP revenue vs regime), and a pool operator may want a model that turns it. Oniblock makes that safe to try: bounded `k` (never ≥ 1), step limits, probation for new model names, and automatic, public demotion. Honest limit: the 0.25 Brier line is strict for noisy labels, so even the honest model was demoted for 13–20% of steps in the volatile windows (0% in calm). Demotion only ever means constant `kDefault`, so that costs nothing relative to what we recommend shipping.

**3. "Who can cheat? What do I have to trust?"**
- **The attestor** is a TEE stand-in. It is trusted to report the mid within the Chainlink band and to name the model truthfully. It could relabel a demoted model's scores as another *seasoned* allowlisted node until that node is demoted too. We document this (N-03).
- **The owner** can allowlist models instantly, which is bounded, because a new node starts on probation. Config, attestor and role-oracle changes are timelocked (1 h, with a 1-day grace). The owner should be a Safe.
- **What you do not have to trust:** the hook never reverts on bad data, a stale mid means the conservative fee rather than zero, `k < 1` always, and the fee is capped at `feeMax`.

We ran two internal review rounds. Round 1 found one High (a gate bypass by rotating model names), which is fixed. Round 2 found no Critical or High. There are 83 Foundry tests, including three invariants over 128k calls each.

**4. "Why ENS? Couldn't this be a mapping in the hook?"**
A mapping would give you an admin key with extra steps. ENSv2 gives us three things a mapping doesn't:
- **Role-scoped permissions on a public name.** The keeper's power is a custom EAC bit on `quoter.oniblock.eth`. Revoke it and the hook rejects the next attestation, which we fork-tested against the real Sepolia ENSv2.
- **A scorecard nobody else can edit.** The resolver grants the seven `calibration.*` text keys to the settler only. Even the name owner can't write them without a visible on-chain self-grant.
- **Stable identity for models.** `jev-v1.models.oniblock.eth` carries its model hash, agent context and calibration, and any client resolves it through UniversalResolverV2. To rotate a model you change a record; you don't redeploy.

**5. "Will real routers send flow to this? Isn't the oracle stale?"**
It is built for the hook allowlist:
- no custom `hookData`, because the keeper pushes the mid once per block and the hook reads storage;
- no proxy;
- verified source;
- no reverts in the swap path;
- `quoteFee` equals what `beforeSwap` charges, so quoters stay honest.

The honest limit is freshness. The gap is measured against the last posted mid, so an arb that lands before the keeper in a block sees the old mid and pays the base fee, like a vanilla pool. It never pays less than the base fee, and if posts stop for more than `staleBlocks` the pool goes stale and charges the conservative fee. Trading API routing needs Uniswap's manual allowlisting, which a testnet hackathon hook doesn't have, so the demo uses a test router.

## Lines to avoid on stage

Don't say "AI inside the hook" (the model is behind it), "we ended sandwiches", "the fee law beats a fixed fee in every window" (v1 only, no competition), "the model beats constant k", "the model reduces LVR", or "we built a prop AMM". Do say LVR, stale mid, informed flow, attested k, markout, calibration, fee law.
