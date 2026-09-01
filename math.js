// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// math.js — vector math, snap, coordinate transforms for precidra web

export function toFixed(v) {
    const s = v.toFixed(8);
    // remove padded trailing 0s and possible trailing dot
    return s.replace(/\.?0+$/, '');
}

export class Vtx {
    constructor(x = 0, y = 0) {
        this.x = x; this.y = y;
        this.through = null;
    }
    clone() {
        const v = new Vtx(this.x, this.y);
        if (this.through) v.through = this.through.clone();
        return v;
    }
    set(x, y) { this.x = x; this.y = y; return this; }
    isValid() { return isFinite(this.x) && isFinite(this.y); }
    add(v) { return new Vtx(this.x + v.x, this.y + v.y); }
    sub(v) { return new Vtx(this.x - v.x, this.y - v.y); }
    scale(s) { return new Vtx(this.x * s, this.y * s); }
    rotate(angleDeg) {
        const rad = angleDeg * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return new Vtx(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
    }
    mid(v) { return new Vtx((this.x + v.x) / 2, (this.y + v.y) / 2); }
    dot(v) { return this.x * v.x + this.y * v.y; }
    cross(v) {
        return new Vtx(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z
        );
    }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
    sqrLength() { return this.x * this.x + this.y * this.y; }
    normalize() {
        const l = this.length();
        if (l > 1e-12) return this.scale(1 / l);
        return new Vtx();
    }
    ortho() { return new Vtx(-this.y, this.x).normalize(); }
    distTo(v) { return this.sub(v).length(); }
    equals(v) {
        return Math.abs(this.x - v.x) < 1e-9 &&
               Math.abs(this.y - v.y) < 1e-9;
    }
    addInPlace(v) { this.x += v.x; this.y += v.y; return this; }
    scaleInPlace(s) { this.x *= s; this.y *= s; return this; }
    str() { return `${toFixed(this.x)} ${toFixed(this.y)}`; }
    prettyStr(precision) { return `(${this.x.toFixed(precision)}|${this.y.toFixed(precision)})`; }
    /** Vertex can start an arc segment to the next vertex. */
    isArc() { return this.through !== null; }
    setArc(through) { this.through = through; return this; }
    clearArc() { this.through = null; return this; }
}
export const SegVtx = Vtx;
export const Vec2 = Vtx;

/** Signed round-half-away-from-zero, matching C++ snap formula:
 *  int((v + sign(v)*0.5*res) / res) * res */
export function snapValue(v, res) {
    if (res <= 0) return v;
    const sign = v < 0 ? -1 : 1;
    return Math.trunc((v + sign * 0.5 * res) / res) * res;
}

export function snapVec2(v, res) {
    return new Vtx(snapValue(v.x, res), snapValue(v.y, res));
}

/** Distance from point p to the line segment (a, b) */
export function pointSegmentDist(p, a, b) {
    const ab = b.sub(a);
    const ap = p.sub(a);
    const t = Math.max(0, Math.min(1, ab.dot(ap) / (ab.sqrLength() || 1)));
    const proj = a.add(ab.scale(t));
    return p.distTo(proj);
}

export function distPointLine(p, a, b) {
    const ab = b.sub(a);
    const ap = p.sub(a);
    const t = ab.dot(ap) / (ab.sqrLength() || 1);
    const proj = a.add(ab.scale(t));
    return p.distTo(proj);
}

/** line–line intersection parameter for 2D (ignores z).
 *  Returns t such that a0 + t*(a1-a0) is the intersection point,
 *  or NaN if lines are parallel. */
export function lineIntersect2D(a0, a1, b0, b1) {
    const d1x = a1.x - a0.x, d1y = a1.y - a0.y;
    const d2x = b1.x - b0.x, d2y = b1.y - b0.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-12) return NaN;
    const t = ((b0.x - a0.x) * d2y - (b0.y - a0.y) * d2x) / denom;
    return t;
}

/** bounding box - bounding box intersection */
export function bboxIntersect(bb1, bb2) {
    return !(bb2.minX > bb1.maxX || bb2.maxX < bb1.minX ||
             bb2.minY > bb1.maxY || bb2.maxY < bb1.minY);
}

