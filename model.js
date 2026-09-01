// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// model.js — Entities + Kernel

import { Vtx, pointSegmentDist, lineIntersect2D, arcFromThrough, pointArcDist, arcMidpoint,
    arcLineIntersect, arcArcIntersect, angleBetween, bboxIntersect, arcLength,
    pointInContour, segmentSegmentDist, segmentArcDist, arcArcDist } from './math.js';
import { entityGenerators } from './generators.js';
import { setBaseName } from './io.js';

const STATE_NORMAL = 0, STATE_SELECTED = 1;

/** Fully-resolved style with defaults. */
export const DEFAULT_STYLE = {
    strokeWidth: 0.25,        // mm
    strokeColor: 'black',
    strokeDasharray: 'none',
    fill: 'transparent',
    fillOpacity: 1,
    fontFamily: 'sans-serif',
    fontWeight: 'normal',
    fontStyle: 'normal',
    fontSize: 3.5,            // mm
};

let _idCounter = 0;


export class Entity {
    constructor(layer = '0') {
        this.id = ++_idCounter;
        this.contours = []; // Array<Array<Vtx>>
        this.contour0IsClosed = false; // only contour 0 can be open (line, path)
        this.state = STATE_NORMAL;
        this.layer = layer;
        this.styleClass = ''; // space-separated CSS class names from stylesheet
    }

    /** preserveId: true for undo/redo snapshots (same entity, later restored);
     *  false for duplication (copy/mirror/array/fan/explode), which must get a fresh id. */
    clone(preserveId = true) {
        const e = new Entity(this.layer);
        if (preserveId) e.id = this.id;
        e.contours = this.contours.map(c => c.map(v => v.clone()));
        e.contour0IsClosed = this.contour0IsClosed;
        e.state = STATE_NORMAL;
        e.applyStyle(this.styleClass);
        if (this._resolvedStyle) e._resolvedStyle = { ...this._resolvedStyle };
        return e;
    }

    /** Translate all contours by (dx, dy) */
    translate(dist) {
        for (const c of this.contours) {
            for (const v of c) {
                v.x += dist.x; v.y += dist.y;
                if (v.through) v.through.addInPlace(dist);
            }
        }
        this.regenerate();
    }

    addContour(verts, isClosed = true) {
        if (verts) {
            const c = verts.map(v => v.clone());
            if (Entity.clockwise(c))
                Entity.reverse(c);
            this.contours.push(c);
            this.contour0IsClosed = this.contours.length > 1 || isClosed;
        } else {
            this.contours.push([]);
            this.contour0IsClosed = this.contours.length > 1;
        }
    }

    addVertex(v) {
        if (!this.contours.length) this.addContour();
        const contour = this.contours[this.contours.length - 1];
        if (Array.isArray(v)) {
            contour.push(new Vtx(v[0], v[1]));
        } else if (v instanceof Vtx) {
            contour.push(v.clone());
        } else {
            contour.push(new Vtx(v.x, v.y));
        }
        return contour[contour.length - 1];
    }

    popVertex() {
        if (!this.contours.length)
            return 1;
        const last = this.contours[this.contours.length - 1];
        if (!last.length) {
            this.contours.pop();
            if (!this.contours.length || !this.contours[this.contours.length - 1].length)
                return 1;
        }
        this.contours[this.contours.length - 1].pop();
        return 0;
    }

    eraseContour(n) {
        if (n >= this.contours.length) return 1;
        this.contours.splice(n, 1);
        return 0;
    }

    closeContour(isClosed = true) {
        if (this.contours.length > 1) {
            this.contour0IsClosed = true;
        } else if (this.contours.length === 0) {
            this.contour0IsClosed = false;
        } else {
            const c = this.contours[0];
            const hasArcs = c.some(v => v.isArc());
            this.contour0IsClosed = (hasArcs ? c.length >= 2 : c.length > 2) ? isClosed : false;
        }
    }

    get isContourClosed() {
        if (this.contours.length > 1) return true;
        if (this.contours.length === 0) return false;
        const c = this.contours[0];
        const hasArcs = c.some(v => v.isArc());
        if (hasArcs ? c.length < 2 : c.length < 3) return false;
        return this.contour0IsClosed;
    }
    get isTopologyConstant() { return false; }

    insertVertex(contour, vertex) {
        if (contour >= this.contours.length) return 1;
        const c = this.contours[contour];
        if (vertex >= c.length) return 1;
        const prev = c[(vertex + c.length - 1) % c.length];
        const cur = c[vertex];
        if (cur.isArc()) {
            // Split arc segment into two arcs with correct through-points
            const arc = arcFromThrough(prev, cur.through, cur);
            if (!arc) return 1; // collinear / degenerate
            const m = arcMidpoint(arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw);
            const midAngle = Math.atan2(m.y - arc.center.y, m.x - arc.center.x);
            const t1 = arcMidpoint(arc.center, arc.radius, arc.startAngle, midAngle, arc.ccw);
            const t2 = arcMidpoint(arc.center, arc.radius, midAngle, arc.endAngle, arc.ccw);
            // update existing arc endpoint: now describes only the second half
            cur.through.x = t2.x; cur.through.y = t2.y;
            // insert new midpoint vertex with first-half arc data
            const midVtx = new Vtx(m.x, m.y).setArc(t1);
            c.splice(vertex, 0, midVtx);
            return 0;
        }
        const mid = new Vtx((prev.x + cur.x) / 2, (prev.y + cur.y) / 2);
        c.splice(vertex, 0, mid);
        return 0;
    }

