// Package sanctions : non-membership circuit for a sanctions list, Groth16 on BN254 (gnark).
//
// Statement proved: the identifier (IdType, Id) does not belong to the list whose root is Root.
//
// The list is a Merkle tree of INTERVALS: identifiers hash to x = MiMC(IdType, Id), are sorted,
// and each leaf is MiMC(low, high) for two adjacent values (0 and p-1 serve as bounds). x is absent from the
// list if some leaf of the tree has low < x < high.
//
// Public inputs: Root, Binding, IdType, Id. Id is PUBLIC by design: if it stayed private, nothing would link the
// proof to the transfer party, and a listed payer could prove the non-membership of another identifier.
// The payer is public in the transfer anyway: the circuit's value is succinct verification and
// the absence of a published list, not the confidentiality of the parties.
package sanctions

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/hash/mimc"
)

// Depth: tree depth, 2^16 leaves, that is at most 65535 identifiers (one more leaf than entries).
const Depth = 16

type Circuit struct {
	// Private.
	Low   frontend.Variable
	High  frontend.Variable
	Index frontend.Variable
	Path  [Depth]frontend.Variable

	// Public.
	Root    frontend.Variable `gnark:",public"`
	Binding frontend.Variable `gnark:",public"`
	IdType  frontend.Variable `gnark:",public"`
	Id      frontend.Variable `gnark:",public"`
}

func (c *Circuit) Define(api frontend.API) error { return c.DefineMuted(api, Mutation(0)) }

// Mutation removes ONE constraint. Reserved for witnesses: each guard of the circuit must be seen red when it is removed.
type Mutation int

const (
	AucuneMutation Mutation = iota
	SansBorneBasse
	SansBorneHaute
	SansRacine
)

func (c *Circuit) DefineMuted(api frontend.API, mut Mutation) error {
	h, err := mimc.NewMiMC(api)
	if err != nil {
		return err
	}
	hash2 := func(a, b frontend.Variable) frontend.Variable {
		h.Reset()
		h.Write(a, b)
		return h.Sum()
	}

	x := hash2(c.IdType, c.Id)

	// Low < x < High, over the whole field.
	if mut != SansBorneBasse {
		api.AssertIsEqual(api.Cmp(c.Low, x), -1)
	}
	if mut != SansBorneHaute {
		api.AssertIsEqual(api.Cmp(x, c.High), -1)
	}

	// The interval is a leaf of the tree.
	cur := hash2(c.Low, c.High)
	bits := api.ToBinary(c.Index, Depth)
	for i := 0; i < Depth; i++ {
		left := api.Select(bits[i], c.Path[i], cur)
		right := api.Select(bits[i], cur, c.Path[i])
		cur = hash2(left, right)
	}
	if mut != SansRacine {
		api.AssertIsEqual(cur, c.Root)
	}

	// Binding comes in only through a product: it stays in the constraint system and the proof cannot
	// be replayed under another binding without the public verification seeing it.
	api.AssertIsEqual(api.Mul(c.Binding, c.Binding), api.Mul(c.Binding, c.Binding))
	return nil
}
