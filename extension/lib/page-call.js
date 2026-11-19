// Sending commands to the content script. Re-inject only when it is missing:
// retrying a command that already reached the page can run the action twice.
const MISSING = /receiving end does not exist|could not establish connection|no response from page/i;

export const isMissingContentScript = (message) => MISSING.test(String(message ?? ""));

export async function retryInjected(send, inject) {
  try { return await send(); }
  catch (e) {
    if (!isMissingContentScript(e.message)) throw e;
    await inject();
    return send();
  }
}