    /** Axis-aligned bounding box from all vertices. Returns {minX,minY,maxX,maxY} or null. */
    get bbox() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let found = false;
        for (const c of this.contours) {
            for (const v of c) {
                if (v.x < minX) minX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.x > maxX) maxX = v.x;
                if (v.y > maxY) maxY = v.y;
                found = true;
                if (v.through) {
                    const t = v.through;
                    if (t.x < minX) minX = t.x;
                    if (t.y < minY) minY = t.y;
                    if (t.x > maxX) maxX = t.x;
                    if (t.y > maxY) maxY = t.y;
                }
            }
        }
        return found ? { minX, minY, maxX, maxY } : null;
    }

    /** perimeter or path length */
    get length() {
        const isClosed = this.isContourClosed;
        let length = 0;
        for (const c of this.contours) {
            for (let i = 0, end = isClosed ? c.length : c.length - 1; i < end; i++) {
                const next = c[(i + 1) % c.length];
                if (next.through) {
                    const arc = arcFromThrough(c[i], next.through, next);
                    if (arc) {
                        length += arcLength(arc);
                    } else {
                        length += c[i].distTo(next);
                    }
                } else {
                    length += c[i].distTo(next);
                }
            }
        }
        return length;
    }

    /** area */
    get area() {
        if(!this.isContourClosed) return null;
        const TWO_PI = 2 * Math.PI;
        let totalArea = 0;

        for (const c of this.contours) {
            let signedArea = 0;
            const n = c.length;
            for (let i = 0; i < n; i++) {
                const cur = c[i];
                const next = c[(i + 1) % n];
                if (next.through) {
                    const arc = arcFromThrough(cur, next.through, next);
                    if (arc) {
                        // Green's theorem arc integral: (1/2) ∫(x dy − y dx)
                        // = (R/2) * [cx(sin ea − sin sa) − cy(cos ea − cos sa) + R * sweep]
                        const { center, radius: R, startAngle: sa, endAngle: ea, ccw } = arc;
                        const sweep = ccw
                            ? (ea - sa + TWO_PI) % TWO_PI
                            : -((sa - ea + TWO_PI) % TWO_PI);
                        signedArea += R * (center.x * (Math.sin(ea) - Math.sin(sa))
                                         - center.y * (Math.cos(ea) - Math.cos(sa))
                                         + R * sweep);
                    } else {
                        signedArea += cur.x * next.y - next.x * cur.y;
                    }
                } else {
                    signedArea += cur.x * next.y - next.x * cur.y;
                }
            }
            totalArea += signedArea;
        }

        return Math.abs(totalArea) / 2;
    }

    /** Distance from entity to point (min dist to any edge segment) */
    distTo(v) {
        let dist = -1;
        for (const c of this.contours) {
            for (let i = 0; i < c.length; i++) {
                const next = c[(i + 1) % c.length];
                let d;
                if (next.through) {
                    const arc = arcFromThrough(c[i], next.through, next);
                    if (arc) {
                        d = pointArcDist(v, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw);
                    } else {
                        d = pointSegmentDist(v, c[i], next);
                    }
                } else {
                    d = pointSegmentDist(v, c[i], next);
                }
                if (dist < 0 || d < dist) dist = d;
            }
        }
        return dist;
    }

    /** Whether point v lies inside this entity's contour(s), inclusive of the boundary
     *  (within Kernel.tolerance.distance). Even-odd across contours: contours[0] is the
     *  outer boundary, any further contours are holes. Entities with no interior (open
     *  contours, TextEntity, BlockEntity) always return false via isContourClosed. */
    containsPoint(v) {
        if (!this.isContourClosed) return false;
        let inside = false;
        const eps = Kernel.tolerance.distance;
        for (const c of this.contours) {
            if (pointInContour(v, c, true, eps)) inside = !inside;
        }
        return inside;
    }

    /** Minimum distance between this entity's and another entity's geometry, in world
     *  units (0 if their edges touch or cross). Two edges crossing mid-segment (not at a
     *  vertex) share a point without either shape having a vertex anywhere near it, so
     *  that case is checked explicitly via entitiesIntersect() rather than relying on
     *  either the segment-pair distance or the vertex-scan fallback below to happen to
     *  find it. When both entities have real edge segments (segmentsOf — i.e. neither is
     *  text/block/dimension), the actual distance is computed exactly per segment-type
     *  pair (segmentSegmentDist / segmentArcDist / arcArcDist — the same three cases
     *  entitiesIntersect already dispatches on), mirroring how entitiesIntersect builds
     *  its own pairwise tests. This used to be vertex-only — sampling only this entity's
     *  and other's discrete vertices against each other's edges — which is exact for
     *  polygons (the closest approach between two non-intersecting straight-edged shapes
     *  is always a vertex-to-edge distance) but badly wrong for arcs/circles whenever the
     *  true closest approach falls on the curve strictly between vertices: two externally
     *  tangent circles of radius 1 (centers 2 apart) came back with distance ~0.73
     *  instead of ~0 whenever the tangent point didn't happen to coincide with one of
     *  the two arc vertices (which it does only for a specific relative rotation — an
     *  easy coincidence to test with by accident and then trust too far). Entities with
     *  no segments (text/block/dimension) fall back to the original vertex/distTo(point)
     *  scan, which is already exact for a point query against anything. */
    distToEntity(other) {
        if (entitiesIntersect(this, other).intersects) return 0;
        const segsA = segmentsOf(this), segsB = segmentsOf(other);
        if (segsA.length && segsB.length) {
            let min = -1;
            for (const sa of segsA) {
                for (const sb of segsB) {
                    let d;
                    if (sa.type === 'line' && sb.type === 'line') d = segmentSegmentDist(sa.a, sa.b, sb.a, sb.b);
                    else if (sa.type === 'arc' && sb.type === 'line') d = segmentArcDist(sb.a, sb.b, sa.center, sa.radius, sa.sa, sa.ea, sa.ccw);
                    else if (sa.type === 'line' && sb.type === 'arc') d = segmentArcDist(sa.a, sa.b, sb.center, sb.radius, sb.sa, sb.ea, sb.ccw);
                    else d = arcArcDist(sa.center, sa.radius, sa.sa, sa.ea, sa.ccw, sb.center, sb.radius, sb.sa, sb.ea, sb.ccw);
                    if (min < 0 || d < min) min = d;
                }
            }
            return min;
        }
        let min = -1;
        for (const c of this.contours) {
            for (const v of c) {
                const d = other.distTo(v);
                if (d >= 0 && (min < 0 || d < min)) min = d;
            }
        }
        for (const c of other.contours) {
            for (const v of c) {
                const d = this.distTo(v);
                if (d >= 0 && (min < 0 || d < min)) min = d;
            }
        }
        return min;
    }

    /** Nearest vertex to v within maxDist. Returns {contour, index, vertex} or null. */
    nearestVertex(v, maxDist = 1.0) {
        let minDist = -1, best = null;
        for (let j = 0; j < this.contours.length; j++) {
            for (let i = 0; i < this.contours[j].length; i++) {
                const d = this.contours[j][i].distTo(v);
                if (d <= maxDist && (minDist < 0 || d < minDist)) {
                    minDist = d;
                    best = { contour: j, index: i, vertex: this.contours[j][i] };
                }
            }
        }
        return best;
    }

    /** Find nearest part (vertex or segment midpoint) within maxDist.
     *  Returns { contour, id, isVertex } or null. */
    nearestPart(v, maxDist = 1.0) {
        let minDist = -1, result = null;
        const isClosed = this.isContourClosed;
        for (let j = 0; j < this.contours.length; j++) {
            const c = this.contours[j];
            const contourClosed = j === 0 ? isClosed : true;
            for (let i = 0; i < c.length; i++) {
                // test vertex
                const dv = c[i].distTo(v);
                if (dv <= maxDist && (minDist < 0 || dv < minDist)) {
                    minDist = dv;
                    result = { contour: j, id: i, isVertex: true };
                }
                // test segment midpoint — skip the wrap-around segment for open contours
                if (!contourClosed && i === c.length - 1) continue;
                const a = c[i];
                const b = c[(i + 1) % c.length];
                let mid;
                if (b.through) {
                    const arc = arcFromThrough(a, b.through, b);
                    mid = arc ? arcMidpoint(arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw) : new Vtx((a.x + b.x) / 2, (a.y + b.y) / 2);
                } else {
                    mid = new Vtx((a.x + b.x) / 2, (a.y + b.y) / 2);
                }
                const dm = mid.distTo(v);
                if (dm <= maxDist && (minDist < 0 || dm < minDist)) {
                    minDist = dm;
                    result = { contour: j, id: i, isVertex: false };
                }
            }
        }
        return result;
    }

    /** Get a direct reference to vertex at [contour][n] */
    vertex(contour, n) {
        if (contour >= this.contours.length)
            return null;
        if (n >= this.contours[contour].length)
            return null;
        return this.contours[contour][n];
    }

    /** get countour index and vertex index for a given vertex */
    vertexIndex(vtx) {
        for (let ci = 0; ci < this.contours.length; ci++) {
            const c = this.contours[ci];
            for (let i = 0; i < c.length; i++) {
                if (c[i] === vtx) return { contour: ci, index: i };
            }
        }
        return null;
    }

    /** Purge near-collinear and duplicate vertices */
    purge(toleranceAngle = 0.1, toleranceDist = 0.001) {
        for (let ci = 0; ci < this.contours.length; ci++) {
            Entity.purgeContour(this.contours[ci], this.isContourClosed, toleranceAngle, toleranceDist);
        }
        // correct orientation for single-contour entities
        if (this.contours.length === 1 && this.contours[0].length >= 3) {
            if (Entity.clockwise(this.contours[0]))
                Entity.reverse(this.contours[0]);
        }
    }

    static purgeContour(c, isClosed, toleranceAngle = 0.1, toleranceDist = 0.001) {
        // remove consecutive coincident vertices (skip arc vertices)
        {
            // Use direct indices — no modulo wrap for open contours.
            let j = 1;
            while (j < c.length) {
                const cur = c[j];
                if (cur.isArc()) { j++; continue; }
                if (cur.distTo(c[j - 1]) < toleranceDist) {
                    c.splice(j, 1); // don't increment: re-test same position
                } else j++;
            }
            // closed: also check the wrap-around pair (last → first)
            if (isClosed && c.length >= 2 && !c[0].isArc()) {
                if (c[0].distTo(c[c.length - 1]) < toleranceDist)
                    c.splice(c.length - 1, 1);
            }
        }
        // remove collinear / near-180° vertices (skip arc vertices)
        {
            // open:   only interior vertices (j = 1..n-2); endpoints are never removed
            // closed: all vertices (j = 0..n-1) with modulo wrap for neighbors
            let j = isClosed ? 0 : 1;
            while (c.length > 2 && j < (isClosed ? c.length : c.length - 1)) {
                const n = c.length;
                const pi = isClosed ? (j - 1 + n) % n : j - 1;
                const ni = isClosed ? (j + 1) % n : j + 1;
                const cur = c[j];
                if (cur.isArc()) { j++; continue; }
                // also skip if the outgoing segment is an arc (next vertex is arc endpoint)
                if (c[ni].isArc()) { j++; continue; }
                const v0 = cur.sub(c[pi]);
                const v1 = c[ni].sub(cur);
                const a = angleBetween(v0, v1);
                const aRev = angleBetween(v0.scale(-1), v1);
                if (a < toleranceAngle || aRev < toleranceAngle) {
                    c.splice(j, 1);
                } else j++;
            }
        }
        { // merge adjacent arcs that lie on the same circle
            const MAX_SWEEP = 355 * Math.PI / 180; // full circles require 2 arcs
            const TWO_PI = 2 * Math.PI;
            const normAngle = a => { a = a % TWO_PI; return a < 0 ? a + TWO_PI : a; };
            const arcSweep = arc => arc.ccw
                ? normAngle(arc.endAngle - arc.startAngle)
                : TWO_PI - normAngle(arc.endAngle - arc.startAngle);
            let changed = true;
            while (changed && c.length >= 2) {
                changed = false;
                const n = c.length;
                for (let k = 0; k < n; k++) {
                    if (!isClosed && k === n - 1) continue; // open: no wrap-around segment
                    const cur = c[k];
                    const next = c[(k + 1) % n];
                    if (!cur.isArc()) continue;
                    if (!next.isArc()) continue;
                    const prev = c[(k - 1 + n) % n];
                    const arc1 = arcFromThrough(prev, cur.through, cur);
                    const arc2 = arcFromThrough(cur, next.through, next);
                    if (!arc1 || !arc2) continue;
                    if (arc1.ccw !== arc2.ccw) continue;
                    if (arc1.center.distTo(arc2.center) > toleranceDist) continue;
                    if (Math.abs(arc1.radius - arc2.radius) > toleranceDist) continue;
                    if (arcSweep(arc1) + arcSweep(arc2) >= MAX_SWEEP) continue;
                    // absorb cur into next: cur's position becomes the new through-point
                    next.through = new Vtx(cur.x, cur.y);
                    c.splice(k, 1);
                    changed = true;
                    break;
                }
            }
        }
    }

    /** Test winding direction (matching smoEntity::clockwise) */
    static clockwise(vVtx) {
        // remove consecutive duplicates first
        let i = 1;
        while (i <= vVtx.length) {
            if (vVtx[i % vVtx.length].equals(vVtx[i - 1])) {
                vVtx.splice(i % vVtx.length, 1);
            } else i++;
        }
        if (vVtx.length < 3)
            return false;

        // Build an augmented point list: insert each arc through-point between its two
        // chord endpoints so the shoelace captures the arc-bulge area.  For purely
        // straight-segment contours this is a no-op.
        const pts = [];
        for (let i = 0; i < vVtx.length; i++) {
            pts.push(vVtx[i]);
            const next = vVtx[(i + 1) % vVtx.length];
            if (next.through) pts.push(next.through);
        }

        // signed area via shoelace on the augmented polygon
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            area += pts[i].x * pts[j].y;
            area -= pts[j].x * pts[i].y;
        }
        return area < 0; // negative area = clockwise
    }

    static reverse(vVtx) {
        // collect arc info before reversing
        const arcInfo = [];
        for (let i = 0; i < vVtx.length; i++) {
            if (vVtx[i].isArc())
                arcInfo.push({ originalIdx: i, through: vVtx[i].through.clone() });
        }
        vVtx.reverse();
        for (const v of vVtx) v.clearArc();
        // reposition: arc on original index i → new index (n - i) % n
        const n = vVtx.length;
        for (const info of arcInfo) {
            vVtx[(n - info.originalIdx) % n].setArc(info.through);
        }
    }

    static resolveSelfIntersections(vVtx, isClosed) {
        let selfIntersectionFound = false;
        do {
            const n = vVtx.length, nSegsToTest = isClosed ? n : n - 1;
            selfIntersectionFound = false;
            for (let i = 0; i < nSegsToTest && !selfIntersectionFound; i++) {
                const a0 = vVtx[i], a1 = vVtx[(i + 1) % n];
                const arcA = a1.isArc() ? arcFromThrough(a0, a1.through, a1) : null;
                const jMax = isClosed ? n : n - 1; // open: no wrap-around segment
                for (let j = i + 2; j < jMax && !selfIntersectionFound; j++) {
                    if (isClosed && i === 0 && j === n - 1) continue; // closed: edges share vertex 0
                    const b0 = vVtx[j], b1 = vVtx[(j + 1) % n];
                    const arcB = b1.isArc() ? arcFromThrough(b0, b1.through, b1) : null;

                    // Find intersection point(s) using the right function for each segment-type pair
                    let ipts;
                    if (!arcA && !arcB) {
                        const t = lineIntersect2D(a0, a1, b0, b1);
                        if (isNaN(t) || t < 1e-9 || t > 1 - 1e-9) continue;
                        const s = lineIntersect2D(b0, b1, a0, a1);
                        if (isNaN(s) || s < 1e-9 || s > 1 - 1e-9) continue;
                        ipts = [new Vtx(a0.x + t * (a1.x - a0.x), a0.y + t * (a1.y - a0.y))];
                    } else if (arcA && !arcB) {
                        ipts = arcLineIntersect(arcA.center, arcA.radius, arcA.startAngle, arcA.endAngle, arcA.ccw, b0, b1);
                    } else if (!arcA && arcB) {
                        ipts = arcLineIntersect(arcB.center, arcB.radius, arcB.startAngle, arcB.endAngle, arcB.ccw, a0, a1);
                    } else {
                        ipts = arcArcIntersect(arcA.center, arcA.radius, arcA.startAngle, arcA.endAngle, arcA.ccw,
                                               arcB.center, arcB.radius, arcB.startAngle, arcB.endAngle, arcB.ccw);
                    }
                    // For arc cases, exclude points at segment endpoints (shared vertices are not self-intersections)
                    if (arcA || arcB) {
                        ipts = ipts.filter(p =>
                            p.distTo(a0) > 1e-9 && p.distTo(a1) > 1e-9 &&
                            p.distTo(b0) > 1e-9 && p.distTo(b1) > 1e-9);
                    }
                    if (!ipts.length) continue;
                    const pt = ipts[0];

                    // The intersection point pt becomes the first vertex of both candidate loops.
                    // The two loops have different closing segments:
                    //   loop1 closes as b0→ptForLoop1  (arcB through-point if arcB)
                    //   loop2 closes as a0→ptForLoop2  (arcA through-point if arcA)
                    // We also update vVtx[i+1].through (a1) for the new pt→a1 arc in loop1,
                    // and vVtx[(j+1)%n].through (b1) for the new pt→b1 arc in loop2.
                    const ptForLoop1 = new Vtx(pt.x, pt.y); // closing seg: b0→ptForLoop1
                    const ptForLoop2 = new Vtx(pt.x, pt.y); // closing seg: a0→ptForLoop2
                    if (arcA) {
                        const ptAngle = Math.atan2(pt.y - arcA.center.y, pt.x - arcA.center.x);
                        const midA0pt = arcMidpoint(arcA.center, arcA.radius, arcA.startAngle, ptAngle, arcA.ccw);
                        ptForLoop2.setArc(midA0pt);
                        pt.setArc(midA0pt); // also used for open-contour splice
                        // a1's predecessor changes from a0 to pt — update its through-point
                        const a1new = vVtx[i + 1].clone();
                        a1new.through = arcMidpoint(arcA.center, arcA.radius, ptAngle, arcA.endAngle, arcA.ccw);
                        vVtx[i + 1] = a1new;
                    }
                    if (arcB) {
                        const ptAngle = Math.atan2(pt.y - arcB.center.y, pt.x - arcB.center.x);
                        ptForLoop1.setArc(arcMidpoint(arcB.center, arcB.radius, arcB.startAngle, ptAngle, arcB.ccw));
                        const b1new = b1.clone();
                        b1new.through = arcMidpoint(arcB.center, arcB.radius, ptAngle, arcB.endAngle, arcB.ccw);
                        vVtx[(j + 1) % n] = b1new;
                    }

                    if (isClosed) {
                        // Two candidate loops at the intersection:
                        //   loop1 = [ptForLoop1, ...vVtx[i+1..j]]       (the "inner" detour)
                        //   loop2 = [ptForLoop2, ...vVtx[j+1..n], ...vVtx[0..i]]  (the "outer" remainder)
                        // Keep the one whose signed area matches the current winding
                        // (CCW = positive area).  For offset contours we always want to
                        // discard the collapsed inner loop and keep the outer one.
                        const _signedArea = (pts) => {
                            let a = 0;
                            for (let k = 0; k < pts.length; k++) {
                                const p1 = pts[k], p2 = pts[(k + 1) % pts.length];
                                a += p1.x * p2.y - p2.x * p1.y;
                            }
                            return a * 0.5;
                        };
                        const loop1 = [ptForLoop1, ...vVtx.slice(i + 1, j + 1)];
                        const loop2 = [ptForLoop2, ...vVtx.slice(j + 1), ...vVtx.slice(0, i + 1)];
                        // Original winding: positive area = CCW (the expected winding for offset contours)
                        const origArea = _signedArea(vVtx);
                        const a1 = _signedArea(loop1), a2 = _signedArea(loop2);
                        // Pick the loop whose sign matches the original; if both match, pick larger abs area
                        let keep;
                        const s1matches = (a1 > 0) === (origArea > 0);
                        const s2matches = (a2 > 0) === (origArea > 0);
                        if (s1matches && !s2matches)      keep = loop1;
                        else if (s2matches && !s1matches) keep = loop2;
                        else                              keep = Math.abs(a1) >= Math.abs(a2) ? loop1 : loop2;
                        vVtx.length = 0;
                        vVtx.push(...keep);
                    } else {
                        // Excise the detour, replacing with pt.
                        vVtx.splice(i + 1, j - i, pt);
                    }
                    selfIntersectionFound = true;
                }
            }
        } while (selfIntersectionFound);
    }

    /** Offset all vertices of a contour by dist (positive = right of traversal direction).
     *  isClosed: treat vVtx as a closed loop for corner bisectors at index 0 and n-1.
     *  Arc through-points are offset radially so the arc keeps the same center with
     *  adjusted radius (CCW arc: radius += dist; CW arc: radius -= dist).
     *  Modifies vVtx in-place. */
    static offset(vVtx, dist, isClosed = false) {
        const n = vVtx.length;
        if (n < 2) return;

        // Normalize a 2D vector; returns [0,0] for near-zero input.
        const norm2 = (x, y) => {
            const l = Math.sqrt(x * x + y * y);
            return l > 1e-12 ? [x / l, y / l] : [0, 0];
        };

        // Arc-aware tangent at the START of the segment from vVtx[i] to its successor.
        const outTangent = (i) => {
            const ni = isClosed ? (i + 1) % n : (i < n - 1 ? i + 1 : -1);
            if (ni < 0) return null;
            const next = vVtx[ni];
            if (next.isArc()) {
                const arc = arcFromThrough(vVtx[i], next.through, next);
                if (arc) {
                    const s = arc.startAngle;
                    return arc.ccw ? [-Math.sin(s), Math.cos(s)] : [Math.sin(s), -Math.cos(s)];
                }
            }
            return norm2(next.x - vVtx[i].x, next.y - vVtx[i].y);
        };

        // Arc-aware tangent at the END of the segment arriving at vVtx[i].
        const inTangent = (i) => {
            const pi = isClosed ? (i - 1 + n) % n : (i > 0 ? i - 1 : -1);
            if (pi < 0) return null;
            const cur = vVtx[i];
            if (cur.isArc()) {
                const arc = arcFromThrough(vVtx[pi], cur.through, cur);
                if (arc) {
                    const e = arc.endAngle;
                    return arc.ccw ? [-Math.sin(e), Math.cos(e)] : [Math.sin(e), -Math.cos(e)];
                }
            }
            return norm2(cur.x - vVtx[pi].x, cur.y - vVtx[pi].y);
        };

        // Step 1: compute new (x, y) for every vertex without modifying anything yet.
        let newXY = [];
        for (let i = 0; i < n; i++) {
            const cur = vVtx[i];
            const v1 = inTangent(i);
            const v2 = outTangent(i);
            let tx, ty, anglePl = 0;

            if (v1 && v2) {
                // Interior (or closed loop): bisector of incoming and outgoing tangents.
                [tx, ty] = norm2(v1[0] + v2[0], v1[1] + v2[1]);
                if (tx === 0 && ty === 0) {
                    // 180° U-turn: bisector degenerates — use incoming direction.
                    [tx, ty] = [v1[0], v1[1]];
                } else {
                    const cosA = Math.max(-1, Math.min(1, v1[0] * tx + v1[1] * ty));
                    anglePl = Math.acos(cosA);
                }
            } else if (v2) {
                [tx, ty] = [v2[0], v2[1]]; // open start: tangent = outgoing direction
            } else if (v1) {
                [tx, ty] = [v1[0], v1[1]]; // open end: tangent = incoming direction
            } else {
                newXY.push(new Vtx(cur.x, cur.y));
                continue;
            }

            // Miter scale = 1 / cos(anglePl).  Clamp to ≤ 10 to prevent extreme miters
            // at near-180° corners (threshold cosAngle ≈ 0.1 → ~84° turn angle).
            const cosAngle = Math.cos(anglePl);
            const scale = cosAngle > 0.1 ? 1 / cosAngle : 10;

            // Right normal of bisector (tx, ty) is (ty, -tx).
            // Move vertex along it by dist * scale.
            newXY.push(new Vtx(cur.x + ty * dist * scale, cur.y - tx * dist * scale));
        }

        // Step 2: compute new through-point positions using the still-original vertex data.
        // A circular arc offset keeps the same center; only the radius changes:
        //   CCW arc → right-normal points outward → new radius = R + dist
        //   CW  arc → right-normal points inward  → new radius = R − dist

        for (let i = 0; i < n; i++) {
            const cur = vVtx[i];
            if (!cur.through) continue;
            const pi = isClosed ? (i - 1 + n) % n : (i > 0 ? i - 1 : -1);
            if (pi < 0) continue;
            const arc = arcFromThrough(vVtx[pi], cur.through, cur);
            if (!arc) continue;
            const newRadius = arc.ccw ? arc.radius + dist : arc.radius - dist;
            if (newRadius <= 0) continue; // arc collapses
            const dx = cur.through.x - arc.center.x;
            const dy = cur.through.y - arc.center.y;
            const rLen = Math.sqrt(dx * dx + dy * dy);
            if (rLen >= 1e-10)
                newXY[i].setArc(new Vtx(
                    arc.center.x + (dx / rLen) * newRadius,
                    arc.center.y + (dy / rLen) * newRadius ));
        }

        Entity.purgeContour(newXY, isClosed);
        Entity.resolveSelfIntersections(newXY, isClosed);
        return newXY;
    }

    /** Advance the global ID counter past a loaded id */
    static advanceCounter(id) {
        if (id >= _idCounter) _idCounter = id + 1;
    }

    /** Reset counter (for testing) */
    static resetCounter() { _idCounter = 0; }

    /** Resolve self-intersections by splitting contours; remove degenerate parts.
     *  Preserves the winding direction of each contour so that CW inner contours
     *  (holes produced by boolean subtraction) survive vertex/segment edits. */
    simplify() {
        if(!this.isContourClosed) {
            if(this.contours.length === 1) {
                const c = this.contours[0];
                Entity.purgeContour(c, false);
                if(c.length >= 2 && c[0].equals(c[c.length - 1])) {
                    c.shift();
                    this.contour0IsClosed = true;
                    if (Entity.clockwise(c))
                        Entity.reverse(c);
                }
            }
        }
        else {
            const result = [];
            for (const c of this.contours) {
                // arc-bearing contours: skip splitting, only filter orientation
                const hasArcs = c.some(v => v.isArc());
                if (hasArcs) {
                    if (c.length >= 2) result.push(c);
                    continue;
                }
                if (c.length < 2) continue;
                if (c.length === 2) { result.push(c); continue; }
                const isCW = Entity.clockwise(c);
                for (const part of _splitSelfIntersection(c)) {
                    if (part.length >= 3 && Entity.clockwise(part) === isCW)
                        result.push(part);
                }
            }
            this.contours = result;
        }
        // remove contours having less than 2 vertices (degenerate):
        this.contours = this.contours.filter(c => c.length >= 2);
        if(this.contours.length === 0)
            Kernel.erase(this);
    }
    regenerate() { } // nothing to do for basic Entity
    applyStyle(style) { this.styleClass = style; }

    isLine() {
        return this.contours.length === 1 && this.contours[0].length === 2
            && !this.contour0IsClosed
            && !this.contours[0][0].isArc() && !this.contours[0][1].isArc();
    }
    isArc() {
        return this.contours.length === 1 && this.contours[0].length === 2
            && !this.contour0IsClosed && this.contours[0][1].isArc();
    }
    isCircle() {
        if(this.contours.length !== 1 || this.contours[0].length !== 2
            || !this.contour0IsClosed || !this.contours[0][0].isArc()
            || !this.contours[0][1].isArc()) return false;
        const arc1 = arcFromThrough(this.contours[0][1], this.contours[0][0].through, this.contours[0][0]);
        const arc2 = arcFromThrough(this.contours[0][0], this.contours[0][1].through, this.contours[0][1]);
        if (!arc1 || !arc2) return false;
        return arc1.center.equals(arc2.center) && Math.abs(arc1.radius - arc2.radius) < 1e-9;
    }
    align(align) { } // ignore

    static circle(layer, center, radius) {
        if (radius < 1e-12) return null;
        const W = new Vtx(center.x - radius, center.y);
        const E = new Vtx(center.x + radius, center.y);
        const N = new Vtx(center.x, center.y + radius);
        const S = new Vtx(center.x, center.y - radius);
        // contour = [W, E] with two semicircular arcs (CCW winding for flatten-js)
        E.setArc(S); // arc W→S→E (lower, CCW)
        W.setArc(N); // closing arc E→N→W (upper, CCW)

        const ent = new Entity(layer);
        ent.contours = [[W, E]];
        ent.closeContour(true);
        return ent;
    }

    /** Create a rounded rectangle entity with uniform corner radius r.
     *  x/y = bottom-left corner, w/h = dimensions (world units).
     *  Contour is CCW with precise quarter-circle arcs at each corner.
     *  Falls back to a sharp rectangle when r ≤ 0. */
    static roundedRect(layer, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        if (r <= 0) {
            const ent = new Entity(layer);
            ent.contours = [[new Vtx(x, y), new Vtx(x+w, y), new Vtx(x+w, y+h), new Vtx(x, y+h)]];
            ent.closeContour(true);
            return ent;
        }
        const k = r * Math.SQRT2 / 2; // r/√2: radial offset to arc midpoint at 45° bisector
        // CCW contour (world Y-up), 8 vertices; arc through-points at each 90° corner:
        const v = [
            new Vtx(x + r,     y),           // v0: bottom edge start (from BL arc)
            new Vtx(x + w - r, y),           // v1: bottom edge end
            new Vtx(x + w,     y + r),       // v2: BR arc end
            new Vtx(x + w,     y + h - r),   // v3: right edge end
            new Vtx(x + w - r, y + h),       // v4: TR arc end
            new Vtx(x + r,     y + h),       // v5: top edge end
            new Vtx(x,         y + h - r),   // v6: TL arc end
            new Vtx(x,         y + r),       // v7: left edge end
        ];
        v[0].through = new Vtx(x + r - k,     y + r - k);      // BL corner (225°)
        v[2].through = new Vtx(x + w - r + k, y + r - k);      // BR corner (315°)
        v[4].through = new Vtx(x + w - r + k, y + h - r + k);  // TR corner (45°)
        v[6].through = new Vtx(x + r - k,     y + h - r + k);  // TL corner (135°)
        const ent = new Entity(layer);
        ent.contours = [v];
        ent.closeContour(true);
        return ent;
    }
}

