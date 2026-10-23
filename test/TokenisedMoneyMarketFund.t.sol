// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

// Roles of the tMMF mock: the fund manager sets the NAV, the issuer issues and redeems, nobody else does either.
//   forge test --match-contract TokenisedMoneyMarketFund
import {Test} from "forge-std/Test.sol";
import {TokenisedMoneyMarketFund} from "../contracts/mocks/TokenisedMoneyMarketFund.sol";

contract TokenisedMoneyMarketFundTest is Test {
    TokenisedMoneyMarketFund t;
    address constant ADMIN = address(0xAD);
    address constant FUND_MANAGER_A = address(0xFA);
    address constant ISSUER_A = address(0x15);
    address constant FI_A = address(0xA1);
    address constant STRANGER = address(0xBAD);

    function setUp() public {
        t = new TokenisedMoneyMarketFund("Tokenised Money Market Fund 1 (representation)", "tMMF1", 18, 107e16, "USD", ADMIN);
        vm.startPrank(ADMIN);
        t.grantRole(t.FUND_MANAGER_ROLE(), FUND_MANAGER_A);
        t.grantRole(t.ISSUER_ROLE(), ISSUER_A);
        vm.stopPrank();
    }

    function test_fundManagerSetsTheNav() public {
        vm.prank(FUND_MANAGER_A);
        t.setNav(108e16);
        assertEq(t.navPerShare(), 108e16);
    }

    function test_issuerIssuesAndRedeems() public {
        vm.startPrank(ISSUER_A);
        t.mint(FI_A, 100e18);
        assertEq(t.balanceOf(FI_A), 100e18);
        t.burn(FI_A, 40e18);
        vm.stopPrank();
        assertEq(t.balanceOf(FI_A), 60e18);
    }

    function test_issuerCannotSetTheNav() public {
        vm.prank(ISSUER_A);
        vm.expectRevert();
        t.setNav(1);
    }

    function test_fundManagerCannotIssue() public {
        vm.prank(FUND_MANAGER_A);
        vm.expectRevert();
        t.mint(FI_A, 1);
    }

    function test_strangerCanDoNeither() public {
        vm.startPrank(STRANGER);
        vm.expectRevert();
        t.mint(FI_A, 1);
        vm.expectRevert();
        t.setNav(1);
        vm.stopPrank();
    }
}
