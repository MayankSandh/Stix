// Interactive crop box drawn on a <canvas>. Crop rectangle is kept in image pixels.
const HANDLE_HIT = 28; // touch radius for handles, CSS px
const MIN_SCREEN = 40; // smallest crop size on screen, CSS px

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class CropTool {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.square = false;
    this.rect = null;
    this.drag = null;

    new ResizeObserver(() => this.layout()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
  }

  /** @param {HTMLCanvasElement|ImageBitmap} image */
  setImage(image) {
    this.image = image;
    this.reset();
  }

  setSquare(square) {
    this.square = square;
    if (square && this.rect) {
      const r = this.rect;
      const s = Math.min(r.w, r.h);
      this.rect = { x: r.x + (r.w - s) / 2, y: r.y + (r.h - s) / 2, w: s, h: s };
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
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    if (this.image) {
      const pad = 24;
      const { width: W, height: H } = this.image;
      this.scale = Math.min((cssW - pad * 2) / W, (cssH - pad * 2) / H);
      this.ox = (cssW - W * this.scale) / 2;
      this.oy = (cssH - H * this.scale) / 2;
    }
    this.draw();
  }

  minSize() {
    const { width: W, height: H } = this.image;
    return Math.min(MIN_SCREEN / this.scale, W, H);
  }

  toImage(e) {
    const b = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - b.left - this.ox) / this.scale,
      y: (e.clientY - b.top - this.oy) / this.scale,
    };
  }

  hitTest(e) {
    const b = this.canvas.getBoundingClientRect();
    const px = e.clientX - b.left;
    const py = e.clientY - b.top;
    const r = this.rect;
    const L = this.ox + r.x * this.scale;
    const T = this.oy + r.y * this.scale;
    const R = L + r.w * this.scale;
    const B = T + r.h * this.scale;
    const near = (a, b) => Math.abs(a - b) <= HANDLE_HIT;
    const corners = { nw: [L, T], ne: [R, T], sw: [L, B], se: [R, B] };
    let best = null;
    let bestDist = Infinity;
    for (const [name, [cx, cy]] of Object.entries(corners)) {
      const d = Math.hypot(px - cx, py - cy);
      if (d <= HANDLE_HIT && d < bestDist) { best = name; bestDist = d; }
    }
    if (best) return best;
    if (!this.square) {
      const insideX = px > L && px < R;
      const insideY = py > T && py < B;
      if (near(py, T) && insideX) return 'n';
      if (near(py, B) && insideX) return 's';
      if (near(px, L) && insideY) return 'w';
      if (near(px, R) && insideY) return 'e';
    }
    if (px >= L && px <= R && py >= T && py <= B) return 'move';
    return null;
  }

  onDown(e) {
    if (!this.image || this.drag) return;
    const handle = this.hitTest(e);
    if (!handle) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, handle, start: this.toImage(e), rect: { ...this.rect } };
  }

  onMove(e) {
    if (!this.drag) {
      if (this.image && e.pointerType === 'mouse') {
        const h = this.hitTest(e);
        const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };
        this.canvas.style.cursor = cursors[h] || 'default';
      }
      return;
    }
    if (e.pointerId !== this.drag.id) return;
    const p = this.toImage(e);
    const dx = p.x - this.drag.start.x;
    const dy = p.y - this.drag.start.y;
    const { handle, rect: r } = this.drag;
    const { width: W, height: H } = this.image;
    const min = this.minSize();

    if (handle === 'move') {
      this.rect = { ...r, x: clamp(r.x + dx, 0, W - r.w), y: clamp(r.y + dy, 0, H - r.h) };
    } else if (handle.length === 2) {
      // Corner: the opposite corner stays fixed.
      const west = handle.includes('w');
      const north = handle.includes('n');
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
      if (handle === 'n') { const b = r.y + r.h; y = clamp(r.y + dy, 0, b - min); h = b - y; }
      if (handle === 's') { h = clamp(r.h + dy, min, H - r.y); }
      if (handle === 'w') { const rr = r.x + r.w; x = clamp(r.x + dx, 0, rr - min); w = rr - x; }
      if (handle === 'e') { w = clamp(r.w + dx, min, W - r.x); }
      this.rect = { x, y, w, h };
    }
    this.draw();
  }

  onUp(e) {
    if (this.drag && e.pointerId === this.drag.id) this.drag = null;
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.image || !this.rect || !this.scale) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const { width: W, height: H } = this.image;
    const s = this.scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, this.ox, this.oy, W * s, H * s);

    const r = this.rect;
    const L = this.ox + r.x * s;
    const T = this.oy + r.y * s;
    const RW = r.w * s;
    const RH = r.h * s;

    // Dim everything outside the crop box.
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

    // Corner handles.
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
