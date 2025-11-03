import React from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RefreshButtonProps {
  onRefresh: () => void;
  disabled?: boolean;
}

const RefreshButton: React.FC<RefreshButtonProps> = ({
  onRefresh,
  disabled = false,
}) => {
  return (
    <Button
      onClick={onRefresh}
      variant="outline"
      size="default"
      className="min-h-[2.5rem]"
      disabled={disabled}
    >
      <RotateCw className="w-4 h-4" />
    </Button>
  );
};

export default RefreshButton;