/** Combined world-space bbox and max distance-from-origin ("radius") across a list of
 *  entities — used to build a block definition's bbox/radius (bbox null if the list has
 *  no geometry; radius guarded to 1 when degenerate, so a zero-size block still scales).
 *  ParamEntity's own contours are just its input control points, not its rendered
 *  geometry, so its sub-entities are measured instead. */
export function computeBoundsAndRadius(entities) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let radius = 0;
    const growBbox = bb => {
        if (!bb) return;
        if (bb.minX < minX) minX = bb.minX;
        if (bb.minY < minY) minY = bb.minY;
        if (bb.maxX > maxX) maxX = bb.maxX;
        if (bb.maxY > maxY) maxY = bb.maxY;
    };
    const growRadius = ent => {
        for (const c of ent.contours) {
            for (const v of c) {
                const d = Math.sqrt(v.x * v.x + v.y * v.y);
                if (d > radius) radius = d;
            }
        }
    };
    for (const ent of entities) {
        growBbox(ent.bbox);
        growRadius(ent);
        if (ent.type === 'param') {
            for (const sub of ent.entities) {
                growBbox(sub.bbox);
                growRadius(sub);
            }
        }
    }
    if (radius === 0) radius = 1;
    const bbox = (minX === Infinity) ? null : { minX, minY, maxX, maxY };
    return { bbox, radius };
}

// --- Camera & coordinate transforms ---

/** screen pixel → world coordinate. Y is flipped (screen Y-down → world Y-up) */
export function screenToWorld(sx, sy, cam, W, H) {
    return new Vtx(
        (sx - W / 2) / cam.zoom + cam.x,
        -(sy - H / 2) / cam.zoom + cam.y
    );
}

/** world coordinate → screen pixel */
export function worldToScreen(wx, wy, cam, W, H) {
    return {
        x: (wx - cam.x) * cam.zoom + W / 2,
        y: -(wy - cam.y) * cam.zoom + H / 2
    };
}

// --- Arc geometry helpers ---

/** Compute circumcircle of three points (a, t, b).
 *  Returns { center: Vtx, radius, startAngle, endAngle, ccw } or null if collinear. */
export function circumcircle(a, t, b) {
    const ax = a.x, ay = a.y, bx = t.x, by = t.y, cx = b.x, cy = b.y;
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) return null; // collinear
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const center = new Vtx(ux, uy);
    const radius = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
    const startAngle = Math.atan2(ay - uy, ax - ux);
    const endAngle = Math.atan2(cy - uy, cx - ux);
    // determine ccw: the through-point determines which arc (short vs long)
    // cross product (t-a) × (b-a) determines the winding
    const cross = (t.x - a.x) * (b.y - a.y) - (t.y - a.y) * (b.x - a.x);
    const ccw = cross > 0;
    return { center, radius, startAngle, endAngle, ccw };
}

/** Convenience wrapper — same as circumcircle(a, t, b). */
export function arcFromThrough(a, t, b) {
    return circumcircle(a, t, b);
}

/** Distance from point p to an arc defined by center, radius, startAngle, endAngle, ccw. */
export function pointArcDist(p, center, radius, startAngle, endAngle, ccw) {
    const angle = Math.atan2(p.y - center.y, p.x - center.x);
    if (angleOnArc(angle, startAngle, endAngle, ccw)) {
        // closest point is on the arc — distance is |dist_to_center - radius|
        const d = Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2);
        return Math.abs(d - radius);
    }
    // closest point is one of the endpoints
    const sa = new Vtx(center.x + radius * Math.cos(startAngle), center.y + radius * Math.sin(startAngle));
    const ea = new Vtx(center.x + radius * Math.cos(endAngle), center.y + radius * Math.sin(endAngle));
    return Math.min(p.distTo(sa), p.distTo(ea));
}

/** Midpoint of an arc at the angle bisector. */
export function arcMidpoint(center, radius, startAngle, endAngle, ccw) {
    const mid = _arcMidAngle(startAngle, endAngle, ccw);
    return new Vtx(center.x + radius * Math.cos(mid), center.y + radius * Math.sin(mid));
}

