// A ref click uses real mouse input. Fall back to a DOM click only when the
// debugger dispatched nothing — otherwise the element gets clicked twice.
export async function clickRef(tab, ref, { click, send }) {
  const rect = await send("rect", { ref });
  try {
    return await click(tab.id, rect.x, rect.y);
  } catch (e) {
    if (e?.dispatched !== false) throw e;
    return send("click", { ref });
  }
}
