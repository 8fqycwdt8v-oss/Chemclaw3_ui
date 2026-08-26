# Structure interaction: input, output, and where the depth is

A second concept study, narrower than [`chemistry-aware-frontend.md`](./chemistry-aware-frontend.md)
and written after the work that document argued for had shipped. It asks one question that the
first one could not, because in `b2fd195` there was almost nothing to ask it of:

> Now that a chemist can get a structure in and see structures come back — **is that the shortest,
> cleanest path through this UI, or merely the first one that worked?**

Frontend facts are cited against this repo @ `5cbe51f`, backend facts against
`8fqycwdt8v-oss/Chemclaw3` @ `8cefd80` and `8fqycwdt8v-oss/Chemclaw3-mcp` @ `90fa943`. Every claim
below was read off the code, not off a docstring — three of the findings are cases where a
docstring states an intention the code does not carry out, which is the specific failure mode
`CLAUDE.md` names ("prose is evidence about what its author believed").

> **Status — read this first.**
>
> **All fourteen proposals in §5 are built**, on `claude/ui-ux-molecular-interaction-v68er3`. The
> body below is **kept as written**, in the present tense of `5cbe51f`, for the same reason the
> first study's is: the analysis of what was missing is the argument for what was built, and
> rewriting it in the past tense would leave every decision looking unmotivated.
>
> So every claim below still describes `5cbe51f`. What changed, and where, is in §5's table — each
> row now names the module that answers it. Four things came out differently from the plan and are
> worth reading before the body, because in each case the code is right and this document was not:
>
> - **P6 landed global rather than per-conversation.** A per-conversation preference asks the same
>   chemist the same question in every new thread, which is the per-token failure at a coarser
>   grain.
> - **P1 confirms reactions as well as molecules**, and only molecules reach the rail —
>   `ingestUserStructure` canonicalises, and a molecule toolkit cannot canonicalise a reaction.
> - **P7 turned out to be fixing a way to lose the app**, not only a missing convenience: a page
>   with no drop handler hands a dropped file to the browser, which navigates to it and takes the
>   draft with it. A window-level guard makes a missed drop a no-op.
> - **A defect this study did not find** fell out of routing every "can I draw this" question
>   through one function: `looksLikeSmiles` rejects anything containing `>` and `isMolecule`
>   refuses a reaction, so every inline reaction SMILES in every answer fell through to plain
>   text — including the ones `similar_reactions` exists to return, which §3.1 is about.
>
> Measured, since §5 quotes costs: the entry chunk went 498.34 kB → 510.67 kB. That is application
> code; RDKit's 6.9 MB and Ketcher's 11.8 MB stay in their own chunks and `index.html` preloads
> neither.

---

Nothing here is a defect report. The structure work is good and most of what follows is a
consequence of it having been built one surface at a time.

---

## 1. The surface, counted

Eight places draw a structure, and one place accepts one.

| Where                              | File                                                   | What it draws                        |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| The structure panel's confirmation | `src/components/StructureInput.tsx:296`                | what is about to be inserted         |
| An inline code span in an answer   | `src/components/Markdown.tsx:121` → `Molecule.tsx:213` | opt-in, per token, per render        |
| A finished job's summary           | `src/components/JobResultCard.tsx:43`                  | `molecule_smiles`                    |
| A hazard screen's `screened` list  | `src/components/ResultSheet.tsx:186`                   | what was screened                    |
| A compound note                    | `src/components/NoteSheet.tsx:180`                     | `compound_smiles`                    |
| The entity rail                    | `src/components/EntityRail.tsx:107,116`                | every admitted molecule and reaction |
| A reaction, anywhere               | `src/components/Molecule.tsx:72`                       | the split, laid out with an arrow    |

And the one way in: `StructureInput`, reached from the hexagon button in the composer
(`src/components/Composer.tsx:363`), offering paste/type, a `.mol`/`.sdf` drop or picker, and
Ketcher — all three funnelled through `canonicalSmiles` so exactly one toolkit decides what a
molecule is.

That is a real chemistry surface and it is more than most tools of this kind have. What follows is
about the **paths between those points**, which is where the friction now lives.

---

## 2. Input — the confirmation is the design, and the default path skips it

`StructureInput`'s own docstring states the principle plainly:

> Nothing is inserted until RDKit has read it and drawn it back. "This is what I understood you to
> mean" is the entire affordance — **a chemist must never send a structure they have not seen.**

The panel keeps that promise exactly. The application does not, because the panel is not the way
most structures will arrive.

### 2.1 Paste is unguarded, and paste is what people do

