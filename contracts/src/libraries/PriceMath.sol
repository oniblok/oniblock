// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Helpers for the Oniblock price convention: priceX96 = (raw token1 per raw token0) * 2^96.
/// Used by scripts/tests; the keeper mirrors `usdToPriceX96` off-chain.
library PriceMath {
    uint256 internal constant Q96 = 1 << 96;

    /// @param usdE8 USD per 1 whole base token (e.g. ETH), 8 decimals (Chainlink style)
    /// @param baseIsToken0 true if the base token (mWETH) is currency0
    /// @param baseDec base token decimals (18), @param quoteDec quote token decimals (6)
    function usdToPriceX96(uint256 usdE8, bool baseIsToken0, uint8 baseDec, uint8 quoteDec)
        internal
        pure
        returns (uint256)
    {
        if (baseIsToken0) {
            // token1 (quote raw) per token0 (base raw) = usd * 10^quoteDec / 10^baseDec
            return FullMath.mulDiv(usdE8 * 10 ** quoteDec, Q96, 10 ** (8 + uint256(baseDec)));
        } else {
            // token1 (base raw) per token0 (quote raw) = 10^baseDec / (usd * 10^quoteDec)
            return FullMath.mulDiv(10 ** (8 + uint256(baseDec)), Q96, usdE8 * 10 ** quoteDec);
        }
    }

    /// @notice sqrtPriceX96 = sqrt(priceX96 * 2^96). Valid for priceX96 < 2^160.
    function priceX96ToSqrtPriceX96(uint256 priceX96) internal pure returns (uint160) {
        return uint160(Math.sqrt(priceX96 << 96));
    }

    function sqrtPriceX96ToPriceX96(uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(sqrtP, sqrtP, Q96);
    }
}
