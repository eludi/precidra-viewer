// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// web-mcp.js — WebMCP adapter exposing read-only Precidra document facts to
// AI agents. See plans/done/WebMCP.md for the design and the contract each tool
// below must satisfy. Pure adapter: every fact is computed from existing
// Kernel/Entity/math functions, no CAD logic lives here.

import { Kernel, Entity, classifyEntity, entitiesIntersect, classifyRelation, entityContains, segmentsOf } from './model.js';
import { Vtx, collinearOverlap, nearestSegmentPoint, segmentSegmentDist, segmentArcDist, arcArcDist } from './math.js';
import { getBaseName } from './io.js';

const NEARBY_TEXT_LIMIT = 3;
const RELATION_VALUES = ['disjoint', 'close', 'touches', 'overlapping', 'contains', 'within'];

// Set by registerWebMcpTools(grid). grid.res (both static config and the zoom-adjusted
// dynRes derived from it) varies with the grid's step mode and, for dynRes, with the
// current camera zoom — not a stable, reproducible basis for a tolerance that decides
// exact touching. Kernel.tolerance.distance is a single scalar, independent of zoom or
// grid mode, and it's already THE tolerance the rest of classifyRelation's pipeline
// uses for "are these coincident" (see _overlapsGenuinely, the exact-touch fallback
// below) — a small multiple of it stays consistent with that, at the cost of being
// deliberately tight: it only reliably catches geometry that was actually snapped
// together, not two walls left a real-world millimeter apart. Always available (Kernel
// always has a tolerance, document-independent), so "touches" never needs to error for
// a missing adjacentTolerance the way "close" still can for closeDistance below.
function defaultAdjacentTolerance() {
    return Kernel.tolerance.distance * 4;
}

// grid.res[0] (primary grid line spacing) is a coarser, more appropriate basis for
// "close" than for "touches": unlike exact-touch detection, "nearby" is inherently a
// fuzzy notion already, so grid-mode/zoom variability matters less, and the primary
// grid spacing is what a user actually sets to reflect "one meaningful unit" of this
// particular drawing. Stays null in a test harness that never calls
// registerWebMcpTools(grid), where "close" then still requires an explicit
// closeDistance, exactly as before this default existed.
let _grid = null;

function defaultCloseDistance() {
    return _grid ? _grid.res[0] * 2 : undefined;
}

function notFound(kind, id) {
    return { error: `${kind} ${id} not found` };
}

function labelOf(entity) {
    if (entity.type === 'text') return entity.text;
    if (entity.type === 'block') return entity.blockName;
    return null;
}

function styleOf(entity) {
    const s = Kernel.resolveStyle(entity);
    const style = { strokeColor: s.strokeColor, strokeWidth: s.strokeWidth, fill: s.fill, fillOpacity: s.fillOpacity };
    if (entity.type === 'text') { style.fontFamily = s.fontFamily; style.fontSize = s.fontSize; }
    return style;
}

/** Nearest text entities to `entity` (excluding itself), closest first, capped.
 *  Delegates to distToEntity — the same exact per-segment-type distance
 *  classifyRelation/find_related_entities use — rather than re-deriving a point
 *  distance by hand, so a future refinement to distance computation applies here too. */
function nearbyTexts(entity, limit = NEARBY_TEXT_LIMIT) {
    const refs = [];
    for (const other of Kernel.entities) {
        if (other === entity || other.type !== 'text') continue;
        refs.push({ id: other.id, text: other.text, distance: entity.distToEntity(other) });
    }
    refs.sort((a, b) => a.distance - b.distance);
    return refs.slice(0, limit);
}

/** Text anchors that geometrically fall inside `entity`'s contour (closed entities only).
 *  Delegates to entityContains — the same containment test classifyRelation's
 *  contains/within use — rather than re-deriving containment by hand. */
function containedTexts(entity) {
    const refs = [];
    for (const other of Kernel.entities) {
        if (other.type !== 'text') continue;
        if (entityContains(entity, other)) refs.push({ id: other.id, text: other.text, distance: entity.distToEntity(other) });
    }
    return refs;
}

/** Closed objects whose contour contains `textEntity`'s anchor, smallest area first.
 *  Delegates to entityContains, matching containedTexts above. */
