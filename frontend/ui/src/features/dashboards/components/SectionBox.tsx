// Section boxes match the detector creation form: square-cornered border with
// a muted header strip, sub-fields divided inside.
export function SectionBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-border">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>;
}
