// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RivoEscrow} from "../src/RivoEscrow.sol";

/// @dev forge script script/Deploy.s.sol --rpc-url $ARC_RPC --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        RivoEscrow escrow = new RivoEscrow();
        vm.stopBroadcast();

        console.log("RivoEscrow deployed:", address(escrow));
        console.log("Set ESCROW_ADDRESS in .env to the address above");
    }
}
