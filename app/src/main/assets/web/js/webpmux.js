// Builds an animated WebP from individually encoded WebP frames (container format:
// https://developers.google.com/speed/webp/docs/riff_container). No libraries needed:
// the browser encodes each frame with canvas.toBlob('image/webp'); this only stitches them.

const te = new TextEncoder();
const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

function u24(v) {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

function u32(v) {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

function chunk(id, payload) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(te.encode(id), 0);
  out.set(u32(payload.length), 4);
  out.set(payload, 8);
  return out;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Returns the ALPH (optional) + VP8/VP8L chunks of a still WebP file, ready to go inside ANMF. */
export function frameChunks(webp) {
  const bytes = new Uint8Array(webp);
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') throw new Error('Not a WebP image');
  const keep = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = fourcc(bytes, at);
    const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    const end = at + 8 + size + (size & 1);
    if (id === 'ALPH' || id === 'VP8 ' || id === 'VP8L') keep.push(bytes.subarray(at, Math.min(end, bytes.length)));
    at = end;
  }
  if (!keep.some((c) => fourcc(c, 0) !== 'ALPH')) throw new Error('WebP frame has no image data');
  // A lossless (VP8L) frame carries its own alpha; ALPH only pairs with lossy VP8.
  return concat(keep.some((c) => fourcc(c, 0) === 'VP8L') ? keep.filter((c) => fourcc(c, 0) === 'VP8L') : keep);
}

/**
 * @param {Uint8Array[]} frames output of frameChunks() for each frame, all sized rect.w x rect.h
 * @param {number[]} durations milliseconds per frame
 * @param {{x:number,y:number,w:number,h:number}} rect where frames sit on the canvas (x, y even)
 */
export function muxAnimatedWebp(frames, durations, { width, height, rect }) {
  const vp8x = chunk('VP8X', new Uint8Array([
    0x10 | 0x02, 0, 0, 0, // flags: alpha + animation
    ...u24(width - 1), ...u24(height - 1),
  ]));
  const anim = chunk('ANIM', new Uint8Array([0, 0, 0, 0, 0, 0])); // transparent background, loop forever
  const anmfs = frames.map((data, i) => {
    const header = new Uint8Array([
      ...u24(rect.x / 2), ...u24(rect.y / 2),
      ...u24(rect.w - 1), ...u24(rect.h - 1),
      ...u24(Math.round(durations[i])),
      0b10, // do not blend with the previous frame; do not dispose
    ]);
    return chunk('ANMF', concat([header, data]));
  });
  const body = concat([te.encode('WEBP'), vp8x, anim, ...anmfs]);
  return new Blob([te.encode('RIFF'), new Uint8Array(u32(body.length)), body], { type: 'image/webp' });
}
