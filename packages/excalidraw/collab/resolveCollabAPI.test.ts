import { resolveCollabAPI } from "./ExcalidrawApp";

import type { CollabAPI } from "./Collab";

const own = { id: "own" } as unknown as CollabAPI;
const shared = { id: "shared" } as unknown as CollabAPI;

describe("resolveCollabAPI", () => {
  it("never hands a board that renders its own Collab the shared one", () => {
    // The regression: `own ?? shared` returns `shared` here, and the board acts
    // on another board's Collab for the commit before its own arrives.
    expect(resolveCollabAPI(null, shared, false)).toBe(null);
  });

  it("uses this board's own Collab once it has mounted", () => {
    expect(resolveCollabAPI(own, shared, false)).toBe(own);
  });

  it("falls back to the shared atom only when no Collab is rendered", () => {
    expect(resolveCollabAPI(null, shared, true)).toBe(shared);
  });
});