// =====================================================================
// WebMCP support — read-only geometry facts (see plans/done/WebMCP.md)
// =====================================================================

/** Classify an entity's geometric kind, independent of any semantic meaning
 *  (layer name, text content, block name are separate — see get_object_info).
 *  Precidra has no shape-name primitives (e.g. no "rectangle"): a plain closed
 *  polygon is always "polygon", never guessed from its vertex count. */
export function classifyEntity(entity) {
    if (entity.type === 'text') return 'text';
    if (entity.type === 'block') return 'block';
    if (entity.type === 'param') return 'dimension'; // any ParamEntity subtype
    if (entity.isCircle()) return 'circle';
    if (entity.isArc()) return 'arc';
    if (entity.isLine()) return 'line';
    if (entity.isContourClosed) return 'polygon';
    return 'path';
}

/** Build the line/arc edge segment list for one entity, in world space.
 *  Returns [] for entities with no direct edge geometry: text, block instances,
 *  and any composite entity exposing its rendered geometry via .entities rather
 *  than .contours (currently only ParamEntity/dimension) — these are not
 *  decomposed for intersection testing, matching computeGeomSnapPoints in
 *  snap.js, which this mirrors and which imports this same function. */
export function segmentsOf(entity) {
    const segs = [];
    if (entity.type === 'text' || entity.type === 'block' || entity.entities) return segs;
    for (let ci = 0; ci < entity.contours.length; ci++) {
        const contour = entity.contours[ci];
        const len = contour.length;
        if (len === 0) continue;
        const isClosed = ci > 0 || entity.isContourClosed;
        const n = isClosed ? len : len - 1;
        for (let i = 0; i < n; i++) {
            const a = contour[i];
            const b = contour[(i + 1) % len];
            if (b.through) {
                const arc = arcFromThrough(a, b.through, b);
                if (arc) segs.push({ type: 'arc', center: arc.center, radius: arc.radius,
                    sa: arc.startAngle, ea: arc.endAngle, ccw: arc.ccw });
            } else {
                segs.push({ type: 'line', a, b });
            }
        }
    }
    return segs;
}

