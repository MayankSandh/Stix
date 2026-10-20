// WhatsApp-style crop: drag a corner/edge, and on release the view zooms to the selection.
// The rest of the image stays visible (dimmed) around it, so you can drag back out to include more.
// Crop rectangle is kept in image pixels; `view` maps image pixels to screen (CSS) pixels.
const HANDLE_HIT = 28; // touch radius for handles, CSS px
const MIN_SCREEN = 40; // smallest crop size on screen, CSS px
const FIT_PAD = 36; // space kept around the crop box after auto-zoom, CSS px
const MAX_ZOOM_PX = 8; // never zoom past 8 screen px per image px
const ANIM_MS = 260;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class CropTool {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.square = false;
    this.rect = null;
    this.view = { scale: 1, ox: 0, oy: 0 };
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.anim = null;

    new ResizeObserver(() => this.layout()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /** @param {HTMLCanvasElement} image may contain transparency (erased areas) */
  setImage(image) {
    this.image = image;
    this.reset();
  }

  /** Redraw after the image's pixels changed, keeping the crop box and zoom. */
  refresh() {
    this.draw();
  }

  setSquare(square) {
    this.square = square;
    if (square && this.rect) {
      const r = this.rect;
      const s = Math.min(r.w, r.h);
      this.rect = { x: r.x + (r.w - s) / 2, y: r.y + (r.h - s) / 2, w: s, h: s };
      this.zoomToCrop();
    }
    this.draw();
  }

  reset() {
    if (!this.image) return;
    const { width: W, height: H } = this.image;
    if (this.square) {
      const s = Math.min(W, H);
      this.rect = { x: (W - s) / 2, y: (H - s) / 2, w: s, h: s };
    } else {
      this.rect = { x: 0, y: 0, w: W, h: H };
    }
    this.layout();
    this.view = this.fitView(this.rect);
    this.draw();
  }

  /** Crop rectangle in whole image pixels. */
  getCrop() {
    const { width: W, height: H } = this.image;
    const x = clamp(Math.round(this.rect.x), 0, W - 1);
    const y = clamp(Math.round(this.rect.y), 0, H - 1);
    const w = clamp(Math.round(this.rect.w), 1, W - x);
    const h = clamp(Math.round(this.rect.h), 1, H - y);
    return { x, y, w, h };
  }

  layout() {
    const parent = this.canvas.parentElement;
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const firstLayout = !this.cssW;
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    if (this.image && this.rect && (firstLayout || this.needsFit)) {
      this.view = this.fitView(this.rect);
      this.needsFit = false;
    } else if (!this.image) {
      this.needsFit = true;
    }
    this.draw();
  }

  /** Scale at which the whole image fits the screen. */
  fitAllScale() {
    const { width: W, height: H } = this.image;
    return Math.min((this.cssW - FIT_PAD * 2) / W, (this.cssH - FIT_PAD * 2) / H);
  }

  maxScale() {
    return Math.max(MAX_ZOOM_PX, this.fitAllScale());
  }

  /** View that centers `r` with FIT_PAD of room around it. */
  fitView(r) {
    if (!this.cssW) return this.view;
    const scale = clamp(
      Math.min((this.cssW - FIT_PAD * 2) / r.w, (this.cssH - FIT_PAD * 2) / r.h),
      this.fitAllScale(),
      this.maxScale(),
    );
    return {
      scale,
      ox: this.cssW / 2 - (r.x + r.w / 2) * scale,
      oy: this.cssH / 2 - (r.y + r.h / 2) * scale,
    };
  }

  zoomToCrop() {
    this.animateTo(this.fitView(this.rect));
  }

  animateTo(target) {
    const from = { ...this.view };
    const start = performance.now();
    cancelAnimationFrame(this.anim);
    const step = (now) => {
      const t = Math.min(1, (now - start) / ANIM_MS);
      const k = 1 - (1 - t) ** 3; // ease-out
      this.view = {
        scale: from.scale + (target.scale - from.scale) * k,
        ox: from.ox + (target.ox - from.ox) * k,
        oy: from.oy + (target.oy - from.oy) * k,
      };
      this.draw();
      this.anim = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  get animating() {
    return this.anim !== null && this.anim !== undefined;
  }

  minSize() {
    const { width: W, height: H } = this.image;
    return Math.min(MIN_SCREEN / this.view.scale, W, H);
  }

  local(e) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  toImage(p) {
    const v = this.view;
    return { x: (p.x - v.ox) / v.scale, y: (p.y - v.oy) / v.scale };
  }

  hitTest(p) {
    const { scale, ox, oy } = this.view;
    const r = this.rect;
    const L = ox + r.x * scale;
    const T = oy + r.y * scale;
    const R = L + r.w * scale;
    const B = T + r.h * scale;
    const near = (a, b) => Math.abs(a - b) <= HANDLE_HIT;
    const corners = { nw: [L, T], ne: [R, T], sw: [L, B], se: [R, B] };
    let best = null;
    let bestDist = Infinity;
    for (const [name, [cx, cy]] of Object.entries(corners)) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d <= HANDLE_HIT && d < bestDist) { best = name; bestDist = d; }
    }
    if (best) return best;
    if (!this.square) {
      const insideX = p.x > L && p.x < R;
      const insideY = p.y > T && p.y < B;
      if (near(p.y, T) && insideX) return 'n';
      if (near(p.y, B) && insideX) return 's';
      if (near(p.x, L) && insideY) return 'w';
      if (near(p.x, R) && insideY) return 'e';
    }
    if (p.x >= L && p.x <= R && p.y >= T && p.y <= B) return 'move';
    return 'pan';
  }

  onDown(e) {
    if (!this.image) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    cancelAnimationFrame(this.anim);
    this.anim = null;

    if (this.pointers.size === 1) {
      const handle = this.hitTest(p);
      this.drag = { id: e.pointerId, handle, startScreen: p, start: this.toImage(p), rect: { ...this.rect }, view: { ...this.view }, changed: false };
    } else if (this.pointers.size === 2) {
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: { ...this.view },
      };
    }
  }

  onMove(e) {
    const p = this.local(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && this.image) {
        const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move', pan: 'grab' };
        this.canvas.style.cursor = cursors[this.hitTest(p)] || 'default';
      }
      return;
    }
    this.pointers.set(e.pointerId, p);

    if (this.pinch) {
      this.updatePinch();
    } else if (this.drag && this.drag.id === e.pointerId) {
      this.updateDrag(p);
    }
    this.draw();
  }

  onUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      this.drag = null; // a finger may remain; it shouldn't start dragging the box
      return;
    }
    if (this.drag && this.drag.id === e.pointerId) {
      const { handle, changed } = this.drag;
      this.drag = null;
      if (changed && handle !== 'pan') this.zoomToCrop();
    }
  }

  onWheel(e) {
    if (!this.image) return;
    e.preventDefault();
    const p = this.local(e);
    const img = this.toImage(p);
    const scale = clamp(this.view.scale * Math.exp(-e.deltaY * 0.0015), this.fitAllScale() * 0.5, this.maxScale());
    this.view = { scale, ox: p.x - img.x * scale, oy: p.y - img.y * scale };
    this.draw();
  }

  updatePinch() {
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = this.pinch;
    const scale = clamp(s.view.scale * (dist / s.dist), this.fitAllScale() * 0.5, this.maxScale());
    const imgX = (s.mid.x - s.view.ox) / s.view.scale;
    const imgY = (s.mid.y - s.view.oy) / s.view.scale;
    this.view = { scale, ox: mid.x - imgX * scale, oy: mid.y - imgY * scale };
  }

  updateDrag(p) {
    const d = this.drag;
    if (Math.hypot(p.x - d.startScreen.x, p.y - d.startScreen.y) > 3) d.changed = true;
    if (d.handle === 'pan') {
      this.view = { ...d.view, ox: d.view.ox + p.x - d.startScreen.x, oy: d.view.oy + p.y - d.startScreen.y };
      return;
    }
    const ip = this.toImage(p);
    const dx = ip.x - d.start.x;
    const dy = ip.y - d.start.y;
    const r = d.rect;
    const { width: W, height: H } = this.image;
    const min = this.minSize();

    if (d.handle === 'move') {
      this.rect = { ...r, x: clamp(r.x + dx, 0, W - r.w), y: clamp(r.y + dy, 0, H - r.h) };
    } else if (d.handle.length === 2) {
      // Corner: the opposite corner stays fixed.
      const west = d.handle.includes('w');
      const north = d.handle.includes('n');
      const ax = west ? r.x + r.w : r.x;
      const ay = north ? r.y + r.h : r.y;
      const sx = west ? -1 : 1;
      const sy = north ? -1 : 1;
      const cornerX = (west ? r.x : r.x + r.w) + dx;
      const cornerY = (north ? r.y : r.y + r.h) + dy;
      const maxW = west ? ax : W - ax;
      const maxH = north ? ay : H - ay;
      let w = clamp((cornerX - ax) * sx, min, maxW);
      let h = clamp((cornerY - ay) * sy, min, maxH);
      if (this.square) {
        const s = Math.min(Math.max(w, h), maxW, maxH);
        w = h = s;
      }
      this.rect = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
    } else {
      // Edge (free mode only).
      let { x, y, w, h } = r;
      if (d.handle === 'n') { const b = r.y + r.h; y = clamp(r.y + dy, 0, b - min); h = b - y; }
      if (d.handle === 's') { h = clamp(r.h + dy, min, H - r.y); }
      if (d.handle === 'w') { const rr = r.x + r.w; x = clamp(r.x + dx, 0, rr - min); w = rr - x; }
      if (d.handle === 'e') { w = clamp(r.w + dx, min, W - r.x); }
      this.rect = { x, y, w, h };
    }
  }

  checker() {
    if (!this.checkerPattern) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 16;
      const t = tile.getContext('2d');
      t.fillStyle = '#fff';
      t.fillRect(0, 0, 16, 16);
      t.fillStyle = '#ccc';
      t.fillRect(0, 0, 8, 8);
      t.fillRect(8, 8, 8, 8);
      this.checkerPattern = this.ctx.createPattern(tile, 'repeat');
    }
    return this.checkerPattern;
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.image || !this.rect || !this.cssW) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const { width: W, height: H } = this.image;
    const { scale: s, ox, oy } = this.view;
    ctx.fillStyle = this.checker();
    ctx.fillRect(ox, oy, W * s, H * s);
    ctx.imageSmoothingEnabled = s < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, ox, oy, W * s, H * s);

    const r = this.rect;
    const L = ox + r.x * s;
    const T = oy + r.y * s;
    const RW = r.w * s;
    const RH = r.h * s;

    // Dim everything outside the crop box (still visible, so you can drag back out).
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    ctx.rect(L, T, RW, RH);
    ctx.fill('evenodd');

    // Rule-of-thirds guides.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(L + (RW * i) / 3, T);
      ctx.lineTo(L + (RW * i) / 3, T + RH);
      ctx.moveTo(L, T + (RH * i) / 3);
      ctx.lineTo(L + RW, T + (RH * i) / 3);
    }
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(L, T, RW, RH);

    // Corner handles (and edge handles in free mode).
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    const len = Math.min(22, RW / 3, RH / 3);
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[L, T, 1, 1], [L + RW, T, -1, 1], [L, T + RH, 1, -1], [L + RW, T + RH, -1, -1]]) {
      ctx.moveTo(cx, cy + dy * len);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * len, cy);
    }
    if (!this.square) {
      const mx = L + RW / 2;
      const my = T + RH / 2;
      const half = Math.min(12, RW / 6, RH / 6);
      ctx.moveTo(mx - half, T); ctx.lineTo(mx + half, T);
      ctx.moveTo(mx - half, T + RH); ctx.lineTo(mx + half, T + RH);
      ctx.moveTo(L, my - half); ctx.lineTo(L, my + half);
      ctx.moveTo(L + RW, my - half); ctx.lineTo(L + RW, my + half);
    }
    ctx.stroke();
  }
}