/** Intersect an arc with line segment a→b. Returns array of Vtx (0–2 points). */
export function arcLineIntersect(center, radius, startAngle, endAngle, ccw, a, b) {
    const results = [];
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - center.x, fy = a.y - center.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - radius * radius;
    let disc = B * B - 4 * A * C;
    if (disc < 0) return results;
    disc = Math.sqrt(disc);
    for (const sign of [-1, 1]) {
        const t = (-B + sign * disc) / (2 * A);
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const px = a.x + t * dx, py = a.y + t * dy;
        const angle = Math.atan2(py - center.y, px - center.x);
        if (angleOnArc(angle, startAngle, endAngle, ccw)) {
            results.push(new Vtx(px, py));
        }
    }
    return results;
}

/** Intersect two arcs. Returns array of Vtx (0–2 points). */
export function arcArcIntersect(c1, r1, sa1, ea1, ccw1, c2, r2, sa2, ea2, ccw2) {
    const results = [];
    const dx = c2.x - c1.x, dy = c2.y - c1.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9 || d < 1e-12) return results;
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h2 = r1 * r1 - a * a;
    if (h2 < -1e-9) return results;
    const h = Math.sqrt(Math.max(0, h2));
    const mx = c1.x + a * dx / d, my = c1.y + a * dy / d;
    const offx = h * dy / d, offy = h * dx / d;
    const points = h < 1e-9
        ? [{ x: mx, y: my }]
        : [{ x: mx + offx, y: my - offy }, { x: mx - offx, y: my + offy }];
    for (const p of points) {
        const ang1 = Math.atan2(p.y - c1.y, p.x - c1.x);
        const ang2 = Math.atan2(p.y - c2.y, p.x - c2.x);
        if (angleOnArc(ang1, sa1, ea1, ccw1) && angleOnArc(ang2, sa2, ea2, ccw2)) {
            results.push(new Vtx(p.x, p.y));
        }
    }
    return results;
}

/** Point-in-polygon test for a single contour (array of Vtx, arc `.through`
 *  bulges supported). isClosed=false always returns false — an open contour
 *  has no interior. A point within eps of any edge (line or arc) counts as
 *  contained (inclusive boundary), checked first against the exact point so
 *  boundary cases don't depend on the ray-casting pass below. */
export function pointInContour(pt, contour, isClosed, eps = 1e-6) {
    if (!isClosed) return false;
    const n = contour.length;
    if (n < 2) return false;

    for (let i = 0; i < n; i++) {
        const a = contour[i], b = contour[(i + 1) % n];
        const arc = b.through ? arcFromThrough(a, b.through, b) : null;
        const d = arc
            ? pointArcDist(pt, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw)
            : pointSegmentDist(pt, a, b);
        if (d <= eps) return true;
    }

    // Ray-casting interior test. The ray's y is nudged by a tiny amount so it can
    // never pass exactly through a contour vertex: two arcs sharing a circle (e.g.
    // the two halves of a circle entity) each compute their crossing x from the
    // same circle equation independently, so an unperturbed ray through their
    // shared vertex registers 0 or 2 crossings there instead of the correct 1,
    // cancelling out or double-counting. Straight edges alone dodge this via the
    // strict/non-strict asymmetry in the y-comparison below, but that guarantee
    // doesn't extend to an arc computed from a different formula — nudging the
    // whole ray sidesteps the vertex case for both edge kinds uniformly.
    const rayY = pt.y + 1e-7;
    let inside = false;
    for (let i = 0; i < n; i++) {
        const a = contour[i], b = contour[(i + 1) % n];
        const arc = b.through ? arcFromThrough(a, b.through, b) : null;
        if (arc) {
            const dy = rayY - arc.center.y;
            if (Math.abs(dy) > arc.radius) continue;
            const dx = Math.sqrt(Math.max(0, arc.radius * arc.radius - dy * dy));
            const xs = dx > 1e-12 ? [arc.center.x - dx, arc.center.x + dx] : [arc.center.x];
            for (const x of xs) {
                if (x <= pt.x) continue;
                const angle = Math.atan2(dy, x - arc.center.x);
                if (angleOnArc(angle, arc.startAngle, arc.endAngle, arc.ccw)) inside = !inside;
            }
        } else if ((a.y > rayY) !== (b.y > rayY)) {
            const t = (rayY - a.y) / (b.y - a.y);
            if (a.x + t * (b.x - a.x) > pt.x) inside = !inside;
        }
    }
    return inside;
}

