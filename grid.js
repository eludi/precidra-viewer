// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// grid.js — work plane grid with snap & UCS, matching C++ glGrid

import { Vtx, snapValue } from './math.js';

/**
 * Named tiling patterns for common drawing disciplines.
 * Each entry defines a pattern that tiles logarithmically across all zoom levels:
 *   step values = pattern[i] × decade^k  for any integer k
 * pattern values must satisfy pattern[0] > 0 and pattern[last] < pattern[0] × decade.
 */
export const TILING_PRESETS = {
    'engineering':   { pattern: [1, 2, 5],         decade: 10 }, // …0.1 0.2 0.5 1 2 5 10 20 50…
    'architectural': { pattern: [1, 1.25, 2.5, 5], decade: 10 }, // …0.1 0.125 0.25 0.5 1 1.25 2.5 5 10…
    'binary':        { pattern: [1],               decade: 2  }, // …0.25 0.5 1 2 4 8 16…
};

export class Grid {
    constructor(gripProvider) {
        this.pos = { x: 0, y: 0, heading: 0 }; // heading in degrees
        this.res = [1.0, 0.5]; // [primary line spacing, snap/secondary spacing]
        this.dynRes = [1.0, 0.5, 64*window.devicePixelRatio]; // dynamic spacing values and reference (adjusted by zoom level)
        this._stepMode = { mode: 'uniform', unit: 1, factor: 2 };
        this.displayPrecision = 3; // decimal places for coordinate display (not for geometric calculations)
        this.snapEnabled = true;
        this.geomSnapMode = false;    // true = geometry snap, false = grid snap
        this.geomSnapPoints = [];
        this.showGuides = true;       // show segment-extension guides in geom snap mode
        this.guides = [];             // active guide descriptors [{type:'line',...}|{type:'circle',...}]
        this.guideSnapPoints = [];    // intersection snap points derived from guides (frozen during move)
        this._baseGuideSnapPoints = []; // guideSnapPoints before viewport-exit augmentation
        this.gripProvider = gripProvider;

        this.colors = {
            primary: '#aabbcc',
            xAxis: '#cc4444',
            yAxis: '#229922',
            secondary: '#aabbcc',
            snaps: '#aabbcc7f'
        }
    }

    /** Set position + heading */
    setPosition(x, y, heading = 0) {
        this.pos.x = x;
        this.pos.y = y;
        this.pos.heading = heading;
    }

    /** Set resolution: primary, optional secondary (backward-compatible wrapper for setStepMode) */
    setResolution(primary, secondary = 0) {
        const sec = (secondary > 0 && secondary < primary) ? secondary : null;
        const factor = sec ? Math.max(2, Math.round(primary / sec)) : 2;
        this.setStepMode({ mode: 'uniform', unit: primary, factor });
    }

    /**
     * Set the step mode configuration.
     * Accepted shapes:
     *   { mode:'uniform',  unit, factor }          – reference step + integer multiplier
     *   { mode:'tiling',   pattern:[…], decade }   – pattern tiles logarithmically at all scales
     *   { mode:'sequence', steps:[…] }             – finite list with hard endpoints
     */
    setStepMode(config) {
        const mode = config.mode ?? 'uniform';
        if (mode === 'uniform') {
            const unit   = (typeof config.unit   === 'number' && config.unit   > 0)  ? config.unit   : 1;
            const factor = (Number.isInteger(config.factor)   && config.factor >= 2) ? config.factor : 2;
            this._stepMode = { mode: 'uniform', unit, factor };
            this.res[0] = unit;
            this.res[1] = unit / factor;
        } else if (mode === 'tiling') {
            const pattern = Array.isArray(config.pattern)
                ? config.pattern.filter(p => typeof p === 'number' && p > 0).sort((a, b) => a - b)
                : [1];
            if (pattern.length === 0) throw new Error('pattern must contain at least one positive number');
            const decade = (typeof config.decade === 'number' && config.decade > 1) ? config.decade : 10;
            if (pattern[pattern.length - 1] >= pattern[0] * decade)
                throw new Error('pattern[last] must be less than pattern[0] × decade');
            this._stepMode = { mode: 'tiling', pattern, decade };
            this.res[0] = pattern[pattern.length - 1];
            this.res[1] = pattern.length > 1 ? pattern[pattern.length - 2] : pattern[0] / 2;
        } else if (mode === 'sequence') {
            const steps = Array.isArray(config.steps)
                ? config.steps.filter(s => typeof s === 'number' && s > 0).sort((a, b) => a - b)
                : [1];
            if (steps.length === 0) throw new Error('steps must contain at least one positive number');
            this._stepMode = { mode: 'sequence', steps };
            this.res[0] = steps[steps.length - 1];
            this.res[1] = steps.length > 1 ? steps[steps.length - 2] : steps[0] / 2;
        } else {
            throw new Error(`Unknown step mode: "${mode}"`);
        }
    }

