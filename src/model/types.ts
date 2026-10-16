export type NodeKind = 'actor' | 'usecase' | 'note';

export type NotePosition = 'left' | 'right' | 'top' | 'bottom';

export interface DNode {
  id: string;
  kind: NodeKind;
  label: string;
  stereotype?: string;
  /** Id of the enclosing container, if any. */
  parent?: string;
  /** For notes attached with `note right of X`: the target and side. */
  attachedTo?: { id: string; side: NotePosition };
  line: number;
}

export interface DContainer {
  id: string;
  kind: string;
  label: string;
  parent?: string;
  line: number;
}

export type EdgeKind = 'association' | 'dependency' | 'generalization' | 'noteLink';

export type ArrowHead = 'none' | 'arrow' | 'triangle';

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
  hidden: boolean;
  line: number;
}

export interface Diagram {
  direction: 'TB' | 'LR';
  nodes: DNode[];
  containers: DContainer[];
  edges: DEdge[];
}

export interface ParseWarning {
  line: number;
  text: string;
  message: string;
}