/** Test whether two entities' geometries intersect, without modifying either
 *  (unlike Kernel.intersect(), which is a destructive boolean operation).
 *  Returns { intersects, points }. Always {intersects:false, points:[]} when
 *  either side is text, a block instance, or a dimension — see segmentsOf().
 *  Known limitation: exactly overlapping/collinear segments yield no points
 *  (lineIntersect2D returns NaN for parallel lines). */
export function entitiesIntersect(a, b) {
    const bbA = a.bbox, bbB = b.bbox;
    if (!bbA || !bbB || !bboxIntersect(bbA, bbB)) return { intersects: false, points: [] };

    const segsA = segmentsOf(a), segsB = segmentsOf(b);
    const raw = [];
    for (const sa of segsA) {
        for (const sb of segsB) {
            if (sa.type === 'line' && sb.type === 'line') {
                const t = lineIntersect2D(sa.a, sa.b, sb.a, sb.b);
                if (isNaN(t) || t < -1e-9 || t > 1 + 1e-9) continue;
                const s = lineIntersect2D(sb.a, sb.b, sa.a, sa.b);
                if (isNaN(s) || s < -1e-9 || s > 1 + 1e-9) continue;
                raw.push(new Vtx(sa.a.x + t * (sa.b.x - sa.a.x), sa.a.y + t * (sa.b.y - sa.a.y)));
            } else if (sa.type === 'arc' && sb.type === 'line') {
                raw.push(...arcLineIntersect(sa.center, sa.radius, sa.sa, sa.ea, sa.ccw, sb.a, sb.b));
            } else if (sa.type === 'line' && sb.type === 'arc') {
                raw.push(...arcLineIntersect(sb.center, sb.radius, sb.sa, sb.ea, sb.ccw, sa.a, sa.b));
            } else if (sa.type === 'arc' && sb.type === 'arc') {
                raw.push(...arcArcIntersect(sa.center, sa.radius, sa.sa, sa.ea, sa.ccw,
                                             sb.center, sb.radius, sb.sa, sb.ea, sb.ccw));
            }
        }
    }

    const eps = Kernel.tolerance.distance;
    const points = [];
    for (const p of raw) {
        if (!points.some(q => q.distTo(p) < eps)) points.push(p);
    }
    return { intersects: points.length > 0, points };
}

/** True when every vertex of ent (including arc through-points) lies inside container. */
export function entityContains(container, ent) {
    if (!container.isContourClosed) return false;
    for (const c of ent.contours)
        for (const v of c) {
            if (!container.containsPoint(v)) return false;
            if (v.through && !container.containsPoint(v.through)) return false;
        }
    return true;
}

/** Whether entity's outer contour (contours[0] only — holes are left untouched) can be
 *  meaningfully grown/shrunk for the adjacency test below. Text, block, and dimension
 *  entities have no freely-editable outline of their own (isTopologyConstant). */
function _canOffset(entity) {
    return !entity.isTopologyConstant && entity.contours[0] && entity.contours[0].length >= 2;
}

/** Offset entity's outer contour by dist (see Entity.offset), returning a new,
 *  non-persisted Entity, or null if the offset collapses/degenerates (e.g. shrinking
 *  past the shape's own width). Holes (contours[1+]) are intentionally left out of the
 *  v1 adjacency test below — real floor-plan regions are almost always single-contour.
 *  A closed contour needs only 2 vertices to be valid here, not 3 — a circle (two
 *  opposing arcs) is exactly that, and rejecting a successful 2-vertex offset as
 *  "degenerate" silently fell back to the un-offset original entity, breaking the
 *  touches/overlapping distinction for every circle (confirmed by testing: two
 *  externally-tangent circles, sharing only a single point, misclassified as
 *  "overlapping" because their shrink-based genuine-overlap check silently used the
 *  un-shrunk originals instead, which do share that one point). */
function _offsetEntity(entity, dist) {
    const c = entity.contours[0];
    if (!c || c.length < 2) return null;
    const isClosed = entity.isContourClosed;
    const offset = Entity.offset(c, dist, isClosed);
    if (!offset || offset.length < 2) return null;
    const result = new Entity(entity.layer);
    result.contours = [offset];
    result.closeContour(isClosed);
    return result;
}

