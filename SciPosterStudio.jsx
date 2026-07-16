import React, { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect } from "react";
import {
  Type, LayoutTemplate, Square, Circle, Minus, ImagePlus, Download, ZoomIn, ZoomOut,
  Maximize2, Trash2, Copy, BringToFront, MousePointer2, Sun, Moon, ChevronDown, X,
  FileText, Check, Loader2, AlignLeft, AlignCenter, AlignRight, Bold, Ruler, Sparkles,
  PenTool, Spline, Waypoints, ArrowRight, ArrowLeftRight, MoveRight, CornerDownRight,
  Redo2, Link2, Unlink, Magnet, Plus,
} from "lucide-react";

/* ============================================================================
   SciPoster Studio — v2
   ----------------------------------------------------------------------------
   Adds: custom-named sections, manual canvas sizing, snap-on-resize (incl.
   equal-size matching), stitched connectors (Canva/PPT-style), a freehand pen,
   equal-spacing distribution guides, and a real vector PDF export path.

   Coordinate systems:
     POSTER SPACE — the poster's own grid, in millimetres. All element/endpoint
                    geometry lives here. Zoom-independent.
     SCREEN SPACE — pixels the user sees.  screen = poster * zoom.
   A mouse delta becomes poster units by dividing by zoom — the single rule that
   keeps every snap threshold feeling identical at any zoom level.
   ========================================================================== */

/* ------------------------------- Constants -------------------------------- */
const POSTER_SIZES = {
  A0:     { label: 'A0 · 841 × 1189 mm',  w: 841, h: 1189 },
  A1:     { label: 'A1 · 594 × 841 mm',   w: 594, h: 841  },
  "36x48":{ label: '36″ × 48″ · 914 × 1219 mm', w: 914, h: 1219 },
  custom: { label: 'Custom…', w: 700, h: 1000 },
};
const ZOOM_PRESETS = ['fit', 0.25, 0.5, 1];

const SNAP_SCREEN_PX = 7;   // grab distance, in screen px (÷ zoom → poster mm)
const HANDLE_PX = 10;
const MIN_SIZE_MM = 30;

const SECTION_PRESETS = [
  { key: 'abstract',   label: 'Abstract',    w: 260, h: 180, fill: '#eef2ff', accent: '#4f46e5' },
  { key: 'intro',      label: 'Introduction',w: 260, h: 220, fill: '#ecfeff', accent: '#0891b2' },
  { key: 'methods',    label: 'Methodology', w: 260, h: 260, fill: '#f0fdf4', accent: '#16a34a' },
  { key: 'results',    label: 'Results',     w: 300, h: 260, fill: '#fef2f2', accent: '#dc2626' },
  { key: 'discussion', label: 'Discussion',  w: 260, h: 220, fill: '#fff7ed', accent: '#ea580c' },
  { key: 'references', label: 'References',  w: 260, h: 150, fill: '#f8fafc', accent: '#475569' },
];

const SHAPE_PRESETS = [
  { key: 'rect',    label: 'Rectangle', icon: Square, w: 160, h: 120 },
  { key: 'ellipse', label: 'Ellipse',   icon: Circle, w: 160, h: 120 },
];

// "Many kinds" of connectors. Each is just a combination of end-heads, routing
// and dash — the geometry engine handles the rest.
const ARROW_VARIANTS = [
  { key: 'arrow',  label: 'Arrow',        startHead: 'none',     endHead: 'triangle', routing: 'straight', dashed: false, icon: ArrowRight },
  { key: 'double', label: 'Double arrow', startHead: 'triangle', endHead: 'triangle', routing: 'straight', dashed: false, icon: ArrowLeftRight },
  { key: 'open',   label: 'Open head',    startHead: 'none',     endHead: 'open',     routing: 'straight', dashed: false, icon: MoveRight },
  { key: 'line',   label: 'Plain line',   startHead: 'none',     endHead: 'none',     routing: 'straight', dashed: false, icon: Minus },
  { key: 'dashed', label: 'Dashed arrow', startHead: 'none',     endHead: 'triangle', routing: 'straight', dashed: true,  icon: Redo2 },
  { key: 'elbow',  label: 'Elbow arrow',  startHead: 'none',     endHead: 'triangle', routing: 'elbow',    dashed: false, icon: CornerDownRight },
  { key: 'curved', label: 'Curved arrow', startHead: 'none',     endHead: 'triangle', routing: 'curved',   dashed: false, icon: Spline },
  { key: 'dot',    label: 'Dot → arrow',  startHead: 'dot',      endHead: 'triangle', routing: 'straight', dashed: false, icon: Waypoints },
];
const variantByKey = Object.fromEntries(ARROW_VARIANTS.map((v) => [v.key, v]));

let ID = 1;
const uid = () => `el_${ID++}`;
const LOREM =
  'Concise, information-dense summary text goes here. Double-click to edit. ' +
  'Keep body copy tight so it reads clearly from two metres away.';

/* ------------------------------ Geometry ---------------------------------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v) => Math.round(v);
const centerOf = (el) => ({ x: el.x + el.w / 2, y: el.y + el.h / 2 });
const isBox = (el) => el.type !== 'connector';           // has x/y/w/h
const isStitchable = (el) => ['section', 'text', 'image', 'shape'].includes(el.type);

// Where a connector endpoint attaches on an element. `toward` is the *other*
// endpoint, used by the 'auto' anchor to aim at it.
function anchorPoint(el, anchor, toward) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  if (anchor === 'center') return { x: cx, y: cy };
  if (anchor === 'top')    return { x: cx, y: el.y };
  if (anchor === 'bottom') return { x: cx, y: el.y + el.h };
  if (anchor === 'left')   return { x: el.x, y: cy };
  if (anchor === 'right')  return { x: el.x + el.w, y: cy };
  // 'auto': the point on the element's border along the ray toward the target.
  let dx = toward.x - cx, dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: el.y };
  const hw = el.w / 2, hh = el.h / 2;
  const s = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx * s, y: cy + dy * s };
}

// Resolve a connector's two absolute endpoints from live element geometry.
function resolveConnector(c, byId) {
  const startEl = c.start.elId != null ? byId[c.start.elId] : null;
  const endEl   = c.end.elId   != null ? byId[c.end.elId]   : null;
  const startRaw = startEl ? centerOf(startEl) : { x: c.start.x, y: c.start.y };
  const endRaw   = endEl   ? centerOf(endEl)   : { x: c.end.x,   y: c.end.y };
  const A = startEl ? anchorPoint(startEl, c.start.anchor, endRaw) : { x: c.start.x, y: c.start.y };
  const B = endEl   ? anchorPoint(endEl,   c.end.anchor,   startRaw) : { x: c.end.x, y: c.end.y };
  return { A, B };
}

// Topmost stitchable element under a poster-space point (for stitching).
function elementAt(px, py, elements, excludeId) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!isStitchable(el) || el.id === excludeId) continue;
    if (px >= el.x && px <= el.x + el.w && py >= el.y && py <= el.y + el.h) return el;
  }
  return null;
}

/* ============================================================================
   MOVE SNAPPING  — alignment (edges/centres) + equal-spacing distribution.
   ----------------------------------------------------------------------------
   For each axis the moving box exposes 3 lines: leading edge, centre, trailing
   edge, each { pos, offset }.  For a target line t and moving line at p, the
   correction is d = t − p; smallest |d| within threshold wins, applied as
   newOrigin = t − offset.  If nothing aligns on an axis we then try to snap the
   box so its gaps to the two nearest neighbours are equal (distribution).
   ========================================================================== */
function computeSnap(box, others, poster, zoom) {
  const th = SNAP_SCREEN_PX / zoom;

  const linesOf = (axis) => {
    const o = axis === 'x' ? box.x : box.y;
    const s = axis === 'x' ? box.w : box.h;
    return [{ pos: o, offset: 0 }, { pos: o + s / 2, offset: s / 2 }, { pos: o + s, offset: s }];
  };
  const targetsFor = (axis) => {
    const span = axis === 'x' ? poster.w : poster.h;
    const t = [{ pos: 0 }, { pos: span / 2 }, { pos: span }];
    for (const el of others) {
      const o = axis === 'x' ? el.x : el.y, s = axis === 'x' ? el.w : el.h;
      t.push({ pos: o, el }, { pos: o + s / 2, el }, { pos: o + s, el });
    }
    return t;
  };
  const alignAxis = (axis) => {
    let best = null;
    for (const ml of linesOf(axis)) for (const tg of targetsFor(axis)) {
      const dist = Math.abs(tg.pos - ml.pos);
      if (dist <= th && (best === null || dist < best.dist))
        best = { dist, coord: tg.pos - ml.offset, targetPos: tg.pos, targetEl: tg.el || null };
    }
    if (!best) return null;
    const snapped = { ...box, [axis]: best.coord };
    let start, end;
    if (best.targetEl) {
      const a = axis === 'x' ? [snapped.y, snapped.y + snapped.h] : [snapped.x, snapped.x + snapped.w];
      const b = axis === 'x' ? [best.targetEl.y, best.targetEl.y + best.targetEl.h]
                             : [best.targetEl.x, best.targetEl.x + best.targetEl.w];
      start = Math.min(a[0], b[0]); end = Math.max(a[1], b[1]);
    } else { start = 0; end = axis === 'x' ? poster.h : poster.w; }
    return { coord: best.coord, guide: { type: 'align', axis, pos: best.targetPos, start, end } };
  };

  // Equal-spacing: snap so gaps to nearest overlapping neighbours match.
  const distribute = (axis) => {
    const s = axis === 'x' ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h';
    const cs = axis === 'x' ? 'y' : 'x', csz = axis === 'x' ? 'h' : 'w';
    const bA = [box[cs], box[cs] + box[csz]];
    const overlaps = others.filter((o) => Math.min(bA[1], o[cs] + o[csz]) - Math.max(bA[0], o[cs]) > 0);
    if (overlaps.length < 2) return null;
    const bStart = box[s], bEnd = box[s] + box[size];
    let left = null, right = null;
    for (const o of overlaps) {
      const oEnd = o[s] + o[size];
      if (oEnd <= bStart + th) { if (!left || oEnd > left[s] + left[size]) left = o; }
      else if (o[s] >= bEnd - th) { if (!right || o[s] < right[s]) right = o; }
    }
    if (!left || !right) return null;
    const gapL = bStart - (left[s] + left[size]);
    const gapR = right[s] - bEnd;
    if (Math.abs(gapL - gapR) > th) return null;
    const eq = (gapL + gapR) / 2;
    const coord = left[s] + left[size] + eq;
    return { coord, guide: { type: axis === 'x' ? 'gapX' : 'gapY', left, right, box: { ...box, [s]: coord }, gap: eq } };
  };

  const guides = [];
  let X = null, Y = null;
  const ax = alignAxis('x'); if (ax) { X = ax.coord; guides.push(ax.guide); }
  const ay = alignAxis('y'); if (ay) { Y = ay.coord; guides.push(ay.guide); }
  if (X === null) { const d = distribute('x'); if (d) { X = d.coord; guides.push(d.guide); } }
  if (Y === null) { const d = distribute('y'); if (d) { Y = d.coord; guides.push(d.guide); } }
  return { x: X === null ? box.x : X, y: Y === null ? box.y : Y, guides };
}

