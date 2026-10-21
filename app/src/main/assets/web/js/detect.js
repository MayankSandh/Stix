// Finds rectangular pictures in a screenshot (e.g. images in Instagram comments).
// Idea: the screenshot background is one flat colour; text breaks into many small separate
// glyphs, while a picture is one large, densely filled blob. Coarse search on a small copy,
// then each edge is snapped to the exact pixel at full resolution.

const WORK_WIDTH = 400;
const TOLERANCE = 22; // how different (0-255 per channel) a pixel must be from the background

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Most common colour, measured on a coarse 5-bit-per-channel histogram. */
function backgroundColor(data) {
  const counts = new Uint32Array(32768);
  for (let i = 0; i < data.length; i += 4) {
    counts[((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)]++;
  }
  let best = 0;
  for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
  return [((best >> 10) << 3) + 4, (((best >> 5) & 31) << 3) + 4, ((best & 31) << 3) + 4];
}

function differs(data, i, bg, tol = TOLERANCE) {
  return Math.abs(data[i] - bg[0]) > tol || Math.abs(data[i + 1] - bg[1]) > tol || Math.abs(data[i + 2] - bg[2]) > tol;
}

/** Morphological closing (dilate then erode, 3x3) to bridge thin dark lines inside photos. */
function close(mask, w, h) {
  const dil = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && mask[yy * w + xx]) { on = 1; break; }
        }
      }
      dil[y * w + x] = on;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && !dil[yy * w + xx]) { all = 0; break; }
        }
      }
      out[y * w + x] = all;
    }
  }
  return out;
}

/** Bounding boxes of 4-connected blobs, with how many mask pixels each holds. */
function blobs(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const found = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    found.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count });
  }
  return found;
}

/** Moves each edge of `box` (full-res pixels) to where the picture actually starts. */
function refine(image, box, bg) {
  const pad = 6;
  const x0 = Math.max(0, Math.floor(box.x - pad));
  const y0 = Math.max(0, Math.floor(box.y - pad));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.w + pad));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.h + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  const data = image.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  const rows = new Float32Array(h);
  const cols = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (differs(data, (y * w + x) * 4, bg)) { rows[y]++; cols[x]++; }
    }
  }
  // An edge row/column of a picture (even with rounded corners) is mostly non-background.
  const rowOn = (y) => rows[y] / w > 0.35;
  const colOn = (x) => cols[x] / h > 0.35;
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && !rowOn(top)) top++;
  while (bottom > top && !rowOn(bottom)) bottom--;
  while (left < right && !colOn(left)) left++;
  while (right > left && !colOn(right)) right--;
  return { x: x0 + left, y: y0 + top, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * @param {HTMLCanvasElement} image full-resolution screenshot
 * @returns {{rects: {x,y,w,h}[], background: number[]}} largest first
 */
export function findPictures(image) {
  const scale = Math.min(1, WORK_WIDTH / image.width);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const small = makeCanvas(w, h);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(image, 0, 0, w, h);
  const data = sctx.getImageData(0, 0, w, h).data;
  const bg = backgroundColor(data);

  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = differs(data, i * 4, bg) ? 1 : 0;
  const mask = close(raw, w, h);

  const minSide = Math.max(20, w * 0.12);
  const candidates = blobs(mask, w, h)
    .filter((b) => b.w >= minSide && b.h >= minSide)
    .filter((b) => b.count / (b.w * b.h) >= 0.6) // solid, not a paragraph of text
    .filter((b) => b.w / b.h <= 6 && b.h / b.w <= 6)
    .filter((b) => b.w < w * 0.995 || b.h < h * 0.9) // not the whole screen
    .map((b) => refine(image, { x: b.x / scale, y: b.y / scale, w: b.w / scale, h: b.h / scale }, bg))
    .filter((r) => r.w >= 16 && r.h >= 16)
    .sort((a, b) => b.w * b.h - a.w * a.h);

  // Drop near-duplicates.
  const rects = [];
  for (const r of candidates) {
    const dup = rects.some((o) => Math.abs(o.x - r.x) < 8 && Math.abs(o.y - r.y) < 8 && Math.abs(o.w - r.w) < 8 && Math.abs(o.h - r.h) < 8);
    if (!dup) rects.push(r);
    if (rects.length === 9) break;
  }
  return { rects, background: bg };
}

/**
 * Makes background-coloured pixels in the rect's four corners transparent (rounded corners
 * of in-app images), flood-filling only from each corner and only within a small corner box.
 * Returns true if anything changed.
 */
export function clearRoundedCorners(canvas, rect, bg) {
  const r = Math.max(4, Math.round(Math.min(rect.w, rect.h) * 0.08));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let changed = false;
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.w - r, rect.y],
    [rect.x, rect.y + rect.h - r],
    [rect.x + rect.w - r, rect.y + rect.h - r],
  ];
  const seeds = [[0, 0], [r - 1, 0], [0, r - 1], [r - 1, r - 1]];
  corners.forEach(([cx, cy], k) => {
    const img = ctx.getImageData(cx, cy, r, r);
    const d = img.data;
    const [sx, sy] = seeds[k];
    if (!(d[(sy * r + sx) * 4 + 3] > 0) || differs(d, (sy * r + sx) * 4, bg, TOLERANCE + 10)) return;
    const seen = new Uint8Array(r * r);
    const stack = [sy * r + sx];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      d[i * 4 + 3] = 0;
      const x = i % r;
      const y = (i - x) / r;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= r || ny >= r) continue;
        const j = ny * r + nx;
        if (seen[j]) continue;
        seen[j] = 1;
        if (d[j * 4 + 3] > 0 && !differs(d, j * 4, bg, TOLERANCE + 10)) stack.push(j);
      }
    }
    ctx.putImageData(img, cx, cy);
    changed = true;
  });
  return changed;
}