/** Whether reference and candidate share genuine 2D area, not just a touching boundary
 *  point. Plain entitiesIntersect(A, B) is NOT enough here: its intersection test is
 *  endpoint-inclusive (by design — a curve touching another's endpoint is a legitimate
 *  intersection for check_intersection), so two polygons that merely share a corner or a
 *  full coincident edge (e.g. two rooms sharing a wall) already register as "intersecting"
 *  even though they don't overlap in area at all. Shrinking both by a tiny, fixed
 *  Kernel.tolerance.distance before testing removes exactly that touching-only case while
 *  leaving any real area overlap intact (shrinking a substantial overlap by a
 *  near-zero amount still leaves it overlapping). Entities offsetting can't handle
 *  (text/block/dimension) fall back to the plain, endpoint-inclusive test — moot in
 *  practice since segmentsOf() already makes entitiesIntersect always false for them. */
function _overlapsGenuinely(reference, candidate) {
    if (!_canOffset(reference) || !_canOffset(candidate))
        return entitiesIntersect(reference, candidate).intersects;
    const eps = Kernel.tolerance.distance;
    const shrunkRef = _offsetEntity(reference, -eps) ?? reference;
    const shrunkCand = _offsetEntity(candidate, -eps) ?? candidate;
    return entitiesIntersect(shrunkRef, shrunkCand).intersects;
}

/**
 * Classify the spatial relationship of `candidate` relative to `reference`, using the
 * OGC/DE-9IM spatial-predicate vocabulary (same terms as PostGIS/JTS/GEOS/Shapely: an
 * LLM or GIS-literate reader already has a precise mental model for these):
 *
 *   "contains"    — reference fully encloses candidate (OGC Contains)
 *   "within"      — reference lies fully inside candidate (OGC Within)
 *   "overlapping" — the two share genuine 2D area (_overlapsGenuinely). Deliberately
 *                   NOT split into OGC's separate Overlaps (same-dimension partial
 *                   overlap) vs Crosses (different-dimension, e.g. a line through a
 *                   polygon) predicates — which one applies to e.g. a door depends on
 *                   whether it's drawn as a thin closed rectangle or an open line, and
 *                   a caller would then have to query both to catch either drawing
 *                   style. One unified value is more useful here than strict fidelity.
 *   "touches"     — touch, or nearly touch within adjacentTolerance, without truly
 *                   overlapping (OGC Touches): entitiesIntersect(grown by +tol) is true
 *                   AND entitiesIntersect(shrunk by -tol) is false. This is what catches
 *                   two contours sharing a coincident/collinear edge (e.g. two rooms
 *                   sharing a wall) — their unmodified boundaries produce no crossing
 *                   points at all (see entitiesIntersect's documented limitation), so
 *                   without growing them first there would be nothing to detect. An
 *                   exact-touch fallback (distToEntity within Kernel.tolerance.distance)
 *                   also counts as touches, covering entities offsetting can't handle
 *                   (text/block/dimension) or calls that don't supply adjacentTolerance.
 *   "close"       — within closeDistance but not touching. No OGC predicate name exists
 *                   for this — DE-9IM's nine predicates are all exact-boundary tests;
 *                   the closest standard concept is a PostGIS-style buffered distance
 *                   query (ST_DWithin), which is a function, not a named topological
 *                   relation.
 *   "disjoint"    — none of the above (OGC Disjoint)
 *
 * closeDistance/adjacentTolerance default to 0 (that branch then never fires). Precidra
 * has no fixed real-world scale outside the paper definition — a "close" or "touches"
 * gap meaningful for an architectural drawing (say 10mm) could be enormous or invisible
 * on a mechanical drawing at a different internal scale, so callers must supply values
 * appropriate to the document at hand rather than relying on a universal default (see
 * find_related_entities in web-mcp.js, which requires them explicitly).
 *
 * Known limitations: the touches test only offsets contours[0] (holes are ignored);
 * two exactly-duplicated/coincident shapes can misclassify as "touches" rather than
 * fully overlapping, inheriting entitiesIntersect's parallel-edge blind spot (shrinking
 * two perfectly coincident copies by the same amount keeps them perfectly coincident,
 * so the genuine-overlap test above can't distinguish that case from mere touching).
 */
export function classifyRelation(reference, candidate, { closeDistance = 0, adjacentTolerance = 0 } = {}) {
    if (entityContains(candidate, reference)) return 'within';
    if (entityContains(reference, candidate)) return 'contains';
    if (_overlapsGenuinely(reference, candidate)) return 'overlapping';

    let touches = false;
    if (adjacentTolerance > 0 && _canOffset(reference) && _canOffset(candidate)) {
        const grownRef = _offsetEntity(reference, adjacentTolerance);
        const grownCand = _offsetEntity(candidate, adjacentTolerance);
        if (grownRef && grownCand && entitiesIntersect(grownRef, grownCand).intersects) {
            const shrunkRef = _offsetEntity(reference, -adjacentTolerance);
            const shrunkCand = _offsetEntity(candidate, -adjacentTolerance);
            const stillOverlaps = shrunkRef && shrunkCand && entitiesIntersect(shrunkRef, shrunkCand).intersects;
            touches = !stillOverlaps;
        }
    }

    const dist = reference.distToEntity(candidate);
    if (!touches && dist <= Kernel.tolerance.distance) touches = true;
    if (touches) return 'touches';
    if (dist <= closeDistance) return 'close';
    return 'disjoint';
}

// =====================================================================
// TextEntity — single-line positioned text
// =====================================================================

export class TextEntity extends Entity {
    constructor(layer = '0') {
        super(layer);
        this.type = 'text';
        this.contours = [[ new Vtx(0, 0) ]]; // contours[0][0] is the anchor position
        this.rot = 0;              // degrees, CCW
        this.text = '';
        this.textAlign = 'left';   // 'left' | 'center' | 'right'
        this.verticalAlign = 'bottom'; // 'top' | 'middle' | 'bottom'
        this.textSize = 3.5;       // mm (always absolute)
    }
    // Position stored in contours[0][0]; expose as x/y for convenience
    get x() { return this.contours[0][0].x; }
    set x(v) { this.contours[0][0].x = v; }
    get y() { return this.contours[0][0].y; }
    set y(v) { this.contours[0][0].y = v; }
    // isContourClosed, translate, bbox all work correctly via Entity with a single vertex
    get length() { return null; }
    get area() { return null; }
    distTo(v) {
        const dx = v.x - this.x, dy = v.y - this.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
    // Suppress sub-selection of the anchor vertex
    nearestVertex() { return null; }
    nearestPart()   { return null; }
    // purge/simplify would corrupt the single anchor vertex — make them no-ops
    purge()    {}
    simplify() {}
    clone(preserveId = true) {
        const e = new TextEntity(this.layer);
        if (preserveId) e.id = this.id;
        e.text = this.text;
        e.x = this.x; e.y = this.y; e.rot = this.rot;
        e.textAlign = this.textAlign;
        e.verticalAlign = this.verticalAlign;
        e.textSize = this.textSize;
        e.applyStyle(this.styleClass);
        if (this._resolvedStyle) e._resolvedStyle = { ...this._resolvedStyle };
        return e;
    }
    get isTopologyConstant() { return true; }
    isLine() { return false; }
    isArc() {return false; }
    isCircle() { return false; }
    align(align) {
        if (align === 'left' || align === 'center' || align === 'right')
            this.textAlign = align;
        else if (align === 'top' || align === 'middle' || align === 'bottom')
            this.verticalAlign = align;
        else throw new Error(`Invalid text alignment: ${align}`);
    }
}

// =====================================================================
// ParamEntity — entity having a generator function for parametric geometry
// =====================================================================

export class ParamEntity extends Entity {
    constructor(layer, type, coords, props) {
        if (!entityGenerators[type])
            throw new Error(`Unknown parametric entity type: ${type}`);
        super(layer);
        this.entities = new Set(); // sub-entities: extension lines, dimension line, text
        this.type = 'param';
        this.subtype = type;

        this.props = {};
        for(const key in props)
            this.props[key] = props[key];
        
        if(!Array.isArray(coords))
            throw new Error('ParamEntity requires an array of coordinates');
        for(const c of coords)
            this.addVertex(c);
        this.regenerate();
    }

    regenerate() {
        const genContext = { viewport: { ...Kernel.viewport } };
        this.entities = entityGenerators[this.subtype](this.layer, this.contours[0], this.props, genContext);
        this.applyStyle(this.styleClass);
    }
    applyStyle(style) {
        this.styleClass = style;
        for(const ent of this.entities)
            ent.applyStyle(style);
    }

    get length() { return null; }
    get area() { return null; }
    // purge/simplify would corrupt the single anchor vertex — make them no-ops
    purge()    {}
    simplify() {}
    clone(preserveId = true) {
        const e = new ParamEntity(this.layer, this.subtype, this.contours[0], this.props);
        if (preserveId) e.id = this.id;
        e.applyStyle(this.styleClass);
        if (this._resolvedStyle) e._resolvedStyle = { ...this._resolvedStyle };
        return e;
    }
    get isTopologyConstant() { return true; }
    isLine() { return false; }
    isArc() {return false; }
    isCircle() { return false; }
}

// =====================================================================
// BlockEntity — an instance of a referenced block definition
// =====================================================================

export class BlockEntity extends Entity {
    constructor(layer, blockName, center, radiusPt) {
        super(layer);
        this.type = 'block';
        this.blockName = blockName;
        // Two control vertices in contours[0]: [center, radiusPt]
        this.contours = [[
            center instanceof Vtx ? center.clone() : new Vtx(center.x, center.y),
            radiusPt instanceof Vtx ? radiusPt.clone() : new Vtx(radiusPt.x, radiusPt.y)
        ]];
        this.contour0IsClosed = false;
    }

    get blockDef() { return Kernel.blocks.get(this.blockName); }

    /** Derives { tx, ty, xx, xy, yx, yy, angle, scale } from the two control vertices.
     *  xx/xy is the x-axis column and yx/yy is the y-axis column of the 2×2 transform matrix
     *  (local → world).  If contours[0][1].through is set it defines the y-axis direction,
     *  enabling mirroring; otherwise the y-axis is the CCW perpendicular to the x-axis. */
    get transform() {
        const c = this.contours[0][0];
        const r = this.contours[0][1];
        const dx = r.x - c.x, dy = r.y - c.y;
        const def = this.blockDef;
        const defRadius = (def && def.radius > 0) ? def.radius : 1;
        // x-axis column: maps block-local x to world
        const xx = dx / defRadius;
        const xy = dy / defRadius;
        // y-axis column: explicit through point or CCW perpendicular
        let yx, yy;
        if (r.through) {
            yx = (r.through.x - c.x) / defRadius;
            yy = (r.through.y - c.y) / defRadius;
        } else {
            yx = -xy;   // CCW perpendicular: (-sin·scale, cos·scale)
            yy =  xx;
        }
        const scale = Math.sqrt(dx * dx + dy * dy) / defRadius;
        return { tx: c.x, ty: c.y, xx, xy, yx, yy, angle: Math.atan2(dy, dx), scale };
    }