/* ============================================================================
   RESIZE SNAPPING — edge-alignment + EQUAL-SIZE matching, unified.
   ----------------------------------------------------------------------------
   The edge being dragged can snap to two families of targets, both expressed as
   a target *position* for that edge:
     (a) alignment — another element's edge/centre, or a canvas line.
     (b) equal-size — fixedOppositeEdge ± otherElement.size, which forces the
         box's width/height to equal that element's. This is what lets you make
         two images identical by dragging one until it "clicks" to the other.
   Nearest target within threshold wins; we tag it so the UI can show either an
   alignment line (magenta) or an equal-size bracket (cyan) with a value badge.
   ========================================================================== */
function computeResizeSnap(box, handle, others, poster, zoom) {
  const th = SNAP_SCREEN_PX / zoom;
  let { x, y, w, h } = box;
  let xSnap = null, ySnap = null; // remember choice to build guides after

  // ---- X axis (width) ----
  if (handle.includes('e') || handle.includes('w')) {
    const movesE = handle.includes('e');
    const movingPos = movesE ? x + w : x;
    const fixed = movesE ? x : x + w;
    const targets = [];
    const align = (pos) => targets.push({ pos, kind: 'align' });
    align(0); align(poster.w / 2); align(poster.w);
    for (const o of others) { align(o.x); align(o.x + o.w / 2); align(o.x + o.w); }
    for (const o of others) targets.push({ pos: movesE ? fixed + o.w : fixed - o.w, kind: 'equalW', el: o, value: o.w });
    let best = null;
    for (const tg of targets) { const d = Math.abs(tg.pos - movingPos); if (d <= th && (!best || d < best.d)) best = { d, tg }; }
    if (best) {
      const np = best.tg.pos;
      if (movesE) w = Math.max(MIN_SIZE_MM, np - x);
      else { const nx = Math.min(np, x + w - MIN_SIZE_MM); w = x + w - nx; x = nx; }
      xSnap = best.tg;
    }
  }
  // ---- Y axis (height) ----
  if (handle.includes('s') || handle.includes('n')) {
    const movesS = handle.includes('s');
    const movingPos = movesS ? y + h : y;
    const fixed = movesS ? y : y + h;
    const targets = [];
    const align = (pos) => targets.push({ pos, kind: 'align' });
    align(0); align(poster.h / 2); align(poster.h);
    for (const o of others) { align(o.y); align(o.y + o.h / 2); align(o.y + o.h); }
    for (const o of others) targets.push({ pos: movesS ? fixed + o.h : fixed - o.h, kind: 'equalH', el: o, value: o.h });
    let best = null;
    for (const tg of targets) { const d = Math.abs(tg.pos - movingPos); if (d <= th && (!best || d < best.d)) best = { d, tg }; }
    if (best) {
      const np = best.tg.pos;
      if (movesS) h = Math.max(MIN_SIZE_MM, np - y);
      else { const ny = Math.min(np, y + h - MIN_SIZE_MM); h = y + h - ny; y = ny; }
      ySnap = best.tg;
    }
  }

  // Build guides from the FINAL box so brackets sit correctly.
  const guides = [];
  const finalBox = { x, y, w, h };
  if (xSnap) guides.push(xSnap.kind === 'align'
    ? { type: 'align', axis: 'x', pos: xSnap.pos, start: 0, end: poster.h }
    : { type: 'equalW', a: finalBox, b: xSnap.el, value: xSnap.value });
  if (ySnap) guides.push(ySnap.kind === 'align'
    ? { type: 'align', axis: 'y', pos: ySnap.pos, start: 0, end: poster.w }
    : { type: 'equalH', a: finalBox, b: ySnap.el, value: ySnap.value });

  return { x, y, w, h, guides };
}

/* ============================================================================
   MAIN COMPONENT
   ========================================================================== */
