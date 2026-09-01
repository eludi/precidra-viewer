// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
import { Vtx,lineIntersect2D, arcMidpoint, angleBetween, vecFromAngle } from './math.js';
import { Entity, TextEntity } from './model.js';

function generateLinearDimension(layer, coords, props, ctx) {
    if(!props.rot)
        props.rot = 0;

    const start = coords[0], end = coords[1], through = end.through ? end.through : start.mid(end);
    const vDir = vecFromAngle(props.rot);
    let vOrtho = vDir.ortho();
    if (vOrtho.dot(through.sub(start)) < 0) vOrtho = vOrtho.scale(-1);

    // project start/end onto line defined by through + vDir to get extension points
    const distStart = lineIntersect2D(start, start.add(vOrtho), through, through.add(vDir));
    const distEnd = lineIntersect2D(end, end.add(vOrtho), through, through.add(vDir));
    if (isNaN(distStart) || isNaN(distEnd))
        throw new Error('invalid dimension points');

    const mmW = 1 / ctx.viewport.scale;
    const entities = new Set();       
    const line =  new Entity(layer);
    line.addVertex(start.add(vOrtho.scale(1*mmW)));
    const projStart = start.add(vOrtho.scale(distStart));
    const projEnd = end.add(vOrtho.scale(distEnd));
    line.addVertex(projStart);
    line.addVertex(projEnd);
    const endNoArc = new Vtx(end.x, end.y); // do not add arc
    line.addVertex(endNoArc.add(vOrtho.scale(1*mmW)));
    line.styleClass = 'lw-thin';
    entities.add(line);

    props.text = projEnd.sub(projStart).length().toFixed(props.precision);
    const text = new TextEntity(layer);
    const textVOffset = new Vtx(0, 1).rotate(props.rot).scale(0.5*mmW);
    const textPos = projStart.mid(projEnd).add(textVOffset);
    text.x = textPos.x; text.y = textPos.y;
    text.rot = props.rot;
    text.text = props.text;
    text.textAlign = 'center';
    text.verticalAlign = 'bottom';
    text.textSize = +props.textSize;
    entities.add(text);

    if(ctx && ctx.viewport) { // add marks at projection points
        const MARK_RADIUS = 0.5; // mm
        const mark1 = Entity.circle(layer, projStart, MARK_RADIUS * mmW);
        mark1.styleClass = 'lw-thin';
        entities.add(mark1);
        const mark2 = Entity.circle(layer, projEnd, MARK_RADIUS * mmW);
        mark2.styleClass = 'lw-thin';
        entities.add(mark2);
    }
    return entities;
}

function generateAngularDimension(layer, coords, props, ctx) {
    if (coords.length < 3)
        throw new Error('angular dimension requires center plus two points');

    const center = coords[0];
    const p1 = coords[1];
    const p2 = coords[2];
    const through = p2.through;

    const v1 = p1.sub(center);
    const v2 = p2.sub(center);
    const d1 = v1.length();
    const d2 = v2.length();
    if (d1 < 1e-12 || d2 < 1e-12)
        throw new Error('invalid angular dimension points');

    const dir1 = v1.scale(1 / d1);
    const dir2 = v2.scale(1 / d2);
    const cross = dir1.x * dir2.y - dir1.y * dir2.x;
    const ccw = cross >= 0;

    const mmW = 1 / ctx.viewport.scale;
    let radius = through ? through.distTo(center) : Math.max(d1, d2) + 2 * mmW;
    if (radius < 1e-12)
        throw new Error('invalid angular dimension radius');

    const startAngle = Math.atan2(v1.y, v1.x);
    const endAngle = Math.atan2(v2.y, v2.x);
    const arcStart = center.add(dir1.scale(radius));
    const arcEnd = center.add(dir2.scale(radius));
    const arcMid = arcMidpoint(center, radius, startAngle, endAngle, ccw);

    const entities = new Set();

    const line1 = new Entity(layer);
    line1.addVertex(p1.add(dir1.scale(1 * mmW)));
    line1.addVertex(arcStart);
    line1.styleClass = 'lw-thin';
    entities.add(line1);

    const line2 = new Entity(layer);
    line2.addVertex(p2.add(dir2.scale(1 * mmW)));
    line2.addVertex(arcEnd);
    line2.styleClass = 'lw-thin';
    entities.add(line2);

    const arc = new Entity(layer);
    arc.addVertex(new Vtx(arcStart.x, arcStart.y));
    arc.addVertex(new Vtx(arcEnd.x, arcEnd.y).setArc(arcMid));
    arc.styleClass = 'lw-thin';
    entities.add(arc);

    const angleRad = angleBetween(dir1, dir2);
    props.text = (angleRad * 180 / Math.PI).toFixed(props.precision)+'°';

    const textOffset = arcMid.sub(center).normalize().scale(0.5 * mmW);
    const textPos = arcMid.add(textOffset);
    const midAngle = Math.atan2(arcMid.y - center.y, arcMid.x - center.x);
    const tangentAngle = (midAngle * 180 / Math.PI) + (ccw ? -90 : 90);
    const text = new TextEntity(layer);
    text.x = textPos.x;
    text.y = textPos.y;
    text.rot = tangentAngle;
    text.text = props.text;
    text.textAlign = 'center';
    text.verticalAlign = 'bottom';
    text.textSize = +props.textSize;
    entities.add(text);

    if (ctx && ctx.viewport) {
        const MARK_RADIUS = 0.5; // mm
        const mark1 = Entity.circle(layer, arcStart, MARK_RADIUS * mmW);
        mark1.styleClass = 'lw-thin';
        entities.add(mark1);
        const mark2 = Entity.circle(layer, arcEnd, MARK_RADIUS * mmW);
        mark2.styleClass = 'lw-thin';
        entities.add(mark2);
    }

    return entities;
}

