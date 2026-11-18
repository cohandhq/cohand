import os from "node:os";
import path from "node:path";

export function paths(home) {
  const h = home || process.env.COHAND_HOME || path.join(os.homedir(), ".cohand");
  return {
    home: h,
    sock: path.join(h, "cohandd.sock"),
    logDir: path.join(h, "log"),
    policyFile: path.join(h, "policy.json"),
    tmp: path.join(h, "tmp"),
  };
}
