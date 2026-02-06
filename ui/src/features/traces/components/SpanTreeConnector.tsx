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
            {/* Continuing vertical line for non-terminal ancestors - covers exactly one row */}
            {showContinuingLine && !isCurrentLevel && (
              <div
                className="absolute bg-border"
                style={{
                  left: lineX,
                  top: 0,
                  height: ROW_HEIGHT,
                  width: 1
                }}
              />
            )}
            {/* Current level connector - L-shape */}
            {isCurrentLevel && (
              <>
                {/* Vertical part - extends above to parent icon, down to row bottom if non-terminal */}
                <div
                  className="absolute bg-border"
                  style={{
                    left: lineX,
                    top: -iconVerticalGap,
                    height: isTerminal
                      ? (ROW_HEIGHT / 2 + iconVerticalGap) // to current row center
                      : (ROW_HEIGHT + iconVerticalGap), // to row bottom
                    width: 1
                  }}
                />
                {/* Horizontal part - extend to touch the icon box border */}
                <div
                  className="absolute bg-border"
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
