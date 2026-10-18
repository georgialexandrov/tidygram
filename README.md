# puml-layout

Make diagrams you don't own look right, without touching them. The source
(`diagram.puml`, `.mmd` or `.drawio`) stays exactly as its author wrote it; everything you change
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
| ArchiMate | ✅ `archimate #Layer "X" as A <<type>>`, `Business_Actor(..)`-style macros, Grouping, junctions, every `Rel_*` with its own ends (direction suffixes ignored); layer tints and ArchiMate type glyphs | `archimate.puml` |
| nwdiag | ✅ networks as bars, hosts with per-network addresses, shapes, descriptions, groups, peer links; networks stack in source order | `nwdiag.puml` |
| Salt, regex, EBNF, math, ditaa, ... | recognised; the editor shows a "not supported yet" panel (`fixtures/unsupported/`) and writes no sidecar | |

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
| Pie, journey, gitGraph, timeline, quadrant, XY, sankey, requirement, C4, block, packet, architecture, kanban, ... | recognised; the editor shows a "not supported yet" panel (`fixtures/unsupported/`) and writes no sidecar | |

## draw.io

`.drawio`, `.drawio.xml`, or any `.xml` holding `<mxfile>`/`<mxGraphModel>`
(fixtures in `fixtures/drawio/`). The file is recognised by its content,
whatever it is called. Ids are the mxCell ids, which draw.io keeps stable;
line ids are the edge cell ids.

**The file's layout is the default layout.** A draw.io file already has
hand-made geometry, so an element with no sidecar entry sits where the
author put it, at the author's size, and lines get the author's waypoints
as `via`. ELK only runs when you ask: **Auto layout** (and Fit to frame)
still lays out with ELK; **Reset** (`--reset`) goes back to the file's
layout, not to ELK. Positions in the sidecar are in the file's coordinates.

| | |
|---|---|
| Pages | every `<diagram>` page, one at a time: the editor shows a page selector for multi-page files (`?page=<id>` deep links), the CLI takes `--page <id\|name\|n>`, code passes `parseDiagram(source, name, { page })` (0-based index, page id or name; `ParseResult.pages` lists them). Each page has its own layout in the sidecar (see layout.json) |
| Compression | inline `<mxGraphModel>` and compressed pages (base64 + raw deflate + URI-encoding), decoded by a built-in inflater (`src/model/inflate.ts`), no dependency |
| Containers | any cell with children: `swimlane`, `container=1`, labelled groups; nested, child geometry made absolute. Unlabelled `group` cells are invisible in draw.io and are flattened (unless a line points at one) |
| Tables | ER entities (stack-layout swimlane of text rows) and `shape=table` become entity boxes with their rows; lines to a row attach to the table |
| Shapes | rectangle, `rounded=1` (rounded box), `ellipse` (ellipse, a circle when square), `rhombus` (diamond), `cylinder*`/`datastore` (database), `umlActor`, `cloud`, `hexagon`, `process`/`step` (PlantUML's process outline), `note`, `document` (file), `card`, `folder`, `component`, `cube` (node), `text` (label), common `mxgraph.flowchart.*`; parallelogram, trapezoid, lifeline and similar as plain boxes. Other stencils (`mxgraph.aws4.*`, images, ...) become boxes with their label, reported in one warning |
| Labels | `html=1` labels lose their tags (`<br>`, `<div>`, `<p>` become line breaks), entities decoded; `UserObject`/`object` wrappers give the label and id; `edgeLabel` children attach to their line (near the source end, middle, near the target end) |
| Arrows | `endArrow`/`startArrow` with `endFill`/`startFill`: classic/open/block (hollow block = triangle), diamond/diamondThin (filled or not), oval, cross, box, none, and ER `ERone`/`ERmandOne`/`ERmany`/`ERzeroToOne`/`ERzeroToMany`/`ERoneToMany`; `dashed=1` |
| Skipped | lines with a loose end (only `sourcePoint`/`targetPoint`) or to another line, each with a warning; hidden cells |

Sizes: a box keeps the file's width and height (times the view's Size) and
only grows when the theme's text, which is not draw.io's font, needs more
room. `whiteSpace=wrap` labels wrap to the box width. Actors keep the
theme's figure; the figure sits on the file box with the label underneath.
A container keeps its file box while its contents stay in place or move
together (dragging it by the title); once they are rearranged it fits them
like any other container.

