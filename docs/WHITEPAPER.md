# Oniblock: Attested, Accountable Fees Against Informed Flow in Uniswap v4

**Oniblock team, ETHGlobal Tokyo 2026**

## Abstract

Liquidity providers (LPs) on constant-function market makers lose value to informed traders whenever the pool price is stale relative to the centralized-exchange (CEX) price. Flat fees do not address this: they tax informed and uninformed flow alike. We present Oniblock, a Uniswap v4 hook that charges an elevated fee only on swaps that move the pool toward an attested Binance mid-price, and only in blocks that a small calibrated model judges likely to carry informed arbitrage flow. A keeper posts an EIP-712 attestation each block containing the mid, a probability p, a confidence c and a model identifier; a settler grades every model against realised markouts, publishes Brier scores on-chain and to ENSv2, and automatically demotes models that fail a calibration bar. On 174,135 real (pool, block) rows from the mainnet Uniswap v3 USDC/WETH pools, the main empirical finding is that price freshness dominates: the label is decided mostly by the Binance move in the roughly 12 seconds after the snapshot, and ranking quality rises from AUC 0.77 with past-only features to 0.947 with a 2-second-old price. On a held-out test period, oniblock's gradient-boosted scorer charges 45.2% of decisive blocks with 95.1% precision at a 5.6% false-positive rate. In a replay benchmark against a vanilla neighbouring pool, LP gains are positive in every volatile hour but the confidence intervals over six windows include zero. We report these limitations plainly.

## 1. Introduction

An automated market maker quotes a price that updates only when someone trades against it. Between trades, the external reference price moves, and the first trader to correct the discrepancy captures the difference at the LP's expense. Milionis, Moallemi, Roughgarden and Zhang formalise this cost as loss-versus-rebalancing (LVR) [3]. The effect is large in practice: Heimbach et al. estimate that more than 25% of volume on the top five Ethereum DEXes is non-atomic (CEX-DEX) arbitrage [4].

Public MEV datasets illustrate the scale and structure of adversarial on-chain flow. EigenPhi publishes a public sample of labelled MEV transactions on Kaggle [1], and its reporting shows that sandwich extraction has declined from roughly $10M per month in late 2024 to roughly $2.5M per month by October 2025, with an average of about $3 per attack [2]. Sandwiching is increasingly contained by private order flow; CEX-DEX arbitrage, which is the dominant source of LVR, is not addressed by those defences, because the arbitrageur is not exploiting a victim transaction but a stale pool price.

Uniswap v4 hooks [7] allow a pool to set its fee per swap. Oniblock uses this to target the fee: swaps that correct a stale price toward the CEX mid pay more in blocks where such flow is likely informed; all other swaps pay the base fee. Because a mispriced model could harm LPs or traders, the design pairs the pricing mechanism with an accountability layer that grades models in public and removes badly calibrated ones automatically.

Contributions: (i) a hook mechanism with a charge gate that keeps the pool exactly vanilla below a threshold; (ii) an on-chain accountability loop (Brier grading, automatic demotion, ENSv2 roles and model hashes); (iii) an empirical study on real mainnet data showing that price freshness, not model capacity, is the binding constraint; (iv) a replay benchmark of LP outcomes under routing competition.

## 2. Related Work

Nezlobin proposes directional fees that charge more to trades in the direction of the latest price move [6]. Detox-Hook sets fees from the gap between pool and oracle price, and an LVR-minimising hook design applies a similar principle. The auction-managed AMM (am-AMM) of Adams, Moallemi, Reynolds and Robinson auctions the right to act as pool manager, capturing arbitrage value through the auction [5]. Application-specific sequencing, for example Sorella's Angstrom, reorders or batches swaps to return arbitrage value to LPs. Oniblock is closest to the oracle-gap approach but differs in three respects: the fee is gated by a calibrated per-block probability rather than applied to every gap; the pricing model is graded and replaceable on-chain; and the hook falls back to vanilla behaviour whenever the model is uncertain or its attestation is stale.

## 3. Mechanism

### 3.1 Fee rule

Let m be the attested Binance mid (USDC per ETH), P the pool price, and gap = |P - m| / m. A swap is *toward* the mid if it reduces the gap. For such swaps the hook charges

fee = min(base + k * gap, feeMax),

and all other swaps pay base. The slope is k = kMax * p * c with kMax = 0.8, where p is the posted probability that the block's arbitrage-direction flow is informed and c is a confidence term.

