/**
 * The eight sections of the documentation page, in page order. Three things
 * read this list — the sticky sidebar, the wrapped row that replaces it on
 * narrow screens, and the section headings themselves — and a heading renamed
 * in one of three places is a heading that disagrees with itself.
 *
 * Its own module, and deliberately not `"use client"`. A server component that
 * imports from a client module gets a client-reference proxy in place of each
 * export, so the array arrives without its methods and `.map` is not a
 * function — the same reason `landing/stack.ts` sits apart from the components
 * that render it.
 */
export const DOC_SECTIONS = [
  { id: "what", number: "01", label: "What it is" },
  { id: "stack", number: "02", label: "Tech stack" },
  { id: "layout", number: "03", label: "Repository" },
  { id: "code", number: "04", label: "The code that matters" },
  { id: "integrate", number: "05", label: "Integration" },
  { id: "bank", number: "06", label: "Bank payout" },
  { id: "scripts", number: "07", label: "Scripts" },
  { id: "reference", number: "08", label: "Reference" },
] as const;

export type DocSectionId = (typeof DOC_SECTIONS)[number]["id"];
