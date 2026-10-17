# puml-layout

Make diagrams you don't own look right, without touching them. The source
(`diagram.puml`) stays exactly as its author wrote it; everything you change
lives in a sidecar, `diagram.layout.json`, keyed by the element ids in the
source. When the author edits the source, your positions survive and new
elements are placed next to what they connect to.

## Supported PlantUML diagrams

| Type | Status | Fixture |
|---|---|---|
| Use case | ✅ | `food-delivery.puml` |
| Component | ✅ components, interfaces (`()`), `[x]` shorthand, queues, databases, nodes, clouds | `component.puml` |
| Deployment | ✅ node (3D), artifact, database, storage, cloud, file, folder, queue, stack, hexagon, ... | `deployment.puml` |
| Class / object | ✅ compartments, abstract/interface/enum, `extends`/`implements`, composition/aggregation/realization, multiplicities | `class.puml` |
| ER (IE notation) | ✅ entities, crow's feet (`\|\|--o{`) | `er.puml` |
| State | ✅ composite states, scoped `[*]`, choice, fork/join, history, descriptions; lines can end on a composite | `state.puml` |
| C4 (stdlib macros) | ✅ Person/System/Container/Component (+Db/Queue/_Ext), boundaries, Rel/BiRel/Lay | `c4.puml` |
| Mindmap / WBS | ✅ as trees | `mindmap.puml` |
| Sequence | ✅ own model: participants as columns (drag to move/reorder), events as rows; activation, return, create/destroy, lost/found, notes, alt/else/loop/par/…, dividers, delays, refs, autonumber, boxes | `sequence.puml` |
| Activity | ✅ compiled into the graph: if/elseif/else, while, repeat, fork/split, switch, notes, partitions; swimlanes as columns | `activity.puml` |
| Gantt | ✅ durations, `starts at [X]'s end`, dates, `->`, `then`, milestones, completion, colours, sections, closed weekdays | `gantt.puml` |
| Timing | ✅ robust, concise, clock, binary; `@t` blocks; messages | `timing.puml` |
| JSON / YAML | ✅ objects and arrays as tables, nested values linked by key; ids are paths (`$.order.lines[0]`); block YAML incl. `- key:` items, flow `[..]`/`{..}`, `\|`/`>` | `json.puml`, `yaml.puml` |
| Chen ER | ✅ entities, relationships (diamonds), attributes (ellipses, owner-scoped ids), composite attributes, `<<key>>`/`<<multi>>`/`<<derived>>`/`<<weak>>`/`<<identifying>>`, `-N-`, `-(1,N)-`, `=N=` (double line), `=>= d { A, B }` | `chen.puml` |
| ArchiMate | ✅ `archimate #Layer "X" as A <<type>>`, `Business_Actor(..)`-style macros, Grouping, junctions, every `Rel_*` with its own ends (direction suffixes ignored); no layer colours | `archimate.puml` |
| nwdiag | ✅ networks as bars, hosts with per-network addresses, shapes, descriptions, groups, peer links; networks stack in source order | `nwdiag.puml` |
| Salt, regex, EBNF, math, ditaa, ... | recognised and reported; no layout to manage | |

The family is detected first because PlantUML reads some keywords per
type (`interface` is a lollipop in a component diagram and a class box in a
class diagram; `{` opens a container in one and a member list in the other).
Lines nothing understands become warnings, never errors.

## Supported Mermaid diagrams

`.mmd` / `.mermaid` files (fixtures in `fixtures/mermaid/`). A source with
`@start` is always PlantUML; otherwise the extension decides, then the
header line. Each Mermaid type lands on the same model as its PlantUML
counterpart, with the same id conventions (`A-->B`, `B--|>A`, `#2`), so the
sidecar works the same way.

