'use client';

import { TREE_LAYOUT } from '../utils';

interface SpanTreeConnectorProps {
  level: number;
  isTerminal: boolean;
  parentLevels: number[];
}

/**
 * Renders L-shaped tree connectors for span hierarchy visualization
 */
export function SpanTreeConnector({ level, isTerminal, parentLevels }: SpanTreeConnectorProps) {
  const { NESTING_INDENT, ROW_HEIGHT, ICON_BOX_SIZE, LEFT_PADDING } = TREE_LAYOUT;

  // Lines should connect to the center of parent icon boxes
  const iconCenterOffset = ICON_BOX_SIZE / 2;
  // Total width needed before the icon
  const width = LEFT_PADDING + level * NESTING_INDENT;
  // Gap between icon edge and row edge (icon is centered vertically)
  const iconVerticalGap = (ROW_HEIGHT - ICON_BOX_SIZE) / 2;

  if (level === 0) return <div style={{ width: LEFT_PADDING }} className="flex-shrink-0" />;

  return (
    <div className="relative flex-shrink-0 overflow-visible" style={{ width, height: ROW_HEIGHT }}>
      {Array.from({ length: level }).map((_, i) => {
        const showContinuingLine = parentLevels.includes(i);
        const isCurrentLevel = i === level - 1;
        // Line X position: center of the icon at this level
        const lineX = LEFT_PADDING + i * NESTING_INDENT + iconCenterOffset;

        return (
          <div key={i}>
            {/* Continuing vertical line for non-terminal ancestors - extends up to touch parent icon */}
            {showContinuingLine && (
              <div
                className="absolute bg-muted-foreground/50"
                style={{
                  left: lineX,
                  top: -iconVerticalGap, // extend up to parent icon bottom
                  height: ROW_HEIGHT + iconVerticalGap, // full row + extension
                  width: 1
                }}
              />
            )}
            {/* Current level connector - L-shape */}
            {isCurrentLevel && (
              <>
                {/* Vertical part - from parent icon bottom to row center */}
                <div
                  className="absolute bg-muted-foreground/50"
                  style={{
                    left: lineX,
                    top: -iconVerticalGap, // start at parent icon bottom
                    height: isTerminal
                      ? (ROW_HEIGHT / 2 + iconVerticalGap) // to current row center
                      : ROW_HEIGHT, // to row bottom (child's line starts there)
                    width: 1
                  }}
                />
                {/* Horizontal part - extend to touch the icon box border */}
                <div
                  className="absolute bg-muted-foreground/50"
                  style={{
                    left: lineX,
                    top: Math.floor(ROW_HEIGHT / 2),
                    width: width - lineX + 1,
                    height: 1
                  }}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
