/**
 * Binary framing protocol used between the relay and the desktop agent.
 *
 * Every WebSocket message carries exactly one frame:
 *   [type:u8][streamId:u32BE][length:u32BE][payload:length bytes]
 *
 * Keeping one frame per WS message means we can rely on ws message
 * boundaries and do not need a streaming parser on either side.
 */

export const FRAME = Object.freeze({
  /** JSON { kind: 'http'|'ws', method, url, headers } */
  OPEN: 1,
  /** Raw request body bytes. */
  DATA: 2,
  /** Request body finished. */
  REQ_END: 3,
  /** JSON { status, statusText, headers } */
  RESPONSE: 4,
  /** [flags:u8][payload]; flags 1 = text, 2 = binary */
  WS_DATA: 5,
  /** JSON { code, reason } */
  CLOSE: 6,
  /** JSON { message } */
  ERROR: 7,
  /** Response body finished. */
  RES_END: 8,
});

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER_BYTES = 9;

export function encodeFrame(type, streamId, payload) {
  const body = payload == null ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`relay frame too large: ${body.length} bytes`);
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  out.writeUInt32BE(body.length, 5);
  if (body.length > 0) body.copy(out, HEADER_BYTES);
  return out;
}

export function decodeFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < HEADER_BYTES) return null;
  const type = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const length = buf.readUInt32BE(5);
  if (buf.length !== HEADER_BYTES + length) return null;
  return { type, streamId, payload: buf.subarray(HEADER_BYTES) };
}

export function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function decodeJson(payload, fallback = {}) {
  if (payload == null || payload.length === 0) return fallback;
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return fallback;
  }
}

export function isOpen(ws) {
  return ws != null && ws.readyState === 1;
}