    /** Return a serializable copy of the current step mode configuration. */
    getStepMode() {
        const sm = this._stepMode;
        if (sm.mode === 'uniform')  return { mode: 'uniform',  unit: sm.unit, factor: sm.factor };
        if (sm.mode === 'tiling')   return { mode: 'tiling',   pattern: [...sm.pattern], decade: sm.decade };
        return { mode: 'sequence', steps: [...sm.steps] };
    }

    /**
     * Compute and store in dynRes the primary and secondary step sizes for the given zoom.
     * dynRes[0] = primary grid line spacing, dynRes[1] = secondary (snap) spacing.
     */
    _computeDynRes(zoom) {
        const threshold = this.dynRes[2]; // min screen pixels per primary step
        const sm = this._stepMode;
        let res0, res1;
        if (sm.mode === 'uniform') {
            const u = sm.unit, f = sm.factor;
            res0 = u;
            while (res0 * zoom < threshold) res0 *= f;
            res1 = res0 / f;
            while (res1 * zoom > threshold && res1 > 1e-15) res1 /= f;
        } else if (sm.mode === 'tiling') {
            // Find the decade power k such that pattern[last] × decade^k is the first
            // scale where any pattern value meets threshold, then pick the entry.
            const { pattern, decade } = sm;
            const logDecade = Math.log(decade);
            const minStep = threshold / zoom;
            const k = Math.ceil(Math.log(minStep / pattern[pattern.length - 1]) / logDecade);
            let scale = Math.pow(decade, k);
            let pi = pattern.findIndex(p => p * scale >= minStep);
            if (pi < 0) { scale *= decade; pi = 0; } // floating-point guard
            res0 = pattern[pi] * scale;
            res1 = pi > 0 ? pattern[pi - 1] * scale : pattern[pattern.length - 1] * (scale / decade);
            while (res1 * zoom > threshold && res1 > 1e-15) res1 /= 2;
        } else { // sequence: finite list with hard endpoints
            const steps = sm.steps;
            let pi = steps.findIndex(s => s * zoom >= threshold);
            if (pi < 0) pi = steps.length - 1;
            res0 = steps[pi];
            res1 = pi > 0 ? steps[pi - 1] : steps[0] / 2;
            while (res1 * zoom > threshold && res1 > 1e-15) res1 /= 2;
        }
        this.dynRes[0] = res0;
        this.dynRes[1] = res1;
    }

    /** Snap a Vtx to grid resolution */
    snap(v) {
        if (!this.snapEnabled)
            return v.clone();
        const res1 = this.dynRes ? this.dynRes[1] : this.res[1];
        const res0 = this.dynRes ? this.dynRes[0] : this.res[0];
        // When primary step isn't an integer multiple of secondary (tiling/sequence modes),
        // also offer primary grid lines as snap candidates so they are always reachable.
        const snapBest = (coord) => {
            const s1 = snapValue(coord, res1);
            if (res0 <= res1 * 1.0001) return s1; // primary aligns with secondary — no extra candidate needed
            const s0 = snapValue(coord, res0);
            return Math.abs(coord - s0) < Math.abs(coord - s1) ? s0 : s1;
        };
        return new Vtx(snapBest(v.x), snapBest(v.y));
    }