/** Minimum distance between two line segments. Exact for a non-intersecting pair — the
 *  closest approach between two straight segments that don't cross is always an
 *  endpoint-to-opposite-segment distance. A crossing pair should be tested for
 *  intersection separately (distance 0) before relying on this. */
export function segmentSegmentDist(p0, p1, q0, q1) {
    return Math.min(
        pointSegmentDist(p0, q0, q1), pointSegmentDist(p1, q0, q1),
        pointSegmentDist(q0, p0, p1), pointSegmentDist(q1, p0, p1),
    );
}

/** The point (an endpoint of one of the two segments) achieving the minimum distance
 *  between them — see segmentSegmentDist's own comment for why an endpoint always wins
 *  for a non-crossing pair. Used to report an approximate contact point for a "touches"
 *  classification that isn't a collinear edge overlap (see collinearOverlap below). */
export function nearestSegmentPoint(p0, p1, q0, q1) {
    const candidates = [
        { d: pointSegmentDist(p0, q0, q1), pt: p0 },
        { d: pointSegmentDist(p1, q0, q1), pt: p1 },
        { d: pointSegmentDist(q0, p0, p1), pt: q0 },
        { d: pointSegmentDist(q1, p0, p1), pt: q1 },
    ];
    candidates.sort((a, b) => a.d - b.d);
    return candidates[0].pt;
}

/** If two line segments are collinear (within tolerance) and their projections onto
 *  that shared line overlap, returns the overlapping sub-segment as {p0, p1, length}
 *  (world coordinates); otherwise null (not collinear, or collinear but not touching at
 *  all). A zero-length result (segments meeting exactly end-to-end) is still returned —
 *  the caller decides whether a length that small counts as a "point" rather than an
 *  "edge" contact (see find_related_entities' touchContact in web-mcp.js, built to
 *  distinguish exactly that: two rooms sharing a real length of wall vs. only touching
 *  at a single corner). */
export function collinearOverlap(p0, p1, q0, q1, tolerance) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return null;
    const ux = dx / len, uy = dy / len;
    const perp = (x, y) => Math.abs((x - p0.x) * -uy + (y - p0.y) * ux);
    if (perp(q0.x, q0.y) > tolerance || perp(q1.x, q1.y) > tolerance) return null;
    const proj = (x, y) => (x - p0.x) * ux + (y - p0.y) * uy;
    let qMin = proj(q0.x, q0.y), qMax = proj(q1.x, q1.y);
    if (qMin > qMax) [qMin, qMax] = [qMax, qMin];
    const start = Math.max(0, qMin), end = Math.min(len, qMax);
    if (end < start - tolerance) return null;
    const clampedStart = Math.min(start, end), clampedEnd = Math.max(start, end);
    return {
        p0: new Vtx(p0.x + ux * clampedStart, p0.y + uy * clampedStart),
        p1: new Vtx(p0.x + ux * clampedEnd, p0.y + uy * clampedEnd),
        length: Math.max(0, clampedEnd - clampedStart),
    };
}

/** Minimum distance between a line segment (p0,p1) and a circular arc. Beyond the four
 *  endpoint-vs-other pairings, also checks the perpendicular foot from the arc's center
 *  onto the segment (clamped to it) — the case where the segment passes closest to the
 *  arc's curve at a point strictly between both entities' endpoints, which no endpoint
 *  pairing alone can find. */