| Type | Status | Fixture |
|---|---|---|
| Flowchart / graph | ✅ all directions (RL/BT drawn as LR/TB); shapes `[ ]` `( )` `{ }` (diamond) `(( ))` `((( )))` `[( )]` `[[ ]]` `{{ }}` `([ ])` `>flag]`, `[/ /]` `[\ \]` as plain boxes, `A@{ shape: … }`; links `-->` `---` `-.->` `==>` `~~~` `<-->` `--o` `--x`, `-->\|text\|`, `-- text -->`, chains, `&`, `e1@-->` edge ids; nested subgraphs (per-subgraph `direction` ignored); classDef/class/style/linkStyle/click/`:::` ignored | `flowchart.mmd` |
| Sequence | ✅ participant/actor (`as`, `@{ "type": … }`), all arrows incl. `-x` `-)` `<<->>`, `+`/`-` activation, activate/deactivate, create/destroy, notes, loop/alt/else/opt/par/and/critical/option/break, box, autonumber; `rect` not drawn | `sequence.mmd` |
| Class | ✅ bodies, `~T~` generics, `["label"]`, annotations, `A : member`, all relations with cardinalities and labels, lollipops as circles, namespaces, `note for` | `class.mmd` |
| State | ✅ scoped `[*]`, composites (nested, forward references), `state "x" as X`, descriptions, choice/fork/join, notes; `--` regions share one `[*]` | `state.mmd` |
| ER | ✅ crow's feet in symbol and word form (`one or more to zero or many`), aliases, attribute blocks with PK/FK/UK and comments | `er.mmd` |
| Gantt | ✅ dateFormat, sections, `excludes weekends`/weekdays, `weekend friday`, ids, `after a b`, `until x`, durations d/w/h, end dates (exclusive unless `inclusiveEndDates`), done/crit/milestone; excluded dates are reported, not drawn | `gantt.mmd` |
| Mindmap | ✅ indentation tree; all node shapes drawn as topics; icons and classes ignored | `mindmap.mmd` |
| Pie, journey, gitGraph, timeline, quadrant, XY, sankey, requirement, C4, block, packet, architecture, kanban, ... | recognised and reported; no layout to manage | |

The parsers feed one format-neutral model (`src/model/types.ts`), so a new
input is a new parser.

## Use

    pnpm install
    pnpm dev                     # editor on http://localhost:5199
    PUML_ROOT=~/diagrams pnpm dev  # edit diagrams in another folder
    pnpm render fixtures/food-delivery.puml -o out/food-delivery.svg
    pnpm render fixtures/food-delivery.puml --theme modern --fit 16:9   # FIT_DEBUG=1 prints every candidate's score

Editor: drag elements (they become pinned), drag a box title to move the
box with its contents, pull a line to bend it, double-click a bend to remove
it, drag labels. Auto layout re-lays out everything that isn't pinned. The
editor reloads live when the .puml or the layout changes on disk.

Selection and panning (the **?** key in the toolbar shows this map):

| | |
|---|---|
| Select | click; <kbd>Shift</kbd> or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> click adds or removes |
| Marquee | drag on empty canvas selects everything fully inside; with <kbd>Shift</kbd>/<kbd>Cmd</kbd> it adds |
| Move | drag any selected element: the whole selection moves, one undo step, all pinned |
| Nudge | arrow keys, <kbd>Shift</kbd> for 10 |
| All / none | <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-A, <kbd>Esc</kbd> |
| Pan | two-finger scroll or wheel, <kbd>Space</kbd>-drag (also over elements), middle-button drag |
| Zoom | pinch, <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + scroll |
| No snap | hold <kbd>Alt</kbd> while dragging |
| Keys | <kbd>U</kbd> unpin, <kbd>Del</kbd> straighten line, <kbd>F</kbd> fit view, <kbd>S</kbd> source, <kbd>Cmd</kbd>-Z / <kbd>Shift</kbd>-<kbd>Cmd</kbd>-Z |

Sequence, Gantt and timing diagrams keep one selected element at a time, and
a drag on empty canvas pans there. Selected elements get a dashed blue
outline; the source panel highlights every selected declaration.

Toolbar: one row. File picker (basenames, grouped by folder; full path on
hover) · Auto layout, Reset, Unpin, Straighten · Undo, Redo · Frame + Fit to
frame · **Display** (popover) · Fit view · Source · readout (selected,
elements, lines, pinned, save state; counts drop out when narrow) · **Export
SVG** with a menu · **?**.

