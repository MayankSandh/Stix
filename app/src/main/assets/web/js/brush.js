// Eraser / restore brush editor with undo, pinch-zoom and pan.
const MAX_UNDO = 12; // each step is a full canvas copy (~4 MB at 1024x1024)
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export class BrushEditor {
  constructor(canvas, { onHistoryChange, onViewChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHistoryChange = onHistoryChange || (() => {});
    this.onViewChange = onViewChange || (() => {});
    this.dirty = false;
    this.mode = 'erase';
    this.brushSize = 40; // diameter in CSS px, constant on screen regardless of zoom
    this.pointers = new Map();
    this.stroke = null;
    this.pinch = null;
    this.cursor = null;
    this.undoStack = [];
    this.redoStack = [];
    this.view = { scale: 1, ox: 0, oy: 0 };

    new ResizeObserver(() => this.layout(false)).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.stroke) { this.cursor = null; this.requestDraw(); }
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /**
   * @param {HTMLCanvasElement} original untouched pixels (what Restore paints back)
   * @param {HTMLCanvasElement} [start] starting point, e.g. with earlier erasing; defaults to original
   */
  setImage(original, start = original) {
    this.original = copyCanvas(original);
    this.work = copyCanvas(start);
    this.workCtx = this.work.getContext('2d', { willReadFrequently: false });
    this.restorePattern = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.onHistoryChange();
    this.layout(true);
  }

  /** Keeps only the original pixels where `mask` is opaque (soft edges preserved). Undoable. */
  applyMask(mask) {
    this.pushUndo(copyCanvas(this.work));
    const ctx = this.workCtx;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.original, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(mask, 0, 0, this.work.width, this.work.height);
    ctx.restore();
    this.dirty = true;
    this.requestDraw();
  }

  /** True when zoomed or panned away from the fitted view. */
  isZoomed() {
    if (!this.work || !this.fitScale) return false;
    const fit = this.fitView();
    return Math.abs(this.view.scale - fit.scale) > 0.001 || Math.abs(this.view.ox - fit.ox) > 1 || Math.abs(this.view.oy - fit.oy) > 1;
  }

  fitView() {
    return {
      scale: this.fitScale,
      ox: (this.cssW - this.work.width * this.fitScale) / 2,
      oy: (this.cssH - this.work.height * this.fitScale) / 2,
    };
  }

  getResult() {
    return this.work;
  }

  setMode(mode) {
    this.mode = mode;
    this.requestDraw();
  }

  setBrushSize(px) {
    this.brushSize = px;
    this.requestDraw();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(copyCanvas(this.work));
    this.replaceWork(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(copyCanvas(this.work));
    this.replaceWork(this.redoStack.pop());
  }

  replaceWork(canvas) {
    this.workCtx.globalCompositeOperation = 'copy';
    this.workCtx.drawImage(canvas, 0, 0);
    this.workCtx.globalCompositeOperation = 'source-over';
    this.dirty = true;
    this.onHistoryChange();
    this.requestDraw();
  }

  pushUndo(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.onHistoryChange();
  }

  fit() {
    this.layout(true);
  }

  layout(refit) {
    const parent = this.canvas.parentElement;
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr;
    const firstLayout = !this.cssW;
    this.cssW = cssW;
    this.cssH = cssH;
    if (this.work) {
      const pad = 16;
      this.fitScale = Math.min((cssW - pad * 2) / this.work.width, (cssH - pad * 2) / this.work.height);
      if (refit || firstLayout || this.needsFit) {
        this.view = this.fitView();
        this.needsFit = false;
      }
    } else {
      this.needsFit = true;
    }
    this.draw();
  }

  localPoint(e) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  toImage(p) {
    const v = this.view;
    return { x: (p.x - v.ox) / v.scale, y: (p.y - v.oy) / v.scale };
  }

  onDown(e) {
    if (!this.work) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.localPoint(e));

    if (this.pointers.size === 1) {
      this.startStroke(e.pointerId, this.localPoint(e));
    } else if (this.pointers.size === 2) {
      // A second finger means zoom/pan: undo the dab the first finger just made.
      this.cancelStroke();
      this.startPinch();
    }
  }

  onMove(e) {
    const p = this.localPoint(e);
    if (e.pointerType === 'mouse') this.cursor = p;
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this.requestDraw();
      return;
    }
    this.pointers.set(e.pointerId, p);

    if (this.pinch) {
      this.updatePinch();
    } else if (this.stroke && this.stroke.id === e.pointerId) {
      this.cursor = p;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) this.continueStroke(this.localPoint(ev));
    }
    this.requestDraw();
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.stroke && this.stroke.id === e.pointerId) {
      this.endStroke();
    }
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
    }
    if (e.pointerType !== 'mouse') this.cursor = null;
    this.requestDraw();
  }

  onWheel(e) {
    if (!this.work) return;
    e.preventDefault();
    const p = this.localPoint(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoomAt(p, this.view.scale * factor);
  }

  zoomAt(p, newScale) {
    const scale = clamp(newScale, this.fitScale * 0.5, this.fitScale * 30);
    const img = this.toImage(p);
    this.view = { scale, ox: p.x - img.x * scale, oy: p.y - img.y * scale };
    this.requestDraw();
  }

  // --- Painting ---

  startStroke(id, p) {
    // The undo snapshot is committed only when the stroke ends, so a stroke cancelled by a
    // second finger (pinch) leaves the history untouched.
    this.stroke = { id, last: this.toImage(p), before: copyCanvas(this.work) };
    this.cursor = p;
    this.paintDab(this.stroke.last);
    this.requestDraw();
  }

  continueStroke(p) {
    const ip = this.toImage(p);
    this.paintSegment(this.stroke.last, ip);
    this.stroke.last = ip;
  }

  endStroke() {
    this.pushUndo(this.stroke.before);
    this.stroke = null;
  }

  cancelStroke() {
    if (!this.stroke) return;
    const { before } = this.stroke;
    this.stroke = null;
    this.replaceWork(before);
  }

  brushRadius() {
    return this.brushSize / 2 / this.view.scale;
  }

  setupBrush(ctx) {
    if (this.mode === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = ctx.strokeStyle = '#000';
    } else {
      if (!this.restorePattern) this.restorePattern = ctx.createPattern(this.original, 'no-repeat');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = ctx.strokeStyle = this.restorePattern;
    }
  }

  paintDab(p) {
    this.dirty = true;
    const ctx = this.workCtx;
    ctx.save();
    this.setupBrush(ctx);
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.brushRadius(), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  paintSegment(a, b) {
    const ctx = this.workCtx;
    ctx.save();
    this.setupBrush(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.brushRadius() * 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // --- Pinch zoom / pan ---

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      view: { ...this.view },
    };
  }

  updatePinch() {
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const start = this.pinch;
    const scale = clamp(start.view.scale * (dist / start.dist), this.fitScale * 0.5, this.fitScale * 30);
    const imgX = (start.mid.x - start.view.ox) / start.view.scale;
    const imgY = (start.mid.y - start.view.oy) / start.view.scale;
    this.view = { scale, ox: mid.x - imgX * scale, oy: mid.y - imgY * scale };
  }

  // --- Rendering ---

  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  checker() {
    if (!this.checkerPattern) {
      const tile = makeCanvas(20, 20);
      const t = tile.getContext('2d');
      t.fillStyle = '#fff';
      t.fillRect(0, 0, 20, 20);
      t.fillStyle = '#ccc';
      t.fillRect(0, 0, 10, 10);
      t.fillRect(10, 10, 10, 10);
      this.checkerPattern = this.ctx.createPattern(tile, 'repeat');
    }
    return this.checkerPattern;
  }

  draw() {
    const zoomed = this.isZoomed();
    if (zoomed !== this.lastZoomed) {
      this.lastZoomed = zoomed;
      this.onViewChange(zoomed);
    }
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.work || !this.cssW) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const { scale, ox, oy } = this.view;
    const w = this.work.width * scale;
    const h = this.work.height * scale;

    ctx.fillStyle = this.checker();
    ctx.fillRect(ox, oy, w, h);

    ctx.imageSmoothingEnabled = scale < 2;
    ctx.imageSmoothingQuality = 'high';
    if (this.mode === 'restore') {
      // Ghost of the original so you can see what can be brought back.
      ctx.globalAlpha = 0.3;
      ctx.drawImage(this.original, ox, oy, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(this.work, ox, oy, w, h);

    if (this.cursor && !this.pinch) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, this.brushSize / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, this.brushSize / 2 + 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
