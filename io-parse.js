// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// io-parse.js — parse Precidra (.prec) XML into Kernel-loadable data, plus file I/O helpers.
//
// This module is deliberately parse-only (no serialization, no DXF/SVG/PDF/PNG
// export or import, no IndexedDB autosave) so it can be shared, verbatim, by both
// this app's own io.js (which imports and re-exports everything here) and
// Precidra Viewer (github.com/eludi/precidra-viewer), which copies this file as-is.
// Mirrors the boolean-ops.js split in model.js, but in the opposite direction: that
// file must NEVER reach the viewer, this one is specifically meant to.
// Keep this file free of anything export/serialize/autosave-related — that all
// belongs in io.js instead.

import { Vtx, computeBoundsAndRadius } from './math.js';
import { DEFAULT_STYLE, DEFAULT_VIEWPORT, Entity, TextEntity, ParamEntity, Kernel } from './model.js';

// Ratio of cap height to em size (approximation valid for common fonts)
export const CAP_HEIGHT_RATIO = 0.72;

function parseContour(text, contours) {
    if (!text)
        return;
    const _c = v => Number.isFinite(v) ? v : 0;
    const verts = text.split(',').map(tok => {
        tok = tok.trim();
        if (tok.includes(':')) {
            // arc vertex: "x y : tx ty"
            const [vtxPart, throughPart] = tok.split(':').map(s => s.trim());
            const vp = vtxPart.split(/\s+/).map(Number);
            const tp = throughPart.split(/\s+/).map(Number);
            const v = new Vtx(_c(vp[0]), _c(vp[1]));
            v.setArc(new Vtx(_c(tp[0]), _c(tp[1])));
            return v;
        }
        const parts = tok.split(/\s+/).map(Number);
        return new Vtx(_c(parts[0]), _c(parts[1]));
    });
    if (verts.length) contours.push(verts);
}

/** Parse a precidra XML string → array of entity data objects.
 *  Each has { id, layer, contours: Array<Array<Vtx>>, open, styleClass } */
