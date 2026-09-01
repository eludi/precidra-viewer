// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// renderer.js — Canvas 2D rendering for precidra web

import { arcFromThrough, arcMidpoint, Vtx, screenToWorld } from './math.js';

const STATE_NORMAL = 0, STATE_SELECTED = 1;

// 1mm = 10 screen pixels at reference density (irrespective of zoom)
const MM_TO_PX = 10;

// Ratio of cap height to em size (approximation valid for common fonts)
const CAP_HEIGHT_RATIO = 0.72;

const COLORS = {
    bg: '#f0f0f0',
    entityNormal: '#222222',
    entitySelected: '#007fff',
    selVertex: '#ff00ff',
    throughVertex: '#aa00ff',
    rubberBand: '#0077cc',
    guide: '#88aaff',
};

function parseDasharray(str, mmInWorldCoords, strokeWidth) {
    if (!str || str === 'none') return [];
    const factor = strokeWidth <= 0.5 ? 1 : strokeWidth/0.5; // scale up dash lengths for thick strokes
    return str.trim().split(/[\s,]+/).map(n => parseFloat(n) * mmInWorldCoords * factor).filter(n => !isNaN(n));
}

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._blockScale = 1; // accumulated scale from enclosing block transforms
    }

    get W() { return this.canvas.width; }
    get H() { return this.canvas.height; }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
            this.canvas.width = w * dpr;
            this.canvas.height = h * dpr;
        }
    }

    /** Set the world-space transform on ctx. Y is flipped so +Y is up. */
    setCamera(cam) {
        const ctx = this.ctx;
        // transform: world (x,y) → screen (px,py)
        // px = (x - cam.x) * zoom + W/2
        // py = -(y - cam.y) * zoom + H/2
        ctx.setTransform(
            cam.zoom, 0,
            0, -cam.zoom,
            -cam.x * cam.zoom + this.W / 2,
            cam.y * cam.zoom + this.H / 2
        );
    }

    clear() {
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, this.W, this.H);
        ctx.restore();
    }

    drawTicks(contour, strokeColor, lineWidth, entity) {
        const ctx = this.ctx;
        const cam = this._cam;
        const px = 1 / cam.zoom; // 1 screen pixel in world coords
        // draw edge-normal ticks at each edge midpoint
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = Math.min(lineWidth, 2 * px);
        const dpr = window.devicePixelRatio || 1;
        const tickLen = lineWidth*0.5 + 6*px * dpr;

        // For all-arc contours (circles etc.) the chord-only shoelace is unreliable.
        // Compute augmented area inserting each through-point between its two endpoints.
        let flipArcNormals = false;
        if (contour.every(v => v.isArc())) {
            const aug = [];
            for (let i = 0; i < contour.length; i++) {
                aug.push(contour[i]);
                const b = contour[(i + 1) % contour.length];
                if (b.through) aug.push(b.through);
            }
            let area = 0;
            for (let i = 0; i < aug.length; i++) {
                const j = (i + 1) % aug.length;
                area += aug[i].x * aug[j].y - aug[j].x * aug[i].y;
            }
            flipArcNormals = area < 0; // CW augmented winding → normals point outward, flip them
        }

        const numTicks = contour.length;
        for (let i = 0; i < numTicks; i++) {
            const a = contour[i];
            const b = contour[(i + 1) % contour.length];
            let mx, my, nx, ny;
            if (b.through) {
                const arc = arcFromThrough(a, b.through, b);
                if (arc) {
                    const mid = arcMidpoint(arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw);
                    mx = mid.x; my = mid.y;
                } else {
                    mx = (a.x + b.x) * 0.5; my = (a.y + b.y) * 0.5;
                }
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                nx = -dy / len; ny = dx / len;
                if (flipArcNormals) { nx = -nx; ny = -ny; }
            } else {
                mx = (a.x + b.x) * 0.5; my = (a.y + b.y) * 0.5;
                const dx = b.x - a.x, dy = b.y - a.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                nx = -dy / len; ny = dx / len;
            }
            ctx.beginPath();
            ctx.moveTo(mx, my);
            ctx.lineTo(mx + nx * tickLen, my + ny * tickLen);
            ctx.stroke();
        }
    }

    /** blockInstanceStyle: when drawing a block def's child entity, the enclosing
     *  BlockEntity's own resolved style — see Kernel.resolveStyle. Not propagated into a
     *  nested block child (cascading stops one level deep: a nested BlockEntity resolves
     *  its own children using only its own styleClass, not the outer instance's). */
    drawEntity(entity, selected=false, blockInstanceStyle=null) {
        if (entity.type === 'text')
            return this.drawTextEntity(entity, selected, blockInstanceStyle);
        else if (entity.type === 'param')
            return this.drawDynEntity(entity, selected, blockInstanceStyle);
        else if (entity.type === 'block')
            return this.drawBlock(entity, selected);
        const ctx = this.ctx;
        const cam = this._cam;
        const kernel = this._kernel;

        const isClosed = entity.isContourClosed;

        const style = kernel.resolveStyle(entity, blockInstanceStyle);
        // stroke width in world units matching export proportions (mm / (mm/unit) = unit);
        // minimum 1 screen pixel so thin lines remain visible when zoomed out
        const mmW = 1 / (kernel.viewport.scale * this._blockScale);
        const lineWidth = Math.max(style.strokeWidth * mmW, 1 / cam.zoom / this._blockScale);
    
        const fillOpacity = style.fillOpacity !== undefined ? style.fillOpacity : 1;
        const f = style.fill;
        const fillStyle = (isClosed && f && f !== 'transparent' && f !== 'none') ? f : null;
        let strokeColor, lineDash;
        if (entity.state === STATE_SELECTED || selected) {
            strokeColor = COLORS.entitySelected;
            lineDash = [];
        } else {
            strokeColor = style.strokeColor;
            lineDash = parseDasharray(style.strokeDasharray, mmW, style.strokeWidth);
        }

        ctx.save();
        for (const contour of entity.contours) {
            if (contour.length < 2)
                continue;

            // draw ticks for closed contours
            if (isClosed && strokeColor !== 'none' && lineWidth > 0)
                this.drawTicks(contour, strokeColor, lineWidth, entity);
        }

        // Fill: single compound path with evenodd rule so inner contours are holes
        if (fillStyle) {
            ctx.beginPath();
            for (const contour of entity.contours) {
                if (contour.length < 2) continue;
                ctx.moveTo(contour[0].x, contour[0].y);
                for (let i = 1; i <= contour.length; i++) {
                    const v = contour[i % contour.length];
                    if (v.through) {
                        const prev = contour[i - 1];
                        const arc = arcFromThrough(prev, v.through, v);
                        if (arc) {
                            ctx.arc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.endAngle, !arc.ccw);
                        } else {
                            ctx.lineTo(v.x, v.y);
                        }
                    } else {
                        ctx.lineTo(v.x, v.y);
                    }
                }
                if (!contour[0].through) ctx.closePath();
            }
            ctx.fillStyle = fillStyle;
            if (fillOpacity !== 1) ctx.globalAlpha = fillOpacity;
            ctx.fill('evenodd');
            ctx.globalAlpha = 1;
        }

        // Stroke: each contour separately
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(lineDash);
        for (const contour of entity.contours) {
            if (contour.length < 2)
                continue;

            ctx.beginPath();
            ctx.moveTo(contour[0].x, contour[0].y);
            for (let i = 1; i <= (isClosed ? contour.length : contour.length - 1); i++) {
                const v = contour[i % contour.length];
                if (v.through) {
                    const prev = contour[i - 1];
                    const arc = arcFromThrough(prev, v.through, v);
                    if (arc) {
                        ctx.arc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.endAngle, !arc.ccw);
                    } else {
                        ctx.lineTo(v.x, v.y);
                    }
                } else {
                    ctx.lineTo(v.x, v.y);
                }
            }
            if (isClosed && !contour[0].through)
                ctx.closePath();
            if (strokeColor !== 'none' && lineWidth > 0)
                ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
    }

    drawVertexHandles(kernel) {
        const ctx = this.ctx;
        const cam = this._cam;
        const dpr = window.devicePixelRatio || 1;
        const r = 6 / cam.zoom * dpr; // 6 logical pixels
        ctx.fillStyle = COLORS.selVertex;
        for (let i = 0, end = kernel.selectedVertexCount(); i < end; i++) {
            const sv = kernel.selectedVertices[i];
            ctx.beginPath();
            ctx.arc(sv.x, sv.y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        // Through-point handle for selected arc segments
        if (kernel.isArcSelected()) {
            const tp = kernel.selectedVertices[1].through;
            if (tp) {
                ctx.fillStyle = COLORS.throughVertex;
                ctx.beginPath();
                ctx.arc(tp.x, tp.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    /** Draw rubberband selection rectangle.
     *  leftToRight=true → window selection (solid border, blue fill)
     *  leftToRight=false → crossing selection (dashed border, green fill) */
    drawSelectionRect(p1, p2, leftToRight) {
        if (!p1 || !p2) return;
        const ctx = this.ctx;
        const cam = this._cam;
        const px = 1 / cam.zoom;
        const minX = Math.min(p1.x, p2.x);
        const minY = Math.min(p1.y, p2.y);
        const w = Math.abs(p2.x - p1.x);
        const h = Math.abs(p2.y - p1.y);
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        if (leftToRight) {
            ctx.strokeStyle = '#0066ff';
            ctx.fillStyle = 'rgba(0, 100, 255, 0.08)';
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = '#00cc44';
            ctx.fillStyle = 'rgba(0, 200, 80, 0.08)';
            ctx.setLineDash([px * 6 * dpr, px * 6 * dpr]);
        }
        ctx.lineWidth = px * dpr;
        ctx.fillRect(minX, minY, w, h);
        ctx.strokeRect(minX, minY, w, h);
        ctx.setLineDash([]);
        ctx.restore();
    }

    drawRubberBand(pts, closed = false) {
        if (!pts || pts.length < 1) return;
        const ctx = this.ctx;
        const cam = this._cam;
        const px = 1 / cam.zoom;
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.strokeStyle = COLORS.rubberBand;
        ctx.lineWidth = 3*px * dpr;
        ctx.setLineDash([px * 6 * dpr, px * 6 * dpr]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            const v = pts[i];
            if (v.through) {
                const prev = pts[i - 1];
                const arc = arcFromThrough(prev, v.through, v);
                if (arc) {
                    ctx.arc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.endAngle, !arc.ccw);
                } else {
                    ctx.lineTo(v.x, v.y);
                }
            } else {
                ctx.lineTo(v.x, v.y);
            }
        }
        if (closed && pts.length > 2) {
            const v0 = pts[0];
            if (v0.through) {
                const prev = pts[pts.length - 1];
                const arc = arcFromThrough(prev, v0.through, v0);
                if (arc) {
                    ctx.arc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.endAngle, !arc.ccw);
                } else {
                    ctx.closePath();
                }
            } else {
                ctx.closePath();
            }
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    drawCrosshair(pt) {
        if (!pt) return;
        const ctx = this.ctx;
        const cam = this._cam;
        const dpr = window.devicePixelRatio || 1;
        const outerSz = 24 / cam.zoom * dpr;
        const innerSz = 6 / cam.zoom * dpr;
        ctx.strokeStyle = COLORS.entitySelected;
        ctx.lineWidth = 1 / cam.zoom * dpr;
        ctx.beginPath();
        ctx.moveTo(pt.x - outerSz, pt.y); ctx.lineTo(pt.x - innerSz, pt.y);
        ctx.moveTo(pt.x + innerSz, pt.y); ctx.lineTo(pt.x + outerSz, pt.y);
        ctx.moveTo(pt.x, pt.y - outerSz); ctx.lineTo(pt.x, pt.y - innerSz);
        ctx.moveTo(pt.x, pt.y + innerSz); ctx.lineTo(pt.x, pt.y + outerSz);
        ctx.stroke();
    }

    drawTextEntity(entity, selected=false, blockInstanceStyle=null) {
        const ctx = this.ctx;
        const cam = this._cam;
        const kernel = this._kernel;

        const style = kernel.resolveStyle(entity, blockInstanceStyle);

        // Text size is always in mm. Render at export proportion:
        // sizeWorld (model units) = textSize(mm) / viewport.scale(mm/unit)
        // Divide by CAP_HEIGHT_RATIO so textSize defines cap height (height of 'M'), not em size.
        const sizeWorld = entity.textSize / kernel.viewport.scale / CAP_HEIGHT_RATIO;

        const fontStr = `${style.fontStyle} ${style.fontWeight} ${sizeWorld.toFixed(4)}px ${style.fontFamily}`;
        const fillColor = (entity.state === STATE_SELECTED || selected) ? COLORS.entitySelected
            : (style.fill && style.fill !== 'transparent' && style.fill !== 'none'
                ? style.fill : COLORS.entityNormal);

        const canvasAlign = { left: 'left', center: 'center', right: 'right' };
        const canvasBaseline = { top: 'hanging', middle: 'middle', bottom: 'alphabetic' };

        ctx.save();
        ctx.translate(entity.x, entity.y);
        ctx.scale(1, -1);
        if (entity.rot) ctx.rotate(-entity.rot * Math.PI / 180);
        ctx.font = fontStr;
        ctx.textAlign = canvasAlign[entity.textAlign] || 'left';
        ctx.textBaseline = canvasBaseline[entity.verticalAlign] || 'alphabetic';
        ctx.fillStyle = fillColor;
        if (style.fillOpacity !== undefined && style.fillOpacity !== 1)
            ctx.globalAlpha = style.fillOpacity;
        ctx.fillText(entity.text, 0, 0);
        ctx.restore();

        // Draw center handle if selected
        if (entity.state === STATE_SELECTED) {
            const dpr = window.devicePixelRatio || 1;
            const r = 8 / cam.zoom * dpr; // 8 logical pixels
            ctx.fillStyle = COLORS.selVertex;
            ctx.beginPath();
            ctx.arc(entity.x, entity.y, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    drawDynEntity(entity, selected=false, blockInstanceStyle=null) {
        selected = selected || entity.state === STATE_SELECTED;
        entity.entities.forEach(ent => this.drawEntity(ent, selected, blockInstanceStyle));
    }

    drawBlock(blockEntity, selected=false) {
        const def = blockEntity.blockDef;
        if (!def) return;
        const ctx = this.ctx;
        const cam = this._cam;
        const kernel = this._kernel;
        const isSelected = selected || blockEntity.state === STATE_SELECTED;
        const { tx, ty, xx, xy, yx, yy } = blockEntity.transform;

        ctx.save();
        // Apply block-local → world transform using the full 2×2 matrix (supports mirroring).
        ctx.translate(tx, ty);
        ctx.transform(xx, xy, yx, yy, 0, 0);
        if (def.imageEl) {
            // Image block: draw image with Y flipped (canvas Y-down vs world Y-up)
            const style = kernel.resolveStyle(blockEntity);
            if (style.fillOpacity !== undefined && style.fillOpacity < 1)
                ctx.globalAlpha = style.fillOpacity;
            ctx.scale(1, -1);
            ctx.drawImage(def.imageEl, 0, -def.imageH, def.imageW, def.imageH);
        } else {
            const blockScale = Math.sqrt(xx * xx + xy * xy);
            const prevBlockScale = this._blockScale;
            this._blockScale = prevBlockScale * blockScale;
            // A child with no styleClass of its own inherits this instance's resolved
            // style instead of falling back to its own layer (see Kernel.resolveStyle).
            const instanceStyle = blockEntity.styleClass ? kernel.resolveStyle(blockEntity) : null;
            for (const ent of def.entities) {
                this.drawEntity(ent, isSelected, instanceStyle);
            }
            this._blockScale = prevBlockScale;
        }
        ctx.restore();

        // Draw bounding box and control vertex handles when selected
        if (isSelected) {
            const bb = blockEntity.bbox;
            if (bb) {
                const dpr = window.devicePixelRatio || 1;
                ctx.save();
                ctx.strokeStyle = COLORS.entitySelected;
                ctx.lineWidth = 1 / cam.zoom * dpr;
                ctx.setLineDash([4 / cam.zoom * dpr, 4 / cam.zoom * dpr]);
                ctx.strokeRect(bb.minX, bb.minY, bb.maxX - bb.minX, bb.maxY - bb.minY);
                ctx.setLineDash([]);
                ctx.restore();
            }
            const r = 6 / cam.zoom * (window.devicePixelRatio || 1);
            ctx.fillStyle = COLORS.selVertex;
            for (const v of blockEntity.contours[0]) {
                ctx.beginPath();
                ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
                ctx.fill();
                /*if(v.through) {
                    ctx.fillStyle = COLORS.throughVertex;
                    ctx.beginPath();
                    ctx.arc(v.through.x, v.through.y, r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = COLORS.selVertex;
                }*/
            }
        }
    }

    /**
     * Draw guide lines and circles (segment extensions for single-vertex selection).
     * @param {Array} guides  [{type:'line', pt, dir} | {type:'circle', center, radius}]
     */
    drawGuides(guides) {
        if (!guides || guides.length === 0) return;
        const ctx = this.ctx;
        const cam = this._cam;
        const px = 1 / cam.zoom;
        const dpr = window.devicePixelRatio || 1;

        // Viewport AABB in world coords for line clipping
        const tl = screenToWorld(0, 0, cam, this.W, this.H);
        const br = screenToWorld(this.W, this.H, cam, this.W, this.H);
        const xMin = Math.min(tl.x, br.x), xMax = Math.max(tl.x, br.x);
        const yMin = Math.min(tl.y, br.y), yMax = Math.max(tl.y, br.y);

        ctx.save();
        ctx.strokeStyle = COLORS.guide;
        ctx.lineWidth = px * dpr;
        ctx.setLineDash([px * 5 * dpr, px * 5 * dpr]);

        for (const g of guides) {
            if (g.type === 'line') {
                const { pt, dir } = g;
                // Clip infinite line to viewport AABB via slab method
                let tMin = -Infinity, tMax = Infinity;
                if (Math.abs(dir.x) > 1e-10) {
                    const t0 = (xMin - pt.x) / dir.x, t1 = (xMax - pt.x) / dir.x;
                    tMin = Math.max(tMin, Math.min(t0, t1));
                    tMax = Math.min(tMax, Math.max(t0, t1));
                } else if (pt.x < xMin || pt.x > xMax) {
                    continue;
                }
                if (Math.abs(dir.y) > 1e-10) {
                    const t0 = (yMin - pt.y) / dir.y, t1 = (yMax - pt.y) / dir.y;
                    tMin = Math.max(tMin, Math.min(t0, t1));
                    tMax = Math.min(tMax, Math.max(t0, t1));
                } else if (pt.y < yMin || pt.y > yMax) {
                    continue;
                }
                if (tMin >= tMax) continue;
                ctx.beginPath();
                ctx.moveTo(pt.x + tMin * dir.x, pt.y + tMin * dir.y);
                ctx.lineTo(pt.x + tMax * dir.x, pt.y + tMax * dir.y);
                ctx.stroke();
            } else if (g.type === 'circle') {
                const { center, radius } = g;
                ctx.beginPath();
                ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.setLineDash([]);
        ctx.restore();
    }

    /** Full frame render */
    render(cam, grid, kernel, interp, cursorWorld) {
        this._cam = cam;
        this._kernel = kernel;
        this.resize();
        this.clear();
        this.setCamera(cam);

        // draw kernel.paperBounds as filled white rectangle
        if (kernel.paperBounds) {
            const ctx = this.ctx;
            const bb = kernel.paperBounds;
            ctx.fillStyle = '#fff';
            ctx.fillRect(bb.minX, bb.minY, bb.maxX - bb.minX, bb.maxY - bb.minY);
        }
        grid.draw(this.ctx, cam, this.W, this.H);

        // draw all entities on visible layers, in ascending z order
        const sortedEnts = [...kernel.entities]
            .filter(e => kernel.layerProps(e.layer ?? '0').visible)
            .sort((a, b) => {
                const az = (kernel.layers.get(a.layer ?? '0') ?? { z: Infinity }).z;
                const bz = (kernel.layers.get(b.layer ?? '0') ?? { z: Infinity }).z;
                return az - bz;
            });
        for (const ent of sortedEnts) {
            this.drawEntity(ent);
        }

        grid.drawOverlay(this.ctx, cam, this.W, this.H);
        // guide lines for single-vertex selection in geom snap mode
        this.drawGuides(grid.guides);
        // rubber band from active command
        if (interp && interp.active && interp.active.rubberBandPts) {
            this.drawRubberBand(interp.active.rubberBandPts(), interp.active.rubberBandClosed);
        }
        // preview entity from active command (e.g. CmdInsertBlock)
        if (interp && interp.active && interp.active.previewEntity) {
            this.drawEntity(interp.active.previewEntity, false);
        }
        // selected vertex handles
        this.drawVertexHandles(kernel);

        // crosshair at snapped cursor. Mouse/pen get continuous hover feedback for free
        // (cursor === 'crosshair'); touch has no hover, so while a command is actively
        // awaiting more input, show the crosshair at the last tapped point instead.
        const cmdAwaitingInput = interp && interp.active && interp.active !== interp._defaultCmd;
        if (this.canvas.style.cursor === 'crosshair' || (this.canvas.style.cursor === 'none' && cmdAwaitingInput))
            this.drawCrosshair(cursorWorld);
    }
}
