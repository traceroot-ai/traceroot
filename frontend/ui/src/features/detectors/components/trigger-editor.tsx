"use client";

import { useState, useEffect, useMemo } from "react";
import { X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dropdown,
  DropdownItem,
  FIELD_ICONS,
  FIELD_UNIT,
  FieldDropdown,
  FilterControlSizeProvider,
  MetadataKeyCombobox,
  NumberField,
  TextField,
  ValueDropdown,
} from "@/features/filters/filter-controls";
import { useFilterValues } from "@/features/filters/hooks";
import { MAX_FILTERS } from "@/features/filters/predicate";
import {
  TRIGGER_FIELD_DEFS,
  defaultTriggerCondition,
  normalizeTriggerConditions,
  triggerFieldDef,
  triggerOpLabel,
  validateTriggerConditions,
  type TriggerCondition,
} from "../trigger-fields";

export type { TriggerCondition } from "../trigger-fields";

interface TriggerEditorProps {
  conditions: TriggerCondition[];
  /** Project the detector belongs to — scopes value/key suggestions. */
  projectId: string;
  /** Controlled mode: called on every change, no Save button shown */
  onChange?: (conditions: TriggerCondition[]) => void;
  /** Uncontrolled/save mode: shows a Save button when dirty */
  onSave?: (conditions: TriggerCondition[]) => void;
  isSaving?: boolean;
  /** Read-only: show conditions but hide add/remove/save controls */
  readOnly?: boolean;
  /** Card mode: renders as a bordered card section (header + body) for embedding inside a card container */
  asCard?: boolean;
}

