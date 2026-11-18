// Ask-first prompt: a Chrome notification with Allow / Deny. Resolves {allow:boolean}.

const pending = new Map(); // askId -> {id, summary, finish}

export const listAsks = () => [...pending.values()].map(({ id, summary }) => ({ id, summary }));

/** Answer a pending ask from the popup. First answer (popup or notification) wins. */
export function resolveAsk(askId, allow) {
  const a = pending.get(askId);
  if (!a) return false;
  a.finish(allow === true);
  return true;
}

export function askUser(summary, timeoutMs = 15000, askId) {
  return new Promise((resolve) => {
    askId = askId || "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const id = "cohand-ask-" + askId;
    let done = false;
    const finish = (allow, timedOut = false) => {
      if (done) return;
      done = true;
      pending.delete(askId);
      clearTimeout(timer);
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.onClosed.removeListener(onClosed);
      chrome.notifications.clear(id);
      resolve(timedOut ? { allow, timedOut } : { allow });
    };
    const onButton = (nid, idx) => { if (nid === id) finish(idx === 0); };
    const onClosed = (nid) => { if (nid === id) finish(false); };
    const timer = setTimeout(() => finish(false, true), timeoutMs);
    pending.set(askId, { id: askId, summary: String(summary), finish });
    chrome.notifications.onButtonClicked.addListener(onButton);
    chrome.notifications.onClosed.addListener(onClosed);
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "cohand: approve this action?",
      message: String(summary).slice(0, 300),
      buttons: [{ title: "Allow" }, { title: "Deny" }],
      requireInteraction: true,
    });
  });
}