function enclosingObjects(textEntity) {
    const refs = [];
    for (const other of Kernel.entities) {
        if (other === textEntity) continue;
        if (entityContains(other, textEntity)) refs.push({ id: other.id, type: classifyEntity(other), area: other.area ?? 0 });
    }
    refs.sort((a, b) => a.area - b.area);
    return refs.map(({ id, type }) => ({ id, type }));
}

function getDocumentInfo() {
    const layers = [...Kernel.layers.entries()]
        .sort((a, b) => a[1].z - b[1].z)
        .map(([name, props]) => {
            let objectCount = 0, textCount = 0;
            for (const e of Kernel.entities) {
                if (e.layer !== name) continue;
                objectCount++;
                if (e.type === 'text') textCount++;
            }
            return { name, objectCount, textCount, visible: props.visible };
        });
    return {
        filename: getBaseName(),
        bounds: Kernel.bbox,
        paper: { width: Kernel.viewport.paperW, height: Kernel.viewport.paperH },
        entityCount: Kernel.entities.size,
        layers,
        lastModified: Kernel.changedAt ?? null,
    };
}

function listObjectsByLayer({ layer }) {
    if (!Kernel.layers.has(layer)) return { error: `layer "${layer}" not found` };
    const objects = [];
    for (const e of Kernel.entities) {
        if (e.layer !== layer) continue;
        objects.push({ id: e.id, type: classifyEntity(e), label: labelOf(e), bounds: e.bbox });
    }
    return { layer, count: objects.length, objects };
}

function getObjectInfo({ id }) {
    const entity = Kernel.entityById(id);
    if (!entity) return notFound('object', id);

    const type = classifyEntity(entity);
    const closed = entity.isContourClosed;
    // BlockEntity reports length/area as 0 (its own convention elsewhere in the app);
    // the WebMCP contract calls for null here instead, so it isn't mistaken for a real
    // zero-length/zero-area measurement.
    const result = {
        id: entity.id,
        type,
        layer: entity.layer,
        label: labelOf(entity),
        closed,
        bounds: entity.bbox,
        length: type === 'block' ? null : entity.length,
        area: closed ? entity.area : null,
        style: styleOf(entity),
        nearbyTexts: nearbyTexts(entity),
        containedTexts: containedTexts(entity),
        enclosingObjects: type === 'text' ? enclosingObjects(entity) : [],
    };
    if (type === 'text') {
        result.text = entity.text;
        result.position = { x: entity.x, y: entity.y };
    } else if (type === 'block') {
        result.blockName = entity.blockName;
        const c = entity.contours[0][0];
        result.position = { x: c.x, y: c.y };
    }
    return result;
}

function getObjectGeometry({ id }) {
    const entity = Kernel.entityById(id);
    if (!entity) return notFound('object', id);
    return {
        id: entity.id,
        type: classifyEntity(entity),
        closed: entity.isContourClosed,
        contours: entity.contours.map(c => c.map(v => {
            const pt = { x: v.x, y: v.y };
            if (v.through) pt.through = { x: v.through.x, y: v.through.y };
            return pt;
        })),
    };
}

/** Resolve an EntityRef — { id } | { x, y } | { closed, contours } (the same shape
 *  get_object_geometry returns) — to a real or ephemeral Entity. An ad-hoc geometry
 *  is built as a plain Entity that is never added to Kernel.entities: every existing
 *  Entity method (distTo, containsPoint, distToEntity, entitiesIntersect via
 *  classifyRelation) then works on it exactly as it would on a real drawing object,
 *  with no special-casing needed anywhere else. Returns { entity } or null if the ref
 *  is malformed or an { id } doesn't resolve. */
function resolveEntityRef(ref) {
    if (!ref || typeof ref !== 'object') return null;
    const hasId = ref.id !== undefined;
    const hasXY = typeof ref.x === 'number' && typeof ref.y === 'number';
    const hasGeometry = Array.isArray(ref.contours);
    if (hasId + hasXY + hasGeometry !== 1) return null; // ambiguous (more than one form) or empty

    if (hasId) {
        const entity = Kernel.entityById(ref.id);
        return entity ? { entity } : null;
    }
    if (hasXY) {
        const entity = new Entity('0');
        entity.contours = [[new Vtx(ref.x, ref.y)]];
        entity.closeContour(false);
        return { entity };
    }
    const entity = new Entity('0');
    try {
        entity.contours = ref.contours.map(c => c.map(v => {
            const vtx = new Vtx(v.x, v.y);
            if (v.through) vtx.setArc(new Vtx(v.through.x, v.through.y));
            return vtx;
        }));
    } catch {
        return null; // malformed vertex data
    }
    entity.closeContour(!!ref.closed);
    return { entity };
}

