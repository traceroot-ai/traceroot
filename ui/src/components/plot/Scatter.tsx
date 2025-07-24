import React from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import { PERCENTILE_COLORS, PercentileKey } from '../../constants/colors';

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

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 p-3 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {format(new Date(data.x), 'MMM d, yyyy HH:mm:ss')}
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Latency: {data.y.toFixed(2)}ms
        </p>
        {data.label !== 'default' && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Label: {data.label}
          </p>
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
  height = 400,
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
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const xRange = maxX - minX;
  const xPadding = xRange * 0.05; // 5% padding on each side
  const xDomain = [minX - xPadding, maxX + xPadding];

  return (
    <div className="w-full h-full">
      {title && (
        <div className="text-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        </div>
      )}
      <div className="w-full" style={{ height: height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            margin={{
              top: 20,
              right: 20,
              bottom: 20,
              left: 20,
            }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="x"
              type="number"
              domain={xDomain}
              tickFormatter={(timestamp) => format(new Date(timestamp), 'HH:mm:ss')}
              label={{ value: xAxisLabel, position: 'bottom' }}
            />
            <YAxis
              dataKey="y"
              type="number"
              label={{ value: yAxisLabel, angle: -90, position: 'left' }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Scatter
              data={chartData}
              name={isPercentilePlot ? 'Trace Latency' : 'Trace Latency'}
              shape={<CustomDot onPointClick={onPointClick} isPercentilePlot={isPercentilePlot} />}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default ScatterPlot;
