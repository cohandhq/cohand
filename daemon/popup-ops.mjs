// Ops the extension popup may call over its native port (always scoped to its own profile).
import { loadPolicy, savePolicy, setBlock } from "./policy.mjs";
import { readLog } from "./log.mjs";

export const POPUP_OPS = {
  "status.profile": (ctx, profile) => {
    const { reg } = ctx;
    const log = readLog(ctx.paths.logDir).filter((e) => e.profile === profile);
    const sessions = reg.listSessions().filter((s) => s.profile === profile).map((s) => {
      const last = [...log].reverse().find((e) => e.session === s.name);
      return { id: s.id, name: s.name, lastAction: last?.op ?? null, lastAt: last?.t ?? null };
    });
    const pol = loadPolicy(ctx.paths.policyFile);
    return {
      front: reg.front() === profile,
      sessions,
      pending: [...reg.asks.values()].filter((a) => a.profile === profile).map(({ id, summary, at }) => ({ id, summary, at })),
      recent: log.slice(-20).reverse(),
      block: pol.profiles[profile]?.block || [],
      anyTab: pol.profiles[profile]?.anyTab === true,
    };
  },
  "policy.block": (ctx, profile, args) => {
    const pol = loadPolicy(ctx.paths.policyFile);
    const block = setBlock(pol, profile, args.domain, args.on === true);
    savePolicy(ctx.paths.policyFile, pol);
    return { block };
  },
  "policy.anyTab": (ctx, profile, args) => {
    const pol = loadPolicy(ctx.paths.policyFile);
    pol.profiles[profile] = { ...(pol.profiles[profile] || {}), anyTab: args.on === true };
    savePolicy(ctx.paths.policyFile, pol);
    return { anyTab: args.on === true };
  },
  "session.end": (ctx, profile, args) => {
    const s = ctx.reg.sessions.get(args.session);
    if (!s || s.profile !== profile) throw new Error("not a session of this profile");
    return endSession(ctx, s);
  },
};

/** End a session and (best effort) tell its profile to ungroup the tabs. Never closes tabs. */
export function endSession(ctx, s) {
  const host = ctx.reg.profiles.get(s.profile);
  if (host) { try { host.send({ v: 1, type: "cmd", id: ctx.nextId++, cmd: "session.end", args: { session: { id: s.id, name: s.name } } }); } catch {} }
  return { ended: ctx.reg.endSession(s.id) };
}
