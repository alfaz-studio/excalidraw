import {
  FONT_FAMILY,
  VERTICAL_ALIGN,
  escapeDoubleQuotes,
  getFontString,
} from "@excalidraw/common";

import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";
import type { MarkRequired } from "@excalidraw/common/utility-types";

import { newTextElement } from "./newElement";
import { wrapText } from "./textWrapping";
import { isIframeElement } from "./typeChecks";

import type {
  ExcalidrawElement,
  ExcalidrawIframeLikeElement,
  IframeData,
} from "./types";

type IframeDataWithSandbox = MarkRequired<IframeData, "sandbox">;

const embeddedLinkCache = new Map<string, IframeDataWithSandbox>();

const RE_YOUTUBE =
  /^(?:http(?:s)?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/(embed\/|watch\?v=|shorts\/|live\/|v\/|playlist\?list=|embed\/videoseries\?list=)?([a-zA-Z0-9_-]+)/;

// Bare section paths must not read as video ids (e.g. /live alone is not a video).
const RE_YOUTUBE_RESERVED = new Set([
  "live",
  "v",
  "watch",
  "embed",
  "shorts",
  "playlist",
  "attribution_link",
  "feed",
  "channel",
  "user",
  "c",
  "results",
  "hashtag",
  "gaming",
  "music",
]);

const RE_VIMEO =
  /^(?:http(?:s)?:\/\/)?(?:(?:w){3}\.)?(?:player\.)?vimeo\.com\/(?:video\/)?([^?\s]+)(?:\?.*)?$/;
const RE_FIGMA = /^https:\/\/(?:www\.)?figma\.com/;

const RE_GH_GIST = /^https:\/\/gist\.github\.com\/([\w_-]+)\/([\w_-]+)/;
const RE_GH_GIST_EMBED =
  /^<script[\s\S]*?\ssrc=["'](https:\/\/gist\.github\.com\/.*?)\.js["']/i;

const RE_MSFORMS = /^(?:https?:\/\/)?forms\.microsoft\.com\//;

// Kahoot assignment links unwrap to the official player embed; the live-PIN
// join page and the player host iframe as-is (three lists move together here:
// this matcher, ALLOWED_DOMAINS and ALLOW_SAME_ORIGIN — see below).
const RE_KAHOOT_CHALLENGE =
  /^(?:https?:\/\/)?(?:www\.)?kahoot\.it\/challenge\/([^/?#\s]+)/i;
const RE_KAHOOT_EMBED =
  /^(?:https?:\/\/)?(?:www\.)?embed\.kahoot\.it\/([^/?#\s]+)/i;
const RE_KAHOOT_LIVE =
  /^(?:https?:\/\/)?(?:www\.)?(?:kahoot\.it\/(?:\?|v2\/)?|play\.kahoot\.it\/)/i;

// not anchored to start to allow <blockquote> twitter embeds
const RE_TWITTER =
  /(?:https?:\/\/)?(?:(?:w){3}\.)?(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/;
const RE_TWITTER_EMBED =
  /^<blockquote[\s\S]*?\shref=["'](https?:\/\/(?:twitter|x)\.com\/[^"']*)/i;

const RE_VALTOWN =
  /^https:\/\/(?:www\.)?val\.town\/(v|embed)\/[a-zA-Z_$][0-9a-zA-Z_$]+\.[a-zA-Z_$][0-9a-zA-Z_$]+/;

const RE_GENERIC_EMBED =
  /^<(?:iframe|blockquote)[\s\S]*?\s(?:src|href)=["']([^"']*)["'][\s\S]*?>$/i;

const RE_GIPHY =
  /giphy.com\/(?:clips|embed|gifs)\/[a-zA-Z0-9]*?-?([a-zA-Z0-9]+)(?:[^a-zA-Z0-9]|$)/;

const RE_REDDIT =
  /^(?:http(?:s)?:\/\/)?(?:www\.)?reddit\.com\/r\/([a-zA-Z0-9_]+)\/comments\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/;

const RE_REDDIT_EMBED =
  /^<blockquote[\s\S]*?\shref=["'](https?:\/\/(?:www\.)?reddit\.com\/[^"']*)/i;

const parseYouTubeLikeTimestamp = (url: string): number => {
  let timeParam: string | null | undefined;

  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    timeParam =
      urlObj.searchParams.get("t") || urlObj.searchParams.get("start");
  } catch (error) {
    const timeMatch = url.match(/[?&#](?:t|start)=([^&#\s]+)/);
    timeParam = timeMatch?.[1];
  }

  if (!timeParam) {
    return 0;
  }

  if (/^\d+$/.test(timeParam)) {
    return parseInt(timeParam, 10);
  }

  const timeMatch = timeParam.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!timeMatch) {
    return 0;
  }

  const [, hours = "0", minutes = "0", seconds = "0"] = timeMatch;
  return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
};

// Share-sheet variants never match a path-prefix regex, so unwrap them first.
const normalizeYouTubeLink = (link: string): string => {
  let url: URL;
  try {
    url = new URL(link.startsWith("http") ? link : `https://${link}`);
  } catch (error) {
    return link;
  }
  if (
    url.hostname.replace(/^(www|m|music)\./, "").toLowerCase() !== "youtube.com"
  ) {
    return link;
  }
  // Attribution links wrap the real watch URL in the `u` param.
  if (url.pathname === "/attribution_link") {
    const wrapped = url.searchParams.get("u");
    if (wrapped) {
      return wrapped.startsWith("/")
        ? `https://www.youtube.com${wrapped}`
        : wrapped;
    }
    return link;
  }
  // `watch` with params before `v` never matches `watch?v=` positionally.
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    if (id && !url.search.startsWith("?v=")) {
      return `https://www.youtube.com/watch?v=${id}`;
    }
  }
  return link;
};

const parseGoogleDriveVideoLink = (
  url: string,
): { fileId: string; resourceKey?: string; timestamp?: number } | null => {
  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    const hostname = urlObj.hostname.replace(/^www\./, "");
    if (hostname !== "drive.google.com") {
      return null;
    }

    let fileId: string | null = null;
    const pathMatch = urlObj.pathname.match(/^\/file\/d\/([^/]+)(?:\/|$)/);
    if (pathMatch?.[1]) {
      fileId = pathMatch[1];
    } else if (urlObj.pathname === "/open" || urlObj.pathname === "/uc") {
      // Shared Drive links can be emitted as:
      // - /open?id=<fileId> (common "open in Drive" format)
      // - /uc?...&id=<fileId> (download/export endpoint often seen in copied links)
      fileId = urlObj.searchParams.get("id");
    }

    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return null;
    }

    // Some Drive share links include `resourcekey` for access to link-shared
    // files; preserve it in the preview URL so embeds keep working.
    const resourceKey = urlObj.searchParams.get("resourcekey");
    const timestamp = parseYouTubeLikeTimestamp(urlObj.toString());

    return {
      fileId,
      resourceKey:
        resourceKey && /^[a-zA-Z0-9_-]+$/.test(resourceKey)
          ? resourceKey
          : undefined,
      // Drive accepts YouTube-like `t` formats (e.g. `t=90`, `t=1m30s`);
      // normalize to seconds for a stable preview URL.
      timestamp: timestamp > 0 ? timestamp : undefined,
    };
  } catch (error) {
    return null;
  }
};

const ALLOWED_DOMAINS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "m.youtube.com",
  "music.youtube.com",
  "vimeo.com",
  "player.vimeo.com",
  "drive.google.com",
  "figma.com",
  "link.excalidraw.com",
  "gist.github.com",
  "twitter.com",
  "x.com",
  "*.simplepdf.eu",
  "stackblitz.com",
  "val.town",
  "giphy.com",
  "reddit.com",
  "forms.microsoft.com",
  // Kahoot classroom embeds (challenge player, live-PIN join page, player host).
  "kahoot.it",
  "play.kahoot.it",
  "embed.kahoot.it",
]);

const ALLOW_SAME_ORIGIN = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "m.youtube.com",
  "music.youtube.com",
  "vimeo.com",
  "player.vimeo.com",
  "drive.google.com",
  "figma.com",
  "twitter.com",
  "x.com",
  "*.simplepdf.eu",
  "stackblitz.com",
  "reddit.com",
  "forms.microsoft.com",
  // Interactive quiz/player frames rely on storage and cookies to join.
  "kahoot.it",
  "play.kahoot.it",
  "embed.kahoot.it",
]);

export const createSrcDoc = (body: string) => {
  return `<html><body>${body}</body></html>`;
};

export const getEmbedLink = (
  link: string | null | undefined,
): IframeDataWithSandbox | null => {
  if (!link) {
    return null;
  }

  if (embeddedLinkCache.has(link)) {
    return embeddedLinkCache.get(link)!;
  }

  const originalLink = link;

  const allowSameOrigin = ALLOW_SAME_ORIGIN.has(
    matchHostname(link, ALLOW_SAME_ORIGIN) || "",
  );

  // Default intrinsic size for generic (non-video) embeds. // landscape 4:3 so pasted links read well without resizing.
  let type: "video" | "generic" = "generic"; // embed kind, refined per matcher below.
  let aspectRatio = { w: 800, h: 600 }; // fallback size; each video branch overrides with 16:9.
  const normalizedYtLink = normalizeYouTubeLink(link);
  const ytLink = normalizedYtLink.match(RE_YOUTUBE);
  if (ytLink?.[2]) {
    if (!ytLink[1] && RE_YOUTUBE_RESERVED.has(ytLink[2])) {
      return null;
    }
    // Unwrapped links carry time inside `u`; reordered watch URLs keep it outside.
    const startTime =
      parseYouTubeLikeTimestamp(normalizedYtLink) ||
      parseYouTubeLikeTimestamp(link);
    const time = startTime > 0 ? `&start=${startTime}` : ``;
    const isPortrait = ytLink[0].includes("shorts");
    type = "video";
    switch (ytLink[1]) {
      case "embed/":
      case "watch?v=":
      case "shorts/":
      case "live/":
      case "v/":
        link = `https://www.youtube.com/embed/${ytLink[2]}?enablejsapi=1${time}`;
        break;
      case "playlist?list=":
      case "embed/videoseries?list=":
        link = `https://www.youtube.com/embed/videoseries?list=${ytLink[2]}&enablejsapi=1${time}`;
        break;
      default:
        link = `https://www.youtube.com/embed/${ytLink[2]}?enablejsapi=1${time}`;
        break;
    }
    // Portrait only for /shorts; everything else is landscape 16:9. // bigger defaults so fresh embeds are usable without an immediate resize.
    aspectRatio = isPortrait ? { w: 540, h: 960 } : { w: 960, h: 540 }; // 9:16 shorts vs 16:9 video.
    embeddedLinkCache.set(originalLink, {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    });
    return {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    };
  }

  const vimeoLink = link.match(RE_VIMEO);
  if (vimeoLink?.[1]) {
    const target = vimeoLink?.[1];
    const error = !/^\d+$/.test(target)
      ? new URIError("Invalid embed link format")
      : undefined;
    type = "video"; // vimeo serves a 16:9 player.
    link = `https://player.vimeo.com/video/${target}?api=1`; // normalize to the player embed URL.
    aspectRatio = { w: 960, h: 540 }; // 16:9, matches YouTube landscape default.
    //warning deliberately ommited so it is displayed only once per link
    //same link next time will be served from cache
    embeddedLinkCache.set(originalLink, {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    });
    return {
      link,
      intrinsicSize: aspectRatio,
      type,
      error,
      sandbox: { allowSameOrigin },
    };
  }

  const googleDriveVideo = parseGoogleDriveVideoLink(link);
  if (googleDriveVideo) {
    type = "video"; // drive preview is a 16:9 video player.
    const searchParams = new URLSearchParams(); // carry resourcekey/timestamp into the preview URL.
    if (googleDriveVideo.resourceKey) {
      searchParams.set("resourcekey", googleDriveVideo.resourceKey);
    }
    if (googleDriveVideo.timestamp) {
      searchParams.set("t", `${googleDriveVideo.timestamp}`);
    }

    const search = searchParams.toString();
    link = `https://drive.google.com/file/d/${googleDriveVideo.fileId}/preview${
      search ? `?${search}` : ""
    }`; // normalized preview URL keeps file id + params.
    aspectRatio = { w: 960, h: 540 }; // 16:9, matches other video defaults.
    embeddedLinkCache.set(originalLink, {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    });
    return {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    };
  }

  const figmaLink = link.match(RE_FIGMA);
  if (figmaLink) {
    type = "generic";
    link = `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(
      link,
    )}`;
    aspectRatio = { w: 550, h: 550 };
    embeddedLinkCache.set(originalLink, {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    });
    return {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    };
  }

  const valLink = link.match(RE_VALTOWN);
  if (valLink) {
    link =
      valLink[1] === "embed" ? valLink[0] : valLink[0].replace("/v", "/embed");
    embeddedLinkCache.set(originalLink, {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    });
    return {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    };
  }

  if (RE_MSFORMS.test(link) && !link.includes("embed=true")) {
    link += link.includes("?") ? "&embed=true" : "?embed=true";
  }

  const kahootChallenge = link.match(RE_KAHOOT_CHALLENGE);
  const kahootEmbed = link.match(RE_KAHOOT_EMBED);
  if (kahootChallenge?.[1] || kahootEmbed?.[1] || RE_KAHOOT_LIVE.test(link)) {
    type = "generic";
    if (kahootChallenge?.[1]) {
      link = `https://embed.kahoot.it/${kahootChallenge[1]}`;
    } else if (kahootEmbed?.[1]) { // official player host passes through untouched.
      link = `https://embed.kahoot.it/${kahootEmbed[1]}`; // canonical player URL for the slug.
    } // live-PIN join page keeps its URL as-is (matched, not rewritten).
    aspectRatio = { w: 960, h: 540 }; // 16:9 player; enlarged like other video sizes.
    embeddedLinkCache.set(originalLink, {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    });
    return {
      link,
      intrinsicSize: aspectRatio,
      type,
      sandbox: { allowSameOrigin },
    };
  }

  if (RE_TWITTER.test(link)) {
    const postId = link.match(RE_TWITTER)![1];
    // the embed srcdoc still supports twitter.com domain only.
    // Note that we don't attempt to parse the username as it can consist of
    // non-latin1 characters, and the username in the url can be set to anything
    // without affecting the embed.
    const safeURL = escapeDoubleQuotes(
      `https://twitter.com/x/status/${postId}`,
    );

    const ret: IframeDataWithSandbox = {
      type: "document",
      srcdoc: (theme: string) =>
        createSrcDoc(
          `<blockquote class="twitter-tweet" data-dnt="true" data-theme="${theme}"><a href="${safeURL}"></a></blockquote> <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`,
        ),
      intrinsicSize: { w: 480, h: 480 },
      sandbox: { allowSameOrigin },
    };
    embeddedLinkCache.set(originalLink, ret);
    return ret;
  }

  if (RE_REDDIT.test(link)) {
    const [, page, postId, title] = link.match(RE_REDDIT)!;
    const safeURL = escapeDoubleQuotes(
      `https://reddit.com/r/${page}/comments/${postId}/${title}`,
    );
    const ret: IframeDataWithSandbox = {
      type: "document",
      srcdoc: (theme: string) =>
        createSrcDoc(
          `<blockquote class="reddit-embed-bq" data-embed-theme="${theme}"><a href="${safeURL}"></a><br></blockquote><script async="" src="https://embed.reddit.com/widgets.js" charset="UTF-8"></script>`,
        ),
      intrinsicSize: { w: 480, h: 480 },
      sandbox: { allowSameOrigin },
    };
    embeddedLinkCache.set(originalLink, ret);
    return ret;
  }

  if (RE_GH_GIST.test(link)) {
    const [, user, gistId] = link.match(RE_GH_GIST)!;
    const safeURL = escapeDoubleQuotes(
      `https://gist.github.com/${user}/${gistId}`,
    );
    const ret: IframeDataWithSandbox = {
      type: "document",
      srcdoc: () =>
        createSrcDoc(`
          <script src="${safeURL}.js"></script>
          <style type="text/css">
            * { margin: 0px; }
            table, .gist { height: 100%; }
            .gist .gist-file { height: calc(100vh - 2px); padding: 0px; display: grid; grid-template-rows: 1fr auto; }
          </style>
        `),
      intrinsicSize: { w: 550, h: 720 },
      sandbox: { allowSameOrigin },
    };
    embeddedLinkCache.set(link, ret);
    return ret;
  }

  embeddedLinkCache.set(link, {
    link,
    intrinsicSize: aspectRatio,
    type,
    sandbox: { allowSameOrigin },
  });
  return {
    link,
    intrinsicSize: aspectRatio,
    type,
    sandbox: { allowSameOrigin },
  };
};

export const createPlaceholderEmbeddableLabel = (
  element: ExcalidrawIframeLikeElement,
): ExcalidrawElement => {
  let text: string;
  if (isIframeElement(element)) {
    text = "IFrame element";
  } else {
    text =
      !element.link || element?.link === "" ? "Empty Web-Embed" : element.link;
  }

  const fontSize = Math.max(
    Math.min(element.width / 2, element.width / text.length),
    element.width / 30,
  );
  const fontFamily = FONT_FAMILY.Helvetica;

  const fontString = getFontString({
    fontSize,
    fontFamily,
  });

  return newTextElement({
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
    strokeColor:
      element.strokeColor !== "transparent" ? element.strokeColor : "black",
    backgroundColor: "transparent",
    fontFamily,
    fontSize,
    text: wrapText(text, fontString, element.width - 20),
    textAlign: "center",
    verticalAlign: VERTICAL_ALIGN.MIDDLE,
    angle: element.angle ?? 0,
  });
};

const matchHostname = (
  url: string,
  /** using a Set assumes it already contains normalized bare domains */
  allowedHostnames: Set<string> | string,
): string | null => {
  try {
    const { hostname } = new URL(url);

    const bareDomain = hostname.replace(/^www\./, "");

    if (allowedHostnames instanceof Set) {
      if (ALLOWED_DOMAINS.has(bareDomain)) {
        return bareDomain;
      }

      const bareDomainWithFirstSubdomainWildcarded = bareDomain.replace(
        /^([^.]+)/,
        "*",
      );
      if (ALLOWED_DOMAINS.has(bareDomainWithFirstSubdomainWildcarded)) {
        return bareDomainWithFirstSubdomainWildcarded;
      }
      return null;
    }

    const bareAllowedHostname = allowedHostnames.replace(/^www\./, "");
    if (bareDomain === bareAllowedHostname) {
      return bareAllowedHostname;
    }
  } catch (error) {
    // ignore
  }
  return null;
};

export const maybeParseEmbedSrc = (str: string): string => {
  const twitterMatch = str.match(RE_TWITTER_EMBED);
  if (twitterMatch && twitterMatch.length === 2) {
    return twitterMatch[1];
  }

  const redditMatch = str.match(RE_REDDIT_EMBED);
  if (redditMatch && redditMatch.length === 2) {
    return redditMatch[1];
  }

  const gistMatch = str.match(RE_GH_GIST_EMBED);
  if (gistMatch && gistMatch.length === 2) {
    return gistMatch[1];
  }

  if (RE_GIPHY.test(str)) {
    return `https://giphy.com/embed/${RE_GIPHY.exec(str)![1]}`;
  }

  const match = str.match(RE_GENERIC_EMBED);
  if (match && match.length === 2) {
    return match[1];
  }

  return str;
};

export const embeddableURLValidator = (
  url: string | null | undefined,
  validateEmbeddable: ExcalidrawProps["validateEmbeddable"],
): boolean => {
  if (!url) {
    return false;
  }
  if (validateEmbeddable != null) {
    if (typeof validateEmbeddable === "function") {
      const ret = validateEmbeddable(url);
      // if return value is undefined, leave validation to default
      if (typeof ret === "boolean") {
        return ret;
      }
    } else if (typeof validateEmbeddable === "boolean") {
      return validateEmbeddable;
    } else if (validateEmbeddable instanceof RegExp) {
      return validateEmbeddable.test(url);
    } else if (Array.isArray(validateEmbeddable)) {
      for (const domain of validateEmbeddable) {
        if (domain instanceof RegExp) {
          if (url.match(domain)) {
            return true;
          }
        } else if (matchHostname(url, domain)) {
          return true;
        }
      }
      return false;
    }
  }

  return !!matchHostname(url, ALLOWED_DOMAINS);
};