There is no `onPaste` handler anywhere in `src/` — verified by grep, zero hits. A chemist who copies
a SMILES out of ChemDraw, an Excel column or a colleague's email and pastes it into the message box
gets no canonicalisation, no drawing, no verdict, and no entity-rail row. The message goes out
exactly as typed.

So the safest path is behind an unlabelled hexagon and the unguarded path is the one the muscle
memory of every user already runs. **This is the single largest gap in the input story**, and it is
larger than the sum of the friction items below, because the others cost time and this one costs
the guarantee.

Worth being precise about what is and is not lost: the backend canonicalises everything it is given
(`core.chem.require_canonical_smiles`), so a pasted structure is not _mis_-computed. What is lost is
the chemist's chance to notice that they pasted the wrong one — which is the failure the panel was
built for.

### 2.2 The drop target only exists after you have already committed to dropping

`onDrop` appears once in the whole codebase, on the structure panel's own container
(`src/components/StructureInput.tsx:225`). The composer has no drag handlers, and its attachment
picker deliberately excludes chemical formats (`Composer.tsx:356` accepts `.csv,.tsv,.txt,.json,
.md,.pdf,.docx,.xlsx`). So dragging a `.mol` onto the app does nothing until the panel is open,
which is the one state in which the chemist has already told the UI what they are about to do.

`takeFile` is already written and already handles multi-record SDF, unreadable records and the
"dropped the wrong file over a typed SMILES" case. What is missing is only the hoist.

### 2.3 The compound name is a documented dead end, and it need not be

`looksLikeCompoundName` exists for one purpose, and the docstring is candid about it: "this function
exists to produce a sentence, not a lookup." The sentence it produces
(`StructureInput.tsx:282-288`) tells the chemist to go and ask the agent, then paste the answer back.

That reasoning is sound at the level it was made — `resolve_compound` is an agent tool and the
service exposes 21 HTTP paths, none of them chemical (verified against `src/chemclaw/api/routes/`).
Inventing an endpoint or shipping a name table were correctly rejected.

But the conclusion skipped a third option that costs nothing. The app already has a mechanism for
composing a message on the user's behalf: the `chemclaw:prefill` window event, with an `autoSend`
flag, used by `Prompts` and `CitationChip` (`Composer.tsx:104-118`). "Ask the agent for the SMILES
of 4-bromoanisole" is one button on top of machinery that already exists. It does not make the panel
a name resolver — the agent still answers — it just stops asking a chemist to retype a sentence the
UI could write.

What the button still leaves open is the return leg: the agent's answer arrives as an inline code
span with a ⌬ toggle, and getting it into the message box is a manual select-and-copy. See §3.5.

### 2.4 Interaction cost, counted

Read off the code rather than timed, so these are lower bounds — they assume no mistake, no scroll
and no re-read.

| Journey                                | Interactions                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Paste a SMILES and ask a question      | paste, type, Enter — **no confirmation at any point**                                                       |
| Type a SMILES _through the panel_      | hexagon, wait debounce+WASM, read the drawing, Insert, type, Enter                                          |
| Draw a structure and ask about it      | hexagon, Draw, wait ~12 MB Ketcher, draw, Use, wait RDKit, Insert, type, Enter — **5 clicks, 2 WASM loads** |
| Insert the 2nd of 12 records in an SDF | the panel closes on Insert (`Composer.tsx:195`), so: hexagon, re-drop, step, Insert                         |
| Get a named compound in                | 4 steps and a copy-paste through the agent (§2.3)                                                           |

The draw path is the one that reads worst, and most of it is irreducible — a sketcher is a sketcher.
The two that are not irreducible are the last two rows.

---

## 3. Output — what is drawn, and what is on the wire and thrown away

### 3.1 The three tools whose entire output is structures render as text

`ResultSheet` dispatches typed renderers for exactly four tools
(`src/components/ResultSheet.tsx:399-406`): `screen_hazards`, `screen_genotoxic_alerts`,
`ich_impurity_limit`, `stoichiometry_table`. Everything else falls through to `AutoTable`, which
renders each value as a string in a cell.

Three tools fall through that should not:

- `similar_molecules` and `substructure_matches` return `MoleculeHit{compound_note_id, smiles,
similarity}` (`science/fingerprints/molfp/search.py:32`).
- `similar_reactions` returns reaction hits with a DRFP score.

So the one question a bench chemist asks that is _purely_ about structures — "have we made anything
like this" — answers with a table of SMILES strings and a decimal. The first study called this the
"hit grid of structures with Tanimoto scores" and predicted the renderers should key on result
_shape_ rather than tool name; four of the five shapes were built, and the structure-list shape was
not.