Ignored: colours, fonts, label positions and offsets, edge styles (lines are
always routed orthogonally through the waypoints, so a straight diagonal
line in draw.io becomes an orthogonal one), rotation, and horizontal
swimlane headers (titles are always on top). Themes own the look.

Like Mermaid, `x.drawio` next to `x.puml` would share `x.layout.json`; keep
them in different folders.

The parsers feed one format-neutral model (`src/model/types.ts`), so a new
input is a new parser.

## Conversion

Any of the three formats converts into any other, with its layout:

    pnpm render diagram.puml --to drawio            # → diagram-drawio.drawio
    pnpm render diagram.drawio --to mermaid         # → diagram-mermaid.mmd + diagram-mermaid.layout.json
    pnpm render diagram.mmd --to puml -o out/x.puml # → out/x.puml + out/x.layout.json
    pnpm render diagram.puml --fit 16:9 --to drawio # layout options apply first

Editor: Export menu → Convert to draw.io / PlantUML / Mermaid (browser
downloads; PlantUML and Mermaid come as two files, the source and its
layout.json). Code: `src/convert/` (`toPlantUml`, `toMermaid`,
`toDrawio(diagram, layout, scene?)`, or `convert(diagram, layout, target)`),
each returning `{ source, layout, warnings, ids }`.

Default output names get a `-<format>` suffix because `x.puml` and `x.mmd`
in one folder would share `x.layout.json`. Existing files aren't overwritten
without `--force`, and an `-o` whose sidecar would be the input's is refused.

**How layout travels.** PlantUML and Mermaid can't hold positions, so:

- **→ draw.io** carries the whole picture: node and container boxes from the
  built scene (children relative to their `container=1` parent), every
  routed line's bends as waypoints with `edgeStyle=orthogonalEdgeStyle` and
  its ends pinned where our router attached them. Reading the file back
  gives the same boxes. No sidecar is written; the view's theme/frame stay
  in the returned layout, size scaling is baked into the geometry.
- **→ PlantUML / Mermaid** write source whose ids our parser reads back, plus
  the sidecar re-keyed to those ids. Node ids are kept as aliases
  (`component "Label" as "if: ok?"`, `id["Label"]`, Mermaid ``class `x` ``);
  PlantUML derives edge ids from the arrow (`A-->B`), Mermaid keeps
  word-like line ids with `id@-->`. Where an id can't be written it is
  renamed and the old → new map (`ids`) re-keys the sidecar. PlantUML lines
  get direction keywords (`-right->`) from the layout and the file gets
  `left to right direction` / `flowchart LR` when most lines run sideways,
  so plantuml.com and mermaid.live come closer; the sidecar holds the exact
  picture.

**What each target holds** (✅ round-trips; ≈ written with approximations,
each warned once per kind):

