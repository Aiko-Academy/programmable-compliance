package sanctions

import (
	"math/big"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/test"
)

type muted struct {
	Circuit
	mut Mutation
}

func (m *muted) Define(api frontend.API) error { return m.DefineMuted(api, m.mut) }

func snap(adresses ...string) *Snapshot {
	s := &Snapshot{ListId: "demo"}
	for _, a := range adresses {
		s.Entries = append(s.Entries, Entree{Type: "address", Id: a})
	}
	return s
}

const (
	a1 = "0x1111111111111111111111111111111111111111"
	a2 = "0x2222222222222222222222222222222222222222"
	a3 = "0x3333333333333333333333333333333333333333"
	ok = "0x4444444444444444444444444444444444444444" // never listed
)

func assignment(t *testing.T, a *Arbre, idHex string, binding int64) (*Circuit, *Temoin) {
	t.Helper()
	typ, id, err := IdOf("address", idHex)
	if err != nil {
		t.Fatal(err)
	}
	x := Point(typ, id)
	tm, err := a.Temoin(x)
	if err != nil {
		return nil, nil
	}
	c := &Circuit{Low: tm.Low, High: tm.High, Index: tm.Index, Root: a.Racine(), Binding: binding, IdType: typ, Id: id}
	for i := range tm.Path {
		c.Path[i] = tm.Path[i]
	}
	return c, tm
}

func resolu(c *Circuit, mut Mutation) error {
	if mut == AucuneMutation {
		return test.IsSolved(&Circuit{}, c, ecc.BN254.ScalarField())
	}
	return test.IsSolved(&muted{mut: mut}, &muted{Circuit: *c}, ecc.BN254.ScalarField())
}

func TestNonMembreAccepte(t *testing.T) {
	a, _ := Construire(snap(a1, a2, a3))
	c, _ := assignment(t, a, ok, 7)
	if c == nil {
		t.Fatal("no witness for a non-member")
	}
	if err := resolu(c, AucuneMutation); err != nil {
		t.Fatalf("non-member rejected: %v", err)
	}
}

func TestMembreSansTemoin(t *testing.T) {
	a, _ := Construire(snap(a1, a2, a3))
	typ, id, _ := IdOf("address", a2)
	if _, err := a.Temoin(Point(typ, id)); err != ErrDansLaListe {
		t.Fatalf("expected ErrDansLaListe, got %v", err)
	}
}

// A listed member forges a witness with the list's neighbours: no interval strictly contains it.
func TestMembreForgeRefuse(t *testing.T) {
	a, _ := Construire(snap(a1, a2, a3))
	typ, id, _ := IdOf("address", a2)
	x := Point(typ, id)
	for i := range a.Valeurs {
		if a.Valeurs[i].Cmp(&x) != 0 {
			continue
		}
		for _, idx := range []int{i, i + 1} { // intervals (v[i-1],v[i]) and (v[i],v[i+1])
			c := &Circuit{Index: idx, Root: a.Racine(), Binding: 1, IdType: typ, Id: id}
			c.Low, c.High = bornes(a, idx)
			idc := idx
			for l := 0; l < Depth; l++ {
				c.Path[l] = a.niveaux[l][idc^1]
				idc >>= 1
			}
			if err := resolu(c, AucuneMutation); err == nil {
				t.Fatalf("member accepted with interval %d", idx)
			}
			// Mutation: without the strict bound that refuses it, the listed member passes.
			mut := SansBorneHaute // (v[i-1], x): it is x < high that refuses
			if idx == i+1 {
				mut = SansBorneBasse // (x, v[i+1]): it is low < x that refuses
			}
			if err := resolu(c, mut); err != nil {
				t.Fatalf("mutation %d: the member should pass without the guard (%v)", mut, err)
			}
		}
	}
}

func bornes(a *Arbre, idx int) (fr.Element, fr.Element) {
	var zero, pm fr.Element
	pm.SetBigInt(new(big.Int).Sub(fr.Modulus(), big.NewInt(1)))
	b := append(append([]fr.Element{zero}, a.Valeurs...), pm)
	return b[idx], b[idx+1]
}

