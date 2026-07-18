// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RivoEscrow} from "../src/RivoEscrow.sol";

/// @dev USDC tiruan (6 desimal) untuk uji lokal.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RivoEscrowTest is Test {
    RivoEscrow internal escrow;
    MockUSDC internal usdc;

    address internal payer = address(0xB0B);
    address internal payee = address(0x5E11E4);
    address internal arbiter = address(0xA4B1);
    address internal relayer = address(0x9E14);
    address internal attacker = address(0xBAD);

    bytes32 internal constant ORDER = keccak256("order-1");
    uint256 internal constant AMOUNT = 120_000_000; // 120.00 USDC (6 desimal)

    uint64 internal shipDeadline;
    uint64 internal constant CONFIRM_WINDOW = 3 days;

    function setUp() public {
        escrow = new RivoEscrow();
        usdc = new MockUSDC();
        shipDeadline = uint64(block.timestamp + 7 days);

        usdc.mint(payer, AMOUNT);
        vm.prank(payer);
        usdc.approve(address(escrow), AMOUNT);
    }

    function _open() internal {
        escrow.open(ORDER, payee, arbiter, address(usdc), AMOUNT, shipDeadline, CONFIRM_WINDOW);
    }

    function _fund() internal {
        vm.prank(payer);
        escrow.fund(ORDER);
    }

    // --- jalur bahagia ---

    function test_fund_locksPayerAndEmitsAttribution() public {
        _open();
        vm.expectEmit(true, true, false, true);
        emit RivoEscrow.Deposited(ORDER, payer, AMOUNT);
        _fund();

        assertEq(escrow.getOrder(ORDER).payer, payer);
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    }

    function test_confirmReceipt_releasesToPayee() public {
        _open();
        _fund();
        vm.prank(payer);
        escrow.confirmReceipt(ORDER);

        assertEq(usdc.balanceOf(payee), AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_autoRelease_afterConfirmWindow_byAnyone() public {
        _open();
        _fund();
        vm.prank(payee);
        escrow.markShipped(ORDER);

        vm.warp(block.timestamp + CONFIRM_WINDOW + 1);
        vm.prank(relayer); // relayer boleh SUBMIT — otorisasi datang dari timeout
        escrow.autoRelease(ORDER);

        assertEq(usdc.balanceOf(payee), AMOUNT);
    }

    function test_claimRefund_afterShipDeadline_returnsFullAmount() public {
        _open();
        _fund();

        vm.warp(uint256(shipDeadline) + 1);
        vm.prank(relayer);
        escrow.claimRefund(ORDER);

        // Refund pra-rilis mengembalikan USDC asli — nol slippage (R3).
        assertEq(usdc.balanceOf(payer), AMOUNT);
    }

    // --- invariant non-custodial ---

    function test_relayerCannotRelease_beforeTimeout() public {
        _open();
        _fund();
        vm.prank(payee);
        escrow.markShipped(ORDER);

        vm.prank(relayer);
        vm.expectRevert(RivoEscrow.TooEarly.selector);
        escrow.autoRelease(ORDER);
    }

    function test_attackerCannotConfirmReceipt() public {
        _open();
        _fund();

        vm.prank(attacker);
        vm.expectRevert(RivoEscrow.NotAuthorized.selector);
        escrow.confirmReceipt(ORDER);
    }

    function test_arbiterCanOnlyChooseBetweenPayerAndPayee() public {
        _open();
        _fund();
        vm.prank(payee);
        escrow.markShipped(ORDER);
        vm.prank(payer);
        escrow.dispute(ORDER);

        vm.prank(arbiter);
        escrow.resolve(ORDER, false); // memihak pembeli

        // Dana hanya bisa mendarat di payer atau payee — tak ada pihak ketiga.
        assertEq(usdc.balanceOf(payer), AMOUNT);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_nonArbiterCannotResolve() public {
        _open();
        _fund();
        vm.prank(payee);
        escrow.markShipped(ORDER);
        vm.prank(payer);
        escrow.dispute(ORDER);

        vm.prank(relayer);
        vm.expectRevert(RivoEscrow.NotAuthorized.selector);
        escrow.resolve(ORDER, true);
    }

    function test_cannotDoubleRelease() public {
        _open();
        _fund();
        vm.prank(payer);
        escrow.confirmReceipt(ORDER);

        vm.prank(payer);
        vm.expectRevert(RivoEscrow.BadState.selector);
        escrow.confirmReceipt(ORDER);
    }

    /// @dev Atribusi: dua pembeli, barang identik → dua record terpisah.
    function test_twoBuyersIdenticalItems_haveDistinctAttribution() public {
        address payer2 = address(0xB0B2);
        bytes32 order2 = keccak256("order-2");
        usdc.mint(payer2, AMOUNT);
        vm.prank(payer2);
        usdc.approve(address(escrow), AMOUNT);

        _open();
        _fund();
        escrow.open(order2, payee, arbiter, address(usdc), AMOUNT, shipDeadline, CONFIRM_WINDOW);
        vm.prank(payer2);
        escrow.fund(order2);

        assertEq(escrow.getOrder(ORDER).payer, payer);
        assertEq(escrow.getOrder(order2).payer, payer2);
    }
}
