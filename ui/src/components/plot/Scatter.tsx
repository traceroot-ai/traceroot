import React from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { format } from 'date-fns';
import { PERCENTILE_COLORS, PercentileKey } from '../../constants/colors';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartConfig,
} from '../ui/chart';

interface DataPoint {
  x: Date;
  y: number;
  label: string;
  traceId?: string;
}

interface ChartDataPoint extends Omit<DataPoint, 'x'> {
  x: number;  // timestamp
}

interface ScatterPlotProps {
  data: DataPoint[];
  width?: number;
  height?: number;
  title?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  isPercentilePlot?: boolean;
  onPointClick?: (traceId: string) => void;
}

const CustomTooltipContent = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="grid gap-2 p-2 bg-white rounded shadow-md border">
        <div className="text-xs font-medium text-zinc-600 dark:text-zinc-200">
          {format(new Date(data.x), 'MMM d, yyyy HH:mm:ss')}
        </div>
        <div className="text-xs text-zinc-600 dark:text-zinc-200">
          Latency: {data.y.toFixed(2)}s
        </div>
        {data.label !== 'default' && (
          <div className="text-xs text-zinc-600 dark:text-zinc-200">
            Label: {data.label}
          </div>
        )}
      </div>
    );
  }
  return null;
};

// Custom dot component for individual point styling and click handling
const CustomDot = (props: any) => {
  const { cx, cy, payload, onPointClick, isPercentilePlot } = props;

  // Get the color for this point
  const getPointColor = (label: string): string => {
    if (isPercentilePlot && Object.keys(PERCENTILE_COLORS).includes(label)) {
      return PERCENTILE_COLORS[label as PercentileKey];
    }
    return '#8884d8'; // Default color
  };

  const handleClick = () => {
    if (payload && payload.traceId && onPointClick) {
      onPointClick(payload.traceId);
    }
  };

  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={getPointColor(payload.label)}
      stroke="none"
      style={{ cursor: onPointClick ? 'pointer' : 'default' }}
      onClick={handleClick}
    />
  );
};

const ScatterPlot: React.FC<ScatterPlotProps> = ({
  data,
  width = 600,
  height = 300,
  title,
  xAxisLabel = 'Time',
  yAxisLabel = 'Duration (ms)',
  isPercentilePlot = false,
  onPointClick,
}) => {
  // Transform dates to timestamps for the chart
  const chartData: ChartDataPoint[] = data.map(point => ({
    ...point,
    x: point.x.getTime(),
  }));

  // Calculate domain with padding to avoid points on borders
  const xValues = chartData.map(point => point.x);
  const yValues = chartData.map(point => point.y);

  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const xRange = maxX - minX;
  const xPadding = xRange * 0.05; // 5% padding on each side
  const xDomain = [minX - xPadding, maxX + xPadding];

  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const yRange = maxY - minY;
  const yPadding = yRange * 0.1; // 10% padding on each side
  const yDomain = [Math.max(0, minY - yPadding), maxY + yPadding];

  // Generate evenly spaced ticks for x-axis (time)
  const generateEvenTimeTicks = (startTime: number, endTime: number, count: number) => {
    const ticks = [];
    const interval = (endTime - startTime) / (count - 1);
    for (let i = 0; i < count; i++) {
      ticks.push(startTime + (i * interval));
    }
    return ticks;
  };

  const xTicks = generateEvenTimeTicks(xDomain[0], xDomain[1], 7);

  // Chart configuration for shadcn/ui
  const chartConfig: ChartConfig = {
    latency: {
      label: "Latency",
    },
    ...(isPercentilePlot ? Object.keys(PERCENTILE_COLORS).reduce((acc, key) => ({
      ...acc,
      [key]: {
        label: key,
        color: PERCENTILE_COLORS[key as PercentileKey],
      }
    }), {}) : {
      default: {
        label: "Trace Latency",
        color: "hsl(var(--chart-1))",
      }
    })
  } satisfies ChartConfig;

  // Calculate responsive margins based on container dimensions
  const getResponsiveMargins = () => {
    const baseMargin = Math.min(width, height) * 0.08; // 8% of the smaller dimension
    return {
      top: Math.max(20, baseMargin),
      right: Math.max(20, baseMargin),
      bottom: Math.max(40, baseMargin),
      left: Math.max(50, baseMargin),
    };
  };

  const margins = getResponsiveMargins();

  return (
    <div className="w-full flex flex-col" style={{ height: height, maxHeight: '300px' }}>
      {title && (
        <div className="text-center flex-shrink-0">
          <h3 className="text-lg font-semibold text-zinc-600 dark:text-zinc-200">{title}</h3>
        </div>
      )}
      <div className="flex-1 w-full min-h-0 flex items-center justify-center">
        <div className="w-full h-full">
          <ChartContainer config={chartConfig} className="h-full w-full">
            <ScatterChart
              data={chartData}
              margin={margins}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#a1a1aa"
                className="dark:stroke-zinc-600"
                horizontal={true}
                vertical={true}
              />
              <XAxis
                dataKey="x"
                type="number"
                domain={xDomain}
                ticks={xTicks}
                tickFormatter={(timestamp) => format(new Date(timestamp), 'MMM d, HH:mm')}
                tick={{
                  fontSize: 11,
                  fill: '#52525b',
                  className: 'dark:fill-zinc-200'
                }}
                axisLine={{ stroke: '#71717a', strokeWidth: 1 }}
                tickLine={{ stroke: '#71717a', strokeWidth: 1 }}
                label={{
                  value: xAxisLabel,
                  position: 'insideBottom',
                  offset: -10,
                  style: {
                    textAnchor: 'middle',
                    fill: '#52525b',
                    fontSize: '14px',
                    fontWeight: '500'
                  },
                  className: 'dark:fill-zinc-200'
                }}
              />
              <YAxis
                dataKey="y"
                type="number"
                domain={yDomain}
                tickCount={7}
                tick={{
                  fontSize: 11,
                  fill: '#52525b',
                  className: 'dark:fill-zinc-200'
                }}
                axisLine={{ stroke: '#71717a', strokeWidth: 1 }}
                tickLine={{ stroke: '#71717a', strokeWidth: 1 }}
                label={{
                  value: yAxisLabel,
                  angle: -90,
                  position: 'insideLeft',
                  style: {
                    textAnchor: 'middle',
                    fill: '#52525b',
                    fontSize: '14px',
                    fontWeight: '500'
                  },
                  className: 'dark:fill-zinc-200'
                }}
              />
              <ChartTooltip content={<CustomTooltipContent />} />
              <Scatter
                data={chartData}
                name={isPercentilePlot ? 'Trace Latency' : 'Trace Latency'}
                shape={<CustomDot onPointClick={onPointClick} isPercentilePlot={isPercentilePlot} />}
              />
            </ScatterChart>
          </ChartContainer>
        </div>
      </div>
    </div>
  );
};

export default ScatterPlot;
