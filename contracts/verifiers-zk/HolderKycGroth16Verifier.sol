// SPDX-License-Identifier: GPL-3.0
// Provenance: src/uc3/compliance/KycCpGroth16Verifier.sol (onchain-fx-markets, GPL-3.0, generated from a circuit under that licence), taken as is; only the contract name and the import paths change.
// The code deployed on Hoodi is this one, byte for byte apart from metadata.
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract HolderKycGroth16Verifier {
    // Scalar field size
    uint256 constant r = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax = 4542939091837502363671882640369804921764776628062732589973203085518213575210;
    uint256 constant alphay = 13699480075080390131847110276737556567107266685751523334622925688108213296559;
    uint256 constant betax1 = 9300514746831057684302269115925884144973696456681533802879228524924511477260;
    uint256 constant betax2 = 10091812778468064829320829589293750521501042989813882266788306137672360910366;
    uint256 constant betay1 = 13536159834244984910850911354032702318754078519752134086360524222033276834950;
    uint256 constant betay2 = 18932655298002808607033907135799930464454818884807372922766223584935733508044;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 14259239915811703768592763235333393374972343041428764572123443040595376131039;
    uint256 constant deltax2 = 17754856481805291958911391190266247850230987750092984812717119132258632169869;
    uint256 constant deltay1 = 9168407897579704090285351469447746478065281817218090400340736300410970144444;
    uint256 constant deltay2 = 4271857432127076125459890600228869646268610023570051236422846741682892943916;

    uint256 constant IC0x = 4775774560295816514214551397221097879014636325994581031713956100636303948839;
    uint256 constant IC0y = 13221371716460220520604502348047991661570620430573848388203251180110168457389;

    uint256 constant IC1x = 16707404756838359555733082401274074472304883090895219229938286369087447119584;
    uint256 constant IC1y = 3032650748203643714452642486750875080236999720919511381016119534982585887497;

    uint256 constant IC2x = 6253451693975599422129351781610914914182826504960131403472611531959068979870;
    uint256 constant IC2y = 8635951972928575970226288411217735844586359485813302127458284353973630013834;

    uint256 constant IC3x = 1174288465679868825535890119997433058980352982437099860777575462304957308230;
    uint256 constant IC3y = 11052512938845863612391901596182363975186885791187814604562132698510388055729;

    uint256 constant IC4x = 10329041229333057694925996207683787220016788288568606348520627086750249803739;
    uint256 constant IC4y = 5749658408811421324324222026385838284313347272168630588113321677749813736447;

    uint256 constant IC5x = 13665612507934288946483418315069233893810571230201962831470355315088119560455;
    uint256 constant IC5y = 18398326406031221646418821071606504127868613407076144877430372159183863486126;

    uint256 constant IC6x = 9267152237670165172153565784025467674323793792800917709752283976086295377118;
    uint256 constant IC6y = 10035861263697896258411373204052815943847153258138843476681214332482023158052;

    uint256 constant IC7x = 8730016573348674164817358897619120327661690675620389715635308079470894940500;
    uint256 constant IC7y = 15535032425249893659186448972150973700322459486127556988556512735018581424442;

    uint256 constant IC8x = 9677259716628474424436286670040973785487787172099851636678399146114489071098;
    uint256 constant IC8y = 11303998706386074279902712394217011634775370933384819950659213608535788181795;

    uint256 constant IC9x = 13569347866949521690444124328498317132502133425027639297504189800126227683843;
    uint256 constant IC9y = 5674187061548179779281421849088539566503277037523976456965225122397442684262;

    uint256 constant IC10x = 5679936440894546189995461256759047198748970760684547916115673926548670153810;
    uint256 constant IC10y = 10772296983022568198993468978459322147803311437547899441851426684762097415954;

    uint256 constant IC11x = 7510213607254398255892817405805801097770989413665683508643254295026554946023;
    uint256 constant IC11y = 14219214177001271397425030168288629199686300054246463833599472249703686973463;

    uint256 constant IC12x = 5959135707600283848223010997679138992769450195425836813844357616406103634041;
    uint256 constant IC12y = 19426818291944252069893324148651671688735420407196730775614299633684124500309;

    uint256 constant IC13x = 8826415655187461443282637272768909508839180909311602076586879948454017749962;
    uint256 constant IC13y = 4200960691780812357556533825796742506614546343993776845708834769139368881874;

    uint256 constant IC14x = 914239010037792270337182654516079631233070000431458904250447903943585866268;
    uint256 constant IC14y = 6585973383671628208490752490789617314654694291657609871829092605289449859373;

    uint256 constant IC15x = 19295975998291333857381178964097468905531974822711076100893633709946844988245;
    uint256 constant IC15y = 13640179818392036437413724025556116121216495777699614827521539973867347553506;

    uint256 constant IC16x = 15382668955061311325265644905178700956433573879912376044304219975122561547216;
    uint256 constant IC16y = 19726121338651678609438138226316553501046338534502255780580474490296243873857;

    uint256 constant IC17x = 3988989796752014130910585630781781365673073552161121354819279975046234220074;
    uint256 constant IC17y = 12431411084290923152081504086618473257287882123205102295691787218270258898080;

    uint256 constant IC18x = 12892535906057442831293070303096695604580946156864454437319308376076765574722;
    uint256 constant IC18y = 10203870077596098614693494728769868106789237246004835812276476558598279515934;

    uint256 constant IC19x = 4736248353566676324933521429601085202813371551869579702538721205578881963672;
    uint256 constant IC19y = 19432278850254931259822311256918007299212456206576840294762828812474560435119;

    uint256 constant IC20x = 10075372632363550097054592045989511752791939180085888872592537171044159151097;
    uint256 constant IC20y = 16805716835453711042754989332882274224452316074749573371055339106532669458791;

    uint256 constant IC21x = 4551080404192001775436050582090837058939364946131327607040590728581306744930;
    uint256 constant IC21y = 2708282451631909099397676024943907250956652181413741753410576370365755444594;

    uint256 constant IC22x = 8266315089349685667361053727600672647854601611033139897268119186965550584525;
    uint256 constant IC22y = 1277227327302580721829828291737829590859378041241119257983470797086571320392;

    uint256 constant IC23x = 19929233673935040599172089388973191769302907193701056385746876694373685222356;
    uint256 constant IC23y = 5105231716888066496604016522075328580523034670941620677149892318346063000746;

    uint256 constant IC24x = 16288592452472390963194114772928156532403538587971446568361915902467513217831;
    uint256 constant IC24y = 16808368786061786939311042448440887006146464485141521852985110085790611328800;

    uint256 constant IC25x = 6220533005246870671682783312896445417396612739515441743834102215441829434153;
    uint256 constant IC25y = 10426809591656120308850952601841895703245380507200027031938951681831154440559;

    uint256 constant IC26x = 3970137264831061746628556898371130140501242127905723063384367818421023029227;
    uint256 constant IC26y = 17714008960606390355622616742996468308157419198307746935350339639179789812520;

    uint256 constant IC27x = 11759869358128638449178257130061827897270455253628966494609884638975969213860;
    uint256 constant IC27y = 16830724772800155955914552359796225658294413277226976319705843236258707837581;

    uint256 constant IC28x = 9602810078316205337620737321769358164688895209624665658175259447391139990573;
    uint256 constant IC28y = 1396652087057306218984171667244405217844079260158171297848028299702260162456;

    uint256 constant IC29x = 18060536322531605538758273849968231898837418095433774400241783304774339091231;
    uint256 constant IC29y = 6621916334496905555892960183859909613141952836143695617454708809555687891934;

    uint256 constant IC30x = 12924409863044790683131346594925413010613389852128244159757520680359858699742;
    uint256 constant IC30y = 7257928032155611466781623026877137024469894187312447771357801082285904108001;

    uint256 constant IC31x = 15921043556771114677552691791871792911813074683707859543253313707560927996753;
    uint256 constant IC31y = 11553362982398115346535749288770287466275124074452474979727207138581176697336;

    uint256 constant IC32x = 21270501761991835018774868105272313850358031857327060303985392600652635971477;
    uint256 constant IC32y = 722344563371317812318740268498755157568078485588298267790280188048851076630;

    uint256 constant IC33x = 5945161664034691457988552809683160903794923531108101542161116934159693958481;
    uint256 constant IC33y = 14355608010818081055025294053902154118868690014325215127668002010333056158233;

    uint256 constant IC34x = 2837708801101506760067984946260592542088512248947759432342775744386740374373;
    uint256 constant IC34y = 1595502927140142229873876239572599881477825692870396130603925193828303974023;

    uint256 constant IC35x = 8485849086033852382497415744104292291078144873761910156011582533670024067521;
    uint256 constant IC35y = 6179000178006187422139057554619882182926745901586516561686860220068989352595;

    uint256 constant IC36x = 12166894649934729446942505916168633511478877560555307461898550713807651820101;
    uint256 constant IC36y = 7492351915463544225566156744279982167067927795591508159021208675017491797092;

    uint256 constant IC37x = 5397723892042678285909927673307902608446292769180609255243892951712002488893;
    uint256 constant IC37y = 5371951967865333995925454256737771787800546638070932496465577335079323526349;

    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[37] calldata _pubSignals
    ) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))

                g1_mulAccC(_pVk, IC26x, IC26y, calldataload(add(pubSignals, 800)))

                g1_mulAccC(_pVk, IC27x, IC27y, calldataload(add(pubSignals, 832)))

                g1_mulAccC(_pVk, IC28x, IC28y, calldataload(add(pubSignals, 864)))

                g1_mulAccC(_pVk, IC29x, IC29y, calldataload(add(pubSignals, 896)))

                g1_mulAccC(_pVk, IC30x, IC30y, calldataload(add(pubSignals, 928)))

                g1_mulAccC(_pVk, IC31x, IC31y, calldataload(add(pubSignals, 960)))

                g1_mulAccC(_pVk, IC32x, IC32y, calldataload(add(pubSignals, 992)))

                g1_mulAccC(_pVk, IC33x, IC33y, calldataload(add(pubSignals, 1024)))

                g1_mulAccC(_pVk, IC34x, IC34y, calldataload(add(pubSignals, 1056)))

                g1_mulAccC(_pVk, IC35x, IC35y, calldataload(add(pubSignals, 1088)))

                g1_mulAccC(_pVk, IC36x, IC36y, calldataload(add(pubSignals, 1120)))

                g1_mulAccC(_pVk, IC37x, IC37y, calldataload(add(pubSignals, 1152)))

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))

                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)

                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))

            checkField(calldataload(add(_pubSignals, 800)))

            checkField(calldataload(add(_pubSignals, 832)))

            checkField(calldataload(add(_pubSignals, 864)))

            checkField(calldataload(add(_pubSignals, 896)))

            checkField(calldataload(add(_pubSignals, 928)))

            checkField(calldataload(add(_pubSignals, 960)))

            checkField(calldataload(add(_pubSignals, 992)))

            checkField(calldataload(add(_pubSignals, 1024)))

            checkField(calldataload(add(_pubSignals, 1056)))

            checkField(calldataload(add(_pubSignals, 1088)))

            checkField(calldataload(add(_pubSignals, 1120)))

            checkField(calldataload(add(_pubSignals, 1152)))

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
            return(0, 0x20)
        }
    }
}
