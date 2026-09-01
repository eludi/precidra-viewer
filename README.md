# Precidra Viewer

A read-only viewer for [Precidra](https://precidra.app) `.prec` drawing
files: open a file, pan/zoom, toggle layers, click an object to inspect it —
and query the document from an AI agent via
[WebMCP](https://webmachinelearning.github.io/webmcp/).

This is a small, standalone subset of Precidra (a browser-based 2D precision
drawing app). It does not include any drawing or editing tools — only what's
needed to load, render and query a document. The full editor lives at
[precidra.app](https://precidra.app) and is closed-source; this viewer is
open source under AGPL-3.0 (see [LICENSE](LICENSE)).

## Running

No build step, no dependencies. Serve the directory with any static file
server and open it in a browser:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080/`, and open a `.prec` file via the "Open…"
button or by dragging it onto the page. You can also link directly to a
hosted file with `?url=<path-to-file.prec>`.

## WebMCP

If the browser supports `document.modelContext`, Precidra Viewer registers
a set of read-only tools an AI agent can call against the currently open
document: `get_document_info`, `list_objects_by_layer`, `get_object_info`,
`get_object_geometry`, `measure_distance`, `check_intersection`, and
`find_related_entities` (spatial relations — contains/within/touches/
overlapping/close/disjoint). See [web-mcp.js](web-mcp.js) for the full
tool contract.

Deploying behind a server you control? MS Edge only exposes
`document.modelContext` on an origin-keyed origin — add:

```
Header always set Origin-Agent-Cluster "?1"
```

## What's here vs. what's not

This repo is a trimmed, standalone copy of a handful of Precidra's modules
(`math.js`, `model.js`, `generators.js`, `grid.js`, `renderer.js`,
`web-mcp.js`, plus a parse-only `io.js`), unchanged from the main app except
where noted in each file, wired up to a new, small `viewer.js`/`index.html`
shell. It deliberately excludes:

- the drawing/editing command interpreter
- DXF/SVG import and PNG/PDF/DXF export
- polygon boolean operations (combine/subtract/intersect/trim)
- autosave, undo/redo UI, and everything else that only matters while
  authoring a drawing

## License

AGPL-3.0. If you deploy a modified version of this viewer as a network
service, section 13 of the AGPL requires you to offer users of that service
the corresponding source — see [LICENSE](LICENSE).