| Family | → PlantUML | → Mermaid | → draw.io |
|---|---|---|---|
| use case / component / deployment, draw.io | ✅ description syntax (draw.io's rounded boxes, diamonds, ellipses ≈ rectangle, hexagon, use case) | ≈ flowchart (actors, components, use cases ≈ boxes; triangle/diamond ends ≈ arrows; no end labels) | ✅ (use case ≈ ellipse, queue ≈ cylinder, storage ≈ rounded box) |
| class / object | ✅ | ✅ classDiagram (compartments beyond fields/methods merge) | ✅ UML class tables: a `«interface»`/`«enum»`/`«stereotype»` line above the name, abstract names in italics, kind and stereotype kept in `pumlClassKind`/`pumlStereotype` style keys |
| ER (crow's foot) | ✅ | ✅ erDiagram (rows reformatted to `type name PK "comment"`) | ✅ tables |
| state | ✅ | ✅ stateDiagram-v2 (one arrow per transition; history ≈ state) | ≈ pseudo-states and states as ellipses/rounded boxes (descriptions as small lines under the name) |
| C4 | ✅ C4 macros | ≈ flowchart; `[technology]` and description as `<small>` lines under the name | ≈ boxes; `[technology]` and description as small lines under the name |
| ArchiMate, Chen, nwdiag, JSON/YAML | ≈ component/class syntax (filled-dot ends ≈ circle; JSON tables ≈ objects) | ≈ flowchart / classDiagram | ✅ / ≈ (JSON tables, network bars ≈ boxes) |
| activity | ≈ component-style graph: activity syntax isn't regenerated from a graph | ≈ flowchart (decisions ≈ diamonds) | ≈ (decisions ≈ rhombus) |
| mindmap / WBS | ✅ | ✅ mindmap (one root; WBS becomes a mindmap) | ≈ rounded boxes |
| sequence | ✅ | ≈ (dividers, delays, spaces, lost/found messages, half/circle heads dropped) | ≈ a drawing (see below) |
| Gantt | ✅ (tasks pinned to dates; `->` keeps dependencies) | ≈ (dependencies kept as `after` where the dates agree; partial completion and colours other than crit lost) | ≈ a drawing |
| timing | ✅ | no Mermaid equivalent | ≈ a drawing |

**Folded labels in draw.io.** draw.io keeps style keys it doesn't know, so
the export writes what a box says beyond its name both ways: visibly
(`«kind»`/`«stereotype»` lines above the name, `[technology]` and
description lines under it, smaller) and as `pumlHead`/`pumlTail`
(how many label lines aren't the name), `pumlStereotype`,
`pumlTechnology` and `pumlClassKind`, which `parseDrawio` uses to take the
label apart again. A file edited in draw.io keeps them as long as the box
isn't restyled.

**Sequence, Gantt and timing → draw.io are drawings.** draw.io has no
sequence or time-axis model, so the built scene is drawn shape by shape in
the theme's colours and text sizes (page background included): participants
as their shapes at the top and bottom, lifelines as dashed lines,
activations as thin boxes, messages as straight lines pinned to their rows
with the label above, fragments and refs as UML frames, notes as notes;
Gantt tasks as bars on the date grid (names in the label column, weekends
tinted, completion as a solid part), milestones as diamonds, sections as
headings, dependencies as lines; timing lanes with their waveforms,
concise states as hexagons, messages between lanes. Everything a line ends
on is a shape, so the file reads back as a plain graph (participants,
tasks and signals as named boxes, messages and dependencies as lines
between them), not as a sequence again: the PlantUML or Mermaid source
stays the editable copy, and our editor shows the read-back file as a free
diagram, not as the original chart.

Everywhere: PlantUML has no escape for `"` in labels (written as `'`) and
its reader drops ` #word` / `$word` decorations; draw.io HTML labels collapse
runs of spaces; note attachment and hidden lines don't survive draw.io; a
note link reads back from draw.io as a dashed line. The full per-fixture
list of losses is asserted in `tests/convert.test.ts` (`LOSSES`).

## Architecture templates

One picture where the layers are bands, a hexagon or rings, applied to a
diagram you don't own: component, C4, class, ArchiMate, Mermaid flowchart or
draw.io architecture diagrams. The source never says which layer an element
is in, so the template and the element → layer assignment live in the
sidecar (`template`, see layout.json); the source stays untouched.

    pnpm render fixtures/architecture/layered-web-shop.puml --template layered
    pnpm render fixtures/architecture/hexagonal-order-service.puml --template hexagonal --theme primary
    pnpm render fixtures/architecture/clean-flowchart.mmd --template clean --fit 16:9
    pnpm render x.puml --template none     # back to the free layout from before

The CLI prints each layer's members, the unassigned elements and the
violations. Fixtures in `fixtures/architecture/`: a hexagonal order service
(ports, driving/driven adapters, DB, queue, an external payment API), a
layered web shop with one deliberate violation and one element nothing
names, a C4 container diagram, a clean-architecture Mermaid flowchart
with two outward lines, and a draw.io file with loosely named swimlanes
("Web tier", "Services", "Data").

| Template | Picture | Violations |
|---|---|---|
| **Layered** | full-width bands top to bottom (default Presentation / Application / Domain / Infrastructure; ArchiMate: Business / Application / Technology), titles in a gutter on the left. Each band is a row (wrapped round-robin into more rows when long); rows are ordered by a few barycentric sweeps (each element under the average of its neighbours in other bands, nearer bands weigh more, same-band neighbours half), packed without overlaps by isotonic regression around those wishes, then improved by adjacent swaps that shorten the lines | a line pointing up (a lower layer using a higher one). `relaxed` (default) lets a realization point up: implementing a higher layer's interface is dependency inversion. `strict` flags those too, and lines that skip a band. ArchiMate defaults to `off` (serving lines point up by design) |
| **Hexagonal** | the application in a flat-topped hexagon, the domain in its own hexagon inside, application elements above and below it; inbound ports on the left outline, outbound ports on the right (their lollipop or box centre exactly on the line, ordered by their partners); adapters in columns outside: driving left, driven right, what touches a port or the core next to the hexagon, what only adapters reach (users, databases, external systems) one column further out. Adapter panels behind each side | an adapter using the core directly (not through a port); the core or a port depending on an adapter; the domain using the application around it; a driving adapter using an outbound port, or a driven adapter using an inbound one (each side has its own ports); a driving adapter using a driven adapter (a controller calling a repository skips the core). Adapters chaining on their own side (UI → controller, repository → database) are fine |
| **Clean / onion** | concentric rings inside out (default Entities / Use cases / Interface adapters / Frameworks & drivers). Each ring is a rounded rectangle (corner radius 0.6 of its half-height; convex, symmetric about both axes) sharing one centre, so they nest calmly with an even band; each takes the smallest width and height that hold its members (padded) and the ring inside (plus a band). Members sit as close to the ring inside as their boxes allow at their angle, in the angular order of what they connect to (circular mean of their neighbours, inner rings first), and placement searches rotations, shifts and swaps for the smallest ring; the core stays evenly spaced because the centre is its mean. Titles at the top of each ring, sliding along it off any line, label or member. Draw.io export: rounded rectangles (`arcSize` = corner radius). A whole fit takes under 100 ms: candidate sizes are scored on a quick arrangement, the winner gets the full search once | a dependency pointing outward. `relaxed` lets the interface adapters use the frameworks & drivers ring (a repository talking to its database); `strict` flags every outward line |

**Guessing.** Every element gets a template-neutral role first, from the
strongest signal: its stereotype (`<<port>>`, `<<adapter>>`, `<<entity>>`,
ArchiMate's `business actor` / `application component` / `technology node`),
"port" in its name, a strong kind (actor/person, database, queue, storage,
interface), the names of its containers (`package domain`, `adapters.in`,
`infrastructure`, a Mermaid subgraph called `usecases`), its own name, id and
C4 technology (`OrderRepository`, `REST Controller`, `[PostgreSQL]`), then a
weak kind (cloud, C4 system/container). A stereotype or container that names
one of the template's layers outright (`package "Domain"`, a renamed layer
"Persistence") wins unless something more specific came first; generic
signals (a container called "adapters" or "frameworks") yield to a more
specific name. Each template maps roles to its layers (C4: the API and
workers are the application). What's left goes by graph position: between
what it uses and what uses it (one band down, one ring in); in the hexagon a
port the core implements is inbound and one it uses outbound, an adapter that
implements a port is driven, one that uses the core or an inbound port is
driving, then sources drive and sinks are driven. Notes follow what they
annotate. Anything still open goes to the default layer (Application, Use
cases) and is listed as **unassigned**. Guesses are stored as `guess` and
re-guessed whenever the diagram loads, so a source edit can move an element
nobody confirmed; a drag stores the layer in `assign`, which is never
re-guessed.

**Rendering.** Bands, hexagons, panels and rings are scene elements
(`src/scene/template.ts`), derived from where the members are, the way
containers fit their children: a drag, a size change or a fit can never
leave an element outside its layer. Placement (`src/layout/template/`) uses
the same functions, so right after placing the geometry is exactly the
planned one. Themed in every theme (`layerFills`, `layerStroke`,
`layerTitle`, `warning`). Violations are drawn in the theme's warning colour,
thicker, with a warning triangle on the line (its tooltip says why). The
source's containers are hidden while a template is on (their names fed the
guesses). SVG and PNG export draw everything; **→ draw.io** writes the
backdrop as locked shapes on their own bottom layer (`pumlTemplate=1`, which
our reader skips, so the file reads back as the same diagram) and colours
violated lines; **→ PlantUML / Mermaid** carry the template in the converted
sidecar, re-keyed.

**Editor.**
- **Template** key in the toolbar (glyph + name, latched when on): None /
  Layered / Hexagonal / Clean, and the rule set (relaxed, strict, off) while
  one is on. Applying is one undoable step; switching kinds keeps the
  original free layout; **None** restores it (also undoable).
- **Drag into another band, ring or zone** to reassign: while dragging, the
  backdrop holds still and the target layer is outlined in blue; on release
  the element is assigned there (pinned) and the template re-places around
  it, everything else keeping its order. Ports dropped on the other side of
  the hexagon become outbound (or inbound). Dragging within a layer is just a
  move.
- **Findings** panel (bottom left): violations (yellow, like warnings) and
  unassigned elements; clicking one selects the line or element. Collapsible.
- **Auto layout** re-places everything (hand-placed elements keep their spot
  as a hint); **Reset** drops the template too; Theme / Size / Text / Icons
  re-place in the same order so the gaps still fit.
- **Fit to frame** keeps the arrangement and only chooses size, gaps and
  (layered) elements per row, trying 21–147 placements in a few ms.

Not done: C4-style tiers (people top, system boundary middle, external
systems right); zoom levels (C4 context → container → component as switchable
views) — the sidecar has room for them as a `views` map shaped like `pages`.

## Use

    pnpm install
    pnpm dev                     # editor on http://localhost:5199
    PUML_ROOT=~/diagrams pnpm dev  # edit diagrams in another folder
    pnpm render fixtures/food-delivery.puml -o out/food-delivery.svg
    pnpm render fixtures/food-delivery.puml --theme modern --fit 16:9   # FIT_DEBUG=1 prints every candidate's score
    pnpm render fixtures/drawio/pages.drawio --page Details             # one page of a multi-page draw.io file → pages-p2.svg
    pnpm render fixtures/architecture/layered-web-shop.puml --template layered   # bands; also hexagonal, clean, none

Editor: drag elements (they become pinned), drag a box title to move the
box with its contents, pull a line to bend it, double-click a bend to remove
it, drag labels. Auto layout re-lays out everything that isn't pinned. The
editor reloads live when the .puml or the layout changes on disk.

**Line ends** (where a line attaches, like draw.io's connection points):
select a line and its two end handles show (hollow = automatic, filled =
chosen by hand). Hovering a handle outlines the element it sits on and marks
its snap points; drag the handle along that outline and it snaps to side
centres, quarter points and corners on boxes, every 22.5° on ellipses,
diamonds and pills, within 10 screen px. Hold <kbd>Alt</kbd> to place it
anywhere on the outline. The line is re-routed live and comes in square to
the chosen side; release is one undo step. Double-click a handle to make
that end automatic again; **Straighten** (<kbd>Del</kbd>) clears both ends
with the bends. Only the attachment moves: what a line connects comes from
the source, so an end can't be dragged to another element. Chosen ends are
stored relative to the element, so they survive moves, resizes, Auto layout,
Fit to frame and templates; **Reset** drops them.

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
| Line end | select a line, drag an end handle along the outline; double-click it for automatic |
| No snap | hold <kbd>Alt</kbd> while dragging (elements and line ends) |
| Keys | <kbd>U</kbd> unpin, <kbd>Del</kbd> straighten line, <kbd>F</kbd> fit view, <kbd>S</kbd> source, <kbd>Cmd</kbd>-Z / <kbd>Shift</kbd>-<kbd>Cmd</kbd>-Z |

Sequence, Gantt and timing diagrams keep one selected element at a time, and
a drag on empty canvas pans there. Selected elements get a dashed blue
outline; the source panel highlights every selected declaration.

Toolbar: one row. **Diagram picker** · page selector (multi-page draw.io
only) · Auto layout, Reset, Unpin, Straighten · Undo, Redo · **Template**
(see Architecture templates) · Frame + Fit to frame · **Display** (popover) · Fit view · Source · readout (selected,
elements, lines, pinned; counts drop out when narrow) · lamps (warnings,
save state; never hidden) · **Export SVG** with a menu · **?**. Narrow
windows lose the nameplate first, then label words ("Auto", "Export", an
icon for Fit view), and below 1060 px the Unpin/Straighten keys (U and
Delete still work); nothing wraps.

- **Diagram picker**: the key shows the open file's format badge (`PUML`,
  `MMD`, a filled `DRAWIO`) and name; its panel lists every diagram under
  the root grouped by folder, with a filter field that matches path and
  format words (`class mmd`, `drawio`, `er plantuml`). Arrows move, Enter
  opens, Esc closes. `?file=path` deep-links a diagram, `&page=<id>` a
  draw.io page.
- **Opening is fast**: ~30–40 ms from fetch to committed scene with a
  sidecar, ~150 ms when ELK has to lay a diagram out first (`window.__perf
  .summary()` has `open: fetch/parse/layout/total`). The view fits the
  window on open and keeps fitting on window resizes until you pan or zoom.
- **Nothing to arrange**: a type we recognise but can't lay out (Salt, pie,
  ...) or a file without elements shows a panel saying so instead of an
  empty grid; nothing is written for it (no sidecar). Fixtures in
  `fixtures/unsupported/`.
- **Warnings** (yellow triangle with a count): a list of skipped or
  approximated source lines that floats over the canvas, so opening it never
  moves the diagram. Errors float the same way (red square), dismissable.

- **Display** popover:
  - **Theme**: stored in layout.json (`view.theme`), so `pnpm render`
    produces the same picture; see [Themes](#themes).
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
  editor saves it, named `x.layout.json`, all draw.io pages included),
  **Copy layout JSON**, and **Import layout JSON…** (replaces the layout as
  one undoable step; elements the file doesn't place are laid out; a
  multi-page sidecar brings the open page's entry).
- **Convert to draw.io / PlantUML / Mermaid**: the conversions run when the
  menu opens (a few ms). A target that can't hold the diagram is disabled
  and says why (timing → Mermaid: "no timing in Mermaid"; sequence, Gantt,
  timing → draw.io: "not yet"); the others show their number of losses
  (yellow triangle), pointing at a row lists what that target can't hold
  under the menu, and the row's tooltip has the full list. A multi-page
  draw.io file converts the page on screen.

## Themes

`modern` is the default (a sidecar without `view.theme` gets it). Every
theme draws every diagram type; `tests/theme.test.ts` checks each theme's
text/background pairs against WCAG AA (4.5:1, no large-text discount, since
diagram text is 10–13 px) and renders every element kind and line end in it.

| Theme | Look |
|---|---|
| `modern` | Default. Slate neutrals, indigo as the one accent, system sans (Inter/SF). White cards with a hairline; containers as tinted panels with small-caps titles; lines a mid grey so boxes read first; labels on knock-out chips |
| `classic` | PlantUML, crisper: Helvetica, `#F1F1F1` boxes, class spots, visibility icons in PlantUML's colours, PlantUML's C4 blues (white text) and ArchiMate layer colours |
| `midnight` | Dark: deep blue-black, cyan accent; fills step up in lightness, strokes stay low |
| `editorial` | Warm paper, serif type, burnt-orange accent: figures for essays and print |
| `blueprint` | Navy paper, white linework, mono type, amber accent |
| `mono` | Black on white, no colour: print and photocopies |
| `primary` | Matches the editor chrome: black ink on warm white, primaries as signals |
| `paper` | Light editorial figure: warm paper, near-black ink, one tangerine accent for people, roots, progress and broken rules. White cards, hairline containers, mono sublabels and line labels, tracked-caps eyebrows, small type tags (`CONT`, `IFACE`), dashed serif-italic notes, no shadows |
| `paper-dark` | `paper` inverted: deep slate paper, off-white ink, a lighter tangerine accent |

`mint` was retired (it was `modern` in green); old sidecars that name it
open in `modern` (`THEME_ALIASES` in `src/scene/theme.ts`), and so do
unknown names.

What the themes share (everything but `classic`):

- **Hierarchy**: elements first (white or tinted cards, 500–600 weight),
  containers recede (tint, hairline, caps titles drawn over the lines on a
  chip of the container's fill, so a crossing line passes under the title),
  notes and labels quieter still.
- **Lines** by relation: associations mid grey, structural relations
  (generalization, realization, composition, aggregation) darker,
  dependencies dashed, note links lightest; violations in the warning colour.
  Heads scale with the line weight: a slim notched arrow, hollow triangles
  and diamonds with mitred joins, crow's feet. Multiplicities have a halo.
- **Colour that means something**: C4 people solid accent, internal
  systems/containers accent tint, external grey, with a
  type line (`Container · NestJS`); ArchiMate elements get their layer's
  tint (business yellow, application blue, technology green, ...) and the
  ArchiMate type glyph in the corner instead of a `«stereotype»` line.
- **Type**: tabular numerals wherever numbers line up (Gantt dates, ticks,
  sequence numbers, multiplicities, JSON values); `[technology]` lines in
  C4 relation labels drawn muted.

Per type:

- **Class / ER / JSON**: a tinted header band; members in aligned columns:
  visibility glyph (PlantUML's circle/square/diamond/triangle, filled for
  methods), name, and the type right-aligned and muted; `{static}`
  underlined, `{abstract}` italic. ER keys as `PK`/`FK` badges (PK on the
  accent tint, name bold), `*` mandatory as a dot. JSON tables read
  key | value with scalars in the accent and zebra rows past three. A class
  without members is a plain named box.
- **Sequence**: autonumbers in accent bubbles (grey for returns), calls in a
  stronger ink than returns, hairline lifelines (dotted through `...`
  delays instead of a white band), tinted activation bars, fragments as thin
  frames with a small-caps tab, drawn over activation bars so guards stay
  readable.
- **Gantt**: weekends shaded through header and body, week/month rules only,
  sections as small-caps headings with task names indented under them, bars
  in the accent (completed share solid, the rest a tint, `60%` next to it;
  a task without a completion is drawn solid, since its progress is unknown,
  not zero), `is colored in` colours honoured, milestones as diamonds with an
  italic name, rounded dependency elbows. No "today" line: the model has no
  today, and exports must not depend on the day they're made.
- **Timing**: accent waveforms, dotted state guides for robust signals, high
  time of clocks/binary signals filled faintly, tick labels tabular.
- **State / activity**: rounded states, bullseye finals, merge diamonds and
  `if` hexagons in the line colour on a tint so they don't vanish.
- **Mindmap**: smooth branches thinning with depth; root a solid accent pill,
  first level tinted, deeper levels quiet pills (WBS keeps its tree lines).
- **nwdiag**: networks as solid accent bars with the address range on them.

## layout.json

    {
      "version": 1,
      "view": { "theme": "modern", "frame": [16, 9], "scale": 2.6 },
      "nodes": {
        "Admin": { "x": 600, "y": 451, "pinned": true },
        "UC_Login": { "x": 2470, "y": 1012 }
      },
      "edges": {
        "UC_Pay-->PSP": { "via": [[2223, 395]], "label": [0, -8] },
        "UC_Login-->Auth": { "from": { "x": 1, "y": 0.5, "side": "right" }, "to": { "x": 0.25, "y": 0, "side": "top" } }
      }
    }

- Node keys are PlantUML aliases (`usecase "Log In" as UC_Login`), or the
  name when there's no alias. Positions are centres.
- Edge keys are `from<arrow>to` with the arrow normalised (`-->`, `..>`,
  `--|>`, `..`); repeated edges get `#2`, `#3`.
- `via` are checkpoints the orthogonal route must pass through; `label` is an
  offset from the label's automatic position.
- `from` / `to` (optional): where the line attaches at its source / target,
  chosen by hand. `x`, `y` are fractions (0..1) of the element's drawn
  outline's bounding box (the figure, not an icon's name below it; for a
  line ending on a container, the container's box), the same convention as
  draw.io's `exitX`/`exitY` and `entryX`/`entryY`. `side` (`top`, `right`,
  `bottom`, `left`) is the way the line leaves: it meets the outline square-on
  from there (on ellipses and diamonds the point is projected onto the outline
  along that side). Fractions are clamped, a missing side is taken from the
  nearest edge, and sidecars without them are automatic exactly as before.
  They win over every automatic attachment (diamond vertices, bars, spread
  ends); container walls and doors still apply. draw.io files with
  exit/entry points open with them here, and Convert to draw.io writes them
  back (ends the router chose are written too, so draw.io draws the same
  path, but flagged `pumlAutoExit=1`/`pumlAutoEntry=1` so they read back as
  automatic).
- Entries for ids that vanish from the source are kept, so a rename can be
  undone without losing the position.
- **`template`** (optional): the architecture template on this page. While
  it is on, `nodes` hold the template's arrangement and `free` the free
  layout it replaced; sidecars without it are free layouts exactly as
  before. `layers` (optional) replaces the kind's default list (bands top to
  bottom, rings inside out; plain strings work as ids and labels; hexagonal
  roles are fixed and only take labels), `rules` is `relaxed` (default),
  `strict` or `off`. `assign` holds what a human assigned (by dragging),
  `guess` the machine's guesses, one entry per line. Unknown kinds or layer
  ids fall back instead of failing the file. Draw.io pages each have their
  own.

      "template": {
        "kind": "layered",
        "layers": [{ "id": "presentation", "label": "Presentation" }, { "id": "application", "label": "Application" }, { "id": "domain", "label": "Domain" }, { "id": "infrastructure", "label": "Infrastructure" }],
        "rules": "strict",
        "assign": { "Cart": "application" },
        "guess": { "Api": "presentation", "Pg": "infrastructure" },
        "free": { "nodes": { "Api": { "x": 120, "y": 40 } }, "edges": {} }
      },
- **Multi-page draw.io files**: the first page's layout is the top level,
  exactly as above, so single-page sidecars (and every sidecar written before
  pages existed) stay valid. Each other page gets its own `view`, `nodes`
  and `edges` under `pages`, keyed by the draw.io page id (which survives
  renaming the page; files without page ids fall back to the name, then
  `#n`). A page with nothing stored has no entry. Reordering pages in
  draw.io moves which page is "first"; ids keep the others straight.

      {
        "version": 1,
        "nodes": { "web": { "x": 100, "y": 110 } },
        "edges": {},
        "pages": {
          "p2": { "view": { "theme": "mono" }, "nodes": { "d1": { "x": 140, "y": 90, "pinned": true } }, "edges": {} }
        }
      }

  Code: `pageLayout(file, key)` / `withPageLayout(file, key, layout)` in
  `src/layout/layout-file.ts`; everything else sees one page.

## How

- Parse: `src/model/parse.ts` (actors, use cases, nested containers, notes,
  relations; unsupported lines become warnings, never errors).
- Layout: the first layout and Auto layout (`src/layout/auto.ts`) lay out
  several candidates, route them, and keep the best; new nodes go next to
  their neighbours. Candidates: ELK layered in both directions (unless the
  source fixes one), with network-simplex node placement, ELK's wrapping,
  containers laid out across the flow, long rows cut into 2–3 rows and long
  columns into 2–3 columns (each still reading in flow order). Use-case
  diagrams also get the use-case layout (below). Scoring, in `routedScore`:
  how large the picture is drawn in a 16:9 window, divided by penalties for
  crossings (strongest), bends, line length, lines running back across more
  than half the picture, proportions outside 4:3–2:1 and faults; scores
  within 3 % count as a tie, won by the more expected layout (the source's
  direction, unwrapped), so a routing tweak doesn't flip the picture. The
  winner of a small diagram (≤ 40 elements) is then polished: each element
  or container slides into free space towards what it connects to, kept only
  when the routed picture has no more crossings, bends or faults and scores
  better. `AUTO_DEBUG=1` prints every candidate's numbers.
- Use-case diagrams (`src/layout/usecase.ts`, description diagrams with
  actors and mostly use cases): actors who start things on the left, called
  systems on the right (by arrow direction and role words: the label's head
  noun — "Payment Gateway", not "Bank Clerk" — or a `<<system>>`-like
  stereotype), generalisation families stacked as one block; use cases in a
  grid inside their package, packages in a grid inside their boundary;
  package order tried exhaustively (≤ 5), use cases ordered by barycentre
  against the actor columns, then improved by swaps and moves scored on
  estimated routes (length, include/extend double, crossings, runs through
  boxes, actor fans that interleave); notes beside what they annotate. Six
  grid shapes nearest 16:10 are optimised and routed with the ELK
  candidates; a stored layout always wins (it's only Auto/first layout).
- State diagrams: fork/join bars lie across the flow (upright when their
  lines run sideways, `orientBars` in `src/scene/shapes.ts`); `note right
  of` turns with the layout when a top-down machine is laid out left to
  right.
- Lines: libavoid (Adaptagrams) orthogonal routing with nudging, compiled to
  WASM, re-run on every pointer move (~8 ms for the fixture).
- Text is measured with a fixed Helvetica width table so the CLI and the
  browser agree on sizes.

## Speed

Measured in Chrome on the fixture (36 elements, 45 lines), `node scripts/perf.mjs`:

| | per pointer move |
|---|---|
| routing while dragging (only lines touching what moves) | ~2 ms |
| React commit (unchanged elements are memoized) | ~4–8 ms (7.5 ms with the fixture's modern theme at 260%) |
| full re-route + nudging on release | ~17 ms |

Opening a diagram: 30–40 ms in the editor with a sidecar; a first layout
routes its candidates: 0.1–0.4 s for most fixtures, ~0.9 s for
food-delivery (use-case layout; Node, 2026-10-18); `node scripts/smoke-types.mjs`
opens all 31 fixtures and drags/switches pages in ~10 s.

Fit to frame: ~0.6 s, 16 ELK layouts in a pool of Web Workers
(`node scripts/fit-timing.mjs`). Drawing is not the bottleneck at this
size, which is why rendering stays SVG (crisp text, real DOM hit-testing,
1:1 SVG export) rather than WebGL.

## Test

    pnpm test        # parser, layout merge, routing (no lines through elements, < 50 ms), fit, themes, conversion round trips, templates
    pnpm typecheck
    node scripts/smoke.mjs out/editor.png   # with pnpm dev running: drag, bend, undo, theme, fit, templates (apply, drag into a band, undo, off), in headless Chrome
    node scripts/smoke-types.mjs [dir]      # every fixture: render, open time, "not supported" panel, draw.io pages (~10 s)
    scripts/png.sh out/x.svg out/x.png 1800 # rasterise an SVG to look at it