export function parsePrecidra(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');
    const root = doc.documentElement;
    if (!root || (root.tagName !== 'precidra' && root.tagName !== 'viremo')) {
        throw new Error('Not a Precidra file');
    }
    const version = root.getAttribute('version') || Kernel.version;
    const changedAt = root.getAttribute('changed') || null;

    // Parse stylesheet from first <style> child of root
    let stylesheet = new Map();
    const styleEl = root.querySelector('style');
    if (styleEl && styleEl.textContent.trim()) {
        stylesheet = parseStylesheet(styleEl.textContent);
    }

    // --- Parse block definitions before entities ---
    const blockDefs = new Map();
    for (const bdEl of root.querySelectorAll(':scope > blockdef')) {
        const def = _parseBlockDef(bdEl, stylesheet);
        if (def) blockDefs.set(def.name, def);
    }

    const entities = [];

    // Parse all entity types in document order to preserve z-ordering
    for (const ent of root.children) {
        const tag = ent.tagName;
        if (tag === 'entity') {
            const id = parseInt(ent.getAttribute('id') || '0', 10);
            const open = ent.getAttribute('open')==='true';
            const styleClass = ent.getAttribute('class') || '';
            const contours = [];
            for (const ctEl of ent.querySelectorAll('contour'))
                parseContour(ctEl.textContent.trim(), contours);
            const layer = ent.getAttribute('layer') || '0';
            entities.push({ id, layer, contours, open, styleClass });
        } else if (tag === 'text') {
            const id = parseInt(ent.getAttribute('id') || '0', 10);
            const e = { type: 'text', id };
            e.styleClass = ent.getAttribute('class') || '';
            e.layer = ent.getAttribute('layer') || '0';
            e.text = ent.textContent || '';
            e.x = parseFloat(ent.getAttribute('x') || '0');
            e.y = parseFloat(ent.getAttribute('y') || '0');
            e.rot = parseFloat(ent.getAttribute('rot') || '0');
            const align = (ent.getAttribute('align') || 'left bottom').split(/\s+/);
            e.textAlign = align[0] || 'left';
            e.verticalAlign = align[1] || 'bottom';
            e.textSize = parseFloat(ent.getAttribute('size') || '3.5');
            entities.push(e);
        } else if (tag === 'param' || tag === 'dyn') {
            const type = ent.getAttribute('type');
            const id = parseInt(ent.getAttribute('id') || '0', 10);
            const open = ent.getAttribute('open')==='true';
            const styleClass = ent.getAttribute('class') || '';
            const contours = [];
            for (const ctEl of ent.querySelectorAll('contour'))
                parseContour(ctEl.textContent.trim(), contours);
            const props = {};
            const propsEl = ent.querySelector('props');
            if (propsEl) {
                for (const attr of propsEl.attributes)
                    props[attr.name] = attr.value;
            }
            const layer = ent.getAttribute('layer') || '0';
            entities.push({ type, id, layer, contours, open, styleClass, props });
        } else if (tag === 'block') {
            const id = parseInt(ent.getAttribute('id') || '0', 10);
            const blockName = ent.getAttribute('src') || '';
            const styleClass = ent.getAttribute('class') || '';
            const layer = ent.getAttribute('layer') || '0';
            const contours = [];
            for (const ctEl of ent.querySelectorAll('contour'))
                parseContour(ctEl.textContent.trim(), contours);
            entities.push({ type: 'block', id, layer, blockName, contours, styleClass });
        }
    }

    // Parse viewport
    let viewport = null;
    const vpEl = root.querySelector(':scope > viewport');
    if (vpEl) {
        viewport = {
            cx:             parseFloat(vpEl.getAttribute('cx')             ?? DEFAULT_VIEWPORT.cx),
            cy:             parseFloat(vpEl.getAttribute('cy')             ?? DEFAULT_VIEWPORT.cy),
            scale:          parseFloat(vpEl.getAttribute('scale')          ?? DEFAULT_VIEWPORT.scale),
            paperW:         parseFloat(vpEl.getAttribute('paperW')         ?? DEFAULT_VIEWPORT.paperW),
            paperH:         parseFloat(vpEl.getAttribute('paperH')         ?? DEFAULT_VIEWPORT.paperH),
            rasterDpi:      parseFloat(vpEl.getAttribute('rasterDpi') ?? vpEl.getAttribute('exportDpi') ?? DEFAULT_VIEWPORT.rasterDpi),
            tileExport: {
                enabled:        vpEl.getAttribute('tileEnabled')  === 'true',
                format:         vpEl.getAttribute('tileFormat')   ?? DEFAULT_VIEWPORT.tileExport.format,
                margin:         parseFloat(vpEl.getAttribute('tileMgn') ?? DEFAULT_VIEWPORT.tileExport.margin),
                showBoundaries: vpEl.getAttribute('tileBoundaries') === 'true',
            },
        };
    }

    const layerData = parseLayers(root);

    // Parse optional grid settings
    const gridData = _parseGridSettings(root);

    return { version, entities, stylesheet, viewport, layers: layerData ?? null, blockDefs, grid: gridData, changedAt };
}

/**
 * Parse a <blockdef> element and return its block definition object.
 * Style classes are resolved against the provided stylesheet and stored as
 * _resolvedStyle on each entity so block rendering is independent of the host stylesheet.
 * Returns the block def object, or null if the element is invalid.
 */
