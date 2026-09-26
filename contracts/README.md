# Oniblock contracts

Foundry project for `OniblockHook` (Uniswap v4 hook). See the root [README](../README.md) for the design, file:line pointers, and how to run.

```bash
forge build
forge test                      # unit + fuzz + invariants (fork suite skipped)
FORK=1 SEPOLIA_RPC_HTTPS=... forge test --match-path test/fork/EnsSetup.t.sol
./smoke-local.sh 8571           # anvil smoke: deploy → attest → swap → Receipt
./export-abis.sh                # writes ../abis
```

Scripts: `script/DeployLocal.s.sol` (fresh anvil), `script/DeploySepolia.s.sol` (real v4 PoolManager, EnsV2RoleOracle), `script/EnsSetup.s.sol` (ENSv2 oniblock.eth, commit/finish phases), `script/bench/DeployBench.s.sol` (benchmark).
