import React from "react";
import { Group, Ungroup } from "lucide-react";
import { Button } from "@/components/ui/button";

interface GroupButtonProps {
  onToggle: () => void;
  isGrouped: boolean;
  disabled?: boolean;
}

const GroupButton: React.FC<GroupButtonProps> = ({
  onToggle,
  isGrouped,
  disabled = false,
}) => {
  return (
    <Button
      onClick={onToggle}
      variant="outline"
      size="default"
      className="min-h-[2.5rem]"
      disabled={disabled}
    >
      {isGrouped ? (
        <Ungroup className="w-4 h-4" />
      ) : (
        <Group className="w-4 h-4" />
      )}
    </Button>
  );
};

export default GroupButton;