export default function SciPosterStudio() {
  const [dark, setDark] = useState(true);
  const [sizeKey, setSizeKey] = useState('A0');
  const [customSize, setCustomSize] = useState({ w: 700, h: 1000 });
  const [unit, setUnit] = useState('mm'); // mm | in — display only for custom entry
  const poster = sizeKey === 'custom' ? customSize : POSTER_SIZES[sizeKey];

  const [elements, setElements] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [tool, setTool] = useState('select');       // select | pen | connector
  const [pendingVariant, setPendingVariant] = useState('arrow');
  const [snapOn, setSnapOn] = useState(true);
  const [guides, setGuides] = useState([]);
  const [draft, setDraft] = useState(null);         // live preview while drawing
  const [hoverStitch, setHoverStitch] = useState(null); // element id being targeted
  const [zoomMode, setZoomMode] = useState('fit');
  const [viewport, setViewport] = useState({ w: 1000, h: 700 });
  const [exporting, setExporting] = useState(null);
  const [menu, setMenu] = useState(null);

  const viewportRef = useRef(null);
  const surfaceRef = useRef(null);
  const interaction = useRef(null);

  const byId = useMemo(() => Object.fromEntries(elements.map((e) => [e.id, e])), [elements]);
  const selected = elements.find((e) => e.id === selectedId) || null;

  /* ------- Fit-to-screen zoom ------- */
  useLayoutEffect(() => {
    const node = viewportRef.current; if (!node) return;
    const ro = new ResizeObserver((es) => { const r = es[0].contentRect; setViewport({ w: r.width, h: r.height }); });
    ro.observe(node); return () => ro.disconnect();
  }, []);
  const zoom = useMemo(() => {
    if (zoomMode !== 'fit') return zoomMode;
    const pad = 64;
    return clamp(Math.min((viewport.w - pad) / poster.w, (viewport.h - pad) / poster.h), 0.05, 4);
  }, [zoomMode, viewport, poster]);

  // Convert a client (screen) point into poster coordinates.
  const toPoster = useCallback((clientX, clientY) => {
    const r = surfaceRef.current.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  }, [zoom]);

  /* ------------------------------ Element ops ------------------------------ */
  const addElement = useCallback((el) => {
    const id = uid();
    const x = round(poster.w / 2 - el.w / 2), y = round(poster.h / 2 - el.h / 2);
    setElements((p) => [...p, { id, x, y, ...el }]);
    setSelectedId(id); setMenu(null);
    return id;
  }, [poster]);

  const addText = () => addElement({ type: 'text', w: 240, h: 90, text: 'New text — double-click to edit',
    fontSize: 20, color: '#0f172a', bold: false, align: 'left', lineHeight: 1.3 });
  const addSection = (preset) => addElement({ type: 'section', w: preset.w, h: preset.h,
    title: preset.label, text: LOREM, fill: preset.fill, accent: preset.accent,
    fontSize: 14, color: '#334155', align: 'left', lineHeight: 1.4 });
  const addCustomSection = () => addElement({ type: 'section', w: 260, h: 200,
    title: 'Custom Section', text: LOREM, fill: '#f1f5f9', accent: '#6366f1',
    fontSize: 14, color: '#334155', align: 'left', lineHeight: 1.4, custom: true });
  const addShape = (preset) => addElement({ type: 'shape', shape: preset.key, w: preset.w, h: preset.h,
    stroke: '#0e7490', fill: '#cffafe', strokeWidth: 4 });

  const addImage = (dataUrl, natW, natH) => {
    const maxW = 320, ratio = natH && natW ? natH / natW : 0.66;
    addElement({ type: 'image', w: maxW, h: round(maxW * ratio), src: dataUrl });
  };
  const onUpload = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => addImage(reader.result, img.width, img.height);
      img.onerror = () => addImage(reader.result, 3, 2);
      img.src = reader.result;
    };
    reader.readAsDataURL(file); e.target.value = '';
  };

  const patchSelected = (patch) => setElements((p) => p.map((el) => (el.id === selectedId ? { ...el, ...patch } : el)));

  const deleteSelected = () => {
    if (!selectedId) return;
    setElements((prev) => detachAndRemove(prev, selectedId, byId));
    setSelectedId(null);
  };
  const duplicateSelected = () => {
    if (!selected) return;
    const id = uid();
    const copy = selected.type === 'connector'
      ? { ...selected, id, start: { ...selected.start }, end: { ...selected.end } }
      : { ...selected, id, x: selected.x + 24, y: selected.y + 24 };
    setElements((p) => [...p, copy]); setSelectedId(id);
  };
  const bringToFront = () => { if (!selected) return; setElements((p) => [...p.filter((e) => e.id !== selectedId), selected]); };

  useEffect(() => {
    const onKey = (e) => {
      if (editingId) return;
      if (e.key === 'Escape') { setTool('select'); setDraft(null); interaction.current = null; return; }
      if (!selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
      if (selected && isBox(selected)) {
        const step = e.shiftKey ? 10 : 1;
        const n = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (n) { e.preventDefault();
          setElements((p) => p.map((el) => el.id === selectedId
            ? { ...el, x: clamp(el.x + n[0], 0, poster.w - el.w), y: clamp(el.y + n[1], 0, poster.h - el.h) } : el)); }
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, editingId, selected, poster, byId]);

  /* --------------------------- Interaction start --------------------------- */
  const beginMove = (e, el) => {
    if (editingId === el.id || tool !== 'select') return;
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId);
    setSelectedId(el.id);
    interaction.current = { kind: 'move', id: el.id, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY, start: { x: el.x, y: el.y, w: el.w, h: el.h },
      startPoints: el.type === 'path' ? el.points.map((p) => ({ ...p })) : null };
  };
  const beginResize = (e, el, handle) => {
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId);
    setSelectedId(el.id);
    interaction.current = { kind: 'resize', id: el.id, handle, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY, start: { x: el.x, y: el.y, w: el.w, h: el.h },
      startPoints: el.type === 'path' ? el.points.map((p) => ({ ...p })) : null };
  };
  const beginEndpoint = (e, connector, which) => {
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId);
    setSelectedId(connector.id);
    interaction.current = { kind: 'endpoint', id: connector.id, which, pointerId: e.pointerId };
  };
  const beginConnectorMove = (e, connector) => {
    if (tool !== 'select') return;
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId);
    setSelectedId(connector.id);
    interaction.current = { kind: 'move-connector', id: connector.id, pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY, start: { ...connector } };
  };

  // Pointer-down on the poster surface: draw connector, draw pen, or deselect.
  const onSurfacePointerDown = (e) => {
    if (tool === 'select') { e.stopPropagation(); setSelectedId(null); setMenu(null); return; }
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toPoster(e.clientX, e.clientY);
    if (tool === 'connector') {
      const hit = elementAt(p.x, p.y, elements, null);
      const start = hit ? { elId: hit.id, anchor: 'auto', x: p.x, y: p.y } : { elId: null, anchor: 'auto', x: p.x, y: p.y };
      interaction.current = { kind: 'draw-connector', pointerId: e.pointerId, start, curEnd: { x: p.x, y: p.y } };
      setDraft({ kind: 'connector', variant: pendingVariant, start, end: { elId: null, anchor: 'auto', x: p.x, y: p.y } });
    } else if (tool === 'pen') {
      interaction.current = { kind: 'draw-pen', pointerId: e.pointerId, points: [p] };
      setDraft({ kind: 'pen', points: [p] });
    }
  };

  /* ------------------------------ Pointer move ----------------------------- */
  const onPointerMove = (e) => {
    const it = interaction.current;
    if (!it || it.pointerId !== e.pointerId) return;
    const others = elements.filter((el) => el.id !== it.id && isBox(el));

    if (it.kind === 'move') {
      const dx = (e.clientX - it.startClientX) / zoom, dy = (e.clientY - it.startClientY) / zoom;
      let nx = clamp(it.start.x + dx, 0, poster.w - it.start.w);
      let ny = clamp(it.start.y + dy, 0, poster.h - it.start.h);
      if (snapOn) {
        const snap = computeSnap({ x: nx, y: ny, w: it.start.w, h: it.start.h }, others, poster, zoom);
        nx = clamp(snap.x, 0, poster.w - it.start.w); ny = clamp(snap.y, 0, poster.h - it.start.h);
        setGuides(snap.guides);
      }
      setElements((p) => p.map((el) => {
        if (el.id !== it.id) return el;
        if (el.type === 'path') { const ox = round(nx) - it.start.x, oy = round(ny) - it.start.y;
          return { ...el, x: round(nx), y: round(ny), points: it.startPoints.map((pt) => ({ x: pt.x + ox, y: pt.y + oy })) }; }
        return { ...el, x: round(nx), y: round(ny) };
      }));

    } else if (it.kind === 'move-connector') {
      // Only FREE endpoints move; stitched ones stay attached.
      const dx = (e.clientX - it.startClientX) / zoom, dy = (e.clientY - it.startClientY) / zoom;
      setElements((p) => p.map((el) => {
        if (el.id !== it.id) return el;
        const s = { ...it.start.start }, en = { ...it.start.end };
        if (s.elId == null) { s.x += dx; s.y += dy; }
        if (en.elId == null) { en.x += dx; en.y += dy; }
        return { ...el, start: s, end: en };
      }));

    } else if (it.kind === 'resize') {
      const dx = (e.clientX - it.startClientX) / zoom, dy = (e.clientY - it.startClientY) / zoom;
      const h = it.handle; let { x, y, w, ht } = { x: it.start.x, y: it.start.y, w: it.start.w, ht: it.start.h };
      if (h.includes('e')) w = it.start.w + dx;
      if (h.includes('s')) ht = it.start.h + dy;
      if (h.includes('w')) { w = it.start.w - dx; x = it.start.x + dx; }
      if (h.includes('n')) { ht = it.start.h - dy; y = it.start.y + dy; }
      if (w < MIN_SIZE_MM) { if (h.includes('w')) x -= (MIN_SIZE_MM - w); w = MIN_SIZE_MM; }
      if (ht < MIN_SIZE_MM) { if (h.includes('n')) y -= (MIN_SIZE_MM - ht); ht = MIN_SIZE_MM; }
      let box = { x, y, w, h: ht };
      if (snapOn) { const s = computeResizeSnap(box, h, others, poster, zoom); box = { x: s.x, y: s.y, w: s.w, h: s.h }; setGuides(s.guides); }
      // keep inside the poster
      box.x = clamp(box.x, 0, poster.w - MIN_SIZE_MM);
      box.y = clamp(box.y, 0, poster.h - MIN_SIZE_MM);
      box.w = clamp(box.w, MIN_SIZE_MM, poster.w - box.x);
      box.h = clamp(box.h, MIN_SIZE_MM, poster.h - box.y);
      setElements((p) => p.map((el) => {
        if (el.id !== it.id) return el;
        if (el.type === 'path') {
          const sx = box.w / it.start.w, sy = box.h / it.start.h;
          const pts = it.startPoints.map((pt) => ({ x: box.x + (pt.x - it.start.x) * sx, y: box.y + (pt.y - it.start.y) * sy }));
          return { ...el, ...roundBox(box), points: pts };
        }
        return { ...el, ...roundBox(box) };
      }));

    } else if (it.kind === 'endpoint') {
      const p = toPoster(e.clientX, e.clientY);
      const hit = elementAt(p.x, p.y, elements, null);
      setHoverStitch(hit ? hit.id : null);
      setElements((prev) => prev.map((el) => {
        if (el.id !== it.id) return el;
        const ep = hit ? { elId: hit.id, anchor: 'auto', x: p.x, y: p.y } : { elId: null, anchor: 'auto', x: p.x, y: p.y };
        return { ...el, [it.which]: ep };
      }));

    } else if (it.kind === 'draw-connector') {
      const p = toPoster(e.clientX, e.clientY);
      const hit = elementAt(p.x, p.y, elements, it.start.elId);
      setHoverStitch(hit ? hit.id : null);
      const end = hit ? { elId: hit.id, anchor: 'auto', x: p.x, y: p.y } : { elId: null, anchor: 'auto', x: p.x, y: p.y };
      it.curEnd = end;
      setDraft({ kind: 'connector', variant: pendingVariant, start: it.start, end });

    } else if (it.kind === 'draw-pen') {
      const p = toPoster(e.clientX, e.clientY);
      it.points.push(p); setDraft({ kind: 'pen', points: it.points.slice() });
    }
  };

  const endInteraction = (e) => {
    const it = interaction.current;
    if (!it || it.pointerId !== e.pointerId) return;

    if (it.kind === 'draw-connector') {
      const { start, curEnd } = it;
      const A = start, B = curEnd || start;
      const dist = Math.hypot((B.x ?? 0) - (A.x ?? 0), (B.y ?? 0) - (A.y ?? 0));
      if (dist > 6 || A.elId != null || B.elId != null) {
        const id = uid();
        setElements((p) => [...p, { id, type: 'connector', variant: pendingVariant,
          start: A, end: B, stroke: '#0f172a', strokeWidth: 3, dashed: variantByKey[pendingVariant].dashed }]);
        setSelectedId(id);
      }
      setDraft(null); setTool('select');
    } else if (it.kind === 'draw-pen') {
      if (it.points.length > 1) {
        const xs = it.points.map((p) => p.x), ys = it.points.map((p) => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        const w = Math.max(...xs) - x || 1, h = Math.max(...ys) - y || 1;
        const id = uid();
        setElements((p) => [...p, { id, type: 'path', points: it.points, x, y, w, h, stroke: '#0f172a', strokeWidth: 3 }]);
        setSelectedId(id);
      }
      setDraft(null); setTool('select');
    }
    interaction.current = null; setGuides([]); setHoverStitch(null);
  };

  /* ------------------------------ Export ----------------------------------- */
  const EXPORT_STEPS = [
    'Rasterising vector layers at 300 DPI…',
    'Embedding fonts & flattening transparency…',
    'Compiling print-ready PDF…',
  ];
  const runExport = async () => {
    for (let i = 0; i < EXPORT_STEPS.length; i++) {
      setExporting({ step: i, done: false });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 650));
    }
    const method = await exportPDF(elements, byId, poster, sizeKey);
    setExporting({ step: EXPORT_STEPS.length, done: true, method });
  };
  const exportSVG = () => {
    const svg = buildSVG(elements, byId, poster);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `sciposter_${sizeKey}.svg`);
  };

  /* ------------------------------- Theme ----------------------------------- */
  const t = dark
    ? { app:'bg-slate-950 text-slate-200', rail:'bg-slate-900 border-slate-800', panel:'bg-slate-900 border-slate-800',
        sub:'text-slate-400', input:'bg-slate-800 border-slate-700 text-slate-100', hover:'hover:bg-slate-800',
        chip:'bg-slate-800 border-slate-700', stage:'bg-slate-950' }
    : { app:'bg-slate-100 text-slate-800', rail:'bg-white border-slate-200', panel:'bg-white border-slate-200',
        sub:'text-slate-500', input:'bg-white border-slate-300 text-slate-900', hover:'hover:bg-slate-100',
        chip:'bg-slate-100 border-slate-200', stage:'bg-slate-200' };

  const canvasCursor = tool === 'pen' ? 'crosshair' : tool === 'connector' ? 'crosshair' : 'default';

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className={`w-full h-screen flex flex-col overflow-hidden select-none ${t.app}`}
         style={{ fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>

      {/* ============================== TOP BAR ============================== */}
      <header className={`flex items-center gap-3 px-4 h-14 border-b shrink-0 ${t.rail}`}>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Ruler size={17} className="text-white" strokeWidth={2.4} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight text-[15px]">SciPoster Studio</div>
            <div className={`text-[10px] uppercase tracking-[0.18em] ${t.sub}`}>Academic canvas engine</div>
          </div>
        </div>
        <div className="mx-1 h-6 w-px bg-current opacity-10" />

        {/* Poster size */}
        <label className={`text-xs ${t.sub}`}>Size</label>
        <div className="relative">
          <select value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}
                  className={`appearance-none pr-8 pl-3 h-9 rounded-lg border text-sm cursor-pointer ${t.input}`}>
            {Object.entries(POSTER_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <ChevronDown size={15} className={`absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none ${t.sub}`} />
        </div>

        {/* Custom size entry */}
        {sizeKey === 'custom' && (
          <div className={`flex items-center gap-1.5 rounded-lg border px-2 h-9 ${t.chip}`}>
            <CustomDim label="W" value={customSize.w} unit={unit} onChange={(mm) => setCustomSize((s) => ({ ...s, w: mm }))} t={t} />
            <span className={t.sub}>×</span>
            <CustomDim label="H" value={customSize.h} unit={unit} onChange={(mm) => setCustomSize((s) => ({ ...s, h: mm }))} t={t} />
            <button onClick={() => setUnit(unit === 'mm' ? 'in' : 'mm')}
                    className={`text-[11px] px-1.5 py-0.5 rounded ${t.hover}`}>{unit}</button>
          </div>
        )}

        {/* Zoom */}
        <div className={`flex items-center rounded-lg border overflow-hidden ${t.chip}`}>
          <button onClick={() => setZoomMode(clamp(+(zoom - 0.1).toFixed(2), 0.05, 4))} className={`h-9 w-9 grid place-items-center ${t.hover}`}><ZoomOut size={15} /></button>
          <div className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</div>
          <button onClick={() => setZoomMode(clamp(+(zoom + 0.1).toFixed(2), 0.05, 4))} className={`h-9 w-9 grid place-items-center ${t.hover}`}><ZoomIn size={15} /></button>
        </div>
        <div className={`flex items-center rounded-lg border overflow-hidden ${t.chip}`}>
          {ZOOM_PRESETS.map((z) => (
            <button key={z} onClick={() => setZoomMode(z)}
              className={`h-9 px-2.5 text-xs ${t.hover} ${zoomMode === z ? 'text-cyan-400 font-semibold' : ''}`}>
              {z === 'fit' ? <Maximize2 size={13} /> : `${z * 100}%`}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <button onClick={() => setSnapOn((s) => !s)} title="Toggle snapping"
          className={`h-9 px-3 rounded-lg border text-sm flex items-center gap-1.5 ${t.chip} ${t.hover} ${snapOn ? 'text-cyan-400' : t.sub}`}>
          <Magnet size={14} /> Snap
        </button>
        <button onClick={() => setDark((d) => !d)} className={`h-9 w-9 grid place-items-center rounded-lg border ${t.chip} ${t.hover}`}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button onClick={runExport}
          className="h-9 pl-3 pr-4 rounded-lg bg-gradient-to-br from-cyan-500 to-indigo-600 text-white text-sm font-medium flex items-center gap-2 shadow-lg shadow-cyan-500/25 hover:brightness-110 transition">
          <Download size={15} /> Export PDF
        </button>
      </header>

      {/* ============================ WORKSPACE ============================= */}
      <div className="flex flex-1 min-h-0">

        {/* --------------------------- LEFT TOOLBAR --------------------------- */}
        <nav className={`w-16 shrink-0 border-r flex flex-col items-center py-3 gap-1 ${t.rail}`}>
          <ToolButton icon={MousePointer2} label="Select (V)" theme={t} active={tool === 'select'}
            onClick={() => { setTool('select'); setMenu(null); }} />
          <div className="my-1 h-px w-8 bg-current opacity-10" />

          <ToolButton icon={Type} label="Text" theme={t} onClick={addText} />

          <FlyoutTool icon={LayoutTemplate} label="Section" theme={t}
            open={menu === 'section'} onToggle={() => setMenu(menu === 'section' ? null : 'section')}>
            <div className="text-[11px] uppercase tracking-wide mb-2 opacity-60 px-1">Scientific sections</div>
            <div className="grid grid-cols-1 gap-1">
              {SECTION_PRESETS.map((s) => (
                <button key={s.key} onClick={() => addSection(s)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left ${t.hover}`}>
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.accent }} />{s.label}
                </button>
              ))}
              <div className="my-1 h-px bg-current opacity-10" />
              <button onClick={addCustomSection}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left ${t.hover}`}>
                <Plus size={13} className="text-indigo-400" /> Custom section…
              </button>
              <div className="text-[10px] px-1 opacity-50">Add, then rename it in the sidebar.</div>
            </div>
          </FlyoutTool>

          <FlyoutTool icon={Square} label="Shape" theme={t}
            open={menu === 'shape'} onToggle={() => setMenu(menu === 'shape' ? null : 'shape')}>
            <div className="text-[11px] uppercase tracking-wide mb-2 opacity-60 px-1">Shapes</div>
            <div className="grid grid-cols-2 gap-1">
              {SHAPE_PRESETS.map((s) => (
                <button key={s.key} onClick={() => addShape(s)} className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-md ${t.hover}`}>
                  <s.icon size={18} /><span className="text-[11px]">{s.label}</span>
                </button>
              ))}
            </div>
          </FlyoutTool>

          {/* Connectors / arrows */}
          <FlyoutTool icon={ARROW_VARIANTS.find((v) => v.key === pendingVariant)?.icon || ArrowRight}
            label="Arrow / connector" theme={t} active={tool === 'connector'}
            open={menu === 'arrow'} onToggle={() => setMenu(menu === 'arrow' ? null : 'arrow')}>
            <div className="text-[11px] uppercase tracking-wide mb-2 opacity-60 px-1">Connectors</div>
            <div className="grid grid-cols-1 gap-0.5">
              {ARROW_VARIANTS.map((v) => (
                <button key={v.key}
                  onClick={() => { setPendingVariant(v.key); setTool('connector'); setMenu(null); }}
                  className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left ${t.hover} ${pendingVariant === v.key && tool === 'connector' ? 'text-cyan-400' : ''}`}>
                  <v.icon size={16} /> {v.label}
                </button>
              ))}
            </div>
            <div className="text-[10px] px-1 mt-1.5 opacity-60 leading-snug">
              Drag from one object to another to stitch. Endpoints follow their object until unstitched.
            </div>
          </FlyoutTool>

          <ToolButton icon={PenTool} label="Pen (freehand)" theme={t} active={tool === 'pen'}
            onClick={() => { setTool(tool === 'pen' ? 'select' : 'pen'); setMenu(null); }} />

          <label className="cursor-pointer">
            <div className={`w-11 h-11 grid place-items-center rounded-xl ${t.hover}`} title="Upload image"><ImagePlus size={19} /></div>
            <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
          </label>

          <div className="flex-1" />
          <div className={`text-[9px] text-center leading-tight ${t.sub} px-1`}>
            <Sparkles size={13} className="mx-auto mb-1 opacity-60" />snap<br/>engine
          </div>
        </nav>

        {/* ----------------------------- CANVAS ------------------------------ */}
        <main ref={viewportRef} className={`flex-1 min-w-0 overflow-auto relative ${t.stage}`}
          onPointerMove={onPointerMove} onPointerUp={endInteraction} onPointerCancel={endInteraction}
          onPointerDown={() => { if (tool === 'select') { setSelectedId(null); setMenu(null); } }}
          style={{ cursor: canvasCursor,
            backgroundImage: dark ? 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.10) 1px, transparent 0)'
                                  : 'radial-gradient(circle at 1px 1px, rgba(100,116,139,0.18) 1px, transparent 0)',
            backgroundSize: '22px 22px' }}>
          <div className="min-w-full min-h-full flex items-center justify-center p-8">
            <div className="relative" style={{ width: poster.w * zoom, height: poster.h * zoom }}>

              {/* Poster surface — element coords are POSTER mm */}
              <div ref={surfaceRef} className="absolute top-0 left-0 bg-white shadow-2xl"
                style={{ width: poster.w, height: poster.h, transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                onPointerDown={onSurfacePointerDown}>

                {/* Element layer */}
                {elements.filter(isBox).map((el) => (
                  <ElementView key={el.id} el={el}
                    selected={el.id === selectedId} editing={el.id === editingId}
                    stitchTarget={hoverStitch === el.id}
                    onPointerDown={(e) => beginMove(e, el)} onSelect={() => setSelectedId(el.id)}
                    onStartEdit={() => setEditingId(el.id)}
                    onCommitText={(f, v) => setElements((p) => p.map((x) => (x.id === el.id ? { ...x, [f]: v } : x)))}
                    onEndEdit={() => setEditingId(null)} />
                ))}

                {/* Connector + path layer (SVG, poster coords, above elements) */}
                <svg className="absolute top-0 left-0" width={poster.w} height={poster.h}
                     style={{ overflow: 'visible', pointerEvents: 'none' }}>
                  {elements.map((el) => {
                    if (el.type === 'connector') {
                      const { A, B } = resolveConnector(el, byId);
                      return <ConnectorView key={el.id} el={el} A={A} B={B} selected={el.id === selectedId}
                        onSelect={(e) => beginConnectorMove(e, el)} zoom={zoom} />;
                    }
                    if (el.type === 'path') {
                      return <PathView key={el.id} el={el} selected={el.id === selectedId}
                        onPointerDown={(e) => beginMove(e, el)} zoom={zoom} />;
                    }
                    return null;
                  })}
                  {/* Live draft while drawing */}
                  {draft?.kind === 'connector' && (() => {
                    const { A, B } = resolveConnector(draft, byId);
                    return <ConnectorView el={{ ...draft, stroke: '#06b6d4', strokeWidth: 3 }} A={A} B={B} draft zoom={zoom} />;
                  })()}
                  {draft?.kind === 'pen' && (
                    <polyline points={draft.points.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none" stroke="#06b6d4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </svg>
              </div>

              {/* Overlay: poster border + smart guides (screen space) */}
              <GuidesOverlay guides={guides} zoom={zoom} poster={poster} dark={dark} />

              {/* Selection handles */}
              {selected && isBox(selected) && (
                <SelectionOverlay el={selected} zoom={zoom} onResizeStart={beginResize} />
              )}
              {selected && selected.type === 'connector' && (
                <ConnectorHandles el={selected} byId={byId} zoom={zoom} onEndpointStart={beginEndpoint} />
              )}
            </div>
          </div>

          {elements.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className={`text-center ${t.sub}`}>
                <LayoutTemplate size={40} className="mx-auto mb-3 opacity-40" />
                <div className="text-sm">Add a section or text block from the left toolbar</div>
                <div className="text-xs mt-1 opacity-70">Drag to move · drag handles to resize · both snap to neighbours</div>
              </div>
            </div>
          )}
        </main>

        {/* -------------------------- RIGHT SIDEBAR -------------------------- */}
        <aside className={`w-72 shrink-0 border-l overflow-y-auto ${t.panel}`}>
          <PropertiesPanel theme={t} selected={selected} poster={poster} elements={elements}
            onPatch={patchSelected} onDelete={deleteSelected} onDuplicate={duplicateSelected}
            onFront={bringToFront} onExportSVG={exportSVG} elementCount={elements.length}
            onUnstitch={(which) => patchSelected({ [which]: (() => {
              const { A, B } = resolveConnector(selected, byId);
              const pt = which === 'start' ? A : B;
              return { elId: null, anchor: 'auto', x: pt.x, y: pt.y };
            })() })} />
        </aside>
      </div>

      {exporting && (
        <ExportModal theme={t} state={exporting} steps={EXPORT_STEPS} sizeKey={sizeKey} poster={poster}
          onClose={() => setExporting(null)} onExportSVG={exportSVG} />
      )}
    </div>
  );
}

/* Convert stitched endpoints to free (last position) before removing an element,
   so connectors survive the deletion of what they were attached to. */
function detachAndRemove(prev, id, byId) {
  return prev.filter((e) => e.id !== id).map((e) => {
    if (e.type !== 'connector') return e;
    if (e.start.elId !== id && e.end.elId !== id) return e;
    const { A, B } = resolveConnector(e, byId);
    const c = { ...e };
    if (c.start.elId === id) c.start = { elId: null, anchor: 'auto', x: A.x, y: A.y };
    if (c.end.elId === id)   c.end   = { elId: null, anchor: 'auto', x: B.x, y: B.y };
    return c;
  });
}
const roundBox = (b) => ({ x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) });

/* ============================================================================
   ELEMENT VIEW
   ========================================================================== */
function ElementView({ el, selected, editing, stitchTarget, onPointerDown, onStartEdit, onCommitText, onEndEdit }) {
  const base = { position: 'absolute', left: el.x, top: el.y, width: el.w, height: el.h,
    cursor: editing ? 'text' : 'move',
    outline: stitchTarget ? '2px solid #06b6d4' : selected ? '1px solid rgba(6,182,212,0.9)' : 'none',
    outlineOffset: '-1px' };

  if (el.type === 'text') {
    const style = { ...base, padding: 8, fontSize: el.fontSize, color: el.color, fontWeight: el.bold ? 700 : 400,
      textAlign: el.align, lineHeight: el.lineHeight, background: selected ? 'rgba(6,182,212,0.04)' : 'transparent',
      overflow: 'hidden', wordBreak: 'break-word' };
    if (editing) return (
      <textarea autoFocus defaultValue={el.text} onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => { onCommitText('text', e.target.value); onEndEdit(); }}
        style={{ ...style, resize: 'none', border: 'none', outline: '1px solid #06b6d4' }} />
    );
    return <div style={style} onPointerDown={onPointerDown} onDoubleClick={onStartEdit}>{el.text}</div>;
  }

  if (el.type === 'section') return (
    <div style={{ ...base, background: el.fill, borderRadius: 6, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
      onPointerDown={onPointerDown} onDoubleClick={onStartEdit}>
      <div style={{ background: el.accent, color: '#fff', padding: '6px 10px', fontSize: Math.max(13, el.fontSize + 2), fontWeight: 700 }}>{el.title}</div>
      {editing ? (
        <textarea autoFocus defaultValue={el.text} onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => { onCommitText('text', e.target.value); onEndEdit(); }}
          style={{ width: '100%', height: 'calc(100% - 34px)', resize: 'none', border: 'none', outline: 'none',
            padding: 10, fontSize: el.fontSize, color: el.color, textAlign: el.align, lineHeight: el.lineHeight, background: 'transparent' }} />
      ) : (
        <div style={{ padding: 10, fontSize: el.fontSize, color: el.color, textAlign: el.align, lineHeight: el.lineHeight, overflow: 'hidden' }}>{el.text}</div>
      )}
    </div>
  );

  if (el.type === 'image') return (
    <div style={{ ...base, overflow: 'hidden', borderRadius: 4 }} onPointerDown={onPointerDown}>
      <img src={el.src} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
    </div>
  );

  if (el.type === 'shape') return (
    <div style={base} onPointerDown={onPointerDown}>
      <svg width={el.w} height={el.h} style={{ display: 'block', overflow: 'visible' }}>
        {el.shape === 'rect' && <rect x={el.strokeWidth/2} y={el.strokeWidth/2}
          width={Math.max(0, el.w - el.strokeWidth)} height={Math.max(0, el.h - el.strokeWidth)} rx="4"
          fill={el.fill} stroke={el.stroke} strokeWidth={el.strokeWidth} />}
        {el.shape === 'ellipse' && <ellipse cx={el.w/2} cy={el.h/2}
          rx={Math.max(0, el.w/2 - el.strokeWidth/2)} ry={Math.max(0, el.h/2 - el.strokeWidth/2)}
          fill={el.fill} stroke={el.stroke} strokeWidth={el.strokeWidth} />}
      </svg>
    </div>
  );
  return null;
}

/* ============================================================================
   CONNECTOR VIEW — resolves geometry, draws heads + routing, has a fat hit path.
   ========================================================================== */
function connectorPath(A, B, routing) {
  if (routing === 'elbow') {
    const mx = (A.x + B.x) / 2;
    return `M ${A.x} ${A.y} L ${mx} ${A.y} L ${mx} ${B.y} L ${B.x} ${B.y}`;
  }
  if (routing === 'curved') {
    const dx = (B.x - A.x) * 0.45;
    return `M ${A.x} ${A.y} C ${A.x + dx} ${A.y}, ${B.x - dx} ${B.y}, ${B.x} ${B.y}`;
  }
  return `M ${A.x} ${A.y} L ${B.x} ${B.y}`;
}
function Head({ id, kind, stroke }) {
  if (kind === 'none') return null;
  const common = { id, markerWidth: 10, markerHeight: 10, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' };
  if (kind === 'triangle') return <marker {...common} refX="7" refY="3.5"><path d="M0,0 L8,3.5 L0,7 Z" fill={stroke} /></marker>;
  if (kind === 'open')     return <marker {...common} refX="7" refY="3.5"><path d="M0,0 L8,3.5 L0,7" fill="none" stroke={stroke} strokeWidth="1.4" /></marker>;
  if (kind === 'dot')      return <marker {...common} refX="3.5" refY="3.5"><circle cx="3.5" cy="3.5" r="3" fill={stroke} /></marker>;
  return null;
}
function ConnectorView({ el, A, B, selected, onSelect, draft, zoom }) {
  const v = variantByKey[el.variant] || variantByKey.arrow;
  const d = connectorPath(A, B, v.routing);
  const sId = `s_${el.id || 'draft'}`, eId = `e_${el.id || 'draft'}`;
  return (
    <g>
      <defs>
        <Head id={sId} kind={v.startHead} stroke={el.stroke} />
        <Head id={eId} kind={v.endHead} stroke={el.stroke} />
      </defs>
      {/* fat invisible hit target */}
      {!draft && (
        <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(el.strokeWidth * 3, 12)}
          style={{ pointerEvents: 'stroke', cursor: 'move' }} onPointerDown={onSelect} />
      )}
      {selected && <path d={d} fill="none" stroke="#06b6d4" strokeWidth={el.strokeWidth + 4} opacity="0.25" style={{ pointerEvents: 'none' }} />}
      <path d={d} fill="none" stroke={el.stroke} strokeWidth={el.strokeWidth} strokeLinecap="round"
        strokeDasharray={el.dashed ? '10 7' : undefined}
        markerStart={v.startHead !== 'none' ? `url(#${sId})` : undefined}
        markerEnd={v.endHead !== 'none' ? `url(#${eId})` : undefined}
        style={{ pointerEvents: 'none' }} />
    </g>
  );
}

/* Freehand path */
function PathView({ el, selected, onPointerDown }) {
  return (
    <g>
      <polyline points={el.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none"
        stroke="transparent" strokeWidth={Math.max(el.strokeWidth * 3, 12)}
        style={{ pointerEvents: 'stroke', cursor: 'move' }} onPointerDown={onPointerDown} />
      <polyline points={el.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none"
        stroke={el.stroke} strokeWidth={el.strokeWidth} strokeLinecap="round" strokeLinejoin="round"
        style={{ pointerEvents: 'none' }} />
      {selected && <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke="#06b6d4" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />}
    </g>
  );
}

/* ============================================================================
   GUIDES OVERLAY (screen space) — alignment lines, equal-size brackets, gaps.
   ========================================================================== */
function GuidesOverlay({ guides, zoom, poster, dark }) {
  const W = poster.w * zoom, H = poster.h * zoom;
  return (
    <svg className="absolute top-0 left-0 pointer-events-none" width={W} height={H} style={{ overflow: 'visible' }}>
      <rect x="0.5" y="0.5" width={W - 1} height={H - 1} fill="none" stroke={dark ? '#334155' : '#cbd5e1'} strokeWidth="1" />
      {guides.map((g, i) => {
        if (g.type === 'align') {
          const isX = g.axis === 'x'; const p = g.pos * zoom, a = g.start * zoom, b = g.end * zoom;
          return (
            <g key={i}>
              <line x1={isX ? p : a} y1={isX ? a : p} x2={isX ? p : b} y2={isX ? b : p} stroke="#ec4899" strokeWidth="1" strokeDasharray="5 4" />
              {[a, b].map((c, j) => <circle key={j} r="2.5" fill="#ec4899" cx={isX ? p : c} cy={isX ? c : p} />)}
            </g>
          );
        }
        if (g.type === 'equalW' || g.type === 'equalH') {
          const horiz = g.type === 'equalW';
          const bracket = (box) => {
            if (horiz) { const cy = (box.y + box.h / 2) * zoom, x1 = box.x * zoom, x2 = (box.x + box.w) * zoom;
              return <g key={Math.random()}><line x1={x1} y1={cy} x2={x2} y2={cy} stroke="#06b6d4" strokeWidth="1.5" />
                <line x1={x1} y1={cy-4} x2={x1} y2={cy+4} stroke="#06b6d4" strokeWidth="1.5" />
                <line x1={x2} y1={cy-4} x2={x2} y2={cy+4} stroke="#06b6d4" strokeWidth="1.5" /></g>; }
            const cx = (box.x + box.w / 2) * zoom, y1 = box.y * zoom, y2 = (box.y + box.h) * zoom;
            return <g key={Math.random()}><line x1={cx} y1={y1} x2={cx} y2={y2} stroke="#06b6d4" strokeWidth="1.5" />
              <line x1={cx-4} y1={y1} x2={cx+4} y2={y1} stroke="#06b6d4" strokeWidth="1.5" />
              <line x1={cx-4} y1={y2} x2={cx+4} y2={y2} stroke="#06b6d4" strokeWidth="1.5" /></g>;
          };
          const lx = (g.a.x + g.a.w / 2) * zoom, ly = (g.a.y + g.a.h / 2) * zoom;
          return (
            <g key={i}>
              {bracket(g.a)}{bracket(g.b)}
              <g transform={`translate(${lx - 26}, ${ly - 9})`}>
                <rect width="52" height="18" rx="9" fill="#06b6d4" />
                <text x="26" y="13" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">= {round(g.value)}mm</text>
              </g>
            </g>
          );
        }
        if (g.type === 'gapX' || g.type === 'gapY') {
          const horiz = g.type === 'gapX';
          const mid = horiz ? (g.box.y + g.box.h / 2) * zoom : (g.box.x + g.box.w / 2) * zoom;
          const seg = (from, to) => horiz
            ? <line x1={from * zoom} y1={mid} x2={to * zoom} y2={mid} stroke="#ec4899" strokeWidth="1.5" />
            : <line x1={mid} y1={from * zoom} x2={mid} y2={to * zoom} stroke="#ec4899" strokeWidth="1.5" />;
          const l = g.left, r = g.right, b = g.box;
          return (
            <g key={i}>
              {horiz ? seg(l.x + l.w, b.x) : seg(l.y + l.h, b.y)}
              {horiz ? seg(b.x + b.w, r.x) : seg(b.y + b.h, r.y)}
            </g>
          );
        }
        return null;
      })}
    </svg>
  );
}

/* ============================================================================
   SELECTION OVERLAY (box) — 8 constant-size resize handles.
   ========================================================================== */
const HANDLES = [['nw',0,0],['n',0.5,0],['ne',1,0],['w',0,0.5],['e',1,0.5],['sw',0,1],['s',0.5,1],['se',1,1]];
const CURSORS = { nw:'nwse-resize', ne:'nesw-resize', sw:'nesw-resize', se:'nwse-resize', n:'ns-resize', s:'ns-resize', e:'ew-resize', w:'ew-resize' };
function SelectionOverlay({ el, zoom, onResizeStart }) {
  const left = el.x * zoom, top = el.y * zoom, w = el.w * zoom, h = el.h * zoom;
  return (
    <div className="absolute pointer-events-none" style={{ left, top, width: w, height: h }}>
      <div className="absolute -top-6 left-0 text-[10px] px-1.5 py-0.5 rounded bg-cyan-500 text-white font-medium tabular-nums whitespace-nowrap">
        {round(el.w)} × {round(el.h)} mm
      </div>
      {HANDLES.map(([name, fx, fy]) => (
        <div key={name} onPointerDown={(e) => onResizeStart(e, el, name)} className="absolute bg-white rounded-sm shadow"
          style={{ width: HANDLE_PX, height: HANDLE_PX, left: fx * w - HANDLE_PX / 2, top: fy * h - HANDLE_PX / 2,
            border: '1.5px solid #06b6d4', cursor: CURSORS[name], pointerEvents: 'auto' }} />
      ))}
    </div>
  );
}

/* Connector endpoint handles: filled = stitched, hollow = free. */
function ConnectorHandles({ el, byId, zoom, onEndpointStart }) {
  const { A, B } = resolveConnector(el, byId);
  const dot = (pt, which, stitched) => (
    <div onPointerDown={(e) => onEndpointStart(e, el, which)} title={stitched ? 'Stitched — drag to move' : 'Free — drag onto an object to stitch'}
      className="absolute rounded-full shadow" style={{ width: 14, height: 14, left: pt.x * zoom - 7, top: pt.y * zoom - 7,
        border: '2px solid #06b6d4', background: stitched ? '#06b6d4' : '#fff', cursor: 'grab', pointerEvents: 'auto' }} />
  );
  return (
    <div className="absolute top-0 left-0 pointer-events-none" style={{ width: '100%', height: '100%' }}>
      {dot(A, 'start', el.start.elId != null)}
      {dot(B, 'end', el.end.elId != null)}
    </div>
  );
}

/* ============================================================================
   PROPERTIES PANEL
   ========================================================================== */
function Group({ t, title, children }) {
  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(120,120,120,0.12)' }}>
      <div className={`text-[11px] uppercase tracking-[0.15em] mb-2.5 ${t.sub}`}>{title}</div>{children}
    </div>
  );
}
function NumField({ t, label, value, onChange, min = -9999, max = 9999 }) {
  return (
    <label className="flex-1">
      <div className={`text-[10px] mb-1 ${t.sub}`}>{label}</div>
      <input type="number" value={round(value)} min={min} max={max}
        onChange={(e) => onChange(clamp(+e.target.value, min, max))}
        className={`w-full h-8 px-2 rounded-md border text-xs tabular-nums ${t.input}`} />
    </label>
  );
}
function Row({ t, k, v }) {
  if (v === undefined) return null;
  return <div className="flex justify-between py-0.5 text-sm"><span className={t.sub}>{k}</span><span className="tabular-nums">{v}</span></div>;
}
function IconBtn({ t, children, onClick, title, danger }) {
  return <button title={title} onClick={onClick}
    className={`h-7 w-7 grid place-items-center rounded-md border ${t.chip} ${t.hover} ${danger ? 'hover:text-red-500' : ''}`}>{children}</button>;
}
function ColorRow({ t, value, onChange, swatches }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {swatches.map((c) => (
        <button key={c} onClick={() => onChange(c)} className={`w-6 h-6 rounded-md border ${value === c ? 'ring-2 ring-cyan-400' : ''}`}
          style={{ background: c === 'none' ? 'repeating-conic-gradient(#cbd5e1 0% 25%, #fff 0% 50%) 50%/8px 8px' : c, borderColor: 'rgba(120,120,120,0.3)' }} title={c} />
      ))}
      <input type="color" value={value === 'none' ? '#ffffff' : value} onChange={(e) => onChange(e.target.value)}
        className="w-6 h-6 rounded-md border-0 bg-transparent cursor-pointer" />
    </div>
  );
}
function CustomDim({ label, value, unit, onChange, t }) {
  // value is stored in mm; display/enter in the chosen unit.
  const disp = unit === 'in' ? +(value / 25.4).toFixed(2) : value;
  return (
    <span className="flex items-center gap-1">
      <span className={`text-[10px] ${t.sub}`}>{label}</span>
      <input type="number" value={disp}
        onChange={(e) => { const n = +e.target.value; onChange(clamp(unit === 'in' ? Math.round(n * 25.4) : Math.round(n), 50, 4000)); }}
        className={`w-14 h-6 px-1 rounded border text-xs tabular-nums ${t.input}`} />
    </span>
  );
}

function PropertiesPanel({ theme: t, selected, poster, elements, onPatch, onDelete, onDuplicate, onFront, onExportSVG, onUnstitch, elementCount }) {
  if (!selected) {
    return (
      <div className="p-4">
        <div className={`text-[11px] uppercase tracking-[0.15em] mb-3 ${t.sub}`}>Canvas</div>
        <div className={`rounded-lg border p-3 text-sm ${t.chip}`}>
          <Row t={t} k="Width" v={`${poster.w} mm`} /><Row t={t} k="Height" v={`${poster.h} mm`} />
          <Row t={t} k="Elements" v={elementCount} />
        </div>
        <div className={`mt-4 text-xs leading-relaxed ${t.sub}`}>
          Select an element to edit it. Drag to move or resize — pink guides show alignment & equal spacing,
          cyan brackets appear when a dimension matches another element's.
        </div>
        <button onClick={onExportSVG} className={`mt-4 w-full h-9 rounded-lg border text-sm flex items-center justify-center gap-2 ${t.chip} ${t.hover}`}>
          <FileText size={14} /> Export lossless SVG
        </button>
      </div>
    );
  }

  const type = selected.type;
  const isConnector = type === 'connector';
  return (
    <div>
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: 'rgba(120,120,120,0.15)' }}>
        <div className="text-sm font-semibold capitalize">{isConnector ? (selected.custom ? 'Connector' : 'Connector') : type}</div>
        <div className="flex gap-1">
          <IconBtn t={t} title="Duplicate" onClick={onDuplicate}><Copy size={14} /></IconBtn>
          {!isConnector && <IconBtn t={t} title="Bring to front" onClick={onFront}><BringToFront size={14} /></IconBtn>}
          <IconBtn t={t} title="Delete" onClick={onDelete} danger><Trash2 size={14} /></IconBtn>
        </div>
      </div>

      {/* Geometry (boxes only) */}
      {!isConnector && (
        <Group t={t} title="Position & size">
          <div className="flex gap-2 mb-2">
            <NumField t={t} label="X (mm)" value={selected.x} min={0} max={poster.w} onChange={(v) => onPatch({ x: clamp(v, 0, poster.w - selected.w) })} />
            <NumField t={t} label="Y (mm)" value={selected.y} min={0} max={poster.h} onChange={(v) => onPatch({ y: clamp(v, 0, poster.h - selected.h) })} />
          </div>
          <div className="flex gap-2">
            <NumField t={t} label="W (mm)" value={selected.w} min={MIN_SIZE_MM} max={poster.w} onChange={(v) => onPatch({ w: clamp(v, MIN_SIZE_MM, poster.w - selected.x) })} />
            <NumField t={t} label="H (mm)" value={selected.h} min={MIN_SIZE_MM} max={poster.h} onChange={(v) => onPatch({ h: clamp(v, MIN_SIZE_MM, poster.h - selected.y) })} />
          </div>
        </Group>
      )}

      {/* Section heading — this is where a custom section is named */}
      {type === 'section' && (
        <Group t={t} title={selected.custom ? 'Custom section' : 'Heading'}>
          <div className={`text-[10px] mb-1 ${t.sub}`}>Title</div>
          <input value={selected.title} onChange={(e) => onPatch({ title: e.target.value })}
            placeholder="Name this section…" className={`w-full h-8 px-2 rounded-md border text-sm ${t.input}`} />
          <div className={`text-[10px] mt-2 mb-1 ${t.sub}`}>Accent</div>
          <ColorRow t={t} value={selected.accent} onChange={(c) => onPatch({ accent: c })}
            swatches={['#4f46e5','#0891b2','#16a34a','#dc2626','#ea580c','#6366f1']} />
          <div className={`text-[10px] mt-2 mb-1 ${t.sub}`}>Background</div>
          <ColorRow t={t} value={selected.fill} onChange={(c) => onPatch({ fill: c })}
            swatches={['#eef2ff','#ecfeff','#f0fdf4','#fef2f2','#fff7ed','#f1f5f9']} />
        </Group>
      )}

      {/* Typography */}
      {(type === 'text' || type === 'section') && (
        <Group t={t} title="Typography">
          <div className="flex items-center gap-2 mb-2.5">
            <NumField t={t} label="Font size" value={selected.fontSize} min={6} max={200} onChange={(v) => onPatch({ fontSize: clamp(v, 6, 200) })} />
            <label className="flex-1">
              <div className={`text-[10px] mb-1 ${t.sub}`}>Line height</div>
              <input type="number" step="0.1" value={selected.lineHeight} onChange={(e) => onPatch({ lineHeight: clamp(+e.target.value, 0.8, 3) })}
                className={`w-full h-8 px-2 rounded-md border text-xs ${t.input}`} />
            </label>
          </div>
          <div className="flex gap-1.5">
            {type === 'text' && (
              <button onClick={() => onPatch({ bold: !selected.bold })}
                className={`h-8 w-8 grid place-items-center rounded-md border ${t.chip} ${selected.bold ? 'text-cyan-400' : ''}`}><Bold size={14} /></button>
            )}
            {[['left',AlignLeft],['center',AlignCenter],['right',AlignRight]].map(([a, Icon]) => (
              <button key={a} onClick={() => onPatch({ align: a })}
                className={`h-8 w-8 grid place-items-center rounded-md border ${t.chip} ${selected.align === a ? 'text-cyan-400' : ''}`}><Icon size={14} /></button>
            ))}
            <input type="color" value={selected.color} onChange={(e) => onPatch({ color: e.target.value })}
              className="h-8 w-8 rounded-md border-0 bg-transparent cursor-pointer" title="Text colour" />
          </div>
        </Group>
      )}

      {/* Shape / path style */}
      {(type === 'shape' || type === 'path') && (
        <Group t={t} title="Style">
          <div className={`text-[10px] mb-1 ${t.sub}`}>Stroke</div>
          <ColorRow t={t} value={selected.stroke} onChange={(c) => onPatch({ stroke: c })}
            swatches={['#0e7490','#dc2626','#16a34a','#7c3aed','#0f172a','#f59e0b']} />
          {type === 'shape' && (<>
            <div className={`text-[10px] mt-3 mb-1 ${t.sub}`}>Fill</div>
            <ColorRow t={t} value={selected.fill} onChange={(c) => onPatch({ fill: c })}
              swatches={['none','#cffafe','#fee2e2','#dcfce7','#ede9fe','#fef9c3']} />
          </>)}
          <label className="block mt-3">
            <div className={`text-[10px] mb-1 ${t.sub}`}>Stroke width: {selected.strokeWidth}px</div>
            <input type="range" min="1" max="20" value={selected.strokeWidth} onChange={(e) => onPatch({ strokeWidth: +e.target.value })} className="w-full accent-cyan-500" />
          </label>
        </Group>
      )}

      {/* Connector controls */}
      {isConnector && (
        <>
          <Group t={t} title="Connector style">
            <div className="grid grid-cols-4 gap-1">
              {ARROW_VARIANTS.map((v) => (
                <button key={v.key} title={v.label} onClick={() => onPatch({ variant: v.key, dashed: v.dashed })}
                  className={`h-9 grid place-items-center rounded-md border ${t.chip} ${selected.variant === v.key ? 'text-cyan-400 ring-1 ring-cyan-400' : ''}`}>
                  <v.icon size={16} />
                </button>
              ))}
            </div>
            <div className={`text-[10px] mt-3 mb-1 ${t.sub}`}>Colour</div>
            <ColorRow t={t} value={selected.stroke} onChange={(c) => onPatch({ stroke: c })}
              swatches={['#0f172a','#0e7490','#dc2626','#16a34a','#7c3aed','#ea580c']} />
            <label className="block mt-3">
              <div className={`text-[10px] mb-1 ${t.sub}`}>Thickness: {selected.strokeWidth}px</div>
              <input type="range" min="1" max="16" value={selected.strokeWidth} onChange={(e) => onPatch({ strokeWidth: +e.target.value })} className="w-full accent-cyan-500" />
            </label>
          </Group>
          <Group t={t} title="Stitching">
            {['start','end'].map((which) => {
              const stitched = selected[which].elId != null;
              return (
                <div key={which} className="flex items-center justify-between mb-1.5">
                  <span className="text-sm capitalize flex items-center gap-1.5">
                    {stitched ? <Link2 size={13} className="text-cyan-400" /> : <Unlink size={13} className={t.sub} />}
                    {which} {stitched ? '· linked' : '· free'}
                  </span>
                  {stitched && (
                    <button onClick={() => onUnstitch(which)} className={`text-xs px-2 py-1 rounded-md border ${t.chip} ${t.hover}`}>Unstitch</button>
                  )}
                </div>
              );
            })}
            <div className={`text-[10px] mt-1 ${t.sub} leading-snug`}>
              Drag an endpoint onto an object to stitch it. Stitched ends follow the object; deleting the object leaves the arrow in place.
            </div>
          </Group>
        </>
      )}
    </div>
  );
}

/* ============================================================================
   EXPORT — real vector PDF (jsPDF+svg2pdf if available) with print fallback.
   ========================================================================== */
function ExportModal({ theme: t, state, steps, onClose, onExportSVG, sizeKey, poster }) {
  const pxW = Math.round((poster.w / 25.4) * 300), pxH = Math.round((poster.h / 25.4) * 300);
  const methodMsg = state.method === 'pdf' ? 'PDF downloaded (true vector via jsPDF).'
    : state.method === 'print' ? 'Opened a print view — choose “Save as PDF”.'
    : 'Downloaded a print-ready HTML — open it and print to PDF.';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`w-[420px] rounded-2xl border shadow-2xl overflow-hidden ${t.panel}`}>
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: 'rgba(120,120,120,0.15)' }}>
          <div className="flex items-center gap-2 font-semibold"><Download size={16} className="text-cyan-400" /> Export poster</div>
          <button onClick={onClose} className={`h-7 w-7 grid place-items-center rounded-md ${t.hover}`}><X size={15} /></button>
        </div>
        <div className="px-5 py-4">
          <div className={`text-xs mb-4 ${t.sub}`}>
            Target: <span className="font-medium">{sizeKey}</span> · {pxW.toLocaleString()} × {pxH.toLocaleString()} px @ 300 DPI · vector pipeline
          </div>
          <div className="space-y-2.5">
            {steps.map((label, i) => {
              const done = state.done || state.step > i, active = !state.done && state.step === i;
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className={`h-5 w-5 grid place-items-center rounded-full shrink-0 ${done ? 'bg-cyan-500 text-white' : active ? 'bg-cyan-500/20 text-cyan-400' : t.chip}`}>
                    {done ? <Check size={12} /> : active ? <Loader2 size={12} className="animate-spin" /> : i + 1}
                  </span>
                  <span className={done || active ? '' : t.sub}>{label}</span>
                </div>
              );
            })}
          </div>
          {state.done && (
            <div className="mt-5 p-3 rounded-lg text-sm flex items-start gap-2" style={{ background: 'rgba(6,182,212,0.10)' }}>
              <Check size={16} className="text-cyan-400 mt-0.5 shrink-0" />
              <div><div className="font-medium">Export complete</div><div className={`text-xs mt-0.5 ${t.sub}`}>{methodMsg}</div></div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 flex justify-end gap-2 border-t" style={{ borderColor: 'rgba(120,120,120,0.15)' }}>
          <button onClick={onExportSVG} className={`h-9 px-3 rounded-lg border text-sm flex items-center gap-2 ${t.chip} ${t.hover}`}><FileText size={14} /> Download SVG</button>
          <button onClick={onClose} className="h-9 px-4 rounded-lg bg-gradient-to-br from-cyan-500 to-indigo-600 text-white text-sm font-medium">Done</button>
        </div>
      </div>
    </div>
  );
}

/* ---- Export helpers ---- */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function exportPDF(elements, byId, poster, sizeKey) {
  const svg = buildSVG(elements, byId, poster);
  // Preferred: real vector PDF if the host project has the libs installed.
  try {
    const jspdfMod = await import(/* @vite-ignore */ 'jspdf');
    const svg2pdfMod = await import(/* @vite-ignore */ 'svg2pdf.js');
    const jsPDF = jspdfMod.jsPDF || jspdfMod.default;
    const doc = new jsPDF({ unit: 'mm', format: [poster.w, poster.h], orientation: poster.w > poster.h ? 'l' : 'p' });
    const node = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    if (typeof doc.svg === 'function') await doc.svg(node, { x: 0, y: 0, width: poster.w, height: poster.h });
    else await (svg2pdfMod.svg2pdf || svg2pdfMod.default)(node, doc, { x: 0, y: 0, width: poster.w, height: poster.h });
    doc.save(`sciposter_${sizeKey}.pdf`);
    return 'pdf';
  } catch (_e) {
    // Fallback that works everywhere: print-ready HTML → browser "Save as PDF".
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>SciPoster ${sizeKey}</title>
<style>@page{size:${poster.w}mm ${poster.h}mm;margin:0}html,body{margin:0}svg{display:block}</style></head>
<body onload="setTimeout(function(){window.print()},250)">${svg}</body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const win = window.open(url, '_blank');
    if (win) { setTimeout(() => URL.revokeObjectURL(url), 8000); return 'print'; }
    downloadBlob(new Blob([html], { type: 'text/html' }), `sciposter_${sizeKey}_print.html`);
    URL.revokeObjectURL(url); return 'html';
  }
}

/* ---- Standalone SVG serialisation (mirrors on-canvas rendering) ---- */
function esc(s = '') { return String(s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c])); }
function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > maxChars) { if (line) lines.push(line); line = w; } else line = (line + ' ' + w).trim(); }
  if (line) lines.push(line); return lines;
}
function buildSVG(elements, byId, poster) {
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${poster.w}mm" height="${poster.h}mm" viewBox="0 0 ${poster.w} ${poster.h}">`);
  p.push(`<rect width="${poster.w}" height="${poster.h}" fill="#ffffff"/>`);
  const defs = [];
  for (const el of elements) {
    if (el.type === 'section') {
      p.push(`<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="6" fill="${el.fill}"/>`);
      p.push(`<rect x="${el.x}" y="${el.y}" width="${el.w}" height="26" fill="${el.accent}"/>`);
      p.push(`<text x="${el.x+10}" y="${el.y+18}" font-family="sans-serif" font-size="${Math.max(13, el.fontSize+2)}" font-weight="700" fill="#fff">${esc(el.title)}</text>`);
      wrapText(el.text, Math.max(10, Math.floor(el.w/(el.fontSize*0.5)))).forEach((ln, i) => {
        const ty = el.y + 40 + i*el.fontSize*el.lineHeight;
        if (ty < el.y+el.h-4) p.push(`<text x="${el.x+10}" y="${ty}" font-family="sans-serif" font-size="${el.fontSize}" fill="${el.color}">${esc(ln)}</text>`);
      });
    } else if (el.type === 'text') {
      const anchor = el.align === 'center' ? 'middle' : el.align === 'right' ? 'end' : 'start';
      const tx = el.align === 'center' ? el.x+el.w/2 : el.align === 'right' ? el.x+el.w-8 : el.x+8;
      wrapText(el.text, Math.max(8, Math.floor(el.w/(el.fontSize*0.52)))).forEach((ln, i) => {
        const ty = el.y + el.fontSize + i*el.fontSize*el.lineHeight + 4;
        p.push(`<text x="${tx}" y="${ty}" font-family="sans-serif" font-size="${el.fontSize}" font-weight="${el.bold?700:400}" fill="${el.color}" text-anchor="${anchor}">${esc(ln)}</text>`);
      });
    } else if (el.type === 'image') {
      p.push(`<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" preserveAspectRatio="xMidYMid slice" href="${el.src}"/>`);
    } else if (el.type === 'shape') {
      const sw = el.strokeWidth;
      if (el.shape === 'rect') p.push(`<rect x="${el.x+sw/2}" y="${el.y+sw/2}" width="${el.w-sw}" height="${el.h-sw}" rx="4" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${sw}"/>`);
      else p.push(`<ellipse cx="${el.x+el.w/2}" cy="${el.y+el.h/2}" rx="${el.w/2-sw/2}" ry="${el.h/2-sw/2}" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${sw}"/>`);
    } else if (el.type === 'path') {
      p.push(`<polyline points="${el.points.map((q) => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else if (el.type === 'connector') {
      const v = variantByKey[el.variant] || variantByKey.arrow;
      const { A, B } = resolveConnector(el, byId);
      const d = connectorPath(A, B, v.routing);
      const headSVG = (id, kind) => kind === 'triangle' ? `<marker id="${id}" markerWidth="10" markerHeight="10" refX="7" refY="3.5" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L8,3.5 L0,7 Z" fill="${el.stroke}"/></marker>`
        : kind === 'open' ? `<marker id="${id}" markerWidth="10" markerHeight="10" refX="7" refY="3.5" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L8,3.5 L0,7" fill="none" stroke="${el.stroke}" stroke-width="1.4"/></marker>`
        : kind === 'dot' ? `<marker id="${id}" markerWidth="10" markerHeight="10" refX="3.5" refY="3.5" orient="auto" markerUnits="strokeWidth"><circle cx="3.5" cy="3.5" r="3" fill="${el.stroke}"/></marker>` : '';
      const sId = `s${el.id}`, eId = `e${el.id}`;
      if (v.startHead !== 'none') defs.push(headSVG(sId, v.startHead));
      if (v.endHead !== 'none') defs.push(headSVG(eId, v.endHead));
      p.push(`<path d="${d}" fill="none" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" stroke-linecap="round" ${el.dashed?'stroke-dasharray="10 7"':''} ${v.startHead!=='none'?`marker-start="url(#${sId})"`:''} ${v.endHead!=='none'?`marker-end="url(#${eId})"`:''}/>`);
    }
  }
  if (defs.length) p.splice(1, 0, `<defs>${defs.join('')}</defs>`);
  p.push(`</svg>`);
  return p.join('\n');
}