    get isTopologyConstant() { return true; }
    get isContourClosed() { return false; }

    /** World-space axis-aligned bbox of the transformed block. */
    get bbox() {
        const def = this.blockDef;
        if (!def || !def.bbox) {
            const c = this.contours[0][0], r = this.contours[0][1];
            return { minX: Math.min(c.x, r.x), maxX: Math.max(c.x, r.x),
                     minY: Math.min(c.y, r.y), maxY: Math.max(c.y, r.y) };
        }
        const { tx, ty, xx, xy, yx, yy } = this.transform;
        const bb = def.bbox;
        const corners = [
            [bb.minX, bb.minY], [bb.maxX, bb.minY],
            [bb.maxX, bb.maxY], [bb.minX, bb.maxY]
        ].map(([lx, ly]) => ({
            x: tx + lx * xx + ly * yx,
            y: ty + lx * xy + ly * yy
        }));
        return {
            minX: Math.min(...corners.map(p => p.x)),
            maxX: Math.max(...corners.map(p => p.x)),
            minY: Math.min(...corners.map(p => p.y)),
            maxY: Math.max(...corners.map(p => p.y))
        };
    }
    get length() { return 0; }
    get area() { return 0; }

    /** Distance to nearest rendered edge of the transformed block. */
    distTo(v) {
        const def = this.blockDef;
        if (!def) {
            const c = this.contours[0][0], r = this.contours[0][1];
            return Math.min(c.distTo(v), r.distTo(v));
        }
        const { tx, ty, xx, xy, yx, yy, scale } = this.transform;
        const dx = v.x - tx, dy = v.y - ty;
        const det = xx * yy - yx * xy;
        const lx = ( dx * yy - dy * yx) / det;
        const ly = (-dx * xy + dy * xx) / det;
        const lv = new Vtx(lx, ly);
        // Image blocks: distance to bounding rectangle edges
        if (def.imageData && def.bbox) {
            const bb = def.bbox;
            const cx = Math.max(bb.minX, Math.min(lx, bb.maxX));
            const cy = Math.max(bb.minY, Math.min(ly, bb.maxY));
            const d = Math.sqrt((lx - cx) * (lx - cx) + (ly - cy) * (ly - cy));
            return d * scale;
        }
        let minDist = -1;
        for (const ent of def.entities) {
            const d = ent.distTo(lv);
            if (d >= 0 && (minDist < 0 || d < minDist)) minDist = d;
        }
        return minDist >= 0 ? minDist * scale : -1;
    }

    /** Expose only the two control vertices. */
    nearestVertex(v, maxDist = 1.0) {
        const c = this.contours[0];
        let best = null, minDist = -1;
        for (let i = 0; i < c.length; i++) {
            const d = c[i].distTo(v);
            if (d <= maxDist && (minDist < 0 || d < minDist)) {
                minDist = d; best = { contour: 0, index: i, vertex: c[i] };
            }
        }
        return best;
    }

    /** Topology is constant — only the two control vertices are exposed. */
    nearestPart(v, maxDist = 1.0) {
        const result = this.nearestVertex(v, maxDist);
        if (!result) return null;
        return { contour: 0, id: result.index, isVertex: true };
    }

    clone(preserveId = true) {
        const c = this.contours[0];
        const cloned = new BlockEntity(this.layer, this.blockName, c[0].clone(), c[1].clone());
        if (preserveId) cloned.id = this.id;
        cloned.applyStyle(this.styleClass);
        return cloned;
    }

    /**
     * Apply a {tx, ty, xx, xy, yx, yy} transform to all vertices of an entity in place.
     * Also accepts legacy {tx, ty, angle, scale} for backward compatibility.
     * Handles plain Entity (contours) and TextEntity (x, y, rot).
     */
    static applyTransform(entity, { tx, ty, xx, xy, yx, yy, angle, scale }) {
        let mxx, mxy, myx, myy;
        if (xx !== undefined) {
            mxx = xx; mxy = xy; myx = yx; myy = yy;
        } else {
            const cos = Math.cos(angle), sin = Math.sin(angle);
            mxx = cos * scale; mxy = sin * scale; myx = -sin * scale; myy = cos * scale;
        }
        for (const c of entity.contours) {
            for (const v of c) {
                const lx = v.x, ly = v.y;
                v.x = tx + lx * mxx + ly * myx;
                v.y = ty + lx * mxy + ly * myy;
                if (v.through) {
                    const tlx = v.through.x, tly = v.through.y;
                    v.through.x = tx + tlx * mxx + tly * myx;
                    v.through.y = ty + tlx * mxy + tly * myy;
                }
            }
        }
        if (entity.type === 'text') {
            const lx = entity.x, ly = entity.y;
            entity.x = tx + lx * mxx + ly * myx;
            entity.y = ty + lx * mxy + ly * myy;
            entity.rot = (entity.rot || 0) + Math.atan2(mxy, mxx) * 180 / Math.PI;
        }
    }

    /** Generator yielding { vertex (world-space Vtx), entity, contourIdx, vtxIdx }
     *  for every vertex in the block def, transformed to world space. */
    *worldVertices() {
        const def = this.blockDef;
        if (!def) return;
        const { tx, ty, xx, xy, yx, yy } = this.transform;
        for (const ent of def.entities) {
            for (let ci = 0; ci < ent.contours.length; ci++) {
                const c = ent.contours[ci];
                for (let i = 0; i < c.length; i++) {
                    const v = c[i];
                    const wv = new Vtx(tx + v.x * xx + v.y * yx, ty + v.x * xy + v.y * yy);
                    yield { vertex: wv, entity: ent, contourIdx: ci, vtxIdx: i };
                }
            }
        }
    }

