import { embeddableURLValidator, getEmbedLink } from "../src/embeddable";

describe("YouTube timestamp parsing", () => {
  it("should parse YouTube URLs with timestamp in seconds", () => {
    const testCases = [
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90",
        expectedStart: 90,
      },
      {
        url: "https://youtu.be/dQw4w9WgXcQ?t=120",
        expectedStart: 120,
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=150",
        expectedStart: 150,
      },
    ];

    testCases.forEach(({ url, expectedStart }) => {
      const result = getEmbedLink(url);
      expect(result).toBeTruthy();
      expect(result?.type).toBe("video");
      if (result?.type === "video" || result?.type === "generic") {
        expect(result.link).toContain(`start=${expectedStart}`);
      }
    });
  });

  it("should parse YouTube URLs with timestamp in time format", () => {
    const testCases = [
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s",
        expectedStart: 90, // 1*60 + 30
      },
      {
        url: "https://youtu.be/dQw4w9WgXcQ?t=2m45s",
        expectedStart: 165, // 2*60 + 45
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s",
        expectedStart: 3723, // 1*3600 + 2*60 + 3
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s",
        expectedStart: 45,
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5m",
        expectedStart: 300, // 5*60
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2h",
        expectedStart: 7200, // 2*3600
      },
    ];

    testCases.forEach(({ url, expectedStart }) => {
      const result = getEmbedLink(url);
      expect(result).toBeTruthy();
      expect(result?.type).toBe("video");
      if (result?.type === "video" || result?.type === "generic") {
        expect(result.link).toContain(`start=${expectedStart}`);
      }
    });
  });

  it("should handle YouTube URLs without timestamps", () => {
    const testCases = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ];

    testCases.forEach((url) => {
      const result = getEmbedLink(url);
      expect(result).toBeTruthy();
      expect(result?.type).toBe("video");
      if (result?.type === "video" || result?.type === "generic") {
        expect(result.link).not.toContain("start=");
      }
    });
  });

  it("should handle YouTube shorts URLs with timestamps", () => {
    const url = "https://www.youtube.com/shorts/dQw4w9WgXcQ?t=30";
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toContain("start=30");
    }
    // Shorts should have portrait aspect ratio
    expect(result?.intrinsicSize).toEqual({ w: 540, h: 960 });
  });

  it("should handle playlist URLs with timestamps", () => {
    const url =
      "https://www.youtube.com/playlist?list=PLrAXtmRdnEQy1KbG5lbfgQ0-PKQY6FKYZ&t=60";
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toContain("start=60");
      expect(result.link).toContain("list=PLrAXtmRdnEQy1KbG5lbfgQ0-PKQY6FKYZ");
    }
  });

  it("should handle malformed or edge case timestamps", () => {
    const testCases = [
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=abc",
        expectedStart: 0, // Invalid timestamp should default to 0
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=",
        expectedStart: 0, // Empty timestamp should default to 0
      },
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0",
        expectedStart: 0, // Zero timestamp should be handled
      },
    ];

    testCases.forEach(({ url, expectedStart }) => {
      const result = getEmbedLink(url);
      expect(result).toBeTruthy();
      expect(result?.type).toBe("video");
      if (result?.type === "video" || result?.type === "generic") {
        if (expectedStart === 0) {
          expect(result.link).not.toContain("start=");
        } else {
          expect(result.link).toContain(`start=${expectedStart}`);
        }
      }
    });
  });

  it("should preserve other URL parameters", () => {
    const url =
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90&feature=youtu.be&list=PLtest";
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toContain("start=90");
      expect(result.link).toContain("enablejsapi=1");
    }
  });
});

describe("Google Drive video embedding", () => {
  it.each([
    {
      url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?usp=sharing",
      expectedLink:
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/preview",
    },
    {
      url: "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz123456",
      expectedLink:
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/preview",
    },
    {
      url: "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz123456",
      expectedLink:
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/preview",
    },
  ])("should normalize Google Drive link: $url", ({ url, expectedLink }) => {
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toBe(expectedLink);
    }
    expect(result?.intrinsicSize).toEqual({ w: 960, h: 540 });
  });

  it("should preserve resourcekey when available", () => {
    const url =
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?resourcekey=0-abcdef123456";
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toBe(
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/preview?resourcekey=0-abcdef123456",
      );
    }
  });

  it("should preserve timestamp when available", () => {
    const url =
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?t=9";
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toBe(
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/preview?t=9",
      );
    }
  });

  it("should preserve resourcekey and timestamp together", () => {
    const url =
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?resourcekey=0-abcdef123456&t=9";
    const result = getEmbedLink(url);

    expect(result).toBeTruthy();
    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toBe(
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/preview?resourcekey=0-abcdef123456&t=9",
      );
    }
  });

  it("should validate Google Drive domain by default", () => {
    expect(
      embeddableURLValidator(
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view",
        undefined,
      ),
    ).toBe(true);
  });
});

