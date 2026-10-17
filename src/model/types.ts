/**
 * Format-neutral diagram model. Parsers (PlantUML, Mermaid, draw.io) produce
 * this; layout, routing and rendering only ever see this.
 */

/**
 * A box in source coordinates: top-left corner and size, absolute (nested
 * draw.io geometry already resolved). Formats that carry a hand-made layout
 * (draw.io) set `sourceBox`/`sourceVia`; it is the default layout:
 * `ensureLayout` puts an element without a sidecar entry there, and Reset
 * returns to it (Auto layout still means ELK). Positions in the sidecar are
 * in the same coordinates.
 */
export interface SourceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which PlantUML family the source belongs to; decides how ambiguous keywords read. */
export type DiagramFamily = 'description' | 'class' | 'state' | 'c4' | 'mindmap' | 'wbs' | 'activity' | 'json' | 'chen' | 'network' | 'archimate';

export type NodeKind =
  // use case / component / deployment ("description" diagrams)
  | 'actor'
  | 'usecase'
  | 'component'
  | 'interface'
  | 'node'
  | 'database'
  | 'cloud'
  | 'queue'
  | 'artifact'
  | 'folder'
  | 'frame'
  | 'file'
  | 'card'
  | 'rectangle'
  | 'hexagon'
  | 'storage'
  | 'stack'
  | 'collections'
  | 'boundary'
  | 'control'
  | 'entity'
  | 'person'
  | 'agent'
  | 'label'
  | 'circle'
  | 'process'
  // class / object / ER
  | 'class'
  // state
  | 'state'
  | 'initial'
  | 'final'
  | 'choice'
  | 'fork'
  | 'history'
  // activity
  | 'action'
  | 'decision'
  // mindmap / WBS
  | 'topic'
  // C4
  | 'system'
  | 'container'
  // Chen ER: attribute ellipse, relationship diamond (entities are rectangles)
  | 'attribute'
  | 'relationship'
  // nwdiag: a network bar hosts hang off
  | 'network'
  // any family
  | 'note';

export type NotePosition = 'left' | 'right' | 'top' | 'bottom';

/** Flavour of a class-like box, shown in its header. */
export type ClassKind = 'class' | 'abstract' | 'interface' | 'enum' | 'annotation' | 'entity' | 'object' | 'map' | 'struct' | 'protocol' | 'exception' | 'record' | 'json';

export interface DNode {
  id: string;
  kind: NodeKind;
  label: string;
  stereotype?: string;
  /** Id of the enclosing container, if any. */
  parent?: string;
  /** For notes attached with `note right of X`: the target and side. */
  attachedTo?: { id: string; side: NotePosition };
  /** Class-like boxes: header flavour and member compartments (fields, methods, ...). */
  classKind?: ClassKind;
  compartments?: string[][];
  /** Extra text under the name: state descriptions, C4 descriptions. */
  description?: string[];
  /** C4 technology, shown as `[tech]`. */
  technology?: string;
  /** C4 / sprite-style external marker (System_Ext, Person_Ext). */
  external?: boolean;
  /** Chen notation: double outline (weak entity, identifying relationship, multi-valued attribute). */
  double?: boolean;
  /** Chen notation: key attribute (underlined) and derived attribute (dashed outline). */
  key?: boolean;
  derived?: boolean;
  /**
   * Where the source draws it (draw.io). Also fixes the size: the box keeps
   * the file's width and height (times the view scale) and only grows when
   * the theme's text needs more room. Icon kinds (actors) keep their
   * figure size; the figure is centred on the box.
   */
  sourceBox?: SourceBox;
  /** Label may wrap to the box width (draw.io `whiteSpace=wrap`); only with `sourceBox`. */
  wrap?: boolean;
  line: number;
}

export interface DContainer {
  id: string;
  kind: string;
  label: string;
  parent?: string;
  stereotype?: string;
  /**
   * The container's box in the source (draw.io). Drawn at that box (moved
   * along when all its contents move together) as long as its contents keep
   * their relative placement; otherwise it fits its contents like any other.
   */
  sourceBox?: SourceBox;
  line: number;
}

export type EdgeKind = 'association' | 'dependency' | 'generalization' | 'realization' | 'composition' | 'aggregation' | 'noteLink';

export type ArrowHead =
  | 'none'
  | 'arrow'
  | 'triangle'
  | 'diamond'
  | 'diamondFilled'
  | 'circle'
  | 'circlePlus'
  | 'cross'
  | 'square'
  /** Filled dot (ArchiMate assignment source). */
  | 'dot'
  // crow's foot (ER): the end's cardinality
  | 'crowZeroOne'
  | 'crowOne'
  | 'crowZeroMany'
  | 'crowOneMany'
  | 'crowMany';