- **Display** popover:
  - **Theme**: `classic` (PlantUML look), `modern` (indigo), `midnight`
    (dark), `blueprint` (navy, mono type), `editorial` (warm paper, serif),
    `mono` (print), `mint`, `primary`. All but classic share one structure:
    one accent colour, hairlines, pill use cases, avatar actors, caps
    titles. Stored in layout.json, so `pnpm render` produces the same picture.
  - **Size**: text, icons and shapes from 75% to 300%, or "Largest that
    fits": the biggest size at which nothing collides and the router keeps
    its line corridors (positions are centres and stay put).
  - **Text − / +** and **Icons − / +**: 10% steps on top of Size; click the
    percentage to reset to 100%. Stored as `view.text` / `view.icons`.
  - **Gaps** (sequence, Gantt, timing only): column and row gap, stored as
    `view.spacing`.
  - **Grid**: dotted canvas or plain white. Zoomed out, the dots switch to a
    5× coarser grid and then disappear rather than turning into a grey mesh.
- **Source** (S): read-only panel with the .puml (highlighted, line numbers)
  and the live layout.json. Selecting elements highlights the lines that
  declare them; clicking a line selects what it declares.
- **Frame** + **Fit to frame**: pick an aspect ratio (16:9, 4:3, 1:1, A4,
  this window) and the diagram is re-arranged to fill it. The search tries
  16 layouts (layered in both directions × 4 spacings × element sizes
  160% and 260%, in parallel Web Workers), scores them by how large the text ends up in the frame minus
  line length and crossings, routes the best three for real, stretches the
  winner into the frame, then grows text into any room left. Line corridors
  are fixed pixels, so laying out at larger sizes is what makes text big
  relative to the frame. Coordinates land on a 4px grid. ~1 s; undoable.
  (`src/layout/blocks.ts`, a per-container block layout with ports, lost on
  this fixture and is not in the search; kept for layout templates.)
  Export uses the frame as the canvas.
- **Export**: the orange key downloads SVG; its menu adds PNG (2×, less for very large layouts; rasterised
  from the same SVG), **Layout JSON** (downloads the sidecar exactly as the
  editor saves it, named `x.layout.json`), **Copy layout JSON**, and
  **Import layout JSON…** (replaces the layout as one undoable step;
  elements the file doesn't place are laid out).

## layout.json

    {
      "version": 1,
      "view": { "theme": "modern", "frame": [16, 9], "scale": 2.6 },
      "nodes": {
        "Admin": { "x": 600, "y": 451, "pinned": true },
        "UC_Login": { "x": 2470, "y": 1012 }
      },
      "edges": {
        "UC_Pay-->PSP": { "via": [[2223, 395]], "label": [0, -8] }
      }
    }

- Node keys are PlantUML aliases (`usecase "Log In" as UC_Login`), or the
  name when there's no alias. Positions are centres.
- Edge keys are `from<arrow>to` with the arrow normalised (`-->`, `..>`,
  `--|>`, `..`); repeated edges get `#2`, `#3`.
- `via` are checkpoints the orthogonal route must pass through; `label` is an
  offset from the label's automatic position.
- Entries for ids that vanish from the source are kept, so a rename can be
  undone without losing the position.

## How

- Parse: `src/model/parse.ts` (actors, use cases, nested containers, notes,
  relations; unsupported lines become warnings, never errors).
- Layout: ELK layered for the first layout and for unpinned nodes
  (`src/layout/auto.ts`); new nodes go next to their neighbours.
- Lines: libavoid (Adaptagrams) orthogonal routing with nudging, compiled to
  WASM, re-run on every pointer move (~8 ms for the fixture).
- Text is measured with a fixed Helvetica width table so the CLI and the
  browser agree on sizes.

## Speed

Measured in Chrome on the fixture (36 elements, 45 lines), `node scripts/perf.mjs`:

| | per pointer move |
|---|---|
| routing while dragging (only lines touching what moves) | ~2 ms |
| React commit (unchanged elements are memoized) | ~4 ms |
| full re-route + nudging on release | ~17 ms |

Fit to frame: ~0.6 s, 16 ELK layouts in a pool of Web Workers
(`node scripts/fit-timing.mjs`). Drawing is not the bottleneck at this
size, which is why rendering stays SVG (crisp text, real DOM hit-testing,
1:1 SVG export) rather than WebGL.

## Test

    pnpm test        # parser, layout merge, routing (no lines through elements, < 50 ms), fit, themes
    pnpm typecheck
    node scripts/smoke.mjs out/editor.png   # with pnpm dev running: drag, bend, undo, theme, fit, in headless Chrome
    scripts/png.sh out/x.svg out/x.png 1800 # rasterise an SVG to look at it