function generateRadialDimension(layer, coords, props, ctx) {
    if (coords.length < 2)
        throw new Error('radial dimension requires center plus a point on the circle');

    const center = coords[0];
    const point = coords[1];
    const through = point.through;

    const v = point.sub(center);
    const distance = v.length();
    if (distance < 1e-12)
        throw new Error('invalid radial dimension points');

    const dir = v.scale(1 / distance);
    const mmW = 1 / ctx.viewport.scale;
    const entities = new Set();

    props.text = `R${distance.toFixed(props.precision)}`;
    const textWidthEstimate = Math.max(props.textSize * props.text.length * 0.6, props.textSize * 2.5);
    const extensionMm = Math.max(textWidthEstimate + 1.5, 8);
    const extension = dir.scale(extensionMm * mmW);
    const start = point;
    const end = point.add(extension);

    const line = new Entity(layer);
    line.addVertex(start);
    line.addVertex(end);
    line.styleClass = 'lw-thin';
    entities.add(line);

    let ortho = dir.ortho();
    if (Math.abs(ortho.y) < 1e-9) {
        ortho = new Vtx(-1, 0); // place text to the left of a vertical line
    } else if (ortho.y < 0) {
        ortho = ortho.scale(-1);
    }
    const textPos = start.add(extension.scale(0.5)).add(ortho.normalize().scale(0.5 * mmW));
    const text = new TextEntity(layer);
    text.x = textPos.x;
    text.y = textPos.y;
    let rot = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
    if (rot > 90) rot -= 180;
    else if (rot <= -90) rot += 180;
    text.rot = rot;
    text.text = props.text;
    text.textAlign = 'center';
    text.verticalAlign = 'bottom';
    text.textSize = +props.textSize;
    entities.add(text);

    if (ctx && ctx.viewport) {
        const MARK_RADIUS = 0.5; // mm
        const mark = Entity.circle(layer, start, MARK_RADIUS * mmW);
        mark.styleClass = 'lw-thin';
        entities.add(mark);
    }

    return entities;
}

export function generateDimension(layer, coords, props, ctx) {
    if(!props.type)
        props.type = 'linear';
    if(!props.textSize)
        props.textSize = 2.5;
    // Loaded from XML, props arrive as raw strings; normalize once here so every
    // generator's toFixed(props.precision) gets a real number.
    props.precision = props.precision !== undefined ? +props.precision : 3;

    if(props.type === 'linear')
        return generateLinearDimension(layer, coords, props, ctx);
    else if(props.type === 'angular')
        return generateAngularDimension(layer, coords, props, ctx);
    else if(props.type === 'radial')
        return generateRadialDimension(layer, coords, props, ctx);
    throw new Error(`Unknown dimension type: ${props.type}`);
}

export const entityGenerators = {
    dim: generateDimension,
};