There is a second thing this renderer would have to carry, and it is the reason it is worth building
properly rather than quickly: `FingerprintSearch` (`science/fingerprints/store.py:94`) exists
specifically so that "we have no analogue on file" and "nothing has been indexed" cannot arrive as
the same empty list — a live run once answered `{"result": []}` off an unbackfilled index and it was
read as "we have never made anything like this". `AutoTable` renders both as an empty table.

### 3.2 The charge table has the structures and does not draw them

`ChargeRow` carries `smiles` (`Chemclaw3-mcp/servers/chem/src/chemclaw_mcp_chem/engine/
stoichiometry.py:35`). The renderer reads `name`, `role`, `equivalents`, `molecular_weight`,
`moles_mmol`, `mass_g`, `volume_ml` — and not `smiles` (`ResultSheet.tsx:290-307`).

This is the table a chemist reads _at the bench while weighing things out_, and the field that says
what they are weighing is on the wire and dropped. It is also the table where the consequence of
confusing two species is physical.

### 3.3 The user's own message loses the structure the instant it is sent

`BubbleBody`'s user branch is a plain `<p className="whitespace-pre-wrap">`
(`src/components/MessageList.tsx:195-203`) — no markdown, no `InlineSmiles`, no rendering of any
kind. Assistant text gets the full chemistry-aware pipeline; the human's gets none.

The effect is exact and slightly perverse: the drawing the panel showed to satisfy "a chemist must
never send a structure they have not seen" is discarded at the moment of sending, and the durable
record a chemist scrolls back through three weeks later shows `COc1ccc(Br)cc1` as a bare string. The
confirmation is real and it is not kept.

### 3.4 The trace draws nothing, while holding the extractor that would let it

`smilesFromArguments` (`src/chem/recognise.ts:137`) safely lifts structures out of a `tool_call`'s
argument document — safely, because it insists the document parse as whole JSON, which is the one
check that distinguishes a complete argument list from a truncated preview.

Its only caller is `src/chem/entities.ts:265`. `TracePanel` renders the same argument string as raw
text behind an "arguments" disclosure (`TracePanel.tsx:220-232`).

So a `predict_pka` row that reads `{"smiles": "COc1ccc(Br)cc1"}` could draw the molecule the
calculation was actually performed on, using an extractor already written, already tested, already
proven safe on that exact source — and does not. "Did it compute the pKa of the compound I meant" is
US-1's real question and it is currently answered by reading a SMILES string.

### 3.5 A drawn structure is a picture and never an input

Every one of the eight render sites in §1 is terminal. There is no action on a rendered molecule
anywhere in the app: not on an inline structure in an answer, not on a rail row, not on a note's
compound, not on a hit. The entity rail's row is a filter toggle and nothing else
(`EntityRail.tsx:94-104`).

This is what makes the §2.3 round trip a real round trip. The agent answers "the SMILES for
4-bromoanisole is `COc1ccc(Br)cc1`", the UI draws it on request, confirms with RDKit that it is a
molecule — and the only way to ask a follow-up question about it is to select the text with a mouse.

### 3.6 The inline toggle is per token, per render, and forgotten on reload

`InlineSmiles` holds `useState(false)` per instance (`Molecule.tsx:214`). An answer naming six
compounds is six clicks; re-parsing the markdown or reloading the page resets all six.

The first study proposed exactly this fix — "the existing opt-in discipline raised to a
per-conversation preference rather than a per-token click" — and it is the one item of Concept A
that was never built. The opt-in _discipline_ is right and should stay: RDKit gates the affordance,
so nothing is drawn from a mere guess. It is the _granularity_ that is wrong.

### 3.7 The rail vanishes below `lg`, with no replacement

`EntityRail` is `hidden … lg:flex` (`EntityRail.tsx:152`). There is no Sheet, no drawer, no
top-bar entry point. Below 1024px the conversation's subject index — the structures, the jobs, the
notes, and the transcript filter — does not exist.

The sidebar's own docstring records what happened the last time this pattern shipped: it
`display:none`d below 768px with no replacement, taking the conversation switcher and the recovery
control off phones, and calls it "the sharpest edge in the product". The fix there was to share the
panel body between a persistent column and a Sheet. The rail has not had that fix.

### 3.8 The payoff canonicalisation was bought for is uncollected

`src/chem/rdkit.ts` opens by justifying a 6.9 MB WASM dependency, and the first of its three reasons
is:

> **Canonical identity.** … the two must collapse to one row **or the rail … can never join a
> computed value to the structure it was computed for.**