const REF_USAGE = 'provide exactly one of { id }, { x, y }, or { closed, contours } (see get_object_geometry)';

function measureDistance({ from, to }) {
    const a = resolveEntityRef(from);
    if (!a) return { error: `from: ${REF_USAGE}; an id must resolve to an existing object` };
    const b = resolveEntityRef(to);
    if (!b) return { error: `to: ${REF_USAGE}; an id must resolve to an existing object` };
    return { distance: a.entity.distToEntity(b.entity), from, to };
}

function checkIntersection({ a, b }) {
    const refA = resolveEntityRef(a);
    if (!refA) return { error: `a: ${REF_USAGE}; an id must resolve to an existing object` };
    const refB = resolveEntityRef(b);
    if (!refB) return { error: `b: ${REF_USAGE}; an id must resolve to an existing object` };
    const { intersects, points } = entitiesIntersect(refA.entity, refB.entity);
    return { intersects, points: points.map(p => ({ x: p.x, y: p.y })) };
}

/** Describes how two "touches"-classified entities actually make contact: a single
 *  point, or a shared edge run with its total length — the distinction real usage
 *  flagged as missing (a connector touching a room only at one corner point looked
 *  identical, in the plain "touches" label, to it touching along a real length of
 *  wall — the former is a poor signal for "this connects to that room", the latter a
 *  strong one; exposing the actual contact geometry lets the caller judge that itself
 *  instead of us guessing a length threshold on its behalf).
 *
 *  Exact for line-line contacts (the common case — walls): collinearOverlap finds the
 *  overlapping sub-segment when two edges run along the same line, giving a real
 *  contact length; a line-line pair that touches without being collinear (e.g. two
 *  perpendicular walls meeting at a corner) reports that corner as a point contact via
 *  nearestSegmentPoint. An arc-involving contact is approximated using the nearest pair
 *  of segment endpoints rather than the true tangent point — exact tangent-point
 *  recovery would need segmentArcDist/arcArcDist to also expose their winning point,
 *  not just its distance; deferred since walls (not arcs) dominate the motivating
 *  floor-plan use case. Returns null if no contact is found (shouldn't normally happen
 *  when the caller already knows relation === "touches"). */
function touchContact(reference, candidate, tolerance) {
    const segsA = segmentsOf(reference), segsB = segmentsOf(candidate);
    const edges = [];
    const points = [];

    const arcEndpoints = seg => seg.type === 'arc'
        ? [new Vtx(seg.center.x + seg.radius * Math.cos(seg.sa), seg.center.y + seg.radius * Math.sin(seg.sa)),
           new Vtx(seg.center.x + seg.radius * Math.cos(seg.ea), seg.center.y + seg.radius * Math.sin(seg.ea))]
        : [seg.a, seg.b];

    for (const sa of segsA) {
        for (const sb of segsB) {
            if (sa.type === 'line' && sb.type === 'line') {
                const overlap = collinearOverlap(sa.a, sa.b, sb.a, sb.b, tolerance);
                if (overlap) {
                    if (overlap.length > tolerance) edges.push(overlap);
                    else points.push(overlap.p0);
                } else if (segmentSegmentDist(sa.a, sa.b, sb.a, sb.b) <= tolerance) {
                    points.push(nearestSegmentPoint(sa.a, sa.b, sb.a, sb.b));
                }
                continue;
            }
            const d = sa.type === 'arc' && sb.type === 'arc'
                ? arcArcDist(sa.center, sa.radius, sa.sa, sa.ea, sa.ccw, sb.center, sb.radius, sb.sa, sb.ea, sb.ccw)
                : sa.type === 'arc'
                    ? segmentArcDist(sb.a, sb.b, sa.center, sa.radius, sa.sa, sa.ea, sa.ccw)
                    : segmentArcDist(sa.a, sa.b, sb.center, sb.radius, sb.sa, sb.ea, sb.ccw);
            if (d > tolerance) continue;
            let best = null, bestD = Infinity;
            for (const pa of arcEndpoints(sa)) for (const pb of arcEndpoints(sb)) {
                const dd = pa.distTo(pb);
                if (dd < bestD) { bestD = dd; best = pa; }
            }
            points.push(best);
        }
    }

    const dedupe = pts => {
        const out = [];
        for (const p of pts) if (!out.some(q => q.distTo(p) < tolerance)) out.push(p);
        return out.map(p => ({ x: p.x, y: p.y }));
    };
    if (edges.length) {
        const length = edges.reduce((sum, e) => sum + e.length, 0);
        return { type: 'edge', length, points: dedupe(edges.flatMap(e => [e.p0, e.p1])) };
    }
    if (points.length) return { type: 'point', points: dedupe(points) };
    return null;
}

