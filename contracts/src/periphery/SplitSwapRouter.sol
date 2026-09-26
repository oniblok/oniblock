// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/utils/CurrencySettler.sol";

/// @title SplitSwapRouter
/// @notice Minimal ERC20 swap router for tests, bots and the demo. `swapSplit` executes N equal sub-swaps inside a
/// single PoolManager unlock (one tx) — the split-swap attack the per-block anchor is designed to defeat.
/// Sends empty hookData (like Uniswap's routers). Payer must approve this router for the input token.
/// NOT for production use (no deadline / min-out; use sqrtPriceLimitX96 for price protection).
contract SplitSwapRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable manager;

    struct CallbackData {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified; // < 0 exact input, > 0 exact output (per v4 convention), split evenly
        uint256 parts;
        uint160 sqrtPriceLimitX96; // 0 => no limit
    }

    error NotManager();
    error ZeroParts();
    error NativeNotSupported();

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    /// @notice Single swap. Returns the swapper's net delta (negative = paid, positive = received).
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, address recipient)
        external
        returns (BalanceDelta)
    {
        return _run(CallbackData(msg.sender, recipient, key, zeroForOne, amountSpecified, 1, sqrtPriceLimitX96));
    }

    /// @notice `parts` sub-swaps of amountSpecified/parts (remainder on the last) in ONE unlock. Returns summed delta.
    function swapSplit(
        PoolKey calldata key,
        bool zeroForOne,
        int256 amountSpecified,
        uint256 parts,
        uint160 sqrtPriceLimitX96,
        address recipient
    ) external returns (BalanceDelta) {
        if (parts == 0) revert ZeroParts();
        return _run(CallbackData(msg.sender, recipient, key, zeroForOne, amountSpecified, parts, sqrtPriceLimitX96));
    }

    function _run(CallbackData memory d) internal returns (BalanceDelta delta) {
        if (d.key.currency0.isAddressZero()) revert NativeNotSupported();
        delta = abi.decode(manager.unlock(abi.encode(d)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));
        uint160 limit = d.sqrtPriceLimitX96 != 0
            ? d.sqrtPriceLimitX96
            : (d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);

        int256 part = d.amountSpecified / int256(d.parts);
        int256 a0;
        int256 a1;
        for (uint256 i = 0; i < d.parts; i++) {
            int256 amt = i == d.parts - 1 ? d.amountSpecified - part * int256(d.parts - 1) : part;
            if (amt == 0) continue;
            BalanceDelta sd = manager.swap(d.key, SwapParams(d.zeroForOne, amt, limit), "");
            a0 += sd.amount0();
            a1 += sd.amount1();
        }
        _settleOrTake(d.key.currency0, a0, d.payer, d.recipient);
        _settleOrTake(d.key.currency1, a1, d.payer, d.recipient);
        return abi.encode(toBalanceDelta(int128(a0), int128(a1)));
    }

    function _settleOrTake(Currency c, int256 amt, address payer, address recipient) internal {
        if (amt < 0) c.settle(manager, payer, uint256(-amt), false);
        else if (amt > 0) c.take(manager, recipient, uint256(amt), false);
    }
}
