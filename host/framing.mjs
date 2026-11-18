// Native-messaging (4-byte LE length + JSON) and newline-delimited JSON codecs.
const MAX_NATIVE = 64 * 1024 * 1024;

export function encodeNative(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class NativeDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_NATIVE) throw new Error("native frame too large");
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export function encodeLine(obj) { return JSON.stringify(obj) + "\n"; }

export class LineDecoder {
  constructor() { this.buf = ""; }
  push(chunk) {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out = [];
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (e) { out.push({ __error: e.message, line }); }
    }
    return out;
  }
}
