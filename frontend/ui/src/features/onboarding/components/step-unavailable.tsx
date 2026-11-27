import Link from "next/link";
import { Logo } from "@/components/Logo";
import { StandaloneFrame } from "./standalone-frame";

/**
 * A sign-up step whose project is missing from the address, or that this
 * account cannot open: nothing to continue, so point at the account's workspaces.
 */
export function StepUnavailable({
  description = "The project it belongs to could not be found.",
}: {
  description?: string;
}) {
  return (
    <StandaloneFrame>
      <div className="flex w-full max-w-md flex-col items-center gap-2 text-center">
        <Logo size="lg" />
        <h1 className="text-[15px] font-medium">This step isn&apos;t available</h1>
        <p className="text-[13px] text-muted-foreground">
          {description}{" "}
          <Link href="/workspaces" className="underline underline-offset-4 hover:text-foreground">
            Go to your workspaces
          </Link>
        </p>
      </div>
    </StandaloneFrame>
  );
}