func TestCasLimites(t *testing.T) {
	for nom, s := range map[string]*Snapshot{
		"empty list":     snap(),
		"single element": snap(a2),
		"three elements": snap(a1, a2, a3),
	} {
		a, err := Construire(s)
		if err != nil {
			t.Fatal(err)
		}
		// one identifier on each side of all the values: look for a non-member below the min and one above the max
		var bas, haut bool
		for n := 1; n < 4000 && !(bas && haut); n++ {
			id := "0x" + padHex(n)
			c, tm := assignment(t, a, id, 3)
			if c == nil {
				continue
			}
			if tm.Index == 0 {
				bas = true
			}
			if tm.Index == len(a.Valeurs) {
				haut = true
			}
			if err := resolu(c, AucuneMutation); err != nil {
				t.Fatalf("%s : %v", nom, err)
			}
		}
		if !bas || !haut {
			t.Fatalf("%s : low case=%v high case=%v not covered", nom, bas, haut)
		}
	}
}

func padHex(n int) string {
	s := new(big.Int).SetInt64(int64(n)).Text(16)
	for len(s) < 40 {
		s = "0" + s
	}
	return s
}

func TestFalsifications(t *testing.T) {
	a, _ := Construire(snap(a1, a2, a3))
	base, _ := assignment(t, a, ok, 7)
	cas := map[string]func(c *Circuit){
		"low neighbour forged":  func(c *Circuit) { c.Low = 1 },
		"high neighbour forged": func(c *Circuit) { c.High = 2 },
		"path forged":           func(c *Circuit) { c.Path[3] = 12345 },
		"wrong index":           func(c *Circuit) { c.Index = 40000 },
		"wrong root":            func(c *Circuit) { c.Root = 99 },
	}
	for nom, f := range cas {
		c := *base
		f(&c)
		if err := resolu(&c, AucuneMutation); err == nil {
			t.Errorf("%s : accepted", nom)
		}
	}
	// root: without the constraint, a fake root passes (the guard's witness is seen red)
	c := *base
	c.Root = 99
	if err := resolu(&c, SansRacine); err != nil {
		t.Errorf("mutation SansRacine: the fake root should pass (%v)", err)
	}
}

func TestIdentifiantTropLong(t *testing.T) {
	if _, _, err := IdOf("address", "0x"+padHex(1)+"00"); err == nil {
		t.Error("42-digit address accepted")
	}
	if _, _, err := IdOf("lei", "TROPCOURT"); err == nil {
		t.Error("short LEI accepted")
	}
}

// End-to-end Groth16 proof: valid for the non-member, invalid under another root or another binding.
func TestPreuveGroth16(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &Circuit{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("constraints=%d public=%d secret=%d", ccs.GetNbConstraints(), ccs.GetNbPublicVariables(), ccs.GetNbSecretVariables())
	pk, vk, err := groth16.Setup(ccs) // test key set, never a ceremony key
	if err != nil {
		t.Fatal(err)
	}
	a, _ := Construire(snap(a1, a2, a3))
	c, _ := assignment(t, a, ok, 7)
	w, _ := frontend.NewWitness(c, ecc.BN254.ScalarField())
	t0 := time.Now()
	proof, err := groth16.Prove(ccs, pk, w)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("proving time=%s", time.Since(t0))
	pub, _ := w.Public()
	if err := groth16.Verify(proof, vk, pub); err != nil {
		t.Fatalf("valid proof rejected: %v", err)
	}
	for nom, f := range map[string]func(*Circuit){
		"other root":    func(x *Circuit) { x.Root = 99 },
		"other binding": func(x *Circuit) { x.Binding = 8 },
		"other party":   func(x *Circuit) { x.Id = 5 },
	} {
		x := *c
		f(&x)
		wp, _ := frontend.NewWitness(&x, ecc.BN254.ScalarField(), frontend.PublicOnly())
		if err := groth16.Verify(proof, vk, wp); err == nil {
			t.Errorf("%s : proof accepted", nom)
		}
	}
}
