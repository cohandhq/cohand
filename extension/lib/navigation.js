/** Convert Chrome's history API errors into directionally correct messages. */
export function historyError(direction, error) {
  const message = String(error?.message || error || "");
  if (!/history|page in history/i.test(message)) return message;
  if (direction === "back") return "no previous page in history";
  if (direction === "forward") return "no next page in history";
  return message;
}

/** Watch for a tab navigation/title change, with a short bounded no-change path. */
export function watchTabChange(tabId, before, { onUpdated, getTab }, idleMs = 800, settleMs = 1500) {
  return new Promise((resolve) => {
    let navigated = false;
    let loading = false;
    let settled = false;
    let idleTimer;
    let settleTimer;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(settleTimer);
      onUpdated.removeListener(listener);
      const tab = await getTab(tabId).catch(() => before);
      resolve({ ...tab, navigated: navigated || tab.url !== before.url, loading });
    };
    // A navigation that started may never report "complete" promptly; stop waiting for it.
    const commit = () => {
      if (navigated) return;
      navigated = true;
      clearTimeout(idleTimer);
      settleTimer = setTimeout(finish, settleMs);
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      const urlChanged = info.url && info.url !== before.url;
      const titleChanged = info.title && info.title !== before.title;
      if (info.status === "loading") { loading = true; commit(); }
      else if (info.status === "complete") loading = false;
      if (urlChanged) return void finish(); // committed: report it now, not when the page settles
      if (titleChanged && info.status !== "loading") return void finish(); // SPA route change
      if (navigated && info.status === "complete") void finish();
    };
    onUpdated.addListener(listener);
    idleTimer = setTimeout(finish, idleMs);
  });
}
