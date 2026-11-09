/* Picture assets for naming practice.
   Uses Twemoji SVG artwork so the object is actually visible; the
   emoji itself remains only as a fallback if the image cannot load. */

import { el } from "./ui.js";

const TWEMOJI_SVG = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg";

function codePoints(emoji) {
  return [...String(emoji || "")]
    .map((char) => char.codePointAt(0))
    .filter((cp) => cp && cp !== 0xfe0f && cp !== 0x200d)
    .map((cp) => cp.toString(16))
    .join("-");
}

export function picturePool(activity, level) {
  const content = activity?.content || {};
  const pool = content[level] || content[1] || content[Object.keys(content)[0]] || [];
  return Array.isArray(pool) ? pool.filter((item) => item && (item.emoji || item.word)) : [];
}

export function pictureVisual(item) {
  const emoji = item?.emoji || "❓";
  const code = codePoints(emoji);
  const frame = el("div", { class: "picture-frame", attrs: { role: "img", "aria-label": "Picture to name" } });
  const fallback = el("span", { class: "picture-fallback", text: emoji, attrs: { hidden: true } });
  if (!code) {
    fallback.hidden = false;
    frame.classList.add("is-fallback");
    frame.append(fallback);
    return frame;
  }
  const img = el("img", {
    class: "picture-img",
    src: `${TWEMOJI_SVG}/${code}.svg`,
    alt: "",
    attrs: { loading: "eager", decoding: "async" },
  });
  img.addEventListener("error", () => {
    img.hidden = true;
    fallback.hidden = false;
    frame.classList.add("is-fallback");
  });
  frame.append(img, fallback);
  return frame;
}
