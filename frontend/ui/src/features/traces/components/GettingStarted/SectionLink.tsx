/**
 * The quiet link that sits at the right-hand end of a section heading.
 *
 * Three headings in this panel carry one — the stack picker's "request one",
 * and the docs link on each of the two routes — and they are deliberately the
 * same link: muted until hovered, so it does not compete with the heading, and
 * `shrink-0` so it never squeezes the heading beside it in the flex row they
 * share. Shared rather than copied because the three sit in three different
 * files, where a restyle of one would otherwise leave the others behind.
 * Onboarding's hand-back step puts the AI route's docs link over the same
 * command, so it takes this one as well.
 *
 * Opens in a new tab, with `noopener noreferrer`, because every one of them
 * leaves the app and the reader is mid-setup on this page.
 */
export function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
    >
      {children}
    </a>
  );
}
