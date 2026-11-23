/**
 * Track in-flight turns so a graceful shutdown waits for replies to finish
 * before the process exits.
 */
export function createTurnDrain({ pollMs = 100, log = console.log } = {}) {
  const active = new Map(); // turnKey -> conversationId

  const count = () => active.size;
  const begin = (id, chatId) => { active.set(id, chatId); };
  const end = (id) => { if (id) active.delete(id); };

  /**
   * Resolve when no turn is running, or when `limitMs` elapses.
   * Returns any turn keys still running (empty array when cleanly drained).
   */
  async function wait(limitMs = 30_000) {
    if (active.size > 0) {
      log(`[Shutdown] Waiting up to ${Math.round(limitMs / 1000)}s for ${active.size} running turn(s)`);
    }
    const deadline = Date.now() + limitMs;
    while (active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const stranded = [...active.keys()];
    if (stranded.length > 0) {
      log(`[Shutdown] Gave up waiting on ${stranded.length} turn(s): ${stranded.join(', ')}`);
    }
    return stranded;
  }

  return { begin, end, count, wait };
}

export default createTurnDrain;
