// Pi Browser — shared wire protocol codec (v1).
// Used by both sides so encode/decode never drift. Plain CommonJS so the pi
// extension (jiti/TS) and node --test both load it without a build step.

export const MAX_FRAME_BYTES = 1024 * 1024; // 1 MiB

/** Serialize a frame object to a JSON string. Throws on non-serializable values. */
export function encodeFrame(obj) {
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === "function" || typeof v === "symbol") {
      throw new TypeError("frame contains non-serializable value");
    }
    if (v === undefined) {
      throw new TypeError("frame contains undefined");
    }
    return v;
  });
}

/**
 * Parse a frame string.
 * @returns {{ok:true, frame:object} | {ok:false, error:string}}
 */
export function decodeFrame(str) {
  if (typeof str !== "string") return { ok: false, error: "frame must be a string" };
  if (Buffer.byteLength(str, "utf8") > MAX_FRAME_BYTES) return { ok: false, error: "frame too large" };
  let frame;
  try {
    frame = JSON.parse(str);
  } catch {
    return { ok: false, error: "malformed JSON" };
  }
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return { ok: false, error: "frame must be a JSON object" };
  }
  return { ok: true, frame };
}

/**
 * Validate the first frame a connection sends.
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function validateHello(frame, { token, protocolVersion }) {
  if (!frame || frame.type !== "hello") return { ok: false, error: "expected hello frame" };
  if (frame.v !== protocolVersion) return { ok: false, error: `unsupported protocol version ${frame.v}` };
  if (typeof frame.token !== "string" || frame.token !== token) return { ok: false, error: "invalid token" };
  if (typeof frame.profile !== "string" || !frame.profile.trim()) return { ok: false, error: "missing profile label" };
  return { ok: true };
}
