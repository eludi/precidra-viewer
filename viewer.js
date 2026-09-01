// Precidra Viewer — load, view and query .prec files.
// Copyright (C) 2026 Gerald Franz / eludi.net
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See LICENSE, or <https://www.gnu.org/licenses/>.

// viewer.js — Precidra Viewer entry point: load, view and query .prec files.
// No editing, no drawing tools — see model.js/renderer.js/grid.js, copied verbatim
// from Precidra, for the shared read/render/query core this app is built on.

import { screenToWorld } from './math.js';
import { Grid } from './grid.js';
import { Renderer } from './renderer.js';
import { Kernel } from './model.js';
import { parsePrecidra, parseStylesheet, setBaseName, getBaseName, loadFile, _applyGridData } from './io-parse.js';
import { tools, registerWebMcpTools } from './web-mcp.js';

const canvas = document.getElementById('canvas');
const renderer = new Renderer(canvas);
const grid = new Grid(() => []); // no interactive grips — viewer never repositions the grid
const cam = { x: 0, y: 0, zoom: 10 };

const dropHint = document.getElementById('dropHint');
const dragOverlay = document.getElementById('dragOverlay');
const filenameEl = document.getElementById('filename');
const mcpBadge = document.getElementById('mcpBadge');
const layerPanel = document.getElementById('layerPanel');
const layerList = document.getElementById('layerList');
const inspector = document.getElementById('inspector');
const inspectorBody = document.getElementById('inspectorBody');
const mcpStatus = document.getElementById('mcpStatus');

let selectedEntity = null;
let dirty = true;
export function scheduleRender() { dirty = true; }

(function renderLoop() {
    if (dirty) {
        dirty = false;
        renderer.render(cam, grid, Kernel, null, null);
        if (selectedEntity && Kernel.entities.has(selectedEntity))
            renderer.drawEntity(selectedEntity, true);
    }
    requestAnimationFrame(renderLoop);
})();

window.addEventListener('resize', scheduleRender);

// --- Startup: load the shared default stylesheet, then register WebMCP tools ---
(async function init() {
    try {
        const cssText = await fetch('./default-stylesheet.css', { cache: 'no-cache' }).then(r => r.text());
        Kernel.defaultStylesheet = parseStylesheet(cssText);
    } catch (e) {
        console.warn('Could not load default-stylesheet.css:', e);
    }
    Kernel.stylesheet = new Map(Kernel.defaultStylesheet);

    const ok = await registerWebMcpTools(grid, ({ name, summary }) => {
        mcpStatus.textContent = `WebMCP ${name}: ${summary}`;
        mcpStatus.hidden = false;
    });
    mcpBadge.textContent = ok ? 'WebMCP: active' : 'WebMCP: unavailable';
    mcpBadge.classList.toggle('on', ok);

    const params = new URLSearchParams(location.search);
    const url = params.get('url') || params.get('file');
    if (url) {
        try {
            const text = await fetch(url).then(r => {
                if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
                return r.text();
            });
            loadDocument(text, url.split('/').pop() || 'drawing.prec');
        } catch (e) {
            console.error('Failed to load ?url=', url, e);
            alert(`Could not load "${url}": ${e.message}`);
        }
    }
})();

// --- Loading a document ---

function loadDocument(text, name) {
    let data;
    try {
        data = parsePrecidra(text);
    } catch (e) {
        alert(`Error loading file: ${e.message}`);
        return;
    }
    Kernel.clear();
    Kernel.load(data);
    _applyGridData(grid, data.grid, Kernel);
    setBaseName(name);
    selectedEntity = null;
    inspector.hidden = true;

    // Re-render once any image block assets finish loading asynchronously
    for (const def of Kernel.blocks.values())
        if (def.imageEl && !def.imageEl.complete)
            def.imageEl.addEventListener('load', scheduleRender, { once: true });

    filenameEl.textContent = `${getBaseName()} — ${data.entities.length} entities`;
    dropHint.classList.add('hidden');
    rebuildLayerPanel();
    zoomToFit(Kernel.bbox);
    scheduleRender();
}

function zoomToFit(bbox, margin = 20) {
    if (!bbox) return;
    renderer.resize(); // ensure renderer.W/H reflect the current canvas size before we use them
    const w = bbox.maxX - bbox.minX;
    const h = bbox.maxY - bbox.minY;
    if (w < 1e-9 || h < 1e-9) { cam.x = bbox.minX; cam.y = bbox.minY; cam.zoom = 10; return; }
    const topInset = 56; // topbar height
    const usableH = renderer.H - topInset;
    cam.zoom = Math.min((renderer.W - 2 * margin) / w, (usableH - 2 * margin) / h);
    cam.x = (bbox.minX + bbox.maxX) / 2;
    const usableCenterScreenY = topInset + usableH / 2;
    cam.y = (bbox.minY + bbox.maxY) / 2 - (renderer.H / 2 - usableCenterScreenY) / cam.zoom;
}

// --- File open (button + drag & drop) ---

