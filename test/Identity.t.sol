// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.28;

// forge-std-free. Programmable Compliance identity layer (G3): CCID-LEI identity + vLEI/KYB credential registry +
// on-chain vLEI data validation (ported from demo-compliance). Backs the RFI check with a real credential.
//   forge test --match-contract Identity
import {VLEICredentialDataValidator} from "../contracts/identity/VLEICredentialDataValidator.sol";
import {IdentityRegistry as IdentityRegistry} from "../contracts/identity/IdentityRegistry.sol";
import {CredentialRegistry as CredentialRegistry} from "../contracts/identity/CredentialRegistry.sol";

contract IdentityTest {
    VLEICredentialDataValidator val;
    IdentityRegistry idReg;
    CredentialRegistry credReg;

    bytes32 KYB; // keccak256("common.kyb")
    bytes20 constant LEI = bytes20("5493001KJTIIGC8Y1R12"); // valid: 20 alphanumeric (digits + A-Z)
    bytes20 constant BAD_LEI = bytes20("5493001kjtiigc8y1r12"); // invalid: lowercase
    address constant WALLET = address(0xA11CE);

    function setUp() public {
        val = new VLEICredentialDataValidator();
        idReg = new IdentityRegistry(address(this));
        credReg = new CredentialRegistry(address(this));
        KYB = val.KYB_CREDENTIAL_TYPE();
        credReg.setDataValidator(KYB, address(val));
    }

    function _vlei(bytes20 lei) internal pure returns (bytes memory) {
        // 85 bytes: lei(20) + schemaSAID(32) + credSAID(32) + credType(1)
        return abi.encodePacked(lei, keccak256("schema"), keccak256("cred"), uint8(1));
    }

    // identity: a wallet resolves to the LEI-derived CCID; CCID lists its wallets
    function test_IdentityCcidFromLei() public {
        bytes32 ccid = idReg.registerIdentity(WALLET, LEI);
        require(ccid == idReg.ccidOf(LEI), "ccid != ccidOf(lei)");
        require(idReg.getIdentity(WALLET) == ccid, "getIdentity wrong");
        require(idReg.getAccounts(ccid).length == 1 && idReg.getAccounts(ccid)[0] == WALLET, "accounts wrong");
    }

    // a valid vLEI KYB credential registers + validates (existence + expiry + data format)
    function test_VleiCredentialValidates() public {
        bytes32 ccid = idReg.ccidOf(LEI);
        credReg.registerCredential(ccid, KYB, uint40(block.timestamp + 365 days), _vlei(LEI));
        require(credReg.isValid(ccid, KYB), "isValid false");
        require(credReg.validate(ccid, KYB), "validate false");
        require(val.validateCredentialData(KYB, _vlei(LEI)), "data invalid");
    }

    // a credential carrying a malformed LEI fails data validation (registered but invalid)
    function test_BadLeiRejected() public {
        bytes32 ccid = idReg.ccidOf(BAD_LEI);
        require(!val.validateCredentialData(KYB, _vlei(BAD_LEI)), "bad LEI passed validation");
        credReg.registerCredential(ccid, KYB, 0, _vlei(BAD_LEI));
        require(credReg.isValid(ccid, KYB), "should be registered (existence)");
        require(!credReg.validate(ccid, KYB), "bad-LEI credential validated");
    }

    // wrong credential type is not a KYB/vLEI credential
    function test_WrongTypeRejected() public view {
        require(!val.validateCredentialData(keccak256("common.other"), _vlei(LEI)), "wrong type passed");
    }

    // a past expiry is rejected at registration
    function test_PastExpiryReverts() public {
        bytes32 ccid = idReg.ccidOf(LEI);
        bool reverted;
        try credReg.registerCredential(ccid, KYB, uint40(block.timestamp), _vlei(LEI)) {}
        catch {
            reverted = true;
        }
        require(reverted, "past expiry not rejected");
    }

    // unregistered CCID → invalid
    function test_NotFoundInvalid() public view {
        require(!credReg.isValid(idReg.ccidOf(LEI), KYB), "unregistered should be invalid");
        require(!credReg.validate(idReg.ccidOf(LEI), KYB), "unregistered should not validate");
    }
}
