/**
 * Isolated threads — conversations that must neither hear nor be heard by
 * their sibling threads.
 *
 * Sibling echoes are right for a person's parallel threads in one channel, and
 * wrong for a thread that is a self-contained work order. A flow hands each
 * task to a dev agent in its own thread of #agent-dev-web; with echoes on, the
 * agent answered the Instagram task's question inside the Contact-button
 * clarification ("pätička je OK, ikonu nechávam ako je") and mixed the two
 * (2026-10-04). Modules register a predicate; an isolated thread is never an
 * echo source, never an echo target, and never seeded or used by backfill.
 */
type IsolationPredicate = (threadId: string) => boolean;

const predicates: IsolationPredicate[] = [];

export function registerIsolatedThreads(fn: IsolationPredicate): void {
  predicates.push(fn);
}

/** True when any registered module claims the thread. A failing predicate counts as "not isolated". */
export function isIsolatedThread(threadId: string | null | undefined): boolean {
  if (!threadId) return false;
  return predicates.some((p) => {
    try {
      return p(threadId);
    } catch {
      return false;
    }
  });
}

/** Test seam: drop every registered predicate. */
export function resetIsolatedThreadsForTest(): void {
  predicates.length = 0;
}