export interface DEdge {
  /** Stable key used in layout.json: `from<op>to`, `#n` suffix for duplicates. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  dashed: boolean;
  head: ArrowHead;
  tail: ArrowHead;
  label?: string;
  /** Labels at the ends, e.g. multiplicities `"1" -- "*"`. */
  fromLabel?: string;
  toLabel?: string;
  hidden: boolean;
  /** Drawn as a double line (Chen total participation). */
  double?: boolean;
  /** True when the source wrote it the other way round (`B <|-- A`); layout follows the written order. */
  reversed?: boolean;
  /** Bend points the source draws (draw.io waypoints), absolute; become `via` when the layout comes from the file. */
  sourceVia?: [number, number][];
  line: number;
}

export interface Diagram {
  family: DiagramFamily;
  direction: 'TB' | 'LR';
  nodes: DNode[];
  containers: DContainer[];
  edges: DEdge[];
  /**
   * Diagram types whose layout is ordered rather than free (sequence, Gantt,
   * timing) carry their own model here; `nodes`/`edges` stay empty for them.
   */
  special?: SequenceModel | GanttModel | TimingModel;
}

// ---- sequence ----------------------------------------------------------------------------------

export type ParticipantKind = 'participant' | 'actor' | 'boundary' | 'control' | 'entity' | 'database' | 'collections' | 'queue';

export interface SeqParticipant {
  id: string;
  kind: ParticipantKind;
  label: string;
  stereotype?: string;
  /** `participant A order 10`: explicit column order. */
  order?: number;
  line: number;
}

export type SeqHead = 'arrow' | 'open' | 'half' | 'cross' | 'circle' | 'none';

export type SeqEvent =
  | {
      type: 'message';
      id: string;
      /** '[' / ']' for messages from/to outside the diagram. */
      from: string;
      to: string;
      label?: string;
      dashed: boolean;
      head: SeqHead;
      tail: SeqHead;
      number?: string;
      line: number;
    }
  | { type: 'note'; side: 'left' | 'right' | 'over' | 'across'; over: string[]; text: string; line: number }
  | { type: 'groupStart'; kind: string; label: string; line: number }
  | { type: 'groupElse'; label: string; line: number }
  | { type: 'groupEnd'; line: number }
  | { type: 'divider'; label: string; line: number }
  | { type: 'delay'; label: string; line: number }
  | { type: 'space'; size: number; line: number }
  | { type: 'ref'; over: string[]; text: string; line: number }
  | { type: 'activate' | 'deactivate' | 'destroy' | 'create'; participant: string; line: number };

export interface SequenceModel {
  type: 'sequence';
  participants: SeqParticipant[];
  events: SeqEvent[];
  boxes: { label: string; participants: string[]; line: number }[];
  hideFootbox: boolean;
}

// ---- gantt -------------------------------------------------------------------------------------

export interface GanttTask {
  id: string;
  name: string;
  /** Calendar-day offset from the project start, after scheduling. */
  start: number;
  /** Calendar days covered (closed days included); 0 for milestones. */
  duration: number;
  milestone: boolean;
  completion?: number;
  color?: string;
  section?: string;
  /** Tasks this one starts after (drawn as arrows). */
  after: string[];
  resources?: string[];
  line: number;
}

export interface GanttModel {
  type: 'gantt';
  /** ISO date of day 0, if the source gave one. */
  start?: string;
  tasks: GanttTask[];
  /** Weekdays that don't count as working days (0 = Sunday). */
  closed: number[];
  scale: 'daily' | 'weekly' | 'monthly';
}

// ---- timing ------------------------------------------------------------------------------------

export interface TimingSignal {
  id: string;
  label: string;
  kind: 'robust' | 'concise' | 'clock' | 'binary';
  /** For clocks: period and pulse width. */
  period?: number;
  pulse?: number;
  /** State changes in time order; binary signals use 'high'/'low'. */
  changes: { time: number; state: string }[];
  /** Robust signals: declared state order, top to bottom. */
  states?: string[];
  line: number;
}

export interface TimingModel {
  type: 'timing';
  signals: TimingSignal[];
  messages: { from: string; fromTime: number; to: string; toTime: number; label?: string; line: number }[];
  end: number;
}

export interface ParseWarning {
  line: number;
  text: string;
  message: string;
}