function findRelatedEntities({ entity, relation, layer, type, closeDistance, adjacentTolerance }) {
    const ref = resolveEntityRef(entity);
    if (!ref) return { error: `entity: ${REF_USAGE}; an id must resolve to an existing object` };

    const relations = Array.isArray(relation) ? relation : [relation];
    if (!relations.length || relations.some(r => !RELATION_VALUES.includes(r)))
        return { error: `relation must be one or more of: ${RELATION_VALUES.join(', ')}` };
    if (relations.includes('close') && typeof closeDistance !== 'number') {
        closeDistance = defaultCloseDistance();
        if (typeof closeDistance !== 'number')
            return { error: 'closeDistance (world units) is required when relation includes "close" — '
                + 'Precidra has no fixed scale outside the paper definition, so inspect a few '
                + 'object sizes via get_object_info first to pick an appropriate value' };
    }
    if (relations.includes('touches') && typeof adjacentTolerance !== 'number')
        adjacentTolerance = defaultAdjacentTolerance(); // always available — see its own comment

    const matches = [];
    for (const candidate of Kernel.entities) {
        if (candidate.id === ref.entity.id) continue; // never match the reference itself
        if (layer !== undefined && candidate.layer !== layer) continue;
        const candType = classifyEntity(candidate);
        if (type !== undefined && candType !== type) continue;
        const rel = classifyRelation(ref.entity, candidate, {
            closeDistance: closeDistance ?? 0,
            adjacentTolerance: adjacentTolerance ?? 0,
        });
        if (!relations.includes(rel)) continue;
        const match = {
            id: candidate.id, type: candType, label: labelOf(candidate), layer: candidate.layer,
            area: candidate.isContourClosed ? candidate.area : null,
            relation: rel, distance: ref.entity.distToEntity(candidate),
        };
        // classifyRelation can call a pair "touches" via either the grow/shrink test
        // (adjacentTolerance) or its exact-touch fallback (Kernel.tolerance.distance) —
        // use whichever is larger so touchContact's own tolerance covers whatever
        // actually triggered the classification, not just one of the two sources.
        if (rel === 'touches')
            match.contact = touchContact(ref.entity, candidate, Math.max(adjacentTolerance, Kernel.tolerance.distance));
        matches.push(match);
    }
    return { matches };
}

/** Tool definitions, kept separate from registration so a test harness can call
 *  `handler(args)` directly without a real document.modelContext (see plans/done/WebMCP.md
 *  "Testing"). */
