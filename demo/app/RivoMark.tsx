import Image from "next/image";
import mark from "../assets/mark_rivo.png";
import markLight from "../assets/mark_rivo_light.png";

/**
 * The RivoKit mark. Source is 8000×8000, so it goes through `next/image` rather
 * than an <img>: the browser gets a resized, re-encoded copy at the size asked
 * for, not the 715 KB original.
 *
 * The artwork carries its own rounded corners and bleeds to its own edges, so
 * it needs no frame and no padding — sizing it is the whole job.
 *
 * `alt=""` by default because everywhere it is used the word "RivoKit" is right
 * beside it; announcing the mark as well would read the name twice.
 *
 * TWO TONES, AND WHY.
 *
 * The mark is `#0022d2` over `#1e009f`. Against the demo's white background
 * those measure 9.7:1 and 13.5:1 — a strong mark on the surface it was drawn
 * for. Against the landing's `--ink` they measure **2.0:1 and 1.44:1**, and the
 * indigo half — 28% of the artwork — effectively disappears. Everything beside
 * it on that page sits between 6.8:1 and 15.8:1, so the mark was the only dark
 * object on a dark field.
 *
 * The hue was never the problem: the mark is 264° and `--sodium` is 74°, which
 * is 190° apart — within 10° of a true complement. Nor should the mark BE
 * sodium: that is the action colour, and a logo wearing it would compete with
 * every CTA on the page. Lightness was the whole fault, and lightness is the
 * only thing the `light` tone changes.
 *
 * That tone is authored artwork, not a recolour: `#f4f4f4` over `#eaeaea`, which
 * measures 17.7:1 and 16.2:1 on `--ink`. Note the fold survives on a much
 * narrower tonal gap than the blue original's — the two halves are a step apart
 * rather than a jump — so if this ever needs to sit on a lighter dark surface
 * than `--ink`, check the fold is still legible before assuming it scales.
 */
// `priority` is defaulted rather than left optional: this repo compiles with
// `exactOptionalPropertyTypes`, and next/image declares the prop as a plain
// `boolean`, so passing `undefined` through is a type error.
export default function RivoMark({
  className = "size-8",
  size = 64,
  priority = false,
  alt = "",
  tone = "brand",
}: {
  className?: string;
  /** Pixel width handed to the optimizer — keep it at ~2× the rendered size. */
  size?: number;
  priority?: boolean;
  alt?: string;
  /**
   * `brand` — the blue mark, for light surfaces (the demo).
   * `light` — the near-white mark, for dark surfaces (the landing and /docs).
   *
   * Defaulted rather than left optional, like `priority` above: this repo
   * compiles with `exactOptionalPropertyTypes`.
   */
  tone?: "brand" | "light";
}) {
  return (
    <Image
      src={tone === "light" ? markLight : mark}
      alt={alt}
      width={size}
      height={size}
      priority={priority}
      className={className}
    />
  );
}