function _parseBlockDef(bdEl, stylesheet) {
    const name = bdEl.getAttribute('name');
    if (!name) { console.warn('blockdef element missing name attribute, skipping.'); return null; }

    // Image block definition
    if (bdEl.getAttribute('type') === 'image') {
        const w = parseFloat(bdEl.getAttribute('w') || '10');
        const h = parseFloat(bdEl.getAttribute('h') || '10');
        const dataEl = bdEl.querySelector('data');
        const dataUrl = dataEl ? dataEl.textContent.trim() : '';
        const bbox = { minX: 0, minY: 0, maxX: w, maxY: h };
        const radius = w; // imageW: so scale = dist/imageW and radiusPt lands on the lower-right bbox corner
        const img = new Image();
        img.src = dataUrl;
        return {
            name, entities: [], bbox, radius, rawNestedXml: '',
            imageData: dataUrl, imageW: w, imageH: h, imageEl: img,
        };
    }

    // Warn about and collect raw XML of any nested blockdefs / block instances
    let rawNestedXml = '';
    for (const child of bdEl.children) {
        if (child.tagName === 'blockdef' || child.tagName === 'block') {
            console.warn(`Nested block content inside blockdef "${name}" is not yet supported and will be preserved as-is.`);
            rawNestedXml += child.outerHTML + '\n';
        }
    }

    // Parse the entities contained in the blockdef
    const blockEntities = [];

    for (const ent of bdEl.querySelectorAll(':scope > entity')) {
        const open = ent.getAttribute('open') === 'true';
        const styleClass = ent.getAttribute('class') || '';
        const layer = ent.getAttribute('layer') || '0';
        const contours = [];
        for (const ctEl of ent.querySelectorAll('contour'))
            parseContour(ctEl.textContent.trim(), contours);
        const e = new Entity(layer);
        e.contours = contours;
        e.closeContour(!open);
        e.applyStyle(styleClass);
        // Baking freezes the entity's appearance against the stylesheet at load time —
        // only meaningful when there's an actual class to resolve. A styleless child must
        // stay dynamic so it keeps falling back to its own layer, or to the enclosing
        // BlockEntity instance's style when drawn as part of a block (see Kernel.resolveStyle).
        if (styleClass) e._resolvedStyle = _resolveStyleWith(e, stylesheet);
        blockEntities.push(e);
    }

    for (const ent of bdEl.querySelectorAll(':scope > text')) {
        const styleClass = ent.getAttribute('class') || '';
        const layer = ent.getAttribute('layer') || '0';
        const te = new TextEntity(layer);
        te.text = ent.textContent || '';
        te.x = parseFloat(ent.getAttribute('x') || '0');
        te.y = parseFloat(ent.getAttribute('y') || '0');
        te.rot = parseFloat(ent.getAttribute('rot') || '0');
        const align = (ent.getAttribute('align') || 'left bottom').split(/\s+/);
        te.textAlign = align[0] || 'left';
        te.verticalAlign = align[1] || 'bottom';
        te.textSize = parseFloat(ent.getAttribute('size') || '3.5');
        te.applyStyle(styleClass);
        if (styleClass) te._resolvedStyle = _resolveStyleWith(te, stylesheet);
        blockEntities.push(te);
    }

    for (const ent of bdEl.querySelectorAll(':scope > param, :scope > dyn')) {
        const subtype = ent.getAttribute('type');
        if (!subtype) continue;
        const open = ent.getAttribute('open') === 'true';
        const styleClass = ent.getAttribute('class') || '';
        const layer = ent.getAttribute('layer') || '0';
        const contours = [];
        for (const ctEl of ent.querySelectorAll('contour'))
            parseContour(ctEl.textContent.trim(), contours);
        const props = {};
        const propsEl = ent.querySelector('props');
        if (propsEl) {
            for (const attr of propsEl.attributes)
                props[attr.name] = attr.value;
        }
        try {
            const pe = new ParamEntity(layer, subtype, contours[0] ?? [], props);
            pe.closeContour(!open);
            pe.applyStyle(styleClass);
            if (styleClass) pe._resolvedStyle = _resolveStyleWith(pe, stylesheet);
            blockEntities.push(pe);
        } catch (err) {
            console.warn(`Skipping unrecognized param entity in blockdef "${name}": ${err.message}`);
        }
    }

    // Compute bbox and radius from all entity vertices
    const { bbox, radius } = computeBoundsAndRadius(blockEntities);

    return { name, entities: blockEntities, bbox, radius, rawNestedXml };
}

/** Resolve an entity's styleClass against a given stylesheet (not the host Kernel.stylesheet). */
function _resolveStyleWith(entity, stylesheet) {
    const style = { ...DEFAULT_STYLE };
    if (entity.styleClass) {
        for (const cls of entity.styleClass.trim().split(/\s+/)) {
            if (!cls) continue;
            const partial = stylesheet.get('.' + cls) ?? stylesheet.get(cls);
            if (partial) Object.assign(style, partial);
        }
    }
    return style;
}

