/** Sections planned in later tasks (see implementation_plan.md §9.3). */
export function Pending({ title, what }: { title: string; what: string }) {
  return (
    <div className="max-w-[72ch] px-6 py-5">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-ink-soft">{what}</p>
    </div>
  );
}
