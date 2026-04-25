/**
 * Nav-side badge for the Presence Copilot.
 *
 * Shows urgency at a glance: drafts dying in <1 h get the danger color,
 * unviewed drafts in the next 24 h get the warn color, just-existing
 * proposed drafts get the neutral chip. Hidden entirely when there are
 * none (zero clutter when the feed is empty).
 */

type Summary = {
  proposed: number;
  proposed_unviewed: number;
  dying_within_1h: number;
  dying_within_24h: number;
};

export function PresenceBadge({ summary }: { summary: Summary }) {
  if (summary.proposed === 0 && summary.proposed_unviewed === 0) return null;

  // Pick the most urgent count we have to surface.
  const isDying = summary.dying_within_1h > 0;
  const isWarn = !isDying && summary.dying_within_24h > 0;
  const tone = isDying
    ? 'bg-[rgba(255,69,58,0.18)] text-[#ff453a]'
    : isWarn
      ? 'bg-[rgba(255,159,10,0.18)] text-[#ff9f0a]'
      : 'bg-[var(--surface-2)] text-[var(--text-mute)]';

  const count = isDying
    ? summary.dying_within_1h
    : isWarn
      ? summary.dying_within_24h
      : summary.proposed_unviewed || summary.proposed;

  const title = isDying
    ? `${summary.dying_within_1h} drafts die within 1 h`
    : isWarn
      ? `${summary.dying_within_24h} drafts die within 24 h`
      : `${summary.proposed_unviewed} unviewed of ${summary.proposed} proposed`;

  return (
    <span
      className={`inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${tone}`}
      title={title}
    >
      {count}
    </span>
  );
}