/**
 * Parse the optional <grid> element from a viremo document root.
 * Returns { stepMode, precision } or null if absent.
 */
function _parseGridSettings(rootEl) {
    const gridEl = rootEl.querySelector(':scope > grid');
    if (!gridEl) return null;
    const mode = gridEl.getAttribute('mode') ?? 'uniform';
    let stepMode;
    if (mode === 'uniform') {
        stepMode = {
            mode: 'uniform',
            unit:   parseFloat(gridEl.getAttribute('unit')   ?? '1') || 1,
            factor: parseInt(gridEl.getAttribute('factor') ?? '2', 10) || 2,
        };
    } else if (mode === 'sequence') {
        const stepsStr = gridEl.getAttribute('steps') ?? '';
        const steps = stepsStr.trim().split(/[\s,]+/).map(Number).filter(n => n > 0);
        stepMode = { mode: 'sequence', steps: steps.length ? steps : [1] };
    } else if (mode === 'tiling') {
        const patternStr = gridEl.getAttribute('pattern') ?? '1 2 5';
        const pattern = patternStr.trim().split(/[\s,]+/).map(Number).filter(n => n > 0);
        const decade  = parseFloat(gridEl.getAttribute('decade') ?? '10');
        stepMode = { mode: 'tiling', pattern: pattern.length ? pattern : [1, 2, 5], decade: decade > 1 ? decade : 10 };
    } else if (mode === 'preset') {
        // Legacy XML format: convert named preset to equivalent tiling
        const LEGACY = {
            'metric-eng':  { pattern: [1, 2, 5],         decade: 10 },
            'decimal':     { pattern: [1, 2, 5],         decade: 10 },
            'metric-arch': { pattern: [1, 1.25, 2.5, 5], decade: 10 },
        };
        const name = gridEl.getAttribute('name') ?? '';
        stepMode = { mode: 'tiling', ...(LEGACY[name] ?? { pattern: [1, 2, 5], decade: 10 }) };
    } else {
        stepMode = { mode: 'uniform', unit: 1, factor: 2 };
    }
    const displayPrecision = parseInt(gridEl.getAttribute('precision') ?? '3', 10);
    const tolerance = {
        distance: parseFloat(gridEl.getAttribute('distanceTol') ?? '0.0001'),
        angle:    parseFloat(gridEl.getAttribute('angleTol')    ?? '0.1'),
    };
    return { stepMode, displayPrecision, tolerance };
}

