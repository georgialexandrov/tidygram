import type { Point } from '../layout/layout-file.ts';
import { CONN_DIR_ALL, type Avoid } from './avoid.ts';
import type { Box } from './containers.ts';

export interface RouteShape {
  /**
   * Lines attach at the centre of this box. Off-centre pins, or extra
   * obstacles touching the box, make libavoid 5-10x slower.
   */
  box: Box;
}

export interface RouteRequest {
  id: string;
  from: string;
  to: string;
  via?: Point[];
  /** Free end points, for lines that end on a container's border instead of a shape. */
  fromPoint?: Point;
  toPoint?: Point;
}

export const ROUTING = {
  shapeBuffer: 10,
  nudging: 10,
  segmentPenalty: 40,
  crossingPenalty: 0,
};

/** Routes every connector orthogonally around the node boxes. Returns centre-to-centre polylines. */
export function routeEdges(avoid: Avoid, shapes: Map<string, RouteShape>, requests: RouteRequest[]): Map<string, Point[]> {
  const A = avoid;
  const router = new A.Router(A.RouterFlag.OrthogonalRouting.value);
  router.setRoutingParameter(A.RoutingParameter.shapeBufferDistance, ROUTING.shapeBuffer);
  router.setRoutingParameter(A.RoutingParameter.idealNudgingDistance, ROUTING.nudging);
  router.setRoutingParameter(A.RoutingParameter.segmentPenalty, ROUTING.segmentPenalty);
  if (ROUTING.crossingPenalty) router.setRoutingParameter(A.RoutingParameter.crossingPenalty, ROUTING.crossingPenalty);
  router.setRoutingOption(A.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true);
  router.setRoutingOption(A.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);

  const refs = new Map<string, unknown>();
  for (const [id, s] of shapes) {
    const { x, y, w, h } = s.box;
    const ref = new A.ShapeRef(router, new A.Rectangle(new A.Point(x + w / 2, y + h / 2), w, h));
    const pin = new A.ShapeConnectionPin(ref, 1, 0.5, 0.5, true, 0, CONN_DIR_ALL);
    pin.setExclusive(false);
    refs.set(id, ref);
  }

  const conns: [string, { displayRoute(): { size(): number; at(i: number): { x: number; y: number } } }][] = [];
  const result = new Map<string, Point[]>();
  for (const r of requests) {
    const src = refs.get(r.from);
    const dst = refs.get(r.to);
    if ((!src && !r.fromPoint) || (!dst && !r.toPoint)) continue;
    if (r.from === r.to && src) {
      result.set(r.id, selfLoop(shapes.get(r.from)!.box));
      continue;
    }
    const end = (ref: unknown, point: Point | undefined) => (point ? new A.ConnEnd(new A.Point(point[0], point[1])) : new A.ConnEnd(ref, 1));
    const conn = new A.ConnRef(router, end(src, r.fromPoint), end(dst, r.toPoint));
    if (r.via?.length) {
      const checkpoints = new A.CheckpointVector();
      for (const [x, y] of r.via) checkpoints.push_back(new A.Checkpoint(new A.Point(x, y)));
      conn.setRoutingCheckpoints(checkpoints);
    }
    conns.push([r.id, conn]);
  }

  router.processTransaction();
  for (const [id, conn] of conns) {
    const route = conn.displayRoute();
    const points: Point[] = [];
    for (let i = 0; i < route.size(); i++) {
      const p = route.at(i);
      points.push([p.x, p.y]);
    }
    result.set(id, points);
  }
  router.delete();
  return result;
}

function selfLoop(box: Box): Point[] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const right = box.x + box.w + 20;
  const top = box.y - 20;
  return [
    [cx, cy],
    [cx, top],
    [right, top],
    [right, cy],
    [cx, cy],
  ];
}