describe("YouTube share-variant embeds", () => {
  it.each([
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/v/dQw4w9WgXcQ",
    "https://www.youtube.com/attribution_link?a=xyz&u=/watch%3Fv%3DdQw4w9WgXcQ",
    "https://www.youtube.com/watch?feature=shared&v=dQw4w9WgXcQ",
  ])("should embed as video: %s", (url) => {
    const result = getEmbedLink(url);

    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      // Classroom privacy: every frame serves from youtube-nocookie.com.
      expect(result.link).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1",
      );
    }
    expect(result?.intrinsicSize).toEqual({ w: 960, h: 540 });
  });

  it("should keep the timestamp on reordered watch params", () => {
    const result = getEmbedLink(
      "https://www.youtube.com/watch?t=90&v=dQw4w9WgXcQ",
    );

    expect(result?.type).toBe("video");
    if (result?.type === "video" || result?.type === "generic") {
      expect(result.link).toContain("start=90");
    }
  });

  it("should validate the new YouTube hosts by default", () => {
    for (const url of [
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
    ]) {
      expect(embeddableURLValidator(url, undefined)).toBe(true);
    }
  });

  it("should not mistake a section page for a video", () => {
    expect(getEmbedLink("https://www.youtube.com/feed/trending")).toBeNull();
  });
});

describe("Second-wave classroom app embeds", () => {
  // Pinterest shim, Wikipedia articles, Wayground join, Maps player and
  // Nearpod student surfaces: all generic-path (no rewrite), validated by
  // host. Validator proves ALLOWED_DOMAINS, sandbox proves ALLOW_SAME_ORIGIN.
  it.each([
    "https://assets.pinterest.com/ext/embed.html?id=1234567890123456",
    "https://assets.pinterest.com/ext/embed.html?grid=teacher/class-ideas",
    "https://en.wikipedia.org/wiki/Photosynthesis",
    "https://de.wikipedia.org/wiki/Photosynthese",
    "https://wayground.com/join?gc=257895",
    "https://www.google.com/maps/embed?pb=!1m18!2m12",
    "https://maps.google.com/maps?q=Ankara&output=embed",
    "https://join.nearpod.com/ABCDE",
    "https://nearpod.com/student/ABCDE",
    "https://app.nearpod.com/presentation?pin=ABCDE",
    "https://share.nearpod.com/xyz123",
  ])("should validate by default: %s", (url) => {
    expect(embeddableURLValidator(url, undefined)).toBe(true);
  });

  it("should keep interactive lesson frames same-origin but not static ones", () => {
    // Wayground, Maps and Nearpod sessions rely on storage/cookies.
    for (const url of [
      "https://wayground.com/join?gc=257895",
      "https://www.google.com/maps/embed?pb=!1m18!2m12",
      "https://app.nearpod.com/presentation?pin=ABCDE",
    ]) {
      expect(getEmbedLink(url)?.sandbox?.allowSameOrigin).toBe(true);
    }
    // The Pinterest shim and Wikipedia articles carry no session.
    for (const url of [
      "https://assets.pinterest.com/ext/embed.html?id=1234567890123456",
      "https://en.wikipedia.org/wiki/Photosynthesis",
    ]) {
      expect(getEmbedLink(url)?.sandbox?.allowSameOrigin).toBe(false);
    }
  });

  it("should still refuse the unframable Pinterest host", () => {
    // Direct Pinterest pages send SAMEORIGIN and only ever reach the board
    // through the shim converter, so pinterest.com itself stays unlisted.
    // (google.com validates by host like docs.google.com does — the meet
    // normalizer is the gate that only ever stores /embed forms, and share
    // pages X-Frame-Options-block in the browser regardless.)
    expect(
      embeddableURLValidator(
        "https://www.pinterest.com/pin/1234567890123456/",
        undefined,
      ),
    ).toBe(false);
  });
});

describe("Google Docs and Desmos embeds", () => {
  // New integration hosts embed as-is via the generic path (no URL rewrite). // validator proves ALLOWED_DOMAINS, sandbox proves ALLOW_SAME_ORIGIN.
  it.each([
    // Slides publish embed URL (docs host, publish path). // canonical pubembed form from File > Share > Publish to web.
    "https://docs.google.com/presentation/d/e/2PACX-1vT1234567890abcdef/pubembed",
    // Google Forms response URL (same docs host, forms path). // standard viewform link pasted from the browser.
    "https://docs.google.com/forms/d/e/1FAIpQLSf1234567890abcdef/viewform",
    // Desmos calculator URL (www variant proves the bare-host match). // matchHostname strips www. so desmos.com covers this.
    "https://www.desmos.com/calculator/abc123xyz",
  ])("should validate by default: %s", (url) => {
    expect(embeddableURLValidator(url, undefined)).toBe(true); // default allowlist accepts the host.
  });

  it.each([
    // Same three URLs, now checking the generic passthrough shape. // link unchanged, type generic, same-origin kept.
    "https://docs.google.com/presentation/d/e/2PACX-1vT1234567890abcdef/pubembed",
    "https://docs.google.com/forms/d/e/1FAIpQLSf1234567890abcdef/viewform",
    "https://www.desmos.com/calculator/abc123xyz",
  ])("should embed as-is via the generic path: %s", (url) => {
    const result = getEmbedLink(url); // generic path returns the link untouched.
    expect(result).toBeTruthy(); // a result object exists for the URL.
    if (result?.type === "video" || result?.type === "generic") {
      // narrow the union so .link/.sandbox read below.
      expect(result.link).toBe(url); // no rewrite branch touches these hosts.
      expect(result.type).toBe("generic"); // non-video hosts fall to the generic kind.
      expect(result.sandbox?.allowSameOrigin).toBe(true); // both hosts sit in ALLOW_SAME_ORIGIN.
    } else {
      throw new Error(`expected generic embed for ${url}`); // fail loudly if a document/srcdoc branch ever claims these URLs.
    }
  });
});
