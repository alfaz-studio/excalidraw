import { fileSave, setFileSaveOverride } from "../../data/filesystem";

describe("setFileSaveOverride", () => {
  afterEach(() => {
    setFileSaveOverride(null);
  });

  it("hands every save, with its resolved blob, to the host override", async () => {
    const override = vi.fn(async () => null);
    setFileSaveOverride(override);

    const blob = new Blob(["{}"], { type: "application/json" });
    const opts = {
      name: "board",
      extension: "excalidraw" as const,
      description: "Excalidraw file",
    };

    await expect(fileSave(Promise.resolve(blob), opts)).resolves.toBe(null);
    expect(override).toHaveBeenCalledWith(blob, opts);
  });

  it("keeps calling the override it started with if the host clears it mid-save", async () => {
    const override = vi.fn(async () => null);
    setFileSaveOverride(override);

    let resolveBlob: (blob: Blob) => void = () => {};
    const pending = fileSave(
      new Promise<Blob>((resolve) => {
        resolveBlob = resolve;
      }),
      { name: "board", extension: "png", description: "PNG" },
    );

    setFileSaveOverride(null);
    resolveBlob(new Blob(["png"]));
    await pending;

    expect(override).toHaveBeenCalledTimes(1);
  });
});