    /** World→local: inverse UCS rotation around pos */
    toLocal(worldPt) {
        const h = -this.pos.heading * Math.PI / 180;
        const ch = Math.cos(h), sh = Math.sin(h);
        const dx = worldPt.x - this.pos.x;
        const dy = worldPt.y - this.pos.y;
        return new Vtx(
            dx * ch - dy * sh,
            dx * sh + dy * ch
        );
    }

    /** Returns true when the world-space displacement (dx, dy) meets or exceeds
     *  the minor grid spacing — the same threshold used for snapping and drawing. */
    isMinorMove(dx, dy) {
        const minor = this.dynRes ? this.dynRes[1] : this.res[1];
        return (dx * dx + dy * dy) >= minor * minor;
    }

    /** Local→world: snap (if enabled) then UCS rotation + translate.
     *  In geom snap mode, returns the nearest stored world-space snap point.
     *  Geom snap is also gated on snapEnabled so callers can bypass it with
     *  snapEnabled=false (e.g. when computing derived rectangle corners). */
    toGlobal(localPt) {
        const h = this.pos.heading * Math.PI / 180;
        const ch = Math.cos(h), sh = Math.sin(h);
        const wx = localPt.x * ch - localPt.y * sh + this.pos.x;
        const wy = localPt.x * sh + localPt.y * ch + this.pos.y;

        if (this.geomSnapMode && this.snapEnabled && this.geomSnapPoints.length > 0) {
            // Convert localPt to world space so we can compare with world-space snap points
            let best = null, bestD2 = Infinity;
            for (const p of this.geomSnapPoints) {
                const d2 = (p.x - wx) ** 2 + (p.y - wy) ** 2;
                if (d2 < bestD2) { bestD2 = d2; best = p; }
            }
            return best.clone();
        }
        let p = this.snapEnabled ? this.snap(localPt) : localPt.clone();
    
        const rx = p.x * ch - p.y * sh;
        const ry = p.x * sh + p.y * ch;
        const gridSnap = new Vtx(rx + this.pos.x, ry + this.pos.y);

        let best = gridSnap, bestDistSqr = (gridSnap.x - wx) ** 2 + (gridSnap.y - wy) ** 2;
        for(const grip of this.gripProvider()) {
            const distSqr = (grip.x - wx) ** 2 + (grip.y - wy) ** 2;
            if(distSqr < bestDistSqr) {
                bestDistSqr = distSqr;
                best = grip;
            }
        }
        return best.clone();
    }

    guidesClear() {
        this.guides = [];
        this.guideSnapPoints = [];
        this._baseGuideSnapPoints = [];
    }
    guidesAppendOrUpdateCircle(center, radius) {
        if(this.guides.length > 0) { // remove prior pending-distance guide if any
            const lastGuide = this.guides[this.guides.length - 1];
            if (lastGuide.type === 'circle' && lastGuide.center.equals(center)) {
                lastGuide.radius = radius;
                return;
            }
        }
        this.guides.push({ type: 'circle', center, radius });
    }

