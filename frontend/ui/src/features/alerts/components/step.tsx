import { cn } from "@/lib/utils";

interface StepProps {
  index: number;
  title: string;
  description?: string;
  isLast?: boolean;
  children?: React.ReactNode;
}

/** One numbered step with its connecting rail. */
export function Step({ index, title, description, isLast = false, children }: StepProps) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-[12px] font-medium text-background">
          {index}
        </div>
        {!isLast && <div className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-6")}>
        <h2 className="text-[14px] font-medium">{title}</h2>
        {description && <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>}
        {children && <div className={description ? "mt-3" : "mt-2"}>{children}</div>}
      </div>
    </div>
  );
}
