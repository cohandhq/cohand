// Command table: CLI words -> daemon ops + arg mapping.
import path from "node:path";

const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`); return n; };
const refOrXY = (key) => (v) => {
  const m = /^(\d+),(\d+)$/.exec(v);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { [key]: v };
};
const typeTarget = (v) => (v === "." || v === "focused") ? { focused: true } : refOrXY("ref")(v);

// pos: [[argKey, transform?]]  flags: { flagName: [argKey, "bool"|"str"|"num"] }
export const COMMANDS = {
  profiles: { op: "profiles" },
  tabs: { op: "tabs" },
  adopt: { op: "adopt", pos: [["tabId", num]] },
  url: { op: "url" },
  open: { op: "open", pos: [["url"]], flags: { new: ["newTab", "bool"] } },
  activate: { op: "activate", pos: [["tabId", num]] },
  close: { op: "close", pos: [["tabId", num]] },
  back: { op: "back" },
  forward: { op: "forward" },
  reload: { op: "reload" },
  snapshot: { op: "snapshot", flags: { scope: ["scope", "str"], page: ["page", "num"] } },
  text: { op: "text", flags: { selector: ["selector", "str"] } },
  find: { op: "find", pos: [["query"]] },
  screenshot: { op: "screenshot", flags: { full: ["full", "bool"], zoom: ["zoom", "str"] }, post: { zoom: (v) => v.split(",").map(num) } },
  click: { op: "click", pos: [["ref", null, (v, a) => Object.assign(a, refOrXY("ref")(v))]], flags: { "from-shot": ["fromShot", "bool"] } },
  type: { op: "type", pos: [["ref", null, (v, a) => Object.assign(a, typeTarget(v))], ["text"]], flags: { submit: ["submit", "bool"], real: ["real", "bool"], "from-shot": ["fromShot", "bool"] } },
  key: { op: "key", pos: [["combo"]] },
  scroll: { op: "scroll", pos: [["direction"]], flags: { amount: ["amount", "num"] } },
  hover: { op: "hover", pos: [["ref"]] },
  select: { op: "select", pos: [["ref"], ["value"]] },
  drag: { op: "drag", pos: [["ref"], ["to"]] },
  upload: { op: "upload", pos: [["ref"], ["file", (v) => path.resolve(v)]] },
  wait: { op: "wait", flags: { text: ["text", "str"], selector: ["selector", "str"], idle: ["idle", "bool"] } },
  eval: { op: "eval", pos: [["js"]] },
  console: { op: "console", flags: { pattern: ["pattern", "str"] } },
  network: { op: "network", flags: { pattern: ["pattern", "str"] } },
  downloads: { op: "downloads", flags: { wait: ["wait", "str"] } },
  cookies: { op: "cookies", pos: [["url"]] },
  off: { op: "off" },
  on: { op: "on" },
  policy: { op: "policy" },
  log: { op: "log", flags: { today: ["today", "bool"] } },
};

export const SESSION_SUB = {
  start: { op: "session.start", pos: [["name"]], flags: { quiet: ["quiet", "bool"] } },
  resume: { op: "session.resume", pos: [["id"]], flags: { quiet: ["quiet", "bool"] } },
  end: { op: "session.end" },
  list: { op: "session.list" },
};

export const GLOBAL_FLAGS = { profile: "str", session: "str", json: "bool", timeout: "num", "any-tab": "bool", "no-show": "bool", help: "bool" };

/** Parse argv (after the command words) into {args, globals}. Throws usage Errors. */
export function parseArgs(spec, argv) {
  const globals = {};
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] === "-q" ? "--quiet" : argv[i];
    if (tok.startsWith("--") && tok.length > 2) {
      const [rawName, inline] = tok.slice(2).split(/=(.*)/s, 2);
      const gType = GLOBAL_FLAGS[rawName];
      const local = spec.flags?.[rawName];
      const type = gType ?? local?.[1];
      if (!type) throw new Error(`unknown flag --${rawName}`);
      let val = true;
      if (type !== "bool") {
        val = inline !== undefined ? inline : argv[++i];
        if (val === undefined) throw new Error(`--${rawName} needs a value`);
        if (type === "num") val = num(val);
      }
      if (gType) globals[rawName] = val;
      else args[local[0]] = spec.post?.[rawName] ? spec.post[rawName](val) : val;
    } else positional.push(tok);
  }
  const want = spec.pos || [];
  if (positional.length < want.length) throw new Error(`missing argument <${want[positional.length][0]}>`);
  if (positional.length > want.length) throw new Error(`unexpected argument "${positional[want.length]}"`);
  want.forEach(([key, transform, assign], i) => {
    if (assign) assign(positional[i], args);
    else args[key] = transform ? transform(positional[i]) : positional[i];
  });
  if (globals["any-tab"]) args.anyTab = true;
  if (globals["no-show"] || process.env.COHAND_NO_SHOW === "1") args.noShow = true;
  return { args, globals };
}