export const tools = [
    {
        name: 'get_document_info',
        description: 'Return summary metadata about the current Precidra document: '
            + 'filename, overall bounds, paper size, and a per-layer breakdown '
            + '(object/text counts, visibility). Call this first to orient yourself '
            + 'before querying individual objects. Note: all coordinates, lengths, and '
            + 'areas returned by every tool are in the document\'s own world-coordinate '
            + 'units, which carry no fixed real-world correspondence (a drawing may be '
            + 'modeled with 1 unit = 1 mm, 1 m, or anything else — only paper size here '
            + 'is a true physical mm value). Infer the intended real-world scale from '
            + 'context — e.g. a door is typically 0.8-1.0 of that unit if the drawing '
            + 'uses meters, or 800-1000 if it uses millimeters; compare a few object '
            + 'sizes via get_object_info to judge which is plausible before reasoning '
            + 'about real-world sizes.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: getDocumentInfo,
        summarize: r => `${r.entityCount} objects, ${r.layers.length} layers`,
    },
    {
        name: 'list_objects_by_layer',
        description: 'List the objects on one layer as compact summaries (id, geometric '
            + 'type, label if any, bounding box). Use get_object_info for full detail on '
            + 'a specific object.',
        inputSchema: {
            type: 'object',
            properties: { layer: { type: 'string', description: 'Layer name, from get_document_info' } },
            required: ['layer'],
            additionalProperties: false,
        },
        handler: listObjectsByLayer,
        summarize: r => `${r.count} object(s) on "${r.layer}"`,
    },
    {
        name: 'get_object_info',
        description: 'Return descriptive facts about one object: geometric type, layer, '
            + 'label (text content or block name, if any), size/shape summary, resolved '
            + 'style, and nearby/contained text relationships. Does not return raw '
            + 'coordinates — use get_object_geometry for that.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'integer', description: 'Object id' } },
            required: ['id'],
            additionalProperties: false,
        },
        handler: getObjectInfo,
        summarize: r => `#${r.id} ${r.type}${r.label ? ` "${r.label}"` : ''}`,
    },
    {
        name: 'get_object_geometry',
        description: 'Return the raw contour/vertex data of one object in the '
            + "document's world coordinates (see get_document_info regarding units). "
            + "An arc segment is a vertex carrying a 'through' point (the arc's "
            + 'midpoint). Call get_object_info first for a compact summary; use this '
            + 'only when actual coordinates are needed.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'integer', description: 'Object id' } },
            required: ['id'],
            additionalProperties: false,
        },
        handler: getObjectGeometry,
        summarize: r => `#${r.id} ${r.type}, ${r.contours.reduce((n, c) => n + c.length, 0)} vertices`,
    },
    {
        name: 'measure_distance',
        description: 'Compute the minimum distance in world units between two '
            + 'references. Each reference is an existing object id, a bare {x,y} point, '
            + 'or an explicit on-the-fly geometry using the same {closed, contours} shape '
            + 'get_object_geometry returns — useful for "what if" probes against geometry '
            + 'that does not exist in the drawing.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'object', description: 'EntityRef: { id } or { x, y } or { closed, contours }' },
                to: { type: 'object', description: 'EntityRef: { id } or { x, y } or { closed, contours }' },
            },
            required: ['from', 'to'],
            additionalProperties: false,
        },
        handler: measureDistance,
        summarize: r => `distance=${r.distance.toFixed(3)}`,
    },
    {
        name: 'check_intersection',
        description: "Test whether two references' geometries intersect, and return the "
            + 'intersection point(s) if so. Each reference is an existing object id, a '
            + 'bare {x,y} point, or an explicit on-the-fly geometry using the same '
            + '{closed, contours} shape get_object_geometry returns. Read-only — does not '
            + 'modify anything, unlike the interactive boolean operations.',
        inputSchema: {
            type: 'object',
            properties: {
                a: { type: 'object', description: 'EntityRef: { id } or { x, y } or { closed, contours }' },
                b: { type: 'object', description: 'EntityRef: { id } or { x, y } or { closed, contours }' },
            },
            required: ['a', 'b'],
            additionalProperties: false,
        },
        handler: checkIntersection,
        summarize: r => r.intersects ? `intersects at ${r.points.length} point(s)` : 'no intersection',
    },
    {
        name: 'find_related_entities',
        description: 'Find objects — optionally filtered by layer or geometric type — '
            + 'that have a specific spatial relationship to a reference. The reference is '
            + 'an existing object id, a bare {x,y} point, or an explicit on-the-fly '
            + 'geometry using the same {closed, contours} shape get_object_geometry '
            + 'returns. relation uses the standard OGC/DE-9IM spatial-predicate terms '
            + '(as in PostGIS/Shapely) and is one or more of: "contains" (reference '
            + 'fully encloses the match), "within" (reference lies fully inside the '
            + 'match), "overlapping" (the two share genuine area — covers both OGC '
            + '"Overlaps" and "Crosses", since which one applies depends on incidental '
            + 'drawing choices like whether a door is a closed rectangle or an open '
            + 'line), "touches" (touch, or nearly touch within adjacentTolerance, '
            + 'without truly overlapping — e.g. two rooms sharing a wall, or a door '
            + 'opening spanning a wall), "close" (within closeDistance but not '
            + 'touching — conceptually like PostGIS ST_DWithin, not a named DE-9IM '
            + 'predicate), "disjoint" (none of the above). Never returns the reference '
            + 'object itself. adjacentTolerance may be omitted — it then defaults to a '
            + "small multiple of the document's own modeling tolerance, tight enough to "
            + 'only catch geometry that was actually snapped together. closeDistance is '
            + "more open-ended: since the document's world-coordinate unit has no fixed "
            + 'real-world correspondence (see get_document_info), it should usually be '
            + "supplied explicitly, scaled to match this document's own units — inspect "
            + 'a few object sizes via get_object_info first to judge that scale — though '
            + "it falls back to a multiple of the document's primary grid spacing when "
            + 'available. Each '
            + 'match includes layer and area (for a closed match) alongside id/type/'
            + 'label, so a follow-up get_object_info call is often unnecessary. A '
            + '"touches" match additionally includes contact: { type: "point"|"edge", '
            + 'length?, points }, describing the actual contact geometry — this matters '
            + 'because a single shared corner point (type "point") is a much weaker '
            + 'signal than a real shared wall run (type "edge", with its length) when '
            + 'deciding whether two spaces are meaningfully connected.',
        inputSchema: {
            type: 'object',
            properties: {
                entity: { type: 'object', description: 'EntityRef: { id } or { x, y } or { closed, contours }' },
                relation: {
                    type: 'array',
                    items: { type: 'string', enum: RELATION_VALUES },
                    minItems: 1,
                    description: 'One or more of: ' + RELATION_VALUES.join(', '),
                },
                layer: { type: 'string', description: 'Restrict matches to this layer' },
                type: { type: 'string', description: 'Restrict matches to this geometric type (see get_object_info)' },
                closeDistance: {
                    type: 'number',
                    description: 'Required if relation includes "close" and no grid is available to default from',
                },
                adjacentTolerance: {
                    type: 'number',
                    description: 'Optional if relation includes "touches" — defaults to a small multiple of the modeling tolerance',
                },
            },
            required: ['entity', 'relation'],
            additionalProperties: false,
        },
        handler: findRelatedEntities,
        summarize: r => `${r.matches.length} match(es)`,
    },
];