Within a block the hook fixes an anchor and tracks a per-direction high-water gap, so an arbitrageur who splits a correction into several small swaps pays the fee implied by the full gap rather than by each residual. If the attestation is stale, the hook applies a conservative fee. The hook never reverts in the swap path: every failure mode degrades to a defined fee.

### 3.2 Attestation and charge gate

A keeper signs an EIP-712 attestation (m, p, c, model id) each block. The posted probability p is kept honest, i.e. it is the model's calibrated output and is what the settler grades. Charging is controlled separately through c: c = 1 only when p >= t, and c = 0 otherwise, so below the threshold k = 0 and the pool behaves exactly as a vanilla pool. The threshold t is re-derived by the settler over a trailing seven-day window as the value that keeps the false-positive rate at or below 5%. The keeper posts only when an attestation would change pricing, which reduces posts by approximately 43-63%.

### 3.3 Accountability

A settler grades every block against realised markouts using the dead-band labels of Section 5 and writes each model's Brier score (mean squared error between p and the 0/1 outcome) on-chain and to its ENSv2 record [8]. A model with Brier score above 0.25, the score of a constant 0.5 forecast, is demoted to k = 0 automatically. ENSv2 roles determine who may post attestations, so revoking a role acts as a kill switch. Each model's ENS record carries the SHA-256 hash of its weights (model-hash), allowing anyone to verify which weights produced a graded series of attestations. The attestor is trusted within a Chainlink price band.

## 4. Model

The deployed decision model is a TypeSafe "System One" model [9]: Kev-0.8B, a LoRA fine-tune of Qwen3.5-0.8B, which answers one typed question per block, "is this block's arbitrage-direction flow informed?", with a calibrated probability, served in about 15 ms locally. It is distilled from oniblock's gradient-boosted scorer, an ensemble of 216 trees over 17 per-block features: price gap; edge versus fee; edge in units of 12-second volatility; 5-minute volatility; signed Binance returns over 12 s, 36 s and 15 min; flow imbalance; swap count and arbitrage share; and size-to-depth.

## 5. Data and Labels

We use 174,135 real (pool, block) rows from the mainnet Uniswap v3 USDC/WETH 0.05% and 0.30% pools, 31 July to 25 September 2026, joined with Binance 1-second mids computed as USDC per ETH = ETHUSDT / USDCUSDT. The label is positive when the block's arbitrage-direction swaps were profitable against Binance after the base fee. A dead band retains only decisive blocks, |markout| > max($1, 1 bp of arbitrage volume), yielding 26,925 / 11,842 / 12,837 train / validation / test blocks in time order. A leakage audit found no forward-looking features. The EigenPhi sample [1] was not used for training or evaluation; it is cited as public context only.

## 6. Price Freshness

The label is decided mostly by the Binance move in the approximately 12 seconds after the feature snapshot. With past-only features the validation AUC is about 0.77; with a Binance price read 2 seconds before the block it is 0.947. The share of toxic blocks caught at a 5% false-positive rate depends strongly on price age: about 16% at 22 s, 25% at 11 s, 52% at 6 s and 79-85% at 1-2 s. The deployment consequence is that the keeper's attestation must be first in the block, placed by a cooperating builder, with a Binance read about 2 seconds before the block.

## 7. Evaluation

### 7.1 Metric

The hook charges if and only if p >= t. We report the pass rate, toxic charged / charged (precision), and the false-positive rate, benign charged / all benign. The design target is pass rate >= 75% with FPR < 7%. We also report the share of toxic blocks caught (recall) and AUC.

### 7.2 Held-out results

The test period is 15-25 September 2026 and was never used for any modelling or threshold choice. Table 1 reports the 3,000-block test subset.

**Table 1.** Held-out test (test_3k subset, 3,000 decisive blocks).

| Policy | Blocks charged | Pass rate | FPR | Toxic caught | AUC |
|---|---|---|---|---|---|
| No hook (vanilla) | 0% | n/a | 0% | 0% | n/a |
| Jev (hosted TypeSafe model, as deployed: premium on every block) | 100% | 59.9% | 100% | 100% | 0.605 |
| oniblock (keeper first in block, 2 s price, rolling threshold) | 45.2% | 95.1% | 5.6% | 71.7% | 0.929 |

*oniblock results are for its gradient-boosted scorer; the System One model is distilled from it (training in progress); the currently published System One weights (trained on 11 s-old prices) reach 77.3% pass and 6.2% FPR on the same test.*

On the full test set (12,837 blocks), oniblock reaches a pass rate of 95.4% [94.2, 96.6], an FPR of 5.5% [4.2, 6.8], and catches 72.7% of toxic blocks (95% day-block bootstrap confidence intervals). Both targets are met.

