/**
 * Shared template runtime. Uses only the browser's Web Animations API, which HyperFrames seeks
 * frame by frame, so no animation library (and no third-party licence) is involved.
 *
 * Whole text blocks animate as one element. Text is never split into letters: per-letter spans
 * break Arabic cursive joining, and this applies to every language so no branch can get it wrong.
 */
(function () {
  const job = JSON.parse(document.getElementById("job-data").textContent);
  const root = document.getElementById("root");

  root.style.setProperty("--background", job.colors.background);
  root.style.setProperty("--text", job.colors.text);
  root.style.setProperty("--accent", job.colors.accent);
  root.style.setProperty("--accent-text", job.colors.accentText);

  for (const [id, value] of [
    ["brand", job.brand],
    ["headline", job.headline],
    ["description", job.description],
    ["cta", job.callToAction],
  ]) {
    const element = document.getElementById(id);
    if (!element) continue;
    // textContent only: submitted text is never parsed as markup.
    element.textContent = value;
    element.hidden = value === "";
  }

  const logo = document.getElementById("logo");
  if (logo) {
    if (job.hasLogo) logo.src = "assets/logo.png";
    else logo.hidden = true;
  }

  /** The width of the widest whole word, so a long Finnish compound can be kept unbroken. */
  function widestWord(element) {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d");
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return Math.max(...element.textContent.split(/\s+/).map((w) => context.measureText(w).width));
  }

  /**
   * The height the box's visible children need. Offsets ignore transforms, so this can't be
   * thrown off by an entrance animation, the way scrollHeight can.
   */
  function neededHeight(box) {
    const style = getComputedStyle(box);
    const gap = parseFloat(style.rowGap) || 0;
    const children = [...box.children].filter((child) => child.offsetHeight > 0);
    const heights = children.map((child) =>
      child.id === "copy" ? neededHeight(child) : child.offsetHeight,
    );
    return (
      heights.reduce((sum, height) => sum + height, 0) +
      gap * Math.max(0, children.length - 1) +
      parseFloat(style.paddingBlockStart) +
      parseFloat(style.paddingBlockEnd)
    );
  }

  /**
   * Shrinks the headline, then the description, until the copy fits `boxSelector` and each block's
   * longest word fits its line where it can. Copy that still overflows at the minimum sizes is
   * rejected by `check`. A word too long for its line at the minimum size does break.
   */
  function fitCopy(boxSelector) {
    const box = document.querySelector(boxSelector);
    const fits = (element) =>
      neededHeight(box) <= box.clientHeight + 1 &&
      widestWord(element) <= element.parentElement.clientWidth;
    for (const [id, floorPercent] of [
      ["headline", 50],
      ["description", 70],
      ["cta", 70],
      ["brand", 70],
    ]) {
      const element = document.getElementById(id);
      if (!element || element.hidden) continue;
      const base = parseFloat(getComputedStyle(element).fontSize);
      for (let percent = 100; percent >= floorPercent; percent -= 5) {
        element.style.fontSize = `${(base * percent) / 100}px`;
        if (fits(element)) break;
      }
    }
  }

  function enter(selector, atSeconds, seconds = 0.7, distance = 40) {
    const element = document.querySelector(selector);
    if (!element || element.hidden) return;
    element.animate(
      [
        { opacity: 0, transform: `translateY(${distance}px)` },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        delay: atSeconds * 1000,
        duration: seconds * 1000,
        fill: "both",
        easing: "cubic-bezier(.2,.7,.2,1)",
      },
    );
  }

  /** Slow drift over the whole film, for still images. Video keeps its own motion. */
  function drift(selector) {
    const element = document.querySelector(selector);
    if (!element || job.mediaKind !== "image") return;
    element.animate([{ transform: "scale(1)" }, { transform: "scale(1.08)" }], {
      duration: job.duration * 1000,
      fill: "both",
      easing: "linear",
    });
  }

  function fadeOutAll(selector) {
    const element = document.querySelector(selector);
    if (!element) return;
    element.animate([{ opacity: 1 }, { opacity: 0 }], {
      delay: (job.duration - 0.5) * 1000,
      duration: 500,
      fill: "both",
      easing: "linear",
    });
  }

  /**
   * HyperFrames requires a registered timeline, and takes the composition's length from it. The
   * Web Animations adapter does the actual seeking, so the other methods have nothing to do.
   */
  const timeline = {
    duration: () => job.duration,
    pause() {},
    seek() {},
  };

  window.SyvekaTemplate = { job, timeline, fitCopy, enter, drift, fadeOutAll };
})();
