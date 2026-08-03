import Image from "next/image";
import mark from "../assets/mark_rivo.png";

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
 */
// `priority` is defaulted rather than left optional: this repo compiles with
// `exactOptionalPropertyTypes`, and next/image declares the prop as a plain
// `boolean`, so passing `undefined` through is a type error.
export default function RivoMark({
  className = "size-8",
  size = 64,
  priority = false,
  alt = "",
}: {
  className?: string;
  /** Pixel width handed to the optimizer — keep it at ~2× the rendered size. */
  size?: number;
  priority?: boolean;
  alt?: string;
}) {
  return (
    <Image
      src={mark}
      alt={alt}
      width={size}
      height={size}
      priority={priority}
      className={className}
    />
  );
}