export function parseStylesheet(cssText) {
    const map = new Map();
    const el = document.createElement('style');
    el.setAttribute('type', 'text/css');
    // Strip @import and url() before injecting into document.head: prevents CSS-triggered
    // network requests (data exfiltration) from malicious imported XML/SVG files.
    el.textContent = cssText
        .replace(/@import\b[^;]*/gi, '')
        .replace(/url\s*\([^)]*\)/gi, '');
    document.head.appendChild(el);
    try {
        const sheet = el.sheet;
        if (sheet) {
            for (const rule of sheet.cssRules) {
                if (rule.type !== CSSRule.STYLE_RULE) continue;
                const partial = {};
                const s = rule.style;
                const stroke = s.getPropertyValue('stroke');
                if (stroke) partial.strokeColor = stroke;
                const fill = s.getPropertyValue('fill');
                if (fill) partial.fill = fill;
                const sw = s.getPropertyValue('stroke-width');
                if (sw) partial.strokeWidth = _parseStrokeWidthMm(sw);
                const sda = s.getPropertyValue('stroke-dasharray');
                // Browser CSSOM normalises unitless numbers to px; strip the unit.
                if (sda) partial.strokeDasharray = sda.replace(/px/g, '').replace(/\s+/g, ' ').trim();
                const op = s.getPropertyValue('fill-opacity');
                if (op) partial.fillOpacity = parseFloat(op);
                const ff = s.getPropertyValue('font-family');
                if (ff) partial.fontFamily = ff.trim().replace(/^['"]|['"]$/g, '');
                const fw = s.getPropertyValue('font-weight');
                if (fw) partial.fontWeight = fw.trim();
                const fst = s.getPropertyValue('font-style');
                if (fst) partial.fontStyle = fst.trim();
                const fsz = s.getPropertyValue('font-size');
                if (fsz) partial.fontSize = _parseStrokeWidthMm(fsz);
                if (Object.keys(partial).length)
                    map.set(rule.selectorText, partial);
            }
        }
    } finally {
        document.head.removeChild(el);
    }
    return map;
}

/** Parse CSS stroke-width value to mm (handles mm, px, pt, cm, unitless). */
function _parseStrokeWidthMm(val) {
    const m = val.match(/^([0-9]*\.?[0-9]+)\s*(mm|px|pt|cm)?/);
    if (!m) return DEFAULT_STYLE.strokeWidth;
    const n = parseFloat(m[1]);
    switch (m[2]) {
        case 'px': return n * 25.4 / 96;
        case 'cm': return n * 10;
        case 'pt': return n * 25.4 / 72;
        default:   return n; // mm or unitless
    }
}

/**
 * Parse the <layers> element from a viremo document root.
 * Returns a Map<string,LayerProps> or null if absent.
 * Layer shape: { visible, locked, snap, z, defaultStyle: Partial<Style>|null }
 */
export function parseLayers(rootEl) {
    const layersEl = rootEl.querySelector('layers');
    if (!layersEl) return null;
    const layers = new Map();
    for (const layerEl of layersEl.querySelectorAll('layer')) {
        const name = layerEl.getAttribute('name');
        if (!name) continue;
        const visible = layerEl.getAttribute('visible') !== 'false';
        const locked  = layerEl.getAttribute('locked')  === 'true';
        const snap    = layerEl.getAttribute('snap')    !== 'false';
        const z       = parseInt(layerEl.getAttribute('z') ?? '0', 10);
        const styleAttr = layerEl.getAttribute('style');
        let defaultStyle = null;
        if (styleAttr) {
            const parsed = parseStylesheet(`._lyr_tmp { ${styleAttr} }`);
            defaultStyle = parsed.get('._lyr_tmp') ?? null;
        }
        layers.set(name, { visible, locked, snap, z, defaultStyle });
    }
    if (!layers.has('0'))
        layers.set('0', { visible: true, locked: false, snap: true, z: 0, defaultStyle: null });
    return layers;
}

let _baseName = 'drawing';
export function setBaseName(filename) {
    _baseName = filename.replace(/\.[^.]+$/, '') || 'drawing';
}
export function getBaseName() { return _baseName; }

/** Open a file picker and read the selected file.
 *  mode: 'text' (default), 'dataurl', or 'auto' (images as dataurl, else as text) */
export function loadFile(accept = '.prec,.xml', mode = 'text') {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.onchange = () => {
            const file = input.files[0];
            if (!file) { reject(new Error('No file selected')); return; }
            const reader = new FileReader();
            reader.onload = () => { resolve({ text: reader.result, name: file.name }); };
            reader.onerror = () => reject(reader.error);
            let useDataUrl = mode === 'dataurl';
            if (mode === 'auto')
                useDataUrl = file.type.startsWith('image/');
            if (useDataUrl)
                reader.readAsDataURL(file);
            else if(mode === 'arraybuffer')
                reader.readAsArrayBuffer(file);
            else
                reader.readAsText(file);
        };
        input.oncancel = () => {
            reject(new Error('File selection canceled'));
        };
        input.click();
    });
}

/** Apply parsed grid data { stepMode, displayPrecision, tolerance } to a live Grid instance and Kernel (safe wrapper). */
export function _applyGridData(grid, gridData, kernel) {
    if (!gridData) return;
    try { if (gridData.stepMode) grid.setStepMode(gridData.stepMode); } catch(e) { console.warn('Grid stepMode restore failed:', e); }
    if (gridData.displayPrecision != null) grid.displayPrecision = gridData.displayPrecision;
    if (gridData.tolerance && kernel) Object.assign(kernel.tolerance, gridData.tolerance);
}
