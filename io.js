// Part of Precidra Viewer — Copyright (C) 2026 Gerald Franz / eludi.net — AGPL-3.0, see LICENSE.
// Tiny re-export shim: model.js and web-mcp.js are verbatim copies of Precidra's
// own modules and import from './io.js' (their io.js re-exports from io-parse.js
// there too) — keeping this shim here means those two files never need editing
// to work in this repo. Everything viewer-specific imports io-parse.js directly.
export * from './io-parse.js';
