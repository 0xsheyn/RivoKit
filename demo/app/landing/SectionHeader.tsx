export default function SectionHeader({ number, title }: { number: string; title: string }) {
  return (
    <div className="mb-8 flex items-baseline justify-between border-b border-[color:var(--ash)]/20 pb-3">
      <span className="eyebrow">
        {number} —— {title}
      </span>
    </div>
  );
}