export function segmentArcDist(p0, p1, center, radius, startAngle, endAngle, ccw) {
    const arcStart = new Vtx(center.x + radius * Math.cos(startAngle), center.y + radius * Math.sin(startAngle));
    const arcEnd   = new Vtx(center.x + radius * Math.cos(endAngle),   center.y + radius * Math.sin(endAngle));
    let min = Math.min(
        pointArcDist(p0, center, radius, startAngle, endAngle, ccw),
        pointArcDist(p1, center, radius, startAngle, endAngle, ccw),
        pointSegmentDist(arcStart, p0, p1),
        pointSegmentDist(arcEnd, p0, p1),
    );
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len2 = dx * dx + dy * dy;
    if (len2 > 1e-18) {
        const t = Math.max(0, Math.min(1, ((center.x - p0.x) * dx + (center.y - p0.y) * dy) / len2));
        const footX = p0.x + t * dx, footY = p0.y + t * dy;
        const angle = Math.atan2(footY - center.y, footX - center.x);
        if (angleOnArc(angle, startAngle, endAngle, ccw)) {
            const dCenter = Math.hypot(footX - center.x, footY - center.y);
            min = Math.min(min, Math.abs(dCenter - radius));
        }
    }
    return min;
}

/** Minimum distance between two circular arcs. Beyond the four endpoint-vs-other-arc
 *  pairings, checks all four combinations of "the point on each circle lying toward or
 *  away from the other circle's center" — the unconstrained closest/farthest approach
 *  between two full circles always lies at one of these four aligned pairs (their
 *  connecting line always passes through both centers), which covers external
 *  separation, overlap-adjacent, and containment configurations alike; restricting each
 *  to its own arc's sweep and taking the overall minimum across all eight candidates
 *  correctly reduces to whichever configuration actually applies. */
export function arcArcDist(c1, r1, sa1, ea1, ccw1, c2, r2, sa2, ea2, ccw2) {
    const p1s = new Vtx(c1.x + r1 * Math.cos(sa1), c1.y + r1 * Math.sin(sa1));
    const p1e = new Vtx(c1.x + r1 * Math.cos(ea1), c1.y + r1 * Math.sin(ea1));
    const p2s = new Vtx(c2.x + r2 * Math.cos(sa2), c2.y + r2 * Math.sin(sa2));
    const p2e = new Vtx(c2.x + r2 * Math.cos(ea2), c2.y + r2 * Math.sin(ea2));
    let min = Math.min(
        pointArcDist(p1s, c2, r2, sa2, ea2, ccw2), pointArcDist(p1e, c2, r2, sa2, ea2, ccw2),
        pointArcDist(p2s, c1, r1, sa1, ea1, ccw1), pointArcDist(p2e, c1, r1, sa1, ea1, ccw1),
    );
    const dx = c2.x - c1.x, dy = c2.y - c1.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-12) {
        const ux = dx / d, uy = dy / d;
        for (const s1 of [1, -1]) {
            for (const s2 of [1, -1]) {
                const q1 = new Vtx(c1.x + s1 * r1 * ux, c1.y + s1 * r1 * uy);
                const q2 = new Vtx(c2.x + s2 * r2 * ux, c2.y + s2 * r2 * uy);
                const a1 = Math.atan2(s1 * uy, s1 * ux);
                const a2 = Math.atan2(s2 * uy, s2 * ux);
                if (angleOnArc(a1, sa1, ea1, ccw1) && angleOnArc(a2, sa2, ea2, ccw2))
                    min = Math.min(min, q1.distTo(q2));
            }
        }
    }
    return min;
}

export function angleBetween(a, b) {
    const la = a.length(), lb = b.length();
    if (la < 1e-12 || lb < 1e-12) return 0;
    const cosA = a.dot(b) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, cosA)));
}

export function vecFromAngle(angle) {
    angle = angle * Math.PI / 180;
    return new Vtx(Math.cos(angle), Math.sin(angle));
}

export function arcLength(radius, startAngle, endAngle, ccw) {
    if(typeof radius === 'object')
        ({ radius, startAngle, endAngle, ccw } = radius);
    let sweep = _normalizeAngle(endAngle - startAngle);
    if (ccw && sweep < 1e-9) sweep = 2 * Math.PI; // full circle
    if (!ccw) sweep = 2 * Math.PI - sweep;
    return radius * sweep;
}

// --- Parametric-curve helpers (shared by SVG and DXF importers) ---

