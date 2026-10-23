// prove-sanctions: produces, OFF-CHAIN and BEFORE the transfer, the proof of a party's non-membership in the list.
//
//	prove-sanctions root  --snapshot S
//	prove-sanctions prove --snapshot S --party payeur|beneficiaire --type address|lei --id X
//	        --wrapper W --uetr U --payer P --beneficiary B --amount M --chainid C
//	        --pk pk.bin --circuit circuit.json --vk vk.bin [--output preuve.json]
//
// If the identifier is in the list, NO proof exists: exit code 3, nothing is written. That is the
// pre-transaction refusal. Reproducible: same snapshot, same root, same tree.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/Aiko-Academy/programmable-compliance/zk/sanctions"
)

func die(code int, err error) {
	fmt.Fprintln(os.Stderr, "prove-sanctions:", err)
	os.Exit(code)
}

func h32(e fr.Element) string { b := e.Bytes(); return "0x" + hex.EncodeToString(b[:]) }

func main() {
	if len(os.Args) < 2 {
		die(1, errors.New("expected command: root | prove"))
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	snapP := fs.String("snapshot", "", "")
	partie := fs.String("party", "payeur", "")
	typ := fs.String("type", "address", "")
	id := fs.String("id", "", "")
	wrapper := fs.String("wrapper", "", "")
	uetr := fs.String("uetr", "", "")
	payeur := fs.String("payer", "", "")
	benef := fs.String("beneficiary", "", "")
	montant := fs.String("amount", "", "")
	minF := fs.String("min", "", "arrival leg: low bound of the delivered amount (with --max, replaces --amount)")
	maxF := fs.String("max", "", "arrival leg: high bound of the delivered amount; --payer is then the originator")
	chainid := fs.String("chainid", "", "")
	pkP := fs.String("pk", "", "")
	circP := fs.String("circuit", "", "")
	vkP := fs.String("vk", "", "")
	sortie := fs.String("output", "", "")
	fs.Parse(os.Args[2:])

	raw, err := os.ReadFile(*snapP)
	if err != nil {
		die(1, err)
	}
	snap, err := sanctions.ParseSnapshot(raw)
	if err != nil {
		die(1, err)
	}
	arbre, err := sanctions.Construire(snap)
	if err != nil {
		die(1, err)
	}
	racine := arbre.Racine()
	listeId := "0x" + hex.EncodeToString(sanctions.Keccak([]byte(snap.ListId)))

	if os.Args[1] == "root" {
		out, _ := json.MarshalIndent(map[string]any{"listId": listeId, "listIdNom": snap.ListId, "version": snap.Version, "date": snap.Date, "racine": h32(racine), "identifiants": len(arbre.Valeurs)}, "", "  ")
		fmt.Println(string(out))
		return
	}
	if os.Args[1] != "prove" {
		die(1, fmt.Errorf("unknown command %q", os.Args[1]))
	}

	t, ident, err := sanctions.IdOf(*typ, *id)
	if err != nil {
		die(1, err)
	}
	tm, err := arbre.Temoin(sanctions.Point(t, ident))
	if errors.Is(err, sanctions.ErrDansLaListe) {
		die(3, fmt.Errorf("%s %s : %w", *partie, *id, err))
	}
	if err != nil {
		die(1, err)
	}
	chain, ok2 := new(big.Int).SetString(*chainid, 10)
	if !ok2 {
		die(1, errors.New("--chainid in decimal"))
	}
	var binding *big.Int
	if *minF != "" || *maxF != "" {
		lo, ok1 := new(big.Int).SetString(*minF, 10)
		hi, ok3 := new(big.Int).SetString(*maxF, 10)
		if !ok1 || !ok3 {
			die(1, errors.New("--min and --max in decimal, both required"))
		}
		binding, err = sanctions.LiaisonFourchette(*wrapper, *uetr, *payeur, *benef, lo, hi, chain)
	} else {
		amount, ok1 := new(big.Int).SetString(*montant, 10)
		if !ok1 {
			die(1, errors.New("--amount in decimal (or --min and --max)"))
		}
		binding, err = sanctions.Liaison(*wrapper, *uetr, *payeur, *benef, amount, chain)
	}
	if err != nil {
		die(1, err)
	}

	// The circuit compiled here must be THE one from the ceremony.
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &sanctions.Circuit{})
	if err != nil {
		die(1, err)
	}
	var manifeste struct {
		CcsSha256 string `json:"ccsSha256"`
	}
	mb, err := os.ReadFile(*circP)
	if err != nil {
		die(1, err)
	}
	json.Unmarshal(mb, &manifeste)
	if got := ccsHash(ccs); got != manifeste.CcsSha256 {
		die(1, fmt.Errorf("the compiled circuit (%s) is not the one from the ceremony (%s)", got, manifeste.CcsSha256))
	}
	pk := groth16.NewProvingKey(ecc.BN254)
	pf, err := os.Open(*pkP)
	if err != nil {
		die(1, err)
	}
	if _, err = pk.ReadFrom(pf); err != nil {
		die(1, err)
	}
	vk := groth16.NewVerifyingKey(ecc.BN254)
	vf, err := os.Open(*vkP)
	if err != nil {
		die(1, err)
	}
	if _, err = vk.ReadFrom(vf); err != nil {
		die(1, err)
	}

	c := &sanctions.Circuit{Low: tm.Low, High: tm.High, Index: tm.Index, Root: racine, Binding: binding, IdType: t, Id: ident}
	for i := range tm.Path {
		c.Path[i] = tm.Path[i]
	}
	w, err := frontend.NewWitness(c, ecc.BN254.ScalarField())
	if err != nil {
		die(1, err)
	}
	proof, err := groth16.Prove(ccs, pk, w)
	if err != nil {
		die(1, err)
	}
	pub, _ := w.Public()
	if err := groth16.Verify(proof, vk, pub); err != nil {
		die(1, fmt.Errorf("the produced proof does not verify: %w", err))
	}
	sol := proof.(*groth16bn.Proof).MarshalSolidity()
	if len(sol) != 256 {
		die(1, fmt.Errorf("proof of %d bytes, expected 256", len(sol)))
	}
	words := make([]string, 8)
	for i := range words {
		words[i] = "0x" + hex.EncodeToString(sol[32*i:32*(i+1)])
	}
	res := map[string]any{
		"partie": *partie, "idType": t, "id": "0x" + ident.Text(16),
		"racine": h32(racine), "listId": listeId, "version": snap.Version,
		"liaison":          "0x" + binding.Text(16),
		"entreesPubliques": []string{h32(racine), "0x" + binding.Text(16), fmt.Sprint(t), "0x" + ident.Text(16)},
		"preuve":           words,
		"statut":           "demo setup, demo list",
	}
	out, _ := json.MarshalIndent(res, "", "  ")
	if *sortie != "" {
		if err := os.WriteFile(*sortie, append(out, '\n'), 0o644); err != nil {
			die(1, err)
		}
		fmt.Println("proof written:", *sortie)
		return
	}
	fmt.Println(string(out))
}

func ccsHash(ccs interface {
	WriteTo(w io.Writer) (int64, error)
}) string {
	h := sha256.New()
	ccs.WriteTo(h)
	return hex.EncodeToString(h.Sum(nil))
}