/** Approximate size of a value's JSON serialization, for the generic activity summary
 *  fallback below — UTF-16 code units (plain .length), not exact UTF-8 bytes: close
 *  enough for a rough B/KB estimate without paying for a TextEncoder pass. */
function jsonSize(value) {
    return JSON.stringify(value).length;
}

/** One-line summary of a tool result for the activity readout: the shared {error}
 *  convention is handled once, generically, here; the success case is delegated to the
 *  tool's own `summarize(result)` (each tool knows what's actually interesting about
 *  its own result shape — a match count, a distance, an id — far better than any
 *  generic guess could), falling back to a bare size if a tool doesn't define one. */
function summarizeActivity(tool, result) {
    if (result?.error) return `error: ${result.error}`;
    if (tool.summarize) {
        try { return tool.summarize(result); } catch { /* fall through to the size below */ }
    }
    return `${jsonSize(result)} chars`;
}

/** Register all WebMCP tools with document.modelContext, if present. Returns false
 *  (and registers nothing) when the browser has no WebMCP support, or when accessing
 *  it/registering throws or rejects (e.g. Chrome rejects registerTool() with a
 *  SecurityError instead of just being absent when document.domain has been set) —
 *  Precidra must behave identically either way. registerTool() is async per spec, so
 *  this must be awaited or its rejection becomes an unhandled promise rejection.
 *
 *  grid (optional) is app.js's Grid instance — stored only to derive
 *  find_related_entities' default closeDistance from the document's own primary grid
 *  spacing (see defaultCloseDistance above). Omit it (as the test harness does) and
 *  that default simply becomes unavailable — callers must then supply closeDistance
 *  explicitly, exactly as before this default existed. adjacentTolerance's default
 *  does not depend on grid at all — see defaultAdjacentTolerance.
 *
 *  onActivity (optional) is called after every tool execute() with { name, summary } —
 *  a ready-to-display one-liner (see summarizeActivity) — since an agent driving the
 *  live document otherwise leaves no visible trace at all. Deliberately a plain
 *  callback rather than web-mcp.js importing app.js's setStatus directly: this file has
 *  no business knowing how (or whether) that gets displayed, and app.js already imports
 *  registerWebMcpTools from here, so importing setStatus back would make the two files
 *  circularly dependent on each other. */
export async function registerWebMcpTools(grid, onActivity) {
    _grid = grid ?? null;
    try {
        if (!globalThis.document?.modelContext) return false;
        for (const tool of tools) {
            await document.modelContext.registerTool({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                execute: async (args) => {
                    const result = tool.handler(args ?? {});
                    onActivity?.({ name: tool.name, summary: summarizeActivity(tool, result) });
                    return result;
                },
            });
        }
        return true;
    } catch (err) {
        console.warn('WebMCP tool registration failed, continuing without it:', err);
        return false;
    }
}