function ConditionRow({
  condition,
  projectId,
  readOnly,
  onPatch,
  onRemove,
}: {
  condition: TriggerCondition;
  projectId: string;
  readOnly?: boolean;
  onPatch: (patch: Partial<TriggerCondition>) => void;
  onRemove: () => void;
}) {
  const def = triggerFieldDef(condition.field);
  const enumerable = def?.valueKind === "enum";

  // Detectors watch live traces, so suggestions are not window-bounded: the
  // hooks fall back to the project's retention window.
  const { values, isLoading } = useFilterValues(
    projectId,
    condition.field,
    undefined,
    undefined,
    enumerable && !readOnly,
  );

  // Keep a previously-saved value selectable even when it no longer occurs in
  // the observed values (it gets no count, marking it as stale).
  const options = useMemo(() => {
    const current = String(condition.value ?? "");
    const hasCurrent = values.some((v) => v.value === current);
    return current && !hasCurrent ? [{ value: current }, ...values] : values;
  }, [values, condition.value]);

  const showValueDropdown = enumerable && (values.length > 0 || isLoading);
  const isNumeric = def?.valueKind === "number";

  return (
    <div className="flex items-center gap-1.5">
      <FieldDropdown
        options={TRIGGER_FIELD_DEFS.map((d) => ({
          key: d.field,
          label: d.label,
          icon: FIELD_ICONS[d.field],
        }))}
        valueKey={condition.field || null}
        onPick={(field) => onPatch(defaultTriggerCondition(field))}
      />

      {def?.requiresKey && (
        <MetadataKeyCombobox
          projectId={projectId}
          value={condition.key ?? ""}
          onValue={(v) => onPatch({ key: v })}
          // The trigger row applies as it is edited, so Enter has nothing to submit.
          onEnter={() => {}}
        />
      )}

      <Dropdown
        disabled={!def}
        trigger={
          <span className="whitespace-nowrap">
            {def && condition.op ? triggerOpLabel(def, condition.op) : "is"}
          </span>
        }
        triggerClassName="min-w-[3.5rem] shrink-0"
        contentClassName="w-28"
      >
        {(close) =>
          (def?.ops ?? []).map((op) => (
            <DropdownItem
              key={op}
              active={op === condition.op}
              onClick={() => {
                onPatch({ op });
                close();
              }}
            >
              {triggerOpLabel(def, op)}
            </DropdownItem>
          ))
        }
      </Dropdown>

      {showValueDropdown ? (
        <ValueDropdown
          value={String(condition.value ?? "")}
          options={options}
          onValue={(v) => onPatch({ value: v })}
          placeholder={isLoading ? "Loading…" : undefined}
        />
      ) : isNumeric ? (
        <NumberField
          ariaLabel="value"
          placeholder="Enter value"
          value={String(condition.value ?? "")}
          // Held as typed and coerced once on the way out: Number() here would
          // round-trip a long entry back into the field as "1e+21".
          onChange={(v) => onPatch({ value: v })}
          unit={FIELD_UNIT[condition.field]}
          integer={def?.integer}
        />
      ) : (
        <TextField
          ariaLabel="value"
          placeholder="Enter value"
          value={String(condition.value ?? "")}
          onChange={(v) => onPatch({ value: v })}
        />
      )}

      {!readOnly && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Remove condition"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function TriggerEditor({
  conditions: initialConditions,
  projectId,
  onChange,
  onSave,
  isSaving,
  readOnly,
  asCard,
}: TriggerEditorProps) {
  const [conditions, setConditions] = useState<TriggerCondition[]>(initialConditions);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setConditions(initialConditions);
    setDirty(false);
  }, [initialConditions]);

  const update = (next: TriggerCondition[]) => {
    setConditions(next);
    if (onChange) {
      onChange(next);
    } else {
      setDirty(true);
    }
  };

  // The write path caps the array at MAX_FILTERS, so refuse the row here rather
  // than building a payload the save would reject.
  const atFilterCap = conditions.length >= MAX_FILTERS;

  const addCondition = () => {
    if (atFilterCap) return;
    update([...conditions, defaultTriggerCondition(TRIGGER_FIELD_DEFS[0].field)]);
  };

  const removeCondition = (i: number) => {
    update(conditions.filter((_, idx) => idx !== i));
  };

  const updateCondition = (i: number, patch: Partial<TriggerCondition>) => {
    update(
      conditions.map((c, idx) => {
        if (idx !== i) return c;
        // A field pick arrives as a full fresh condition (op/value/key reset);
        // re-picking the field already on the row leaves it as it is rather
        // than wiping what has been typed. Any other patch merges.
        if (patch.field) return patch.field === c.field ? c : { ...(patch as TriggerCondition) };
        return { ...c, ...patch };
      }),
    );
  };

  const normalized = normalizeTriggerConditions(conditions);
  const validationError = validateTriggerConditions(normalized);

  const conditionRows = (
    <FilterControlSizeProvider size="sm">
      <div className={`space-y-1.5 ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
        {conditions.map((cond, i) => (
          <ConditionRow
            key={i}
            condition={cond}
            projectId={projectId}
            readOnly={readOnly}
            onPatch={(patch) => updateCondition(i, patch)}
            onRemove={() => removeCondition(i)}
          />
        ))}
      </div>
    </FilterControlSizeProvider>
  );

  if (asCard) {
    return (
      <>
        {/* Card header */}
        <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">Filter</span>
          {!readOnly && (
            <button
              type="button"
              onClick={addCondition}
              disabled={atFilterCap}
              className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
            >
              <Plus className="h-3 w-3" />
              Add condition
            </button>
          )}
        </div>
        {/* Card body */}
        <div className="p-3">
          {conditions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">Runs on all completed traces.</p>
          ) : (
            <>
              <p className="mb-2 text-[12px] text-muted-foreground">All conditions must match.</p>
              {conditionRows}
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div>
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12px] font-medium text-muted-foreground">Filter</p>
        {!readOnly && (
          <button
            type="button"
            onClick={addCondition}
            className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Add condition
          </button>
        )}
      </div>

      {conditions.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">Runs on all completed traces.</p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-muted-foreground">All conditions must match.</p>
          {conditionRows}
        </>
      )}

      {/* Save button — only in uncontrolled/save mode when dirty and not readOnly */}
      {!readOnly && !onChange && dirty && onSave && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {validationError && (
            <span className="text-[12px] text-destructive">{validationError}</span>
          )}
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => onSave(normalized)}
            disabled={isSaving || validationError !== null}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