### 7.3 LP benchmark

We replay mainnet 12-second blocks driven by real Binance 1-second klines. A hooked pool competes with a vanilla neighbour for routed retail flow and two arbitrageurs; both pools hold $20M. We evaluate six one-hour windows, the three most volatile and three calm hours of 60 days. Results are net of keeper gas at 1 gwei and before any payment to the builder; intervals are 95% Student-t over windows.

**Table 2.** LP gain of the hooked pool relative to vanilla (basis points of pool value per hour).

| Configuration | 0.05% tier | 0.30% tier |
|---|---|---|
| oniblock, keeper first in block | +0.507 bps/h [-0.21, 1.23] (about +$1,014/h); 3/3 volatile hours positive | +0.289 bps/h [-0.14, 0.72] (about +$578/h); 3/3 volatile hours positive |
| oniblock, no builder deal | +0.037 bps/h | +0.160 bps/h |

All gain occurs in volatile hours; calm hours are about -0.01 bps/h, which is the keeper's gas cost. A heuristic scorer at the same timing earns roughly the same LP gain. We interpret this as follows: the LP benefit comes from price freshness plus first position in the block, while the model's contribution is precision, i.e. few benign blocks are overcharged, which matters for traders and for routing share. The break-even payment to the builder is about $3.4 per block in the 0.05% tier and $1.9 in the 0.30% tier.

## 8. Discussion

The results reframe the problem. Model capacity is not the binding constraint on detecting informed flow; information timing is. With a 22-second-old price, even a good model catches few toxic blocks at an acceptable false-positive rate; with a 2-second-old price and first position, a compact model catches most of them. This makes builder cooperation part of the mechanism, and it makes the accountability layer important: a model with a privileged position in every block should be graded publicly and removable without governance delay. The charge gate keeps the downside bounded. When the model is uncertain, the pool is exactly vanilla, so the worst case of a silent or demoted model is the status quo rather than a mispriced pool.

## 9. Limitations

- Freshness requires top-of-block placement, which on mainnet requires builder cooperation. Without it, gains fall to +0.037 and +0.160 bps/h.
- All benchmark confidence intervals include zero; six windows are too few for a significant result.
- The benchmark hours fall inside the training period. The held-out test (Section 7.2) is the out-of-sample evidence.
- Classification metrics cover decisive (dead-band) blocks. Over all blocks, precision is 91.4%.
- Routing competition moves retail flow to vanilla pools when fees rise; the benchmark models one neighbour, not the full routing landscape.
- The attestor is trusted within a Chainlink band.
- The deployed System One weights currently trail the gradient-boosted scorer (77.3% pass, 6.2% FPR) because they were trained on 11-second-old prices; distillation at 2-second freshness is in progress.

## 10. Conclusion

Oniblock charges informed arbitrage flow in Uniswap v4 pools through a narrow, gated fee, driven by attested per-block predictions from a small calibrated model whose record is graded on-chain. On real mainnet data the approach meets its precision and false-positive targets out of sample. The empirical lesson is that fresh prices and block position determine whether informed flow can be priced at all; the model's job is to do so without overcharging everyone else.

## References

[1] EigenPhi. DeFi Sample Data (Kaggle dataset). Public sample of labelled MEV transactions published by EigenPhi. https://www.kaggle.com/datasets/eigenphi/defi-sample-data

[2] EigenPhi. Sandwich MEV market reports (Wisdom of DeFi), 2024-2025. https://eigenphi.io/

[3] J. Milionis, C. C. Moallemi, T. Roughgarden, A. L. Zhang. Automated Market Making and Loss-Versus-Rebalancing. arXiv:2208.06046, 2022.

[4] L. Heimbach, V. Pahari, E. Schertenleib. Non-Atomic Arbitrage in Decentralized Finance. IEEE Symposium on Security and Privacy (S&P), 2024.

[5] A. Adams, C. C. Moallemi, S. Reynolds, D. Robinson. am-AMM: An Auction-Managed Automated Market Maker. arXiv:2403.03367, 2024.

[6] A. Nezlobin. Directional fees for AMMs. 2023.

[7] Uniswap Labs. Uniswap v4 Hooks documentation. https://docs.uniswap.org/contracts/v4/concepts/hooks

[8] ENS Labs. ENSv2. https://ens.domains/

[9] J. Palmer et al. TypeSafe System One / Kev. https://github.com/jaredpalmer/kev