The join is not rendered. `MoleculeEntity` carries `smiles`, `aliases`, `mentions` and `firstSeen`;
a rail row shows the drawing, the canonical SMILES, and a comma-joined list of tool names
(`EntityRail.tsx:84-90,105-122`). No value ever appears beside a structure.

The data to do it is present on the trace: `tool_result.numbers` is the untruncated, deduplicated
list of every figure a call returned, `TraceEntry` carries it, and `returnedFigures` already reads
it for the grounding overlay (`src/chem/provenance.ts:54`). What is missing is the join itself.

The honest limit — and it must be stated on the surface if this is built — is that `numbers` carries
no labels and no units. "`predict_pka` returned 4.76, 1.6" is the most that can truthfully be said.
That is still strictly more than a tool name, and the method badge and its caveat are the right
neighbours for it.

---

## 4. Cleanliness — the depth is real, and it is in the wrong place

### 4.1 Provenance is inverted relative to risk

Count the disclosure layers between a chemist and the qualifier on a number:

```
answer text                                    depth 0   "the pKa is 4.76"
AnswerFooter → confidence, unsupported claims  depth 1
TracePanel   → "Show the agent's work"         depth 2
  the row for predict_pka                      depth 3
    the method badge                           depth 3   GFN2-xTB · semiempirical
    → "what it does not say"                   depth 4   ±1.6 units; aromatic N only
    → "arguments"                              depth 4
    → "N values returned (untruncated)"        depth 4
    → "See the full result" (sheet)            depth 4
      → "Everything the tool returned"         depth 5
```

The number is at depth 0. The sentence saying the number carries ±1.6 units of uncertainty and does
not cover aliphatic amines is at depth 4, behind two collapsed sections and a scan.

Every one of those layers is individually well argued, and the argument against putting caveats
inline is also right and is written down in `provenance.ts`: "annotation clutter … trains people to
ignore it — which is worse than absent." Both things are true, which is why the answer is not "move
the caveats up" but "move _one line_ up": the set of distinct methods this turn used, in the
`AnswerFooter`, beside the confidence score that is already there. One line per answer, not one per
call, with the trace as the drill-down it already is.

`methodFor` already returns exactly this, keyed on `KnownTool` so a wrong method label will not
compile (`provenance.ts:322,544`). Deduplicating across a turn's trace is a `Set`.

### 4.2 Two indexes of the same turn, neither showing what the other has

The trace panel and the entity rail are both built from the same event stream and both answer "what
did this turn touch", on two axes and in two visual languages. That division — steps versus subjects
— is a good one. The execution blurs it in both directions:

- the rail's only text per row is a list of **tool names**, which is the trace's axis;
- the trace shows **no structures at all** (§3.4), which is the rail's axis.

Sharpening it costs nothing and clarifies both: structures and their values belong to the rail,
sequence and method belong to the trace, and each stops half-answering the other's question.

### 4.3 Composer chrome

Up to seven interactive elements surround the message box: textarea, hexagon, paperclip, Send/Stop,
a profile `<select>` (conditional and correctly so), a Dry-run switch and its label, and the
counter/hint. The Dry-run switch is permanently visible for a mode used rarely — the expensive-job
case — and it is the one item there that a chemist has to flip _before_ they know whether the turn
would have been expensive.

The right long-term shape is a confirmation at the moment an expensive tool is about to run, which
the backend already marks (`expensive: true`) and the plan gate already has a path for. The cheap
version is relocating the switch. Neither is urgent; it is listed because a simplification pass
should know where the permanent chrome is.

### 4.4 The ⌬ glyph

An unlabelled 0.7em character with the accessible name in `aria-label` only. Discoverable by
screen-reader users and by nobody else. If §3.6's per-conversation preference lands, the per-token
button can be removed outright rather than relabelled — which is the better outcome.

---

## 5. Proposals, ranked by value per unit of work

Nothing here needs a backend change. Every item is reachable from data already on the wire or from a
function already in this repo.