/** Default chord-height tolerance in mm for curve-to-polyline subdivision. */
export const CURVE_SUBDIV_TOL = 0.25;

function _ccXY(ax, ay, bx, by, px, py) {
    const D = 2 * (ax*(by - py) + bx*(py - ay) + px*(ay - by));
    if (Math.abs(D) < 1e-10) return null;
    const a2 = ax*ax + ay*ay, b2 = bx*bx + by*by, p2 = px*px + py*py;
    const ux = (a2*(by - py) + b2*(py - ay) + p2*(ay - by)) / D;
    const uy = (a2*(px - bx) + b2*(ax - px) + p2*(bx - ax)) / D;
    return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}

/** Test if a parametric curve (evalFn: t→{x,y}) lies on a circular arc.
 *  Returns the through-point Vtx at t=0.5, or null if not circular. */
export function curveArcThrough(evalFn) {
    const p0 = evalFn(0), pm = evalFn(0.5), p1 = evalFn(1);
    const cc = _ccXY(p0.x, p0.y, pm.x, pm.y, p1.x, p1.y);
    if (!cc || cc.r < 1e-6) return null;
    const tol = 0.001 * cc.r;
    for (const t of [0.1, 0.25, 0.75, 0.9]) {
        const p = evalFn(t);
        if (Math.abs(Math.hypot(p.x - cc.cx, p.y - cc.cy) - cc.r) > tol) return null;
    }
    return new Vtx(pm.x, pm.y);
}

/** Recursively subdivide a parametric curve into polyline segments (chord-height test).
 *  Pushes only the endpoint of each leaf segment; the caller owns the start point. */
export function curveSubdivide(verts, evalFn, t0, x0, y0, t1, x1, y1, depth, tol) {
    const tmid = (t0 + t1) / 2;
    const pm = evalFn(tmid);
    const dx = pm.x - (x0 + x1) / 2, dy = pm.y - (y0 + y1) / 2;
    if (depth >= 8 || dx*dx + dy*dy < tol * tol) {
        verts.push(new Vtx(x1, y1));
        return;
    }
    curveSubdivide(verts, evalFn, t0, x0, y0, tmid, pm.x, pm.y, depth + 1, tol);
    curveSubdivide(verts, evalFn, tmid, pm.x, pm.y, t1, x1, y1, depth + 1, tol);
}

/** Add one parametric curve segment to verts: arc-fit first, chord-height subdivision as fallback. */
export function addCurveSeg(verts, x0, y0, x1, y1, evalFn, tol) {
    const through = curveArcThrough(evalFn);
    if (through) {
        const end = new Vtx(x1, y1);
        end.through = through;
        verts.push(end);
    } else {
        curveSubdivide(verts, evalFn, 0, x0, y0, 1, x1, y1, 0, tol);
    }
}

// --- Internal arc angle helpers ---

/** Normalize angle to [0, 2π) */
function _normalizeAngle(a) {
    a = a % (2 * Math.PI);
    return a < 0 ? a + 2 * Math.PI : a;
}

/** Test if angle is within the arc sweep from startAngle to endAngle in direction ccw. */
export function angleOnArc(angle, startAngle, endAngle, ccw) {
    const a = _normalizeAngle(angle - startAngle);
    const e = _normalizeAngle(endAngle - startAngle);
    if (e < 1e-9) return true; // full circle: every angle is on the arc
    if (ccw) {
        // CCW: sweep goes from 0 to e (positive direction)
        return a <= e + 1e-9;
    } else {
        // CW: sweep goes from 0 to (2π - e) in negative direction, i.e., angle >= e
        return a >= e - 1e-9;
    }
}

/** The midpoint angle of an arc sweep. */
function _arcMidAngle(startAngle, endAngle, ccw) {
    let sweep = _normalizeAngle(endAngle - startAngle);
    if (ccw && sweep < 1e-9) sweep = 2 * Math.PI; // full circle
    if (!ccw) sweep = 2 * Math.PI - sweep;
    const halfSweep = sweep / 2;
    return ccw ? startAngle + halfSweep : startAngle - halfSweep;
}