    /** Draw grid on a Canvas2D context in world coordinates.
     *  Assumes ctx already has world-space transform applied (Renderer.setCamera).
     *  In geom snap mode draws snap points instead of the grid. */
    draw(ctx, cam, vpW, vpH) {
        // pixel size in world coords (for consistent line widths and dynamic grid spacing)
        const px = 1 / cam.zoom;
        if (this.dynRes) this._computeDynRes(cam.zoom);
        const res0 = this.dynRes ? this.dynRes[0] : this.res[0];
        if (this.geomSnapMode && this.geomSnapPoints.length > 0) // draw only snaps in overlay
            return;

        ctx.save();
        // apply UCS transform
        ctx.translate(this.pos.x, this.pos.y);
        ctx.rotate(this.pos.heading * Math.PI / 180);

        // Compute the bounding box of the viewport corners in local grid space
        const hw = vpW * 0.5 / cam.zoom;
        const hh = vpH * 0.5 / cam.zoom;
        const angle = -this.pos.heading * Math.PI / 180;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (const [wx, wy] of [
            [cam.x - hw, cam.y - hh], [cam.x + hw, cam.y - hh],
            [cam.x - hw, cam.y + hh], [cam.x + hw, cam.y + hh],
        ]) {
            const dx = wx - this.pos.x, dy = wy - this.pos.y;
            const lx = dx * ca - dy * sa;
            const ly = dx * sa + dy * ca;
            if (lx < xMin) xMin = lx; if (lx > xMax) xMax = lx;
            if (ly < yMin) yMin = ly; if (ly > yMax) yMax = ly;
        }

        // primary grid lines
        const i0 = Math.floor(xMin / res0);
        const i1 = Math.ceil(xMax / res0);
        const j0 = Math.floor(yMin / res0);
        const j1 = Math.ceil(yMax / res0);

        ctx.lineWidth = px;
        for (let i = i0; i <= i1; i++) {
            ctx.strokeStyle = i === 0 ? this.colors.yAxis : this.colors.primary;
            ctx.beginPath();
            ctx.moveTo(i * res0, yMin);
            ctx.lineTo(i * res0, yMax);
            ctx.stroke();
        }
        for (let j = j0; j <= j1; j++) {
            ctx.strokeStyle = j === 0 ? this.colors.xAxis : this.colors.primary;
            ctx.beginPath();
            ctx.moveTo(xMin, j * res0);
            ctx.lineTo(xMax, j * res0);
            ctx.stroke();
        }
        ctx.restore();
    }

    /**  In geom snap mode draws snap points instead of the grid. */
    drawOverlay(ctx, cam, vpW, vpH) {
        const px = 1 / cam.zoom; // pixel size in world coords
        const dpr = window.devicePixelRatio || 1;
        if (this.geomSnapMode && this.geomSnapPoints.length > 0) {
            // Draw snap points instead of grid (world-space ctx, no UCS transform needed)
            const size = 16 * px * dpr;
            const half = size / 2;
            ctx.fillStyle = ctx.strokeStyle = this.colors.snaps;
            ctx.lineWidth = px;
            for (const p of this.geomSnapPoints) {
                ctx.fillRect(p.x - half, p.y - half, size, size);
            }
        }
        else { //d raw secondary grid points
            ctx.save();
            // apply UCS transform
            ctx.translate(this.pos.x, this.pos.y);
            ctx.rotate(this.pos.heading * Math.PI / 180);

            // Compute the bounding box of the viewport corners in local grid space
            const hw = vpW * 0.5 / cam.zoom;
            const hh = vpH * 0.5 / cam.zoom;
            const angle = -this.pos.heading * Math.PI / 180;
            const ca = Math.cos(angle), sa = Math.sin(angle);
            let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
            for (const [wx, wy] of [
                [cam.x - hw, cam.y - hh], [cam.x + hw, cam.y - hh],
                [cam.x - hw, cam.y + hh], [cam.x + hw, cam.y + hh],
            ]) {
                const dx = wx - this.pos.x, dy = wy - this.pos.y;
                const lx = dx * ca - dy * sa;
                const ly = dx * sa + dy * ca;
                if (lx < xMin) xMin = lx; if (lx > xMax) xMax = lx;
                if (ly < yMin) yMin = ly; if (ly > yMax) yMax = ly;
            }

            // secondary dot grid
            const res1 = this.dynRes[1];
            const si0 = Math.floor(xMin / res1);
            const si1 = Math.ceil(xMax / res1);
            const sj0 = Math.floor(yMin / res1);
            const sj1 = Math.ceil(yMax / res1);
            const dotL = px * 8.0 * dpr, dotW = px * 1.0 * dpr;
            ctx.fillStyle = this.colors.secondary;
            for (let i = si0; i <= si1; i++) {
                for (let j = sj0; j <= sj1; j++) {
                    ctx.fillRect(i * res1 - dotL * 0.5, j * res1 - dotW * 0.5, dotL, dotW);
                    ctx.fillRect(i * res1 - dotW * 0.5, j * res1 - dotL * 0.5, dotW, dotL);
                }
            }
            ctx.restore();
        }
    }

}