async function openFilePicker() {
    try {
        const { text, name } = await loadFile('.prec,.xml');
        loadDocument(text, name);
    } catch (e) {
        // user canceled the picker — not an error
    }
}
document.getElementById('btnOpen').addEventListener('click', openFilePicker);
document.getElementById('btnOpen2').addEventListener('click', openFilePicker);
document.getElementById('btnFit').addEventListener('click', () => { zoomToFit(Kernel.bbox); scheduleRender(); });
document.getElementById('btnCloseInspector').addEventListener('click', () => {
    selectedEntity = null;
    inspector.hidden = true;
    scheduleRender();
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dragOverlay.classList.add('active'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dragOverlay.classList.remove('active'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dragOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadDocument(reader.result, file.name);
    reader.readAsText(file);
});

// --- Layer panel (read-only list + visibility toggle, collapsible) ---

document.getElementById('layerPanelHeader').addEventListener('click', () => {
    const collapsed = layerPanel.classList.toggle('collapsed');
    try { localStorage.setItem('precidra-viewer.layersCollapsed', collapsed ? '1' : '0'); } catch (e) {}
});
try {
    if (localStorage.getItem('precidra-viewer.layersCollapsed') === '1') layerPanel.classList.add('collapsed');
} catch (e) {}

function rebuildLayerPanel() {
    layerList.innerHTML = '';
    const names = [...Kernel.layers.keys()].sort((a, b) =>
        (Kernel.layers.get(a).z ?? 0) - (Kernel.layers.get(b).z ?? 0));
    for (const name of names) {
        const props = Kernel.layers.get(name);
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = props.visible !== false;
        cb.addEventListener('change', () => { props.visible = cb.checked; scheduleRender(); });
        const span = document.createElement('span');
        span.textContent = name;
        label.appendChild(cb);
        label.appendChild(span);
        layerList.appendChild(label);
    }
    layerPanel.hidden = names.length === 0;
}

// --- Camera: pan (drag) + zoom (wheel, pinch) ---

const pointers = new Map(); // pointerId -> {x,y}
let panLast = null;
let pinchStartDist = null;
let pinchStartZoom = null;
let downPt = null; // {x,y} screen coords at pointerdown, to distinguish click from drag

function screenPt(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// renderer.W/H are device pixels (canvas.width/height); pointer events give CSS pixels.
function toDevicePx(p) {
    const dpr = canvas.width / canvas.clientWidth || 1;
    return { x: p.x * dpr, y: p.y * dpr };
}

canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = screenPt(e);
    pointers.set(e.pointerId, p);
    downPt = p;
    if (pointers.size === 1) {
        panLast = p;
        canvas.classList.add('panning');
    } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartZoom = cam.zoom;
        panLast = null;
    }
});

canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = screenPt(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStartDist > 1) {
            cam.zoom = pinchStartZoom * (dist / pinchStartDist);
            scheduleRender();
        }
    } else if (panLast) {
        const dx = p.x - panLast.x, dy = p.y - panLast.y;
        cam.x -= dx / cam.zoom;
        cam.y += dy / cam.zoom;
        panLast = p;
        scheduleRender();
    }
});

function endPointer(e) {
    const wasClick = pointers.size === 1 && downPt &&
        Math.hypot(screenPt(e).x - downPt.x, screenPt(e).y - downPt.y) < 4;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
        canvas.classList.remove('panning');
        panLast = null;
    } else if (pointers.size === 1) {
        panLast = [...pointers.values()][0];
    }
    pinchStartDist = null;
    if (wasClick) handleClick(downPt);
    downPt = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toDevicePx(screenPt(e));
    const before = screenToWorld(p.x, p.y, cam, renderer.W, renderer.H);
    const factor = Math.exp(-e.deltaY * 0.001);
    cam.zoom *= factor;
    const after = screenToWorld(p.x, p.y, cam, renderer.W, renderer.H);
    cam.x -= (after.x - before.x);
    cam.y -= (after.y - before.y);
    scheduleRender();
}, { passive: false });

// --- Click-to-inspect ---

const getObjectInfo = tools.find(t => t.name === 'get_object_info').handler;

function handleClick(p) {
    const dp = toDevicePx(p);
    const world = screenToWorld(dp.x, dp.y, cam, renderer.W, renderer.H);
    const pickRadius = 6 / cam.zoom; // ~6 screen px in world units
    const hit = Kernel.nearestEntity(world, pickRadius);
    if (!hit) {
        selectedEntity = null;
        inspector.hidden = true;
        scheduleRender();
        return;
    }
    selectedEntity = hit;
    showInspector(hit);
    scheduleRender();
}

function showInspector(entity) {
    const info = getObjectInfo({ id: entity.id });
    inspectorBody.innerHTML = '';
    const row = (k, v) => {
        if (v === null || v === undefined || v === '') return;
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd'); dd.textContent = v;
        inspectorBody.appendChild(dt);
        inspectorBody.appendChild(dd);
    };
    row('id', info.id);
    row('type', info.type);
    row('layer', info.layer);
    row('label', info.label);
    row('closed', info.closed);
    if (info.bounds) row('bounds', `${info.bounds.minX.toFixed(2)}, ${info.bounds.minY.toFixed(2)} → ${info.bounds.maxX.toFixed(2)}, ${info.bounds.maxY.toFixed(2)}`);
    row('length', info.length != null ? info.length.toFixed(3) : null);
    row('area', info.area != null ? info.area.toFixed(3) : null);
    if (info.text != null) row('text', info.text);
    if (info.blockName) row('block', info.blockName);
    if (info.style) row('stroke', info.style.strokeColor);
    if (info.nearbyTexts && info.nearbyTexts.length)
        row('nearby text', info.nearbyTexts.map(t => t.text).join(', '));
    inspector.hidden = false;
}
