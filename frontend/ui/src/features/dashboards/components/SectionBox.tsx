// Section boxes match the detector creation form: square-cornered border with
// a muted header strip, sub-fields divided inside.
export function SectionBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-border">
      <div className="flex h-9 items-center border-b border-border px-4">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">{children}</p>;
}
