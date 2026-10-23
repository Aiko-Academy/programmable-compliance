package sanctions

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"golang.org/x/crypto/sha3"
)

func Keccak(b ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, x := range b {
		h.Write(x)
	}
	return h.Sum(nil)
}

func word(b []byte) []byte { // right-aligned over 32 bytes (address, integer)
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func hexBytes(s string, n int) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.ToLower(s), "0x"))
	if err != nil || len(b) != n {
		return nil, fmt.Errorf("%q: %d hex bytes expected", s, n)
	}
	return b, nil
}

// Liaison: keccak256(abi.encode(subject, uetr, from, to, amount, chainid)) mod p, like AtelierZkSanctionsPolicy.bindingOf.
// uetr is a bytes16: abi.encode left-aligns it over 32 bytes.
func Liaison(subject, uetr, from, to string, amount, chainid *big.Int) (*big.Int, error) {
	s, err := hexBytes(subject, 20)
	if err != nil {
		return nil, err
	}
	u, err := hexBytes(uetr, 16)
	if err != nil {
		return nil, err
	}
	f, err := hexBytes(from, 20)
	if err != nil {
		return nil, err
	}
	t, err := hexBytes(to, 20)
	if err != nil {
		return nil, err
	}
	uw := make([]byte, 32)
	copy(uw, u)
	h := Keccak(word(s), uw, word(f), word(t), word(amount.Bytes()), word(chainid.Bytes()))
	return new(big.Int).Mod(new(big.Int).SetBytes(h), fr.Modulus()), nil
}

// LiaisonFourchette: the binding of the ARRIVAL leg, where the amount delivered by the pool is only known within an
// attested range. keccak256(abi.encode(subject, uetr, originator, beneficiary, min, max, chainid)) mod p, like
// AtelierZkSanctionsArrivalPolicy.rangeBindingOf. The originator is the original economic party, not the
// composer who carries the transfer.
func LiaisonFourchette(subject, uetr, originator, beneficiary string, min, max, chainid *big.Int) (*big.Int, error) {
	s, err := hexBytes(subject, 20)
	if err != nil {
		return nil, err
	}
	u, err := hexBytes(uetr, 16)
	if err != nil {
		return nil, err
	}
	o, err := hexBytes(originator, 20)
	if err != nil {
		return nil, err
	}
	b, err := hexBytes(beneficiary, 20)
	if err != nil {
		return nil, err
	}
	if min.Cmp(max) > 0 {
		return nil, fmt.Errorf("inverted range: min %s > max %s", min, max)
	}
	uw := make([]byte, 32)
	copy(uw, u)
	h := Keccak(word(s), uw, word(o), word(b), word(min.Bytes()), word(max.Bytes()), word(chainid.Bytes()))
	return new(big.Int).Mod(new(big.Int).SetBytes(h), fr.Modulus()), nil
}