| #       | Change                                                                                                                                        | Fixes      | Cost | Built in                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- | ------------------------------------------ |
| **P1**  | Recognise a pasted structure in the composer: a non-blocking confirmation strip above the message box with the drawing and the canonical form | §2.1       | S    | `Composer.tsx` — `PasteConfirmation`       |
| **P2**  | An "insert into the message" action on any rendered structure — inline, rail, hit, note                                                       | §3.5, §2.3 | S    | `components/chem/UseStructure.tsx`         |
| **P3**  | A structure-hit renderer for the three fingerprint searches, carrying the empty-index distinction                                             | §3.1       | M    | `ResultSheet.tsx` — `StructureHits`        |
| **P4**  | Draw `ChargeRow.smiles` in the charge table                                                                                                   | §3.2       | S    | `ResultSheet.tsx` — `ChargeTable`          |
| **P5**  | Render the user's message through the chemistry pipeline                                                                                      | §3.3       | S    | `Molecule.tsx` — `StructureText`           |
| **P6**  | A "draw structures in answers" preference; drop the per-token toggle                                                                          | §3.6, §4.4 | S    | `state/prefsStore.ts` + the top-bar toggle |
| **P7**  | Hoist the file drop to the composer; open the panel pre-loaded                                                                                | §2.2       | S    | `Composer.tsx` — the drop zone             |
| **P8**  | Draw the molecule a tool was called on, in its trace row                                                                                      | §3.4, §4.2 | S    | `TracePanel.tsx` — `CalledOn`              |
| **P9**  | One method line in `AnswerFooter`: the distinct methods this turn used                                                                        | §4.1       | S    | `AnswerBadges.tsx` — `MethodLine`          |
| **P10** | "Ask the agent to resolve this name", via `chemclaw:prefill`                                                                                  | §2.3       | S    | `StructureInput.tsx`                       |
| **P11** | The rail as a Sheet below `lg`, sharing its body                                                                                              | §3.7       | M    | `EntityRail.tsx` — `EntityRailTrigger`     |
| **P12** | Attach returned values to rail molecules, labelled by the tool that returned them                                                             | §3.8       | M    | `chem/entities.ts` — `Mention.values`      |
| **P13** | Label the structure button (icon at narrow, "Structure" at ≥sm)                                                                               | §2         | XS   | `Composer.tsx`                             |
| **P14** | Keep the panel open after Insert when the source was a multi-record SDF                                                                       | §2.4       | XS   | `StructureInput.tsx`                       |

The risks the last column displaced are all still live and all still handled in the code: P1's
false positives (a paste must be one whitespace-free token, and RDKit is the arbiter), P3's
obligation not to render "the index is empty" as "no analogue exists" (the service's own `verdict`
is rendered verbatim rather than paraphrased), and P12's missing units (`numbers` carries neither
labels nor units, and the rail says only what the tool returned).

**If only three are taken: P1, P2, P5.** Together they close the loop the current design leaves
open — a structure that arrives by the fastest route is confirmed, a structure that is drawn can be
used, and a structure that was sent stays visible. Each is small and none of them argues with a rule
this codebase has already written down.

---

## 6. What this study deliberately does not propose

- **Substructure highlighting.** Still blocked for the reason `rdkit.ts:209-219` records: no SMARTS
  crosses the wire. `HazardFlag.matched` is the input a rule fired _on_, not the pattern it fired
  _with_. Nothing has changed.
- **A chart layer.** US-11 (scan profiles) and US-25 (Pareto fronts) still want one, and it is still
  a dependency decision rather than a structure question. Out of scope here.
- **Pinning two structures side by side.** Genuinely wanted — "which bromide were we using" is the
  bench question — but `EntityRail`'s docstring is right that a pin with nowhere to pin _to_ is a
  control that looks like a feature and is a no-op. It becomes worth building once P12 gives a rail
  entry real content to compare.
- **A "run this calculation" button on a structure.** P2 stops at composing a message, and that
  restraint is deliberate — it is the same line the first study drew, and crossing it means thinking
  through `agent/authz.py`, the plan gate and `expensive: true` first.
- **Parsing `tool_result.preview` for structures.** Never. A SMILES cut at an arbitrary byte very
  often stays valid as a smaller, different molecule, and there is nothing downstream that can catch
  it. `recognise.ts` says so and it remains the most dangerous available mistake in this repo.

---

## 7. Open questions

- **Should the composer's paste confirmation be dismissible-and-forgotten, or sticky?** A chemist
  pasting twenty structures in a screening session will hate a strip they must dismiss twenty times;
  a chemist pasting one will not read a strip that has been suppressed. P1 needs a decision here and
  the code cannot make it.
- **Does P12's value join survive a real transcript?** `numbers` is per-call and unlabelled, and a
  turn that calls `compute_electronic_properties` returns ~49 of them. The join may be legible for
  `predict_pka` and noise for the wide results, in which case it wants a cap and a rule for which
  tools it applies to — which is a measurement, not a design.
- **Is the rail the right home for structures on a phone at all?** P11 assumes yes by analogy with
  the sidebar. The alternative is that on a small screen the structures belong _in_ the transcript
  and the rail is a desktop affordance — which would make P5 and P6 the mobile answer and P11
  unnecessary.
