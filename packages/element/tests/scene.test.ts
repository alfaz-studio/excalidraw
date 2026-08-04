import { Scene } from "../src/Scene";

describe("Scene.onUpdate", () => {
  it("does not throw when unsubscribing after the scene was destroyed", () => {
    const scene = new Scene();
    const unbind = scene.onUpdate(() => {});

    // `destroy()` clears the callbacks; a subscriber torn down afterwards
    // (e.g. during React's commit-phase unmount) must not crash.
    scene.destroy();

    expect(() => unbind()).not.toThrow();
  });

  it("is idempotent when unsubscribing more than once", () => {
    const scene = new Scene();
    const unbind = scene.onUpdate(() => {});

    expect(() => {
      unbind();
      unbind();
    }).not.toThrow();
  });

  it("throws with a readable message when the same callback is registered twice", () => {
    const scene = new Scene();
    const cb = () => {};
    scene.onUpdate(cb);

    expect(() => scene.onUpdate(cb)).toThrow(
      "Scene.onUpdate: callback is already registered",
    );
  });
});
