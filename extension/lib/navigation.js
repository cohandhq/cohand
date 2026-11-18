/** Convert Chrome's history API errors into directionally correct messages. */
export function historyError(direction, error) {
  const message = String(error?.message || error || "");
  if (!/history|page in history/i.test(message)) return message;
  if (direction === "back") return "no previous page in history";
  if (direction === "forward") return "no next page in history";
  return message;
}

/** Watch for a tab navigation/title change, with a short bounded no-change path. */
export function watchTabChange(tabId, before, { onUpdated, getTab }, idleMs = 300, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let changed = false;
    let settled = false;
    let idleTimer;
    let maxTimer;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      onUpdated.removeListener(listener);
      resolve(await getTab(tabId).catch(() => before));
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      const urlChanged = info.url && info.url !== before.url;
      const titleChanged = info.title && info.title !== before.title;
      if (info.status === "loading" || urlChanged) {
        if (!changed) {
          clearTimeout(idleTimer);
          maxTimer = setTimeout(finish, timeoutMs);
        }
        changed = true;
      }
      if ((titleChanged && info.status !== "loading") || (changed && info.status === "complete")) void finish();
    };
    onUpdated.addListener(listener);
    idleTimer = setTimeout(finish, idleMs);
  });
}