    purge()    {}
    simplify() {}
    isLine()   { return false; }
    isArc()    { return false; }
    isCircle() { return false; }
    regenerate() {}
}

// =====================================================================
// Kernel — singleton document manager (matching smoKernel)
// =====================================================================

// scale = mm per screen unit; paperW/H in mm for export and font scaling
export const DEFAULT_VIEWPORT = { cx: 0, cy: 0, scale: 10, paperW: 210, paperH: 297, rasterDpi: 300,
    tileExport: { enabled: false, format: 'a4', margin: 10, showBoundaries: false } };

/** Build a single entity from a deserialized entity data object.
 *  Returns the entity, or null if the data is invalid/unsupported.
 *  Throws on unexpected constructor errors so callers can log them. */
export function buildEntityFromData(ed) {
    if (ed.type === 'text') {
        const ent = new TextEntity(ed.layer ?? '0');
        if (ed.id) TextEntity.advanceCounter(ed.id);
        ent.id = ed.id || ent.id;
        ent.applyStyle(ed.styleClass || '');
        ent.text = ed.text; ent.x = ed.x; ent.y = ed.y; ent.rot = ed.rot;
        ent.textAlign = ed.textAlign; ent.verticalAlign = ed.verticalAlign;
        ent.textSize = ed.textSize;
        return ent;
    }
    if (ed.type === 'block') {
        if (!ed.contours?.[0] || ed.contours[0].length < 2) return null;
        const ent = new BlockEntity(ed.layer ?? '0', ed.blockName, ed.contours[0][0], ed.contours[0][1]);
        if (ed.id) Entity.advanceCounter(ed.id);
        ent.id = ed.id || ent.id;
        ent.applyStyle(ed.styleClass || '');
        return ent;
    }
    if (ed.type) {
        const ent = new ParamEntity(ed.layer, ed.type, ed.contours?.[0] ?? [], ed.props);
        if (ed.id) Entity.advanceCounter(ed.id);
        ent.id = ed.id || ent.id;
        ent.closeContour(!ed.open);
        ent.applyStyle(ed.styleClass || '');
        return ent;
    }
    const ent = new Entity(ed.layer ?? '0');
    if (ed.id) Entity.advanceCounter(ed.id);
    ent.id = ed.id || ent.id;
    ent.contours = ed.contours;
    ent.closeContour(!ed.open);
    ent.applyStyle(ed.styleClass || '');
    return ent;
}

const _cloneStylesheet = ss => new Map([...ss].map(([k, v]) => [k, { ...v }]));

export const Kernel = {
    version: '0.3.0',
    entities: new Set(),
    _undoStack: [],       // Array<Set<Entity>> — bounded undo history
    _redoStack: [],       // Array<Set<Entity>> — redo history
    _maxUndo: 50,
    selection: [],        // Array<Entity>
    selectedVertices: [], // references into contour vertex arrays
    _selUndo: [],         // flat array of {x,y,z} for selectionStore/Restore
    _selUndoRot: new Map(), // entity → { rot, textSize } for text entities
    stylesheet: new Map(), // Map<string, Partial<Style>>: CSS selector → partial style
    defaultStylesheet: new Map(), // parsed default-stylesheet.css; reset target for clear/load
    viewport: { ...DEFAULT_VIEWPORT, tileExport: { ...DEFAULT_VIEWPORT.tileExport } }, // export viewport: center, scale, paper dimensions
    layers: new Map([['0', { visible: true, locked: false, snap: true, z: 0 }]]), // layer 0 always exists
    currLayer: '0',
    blocks: new Map(), // Map<string, BlockDef> — shared block definitions
    tolerance: { distance: 1e-4, angle: 0.1 }, // modeling tolerances: distance (units), angle (degrees)
    changedAt: null, // ISO timestamp of the last committed edit, or null if unchanged
    _pinnedSnapshots: [], // up to 4 time-bracketed snapshots for extended undo (≥5 min, ≥1 h, ≥4 h, prev day)
    _lastRestoredAt: null, // savedAt of most recently restored snapshot; shown in undo/redo status

    /** O(1) layer property lookup. Returns all-permissive defaults for unknown layer names. */
    layerProps(name) {
        return this.layers.get(name) ?? { visible: true, locked: false, snap: true, z: Infinity };
    },

    /** Merge DEFAULT_STYLE → layer defaultStyle → per-class overrides from the stylesheet.
     *  If entity._resolvedStyle is set (block def entities pre-resolved at import time),
     *  it is returned directly, bypassing host stylesheet lookup.
     *  blockInstanceStyle (optional): when resolving a block def's child entity during
     *  rendering, the enclosing BlockEntity instance's own resolved style is passed here.
     *  A child with no styleClass of its own inherits it in place of its own layer default
     *  (BYBLOCK-like) — a child with its own explicit override always keeps that instead. */
    resolveStyle(entity, blockInstanceStyle) {
        if (entity._resolvedStyle) return entity._resolvedStyle;
        const style = { ...DEFAULT_STYLE };
        const hasOwnOverride = !!(entity.styleClass && entity.styleClass.trim());
        if (!hasOwnOverride && blockInstanceStyle) {
            Object.assign(style, blockInstanceStyle);
        } else {
            const layerStyle = this.layerProps(entity.layer ?? '0').defaultStyle;
            if (layerStyle) Object.assign(style, layerStyle);
        }
        // Text entities are always opaque unless explicitly overridden by their own styleClass
        if (entity.type === 'text') style.fillOpacity = 1;
        if (entity.styleClass) {
            for (const cls of entity.styleClass.trim().split(/\s+/)) {
                if (!cls) continue;
                const partial = this.stylesheet.get('.' + cls) ?? this.stylesheet.get(cls);
                if (partial) Object.assign(style, partial);
            }
        }
        return style;
    },

    add(entity) {
        if (!entity) entity = new Entity(this.currLayer);
        this.entities.add(entity);
        return entity;
    },

    /** Look up an entity by its stable id (survives clone()/undo/redo). Linear scan —
     *  fine at expected entity counts; revisit only if profiling says otherwise. */
    entityById(id) {
        for (const e of this.entities) { if (e.id === id) return e; }
        return null;
    },

    erase(arr) {
        if (!Array.isArray(arr)) arr = [arr];
        for (const e of arr) {
            const layer = this.layerProps(e.layer);
            if (layer.locked || !layer.visible)
                continue;
            this.entities.delete(e);
        }
        // remove from selection too
        this.selection = this.selection.filter(e => this.entities.has(e));
        this.selectedVerticesClear();
        // prune orphaned block defs
        const usedBlocks = new Set();
        for (const e of this.entities) { if (e.type === 'block') usedBlocks.add(e.blockName); }
        for (const name of this.blocks.keys()) { if (!usedBlocks.has(name)) this.blocks.delete(name); }
    },

    /** Select/deselect an entity (toggle). Returns true if now selected. */
    select(entity) {
        if (!entity) return false;
        const idx = this.selection.indexOf(entity);
        if (idx >= 0) {
            // deselect
            if (entity === this.selection[0]) {
                this.selectedVerticesClear();
            }
            entity.state = STATE_NORMAL;
            this.selection.splice(idx, 1);
            return false;
        }
        const layer = this.layerProps(entity.layer);
        if (layer.locked || !layer.visible)
            return false;
        entity.state = STATE_SELECTED;
        this.selection.push(entity);
        return true;
    },

    /** Sub-select a vertex or segment within an entity */
    selectPart(entity, contour, id, isVertex) {
        if (!this.entities.has(entity)) {
            this.selectedVerticesClear();
            return false;
        }
        if (contour >= entity.contours.length) return false;
        const c = entity.contours[contour];
        if (id >= c.length) return false;
        this.selectedVerticesClear();
        this.selectedVertices.push(c[id]);
        if (!isVertex) {
            this.selectedVertices.push(c[(id + 1) % c.length]);
        }
        return true;
    },

    // sub-select vertices by a bounding box (for marquee selection), only valid if single entity is selected
    selectVerticesWithin(bbox, isAppend = false) {
        if (this.selection.length !== 1) return false;
        const ent = this.selection[0];
        const selected = [];
        for (const c of ent.contours) {
            for (const v of c) {
                if (v.x >= bbox.minX && v.x <= bbox.maxX && v.y >= bbox.minY && v.y <= bbox.maxY) {
                    selected.push(v);
                }
            }
        }
        if (!isAppend)
            this.selectedVertices = selected;
        else {
            const alreadySelected = new Set(this.selectedVertices);
            for(const v of selected)
                if (!alreadySelected.has(v)) this.selectedVertices.push(v);
        }
        return selected.length > 0;
    },

    nearestEntity(pt, maxDist = 1.0) {
        let minDist = -1, best = null;
        for (const ent of this.entities) {
            const layer = this.layerProps(ent.layer);
            if (layer.locked || !layer.visible)
                continue;
            const d = ent.distTo(pt);
            if (d >= 0 && (minDist < 0 || d <= minDist)) { // <= to prefer later entities in draw order when distances are equal
                minDist = d;
                best = ent;
            }
        }
        return (minDist < 0 || minDist > maxDist || !best) ? null : best;
    },

    selectAll() {
        this.selectionClear();
        for (const ent of this.entities) {
            const layer = this.layerProps(ent.layer);
            if (layer.locked || !layer.visible)
                continue;
            ent.state = STATE_SELECTED;
            this.selection.push(ent);
        }
    },

    selectionClear() {
        for (const ent of this.selection) ent.state = STATE_NORMAL;
        this.selectedVertices = [];
        this.selection = [];
        this._selUndo = [];
    },

    /** Deep-clone all entities and layers as an undo snapshot. Block defs are shallow-copied
     *  (they are immutable after creation, so sharing references across snapshots is safe). */
    store() {
        const snapshot = { entities: new Set(), layers: new Map(), blocks: new Map(this.blocks) };
        for (const ent of this.entities) {
            snapshot.entities.add(ent.clone());
        }
        for (const [layerId, layer] of this.layers) {
            const lc = { ...layer };
            if (lc.defaultStyle) lc.defaultStyle = { ...lc.defaultStyle };
            snapshot.layers.set(layerId, lc);
        }
        snapshot.stylesheet = _cloneStylesheet(this.stylesheet);
        snapshot.changedAt = this.changedAt;
        snapshot.savedAt = new Date().toISOString();
        this._undoStack.push(snapshot);
        if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
        this._redoStack.length = 0;
        this.changedAt = snapshot.savedAt;
        this._updatePinned();
    },

    /** Restore from undo snapshot (pushes current state to redo). Falls through to pinned snapshots when stack is empty. */
    restore() {
        if (!this._undoStack.length && !this._pinnedSnapshots.length) return 1;
        const redoSnapshot = { entities: new Set(), layers: new Map(), blocks: new Map(this.blocks) };
        for (const ent of this.entities) {
            redoSnapshot.entities.add(ent.clone());
        }
        for (const [layerId, layer] of this.layers) {
            const lc = { ...layer };
            if (lc.defaultStyle) lc.defaultStyle = { ...lc.defaultStyle };
            redoSnapshot.layers.set(layerId, lc);
        }
        redoSnapshot.stylesheet = _cloneStylesheet(this.stylesheet);
        redoSnapshot.changedAt = this.changedAt;
        redoSnapshot.savedAt = new Date().toISOString();
        this._redoStack.push(redoSnapshot);
        let snapshot;
        if (this._undoStack.length) {
            snapshot = this._undoStack.pop();
        } else {
            this._pinnedSnapshots.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
            snapshot = this._pinnedSnapshots.shift();
        }
        this.entities.clear();
        this.selection = [];
        this.blocks = new Map(snapshot.blocks);
        for (const ent of snapshot.entities) {
            this.entities.add(ent);
        }
        this.layers.clear();
        for (const [layerId, layer] of snapshot.layers) {
            const lc = { ...layer };
            if (lc.defaultStyle) lc.defaultStyle = { ...lc.defaultStyle };
            this.layers.set(layerId, lc);
        }
        if (snapshot.stylesheet) this.stylesheet = _cloneStylesheet(snapshot.stylesheet);
        this.changedAt = snapshot.changedAt ?? null;
        this._lastRestoredAt = snapshot.savedAt ?? snapshot.changedAt ?? null;
        this.selectionClear();
        return 0;
    },

    /** Redo a previously undone action */
    redo() {
        if (!this._redoStack.length) return 1;
        const undoSnapshot = { entities: new Set(), layers: new Map(), blocks: new Map(this.blocks) };
        for (const ent of this.entities) {
            undoSnapshot.entities.add(ent.clone());
        }
        for (const [layerId, layer] of this.layers) {
            const lc = { ...layer };
            if (lc.defaultStyle) lc.defaultStyle = { ...lc.defaultStyle };
            undoSnapshot.layers.set(layerId, lc);
        }
        undoSnapshot.stylesheet = _cloneStylesheet(this.stylesheet);
        undoSnapshot.changedAt = this.changedAt;
        // savedAt intentionally not set: redo is navigation, not a new edit
        this._undoStack.push(undoSnapshot);
        const snapshot = this._redoStack.pop();
        this.entities.clear();
        this.layers.clear();
        this.selection = [];
        this.blocks = new Map(snapshot.blocks);
        for (const ent of snapshot.entities) {
            this.entities.add(ent);
        }
        for (const [layerId, layer] of snapshot.layers) {
            const lc = { ...layer };
            if (lc.defaultStyle) lc.defaultStyle = { ...lc.defaultStyle };
            this.layers.set(layerId, lc);
        }
        if (snapshot.stylesheet) this.stylesheet = _cloneStylesheet(snapshot.stylesheet);
        this.changedAt = snapshot.changedAt ?? null;
        this._lastRestoredAt = snapshot.changedAt ?? null;  // changedAt = original edit time, not undo time
        this.selectionClear();
        return 0;
    },

    /** Select time-bracketed pinned snapshot slots.
     *  Scans the full _undoStack (up to 50 entries) plus existing _pinnedSnapshots so
     *  snapshots that have aged out of the regular stack are not lost.
     *  Keeps at most 6 entries: one per bracket (last step, ≥5 min, ≥1 h, ≥4 h, prev day)
     *  plus one "aging candidate" — the oldest ≥1 h snapshot not already a bracket winner,
     *  kept alive so it can eventually age into the ≥4 h and prev-day brackets. */
    _updatePinned() {
        const now = Date.now();
        const todayStr = new Date(now).toLocaleDateString('sv');
        const D5m = 5 * 60 * 1000, D1h = 60 * 60 * 1000, D4h = 4 * 60 * 60 * 1000;
        // pool = full undo stack + currently pinned (union; pinned may contain older entries
        // that have already been pushed off the bounded undo stack)
        const pool = [...this._undoStack, ...this._pinnedSnapshots];
        const brackets = [
            () => true,                                                              // last step: most recent
            s => (now - Date.parse(s.savedAt)) >= D5m,
            s => (now - Date.parse(s.savedAt)) >= D1h,
            s => (now - Date.parse(s.savedAt)) >= D4h,
            s => new Date(s.savedAt).toLocaleDateString('sv') !== todayStr,
        ];
        const kept = [];
        for (const qualifies of brackets) {
            let best = null;
            for (const s of pool)
                if (s.savedAt && qualifies(s) && (!best || Date.parse(s.savedAt) > Date.parse(best.savedAt))) best = s;
            if (best && !kept.includes(best)) kept.push(best);
        }
        // Aging candidates: keep the oldest snapshot in each "in-transit" tier so it
        // survives long enough to cross into the next bracket, even under heavy edit rates.
        //   aging5m: oldest ≥5 min (not yet ≥1 h) → will eventually win the ≥1 h bracket
        //   aging1h: oldest ≥1 h (not yet ≥4 h) → will eventually win the ≥4 h bracket
        for (const [minAge, maxAge] of [[D5m, D1h], [D1h, D4h]]) {
            let aging = null;
            for (const s of pool) {
                if (!s.savedAt || kept.includes(s)) continue;
                const age = now - Date.parse(s.savedAt);
                if (age < minAge || age >= maxAge) continue;
                if (!aging || Date.parse(s.savedAt) < Date.parse(aging.savedAt)) aging = s;
            }
            if (aging) kept.push(aging);
        }
        this._pinnedSnapshots = kept;
    },

    /** Restore from undo snapshot without creating a redo entry (for command cancellation) */
    restoreDiscard() {
        if (!this._undoStack.length) return 1;
        const snapshot = this._undoStack.pop();
        this.entities.clear();
        this.layers.clear();
        this.selection = [];
        this.blocks = new Map(snapshot.blocks);
        for (const ent of snapshot.entities) {
            this.entities.add(ent);
        }
        for (const [layerId, layer] of snapshot.layers) {
            const lc = { ...layer };
            if (lc.defaultStyle) lc.defaultStyle = { ...lc.defaultStyle };
            this.layers.set(layerId, lc);
        }
        if (snapshot.stylesheet) this.stylesheet = _cloneStylesheet(snapshot.stylesheet);
        this.changedAt = snapshot.changedAt ?? null;
        this.selectionClear();
        return 0;
    },

    /** Store all selected vertex positions for live-preview rollback */
    selectionStore() {
        this._selUndo = [];
        this._selUndoRot = new Map();
        for (const ent of this.selection) {
            if (ent.type === 'text') this._selUndoRot.set(ent, { rot: ent.rot, textSize: ent.textSize });
            for (const c of ent.contours) {
                for (const v of c) {
                    const entry = { x: v.x, y: v.y };
                    if (v.through) entry.through = { x: v.through.x, y: v.through.y };
                    this._selUndo.push(entry);
                }
            }
        }
    },

    /** Restore saved vertex positions */
    selectionRestore() {
        let idx = 0;
        for (const ent of this.selection) {
            if (ent.type === 'text' && this._selUndoRot.has(ent)) {
                const saved = this._selUndoRot.get(ent);
                ent.rot = saved.rot;
                ent.textSize = saved.textSize;
            }
            for (const c of ent.contours) {
                for (const v of c) {
                    if (idx < this._selUndo.length) {
                        v.x = this._selUndo[idx].x;
                        v.y = this._selUndo[idx].y;
                        if (v.through && this._selUndo[idx].through) {
                            v.through.x = this._selUndo[idx].through.x;
                            v.through.y = this._selUndo[idx].through.y;
                        }
                        idx++;
                    }
                }
            }
        }
        this._selUndo = [];
        this._selUndoRot = new Map();
    },

    /** Reorder selected entities within the draw stack.
     *  op: 'top' | 'bottom' | 'up' | 'down'
     *  Retains relative ordering within targets; uses draw-order position of
     *  first target as reference for 'up'/'down'. */
    reorder(targets, op) {
        const all = [...this.entities];
        const isTarget = new Set(targets);
        const selected = all.filter(e => isTarget.has(e));
        const others   = all.filter(e => !isTarget.has(e));
        if (!selected.length) return;
        let reordered;
        if (op === 'top') {
            reordered = [...others, ...selected];
        } else if (op === 'bottom') {
            reordered = [...selected, ...others];
        } else if (op === 'up' || op === 'down') {
            // count how many non-selected entities precede the first selected entity
            let insertIdx = 0;
            for (const e of all) {
                if (e === selected[0]) break;
                if (!isTarget.has(e)) insertIdx++;
            }
            if (op === 'up')   insertIdx = Math.min(insertIdx + 1, others.length);
            else               insertIdx = Math.max(insertIdx - 1, 0);
            reordered = [...others.slice(0, insertIdx), ...selected, ...others.slice(insertIdx)];
        } else {
            return;
        }
        this.entities = new Set(reordered);
    },

    /** Number of selected vertices (0, 1, or 2) */
    selectedVertexCount() {
        return this.selectedVertices.length;
    },

    selectedVerticesClear() {
        this.selectedVertices = [];
    },
    isSegmentSelected() {
        if(this.selectedVertices.length !== 2 || this.selection.length !== 1) return false;
        // check if the two selected vertices are consecutive in the same contour
        const v1 = this.selectedVertices[0];
        const v2 = this.selectedVertices[1];
        const ent = this.selection[0];
        for (const c of ent.contours) {
            for (let i = 0; i < c.length; i++) {
                if (c[i] === v1 && c[(i + 1) % c.length] === v2)
                    return ent.isContourClosed || i < c.length - 1; // if contour is open, only allow segments that aren't the closing pair
            }
        }
        return false;
    },
    isArcSelected() {
        return this.isSegmentSelected() && this.selectedVertices[1].isArc();
    },
    isVertexSelected() {
        return this.selectedVertices.length === 1;
    },
    isEntitiesSelected() {
        return this.selection.length > 0 && this.selectedVertexCount() === 0;
    },
    isTextSelected() {
        return this.selection.length === 1 && this.selection[0].type === 'text';
    },

    /** True if any pair of selected entities has overlapping bounding rects */
    selectionOverlaps() {
        if (this.selection.length < 2) return false;
        const boxes = this.selection.map(e => e.bbox);
        for (let i = 0; i < boxes.length; i++) {
            if (!boxes[i]) continue;
            for (let j = i + 1; j < boxes.length; j++) {
                if (!boxes[j]) continue;
                if (bboxIntersect(boxes[i], boxes[j])) return true;
            }
        }
        return false;
    },

    /** Clear everything */
    clear() {
        this.selectionClear();
        this.entities.clear();
        this.blocks.clear();
        this.layers = new Map([['0', { visible: true, locked: false, snap: true, z: 0 }]]);
        this.currLayer = '0';
        this.stylesheet = new Map(this.defaultStylesheet);
        this.viewport = { ...DEFAULT_VIEWPORT, tileExport: { ...DEFAULT_VIEWPORT.tileExport } };
        this.changedAt = null;
        setBaseName('drawing');
        Entity.resetCounter();
    },

    regenerate() {
        for (const ent of this.entities)
            ent.regenerate();
    },

    get bbox() {
        let bbox = null;
        for (const ent of this.entities) {
            const eb = ent.bbox;
            if (!eb) continue;
            if (!bbox) {
                bbox = { ...eb };
            } else {
                bbox.minX = Math.min(bbox.minX, eb.minX);
                bbox.maxX = Math.max(bbox.maxX, eb.maxX);
                bbox.minY = Math.min(bbox.minY, eb.minY);
                bbox.maxY = Math.max(bbox.maxY, eb.maxY);
            }
        }
        return bbox;
    },

    /** bounding box of the current selection, or null if empty/degenerate */
    get selectionBbox() {
        let bbox = null;
        for (const ent of this.selection) {
            const eb = ent.bbox;
            if (!eb) continue;
            if (!bbox) {
                bbox = { ...eb };
            } else {
                bbox.minX = Math.min(bbox.minX, eb.minX);
                bbox.maxX = Math.max(bbox.maxX, eb.maxX);
                bbox.minY = Math.min(bbox.minY, eb.minY);
                bbox.maxY = Math.max(bbox.maxY, eb.maxY);
            }
        }
        return bbox;
    },

    /** paper bounding box in world units */
    get paperBounds() {
        const vp = this.viewport;
        const halfW = vp.paperW / (2 * vp.scale);
        const halfH = vp.paperH / (2 * vp.scale);
        return {
            minX: vp.cx - halfW,
            maxX: vp.cx + halfW,
            minY: vp.cy - halfH,
            maxY: vp.cy + halfH
        };
    },

    layerCreate(name) {
        if (this.layers.has(name))
            return { success:false, msg:`Layer "${name}" already exists`};

        const currZ = this.layers.get(this.currLayer)?.z ?? 0;
        const newZ = currZ + 1;
        // bump all layers at or above newZ up by one
        for (const [, p] of this.layers) if (p.z >= newZ) p.z++;
        this.layers.set(name, { visible: true, locked: false, snap: true, z: newZ });
        this.currLayer = name;
        return { success:true };
    },

    load(data) {
        if (data.stylesheet && data.stylesheet.size) {
            // Merge: saved entries override defaults, but new default classes are preserved
            for (const [k, v] of data.stylesheet) this.stylesheet.set(k, v);
        }
        if (data.viewport) this.viewport = { ...DEFAULT_VIEWPORT, ...data.viewport,
            tileExport: { ...DEFAULT_VIEWPORT.tileExport, ...(data.viewport.tileExport ?? {}) } };
        if (data.layers) {
            this.layers = data.layers;
            if (!this.layers.has('0'))
                this.layers.set('0', { visible: true, locked: false, snap: true, z: 0 });
        }
        if (data.blockDefs) {
            for (const [k, v] of data.blockDefs) this.blocks.set(k, v);
        }
        for (const ed of data.entities) {
            let ent = null;
            try { ent = buildEntityFromData(ed); }
            catch (e) { console.error(`Failed to create entity id=${ed.id}:`, e); }
            if (ent) this.add(ent);
        }
        if (data.changedAt != null) this.changedAt = data.changedAt;
    }
};

// Boolean operations (combine/subtract/intersect/trim) are NOT wired onto Kernel
// here — see boolean-ops.js's header comment. model.js must stay loadable with no
// mention of that file, so a viewer/query-only build never needs to fetch it.
// commands.js (editing-only, never shipped to that build) does the Object.assign.

/** Split a closed contour at its first self-intersection, recursively.
 *  Returns an array of simple (non-self-intersecting) sub-contours. */
function _splitSelfIntersection(contour) {
    const n = contour.length;
    for (let i = 0; i < n; i++) {
        const a0 = contour[i], a1 = contour[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue; // edges share vertex 0
            const b0 = contour[j], b1 = contour[(j + 1) % n];
            const t = lineIntersect2D(a0, a1, b0, b1);
            if (isNaN(t) || t < 1e-9 || t > 1 - 1e-9) continue;
            const s = lineIntersect2D(b0, b1, a0, a1);
            if (isNaN(s) || s < 1e-9 || s > 1 - 1e-9) continue;
            const pt = new Vtx(a0.x + t * (a1.x - a0.x), a0.y + t * (a1.y - a0.y));
            const sub1 = [pt, ...contour.slice(i + 1, j + 1)];
            const sub2 = [pt, ...contour.slice(j + 1), ...contour.slice(0, i + 1)];
            return [..._splitSelfIntersection(sub1), ..._splitSelfIntersection(sub2)];
        }
    }
    return [contour];
}

export { STATE_NORMAL, STATE_SELECTED };
