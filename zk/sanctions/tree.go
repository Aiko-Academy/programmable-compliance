package sanctions

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strings"

	"golang.org/x/crypto/sha3"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	nativemimc "github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
)

const (
	TypeAddress = 1
	TypeLEI     = 2
)

// Entry of a snapshot: an exact identifier, never a name.
type Entree struct {
	Type  string `json:"type"` // "address" or "lei"
	Id    string `json:"id"`   // 0x... address (20 bytes) or LEI (20 characters)
	Label string `json:"label,omitempty"`
}

// Snapshot: dated, hashed, labelled demonstration list. This is not an official compliance list.
type Snapshot struct {
	ListId  string   `json:"listId"`
	Version uint64   `json:"version"`
	Date    string   `json:"date"`
	Source  string   `json:"source"`
	Statut  string   `json:"statut"`
	Entries []Entree `json:"entries"`
}

func ParseSnapshot(b []byte) (*Snapshot, error) {
	var s Snapshot
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

// CCID: keccak256(lei) reduced to the BN254 field, like the policy (uint256(ccid) % FIELD).
func CCID(lei []byte) *big.Int {
	h := sha3.NewLegacyKeccak256()
	h.Write(lei)
	return new(big.Int).Mod(new(big.Int).SetBytes(h.Sum(nil)), fr.Modulus())
}

// IdOf: (numeric type, identifier as a field element). An address is worth its 160-bit integer; a
// LEI is worth its CCID reduced to the field.
func IdOf(typ, id string) (int, *big.Int, error) {
	switch strings.ToLower(typ) {
	case "address":
		s := strings.TrimPrefix(strings.ToLower(id), "0x")
		if len(s) != 40 {
			return 0, nil, fmt.Errorf("%d hex digits in address, expected 40", len(s))
		}
		v, ok := new(big.Int).SetString(s, 16)
		if !ok {
			return 0, nil, fmt.Errorf("non-hexadecimal address")
		}
		return TypeAddress, v, nil
	case "lei":
		if len(id) != 20 {
			return 0, nil, fmt.Errorf("%d characters in LEI, expected 20", len(id))
		}
		// The IdentityRegistry keeps only the CCID = keccak256(abi.encodePacked(bytes20 lei)): that is what the policy
		// reads on-chain, so that is what the list must carry.
		return TypeLEI, CCID([]byte(id)), nil
	}
	return 0, nil, fmt.Errorf("unknown identifier type %q", typ)
}

func hash2(a, b *fr.Element) fr.Element {
	h := nativemimc.NewMiMC()
	ab, bb := a.Bytes(), b.Bytes()
	h.Write(ab[:])
	h.Write(bb[:])
	var out fr.Element
	out.SetBytes(h.Sum(nil))
	return out
}

// Point: x = MiMC(type, id), the element ordered in the tree.
func Point(typ int, id *big.Int) fr.Element {
	var t, i fr.Element
	t.SetUint64(uint64(typ))
	i.SetBigInt(id)
	return hash2(&t, &i)
}

type Arbre struct {
	Valeurs  []fr.Element   // hashed identifiers, sorted, no duplicates
	Feuilles []fr.Element   // 2^Depth leaves
	niveaux  [][]fr.Element // niveaux[0] = leaves, last one = root
}

func Construire(s *Snapshot) (*Arbre, error) {
	vals := make([]fr.Element, 0, len(s.Entries))
	for i, e := range s.Entries {
		t, id, err := IdOf(e.Type, e.Id)
		if err != nil {
			return nil, fmt.Errorf("entry %d: %w", i, err)
		}
		vals = append(vals, Point(t, id))
	}
	sort.Slice(vals, func(i, j int) bool { return vals[i].Cmp(&vals[j]) < 0 })
	uniq := vals[:0]
	for i := range vals {
		if i == 0 || vals[i].Cmp(&vals[i-1]) != 0 {
			uniq = append(uniq, vals[i])
		}
	}
	vals = uniq
	if len(vals)+1 > 1<<Depth {
		return nil, fmt.Errorf("%d identifiers, capacity %d", len(vals), (1<<Depth)-1)
	}
	var zero, pMoins1 fr.Element
	pMoins1.SetBigInt(new(big.Int).Sub(fr.Modulus(), big.NewInt(1)))
	bornes := append(append([]fr.Element{zero}, vals...), pMoins1)
	for _, v := range vals {
		if v.IsZero() || v.Cmp(&pMoins1) == 0 {
			return nil, fmt.Errorf("identifier hashed onto a bound (impossible in practice)")
		}
	}
	feuilles := make([]fr.Element, 1<<Depth)
	for i := 0; i+1 < len(bornes); i++ {
		feuilles[i] = hash2(&bornes[i], &bornes[i+1])
	}
	niv := [][]fr.Element{feuilles}
	for l := 0; l < Depth; l++ {
		prev := niv[l]
		next := make([]fr.Element, len(prev)/2)
		for i := range next {
			next[i] = hash2(&prev[2*i], &prev[2*i+1])
		}
		niv = append(niv, next)
	}
	return &Arbre{Valeurs: vals, Feuilles: feuilles, niveaux: niv}, nil
}

func (a *Arbre) Racine() fr.Element { return a.niveaux[Depth][0] }

// Temoin: the interval that contains x and its path. Refused when x is in the list.
type Temoin struct {
	Low, High fr.Element
	Index     int
	Path      [Depth]fr.Element
}

var ErrDansLaListe = fmt.Errorf("the identifier is in the list: no proof of non-membership exists")

func (a *Arbre) Temoin(x fr.Element) (*Temoin, error) {
	// first index i such that valeurs[i] >= x
	i := sort.Search(len(a.Valeurs), func(k int) bool { return a.Valeurs[k].Cmp(&x) >= 0 })
	if i < len(a.Valeurs) && a.Valeurs[i].Cmp(&x) == 0 {
		return nil, ErrDansLaListe
	}
	var zero, pMoins1 fr.Element
	pMoins1.SetBigInt(new(big.Int).Sub(fr.Modulus(), big.NewInt(1)))
	t := &Temoin{Index: i}
	if i == 0 {
		t.Low = zero
	} else {
		t.Low = a.Valeurs[i-1]
	}
	if i == len(a.Valeurs) {
		t.High = pMoins1
	} else {
		t.High = a.Valeurs[i]
	}
	idx := i
	for l := 0; l < Depth; l++ {
		t.Path[l] = a.niveaux[l][idx^1]
		idx >>= 1
	}
	return t, nil
}
