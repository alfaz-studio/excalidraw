/**
 * Targeted polyfill for `Object.fromEntries` (ES2019).
 *
 * The `@excalidraw/mermaid-to-excalidraw` bundle (and the mermaid runtime it
 * pulls in) call `Object.fromEntries` at module-init time. On older / restricted
 * browser runtimes that global is missing, so the lazy
 * `import("@excalidraw/mermaid-to-excalidraw")` throws
 * `TypeError: Object.fromEntries is not a function` before the Text-to-diagram
 * dialog can render (issue 019ecaf5).
 *
 * Importing this module for its side effect ahead of that dynamic import
 * guarantees the global exists by the time the mermaid chunk evaluates. It is a
 * no-op on runtimes that already provide it.
 */
if (typeof (Object as any).fromEntries !== "function") {
  (Object as any).fromEntries = function fromEntries<T = any>(
    entries: Iterable<readonly [PropertyKey, T]>,
  ): { [k: string]: T } {
    const obj: { [k: string]: T } = {};

    for (const entry of entries as Iterable<readonly [PropertyKey, T]>) {
      obj[String(entry[0])] = entry[1];
    }

    return obj;
  };
}
