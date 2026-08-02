import { barY, defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/react-charts";
import { scaleBand, scaleLinear, scalePoint } from "d3-scale";

// TanStack Charts (spec: specs/insights.md) is an alpha grammar; every call into
// its API is confined to this file so a future version bump touches one place
// (spec 備考). The two charts the insights page needs are exposed as plain React
// components taking already-aggregated rows. animate は無効化(spec: VRT の決定性)。

export type TrendPoint = { date: string; count: number };
export type LabelDatum = { name: string; color: string; count: number };

// Resolved-per-day line over the 14-day window. x is the "YYYY-MM-DD" day as a
// point scale (evenly spaced categories), y the resolved count.
export function TrendChart({ data }: { data: readonly TrendPoint[] }) {
  const definition = defineChart({
    marks: [lineY(data, { x: "date", y: "count" })],
    x: { scale: scalePoint },
    y: { scale: scaleLinear, nice: true, grid: true },
    animate: false,
  });
  return <Chart definition={definition} height={200} ariaLabel="解決数の推移(直近14日)" />;
}

// Count-per-label bar chart. The bar fill is the label's own catalogue color
// (spec: バー色はラベルの color), read per datum via the fill channel.
export function LabelChart({ data }: { data: readonly LabelDatum[] }) {
  const definition = defineChart({
    marks: [
      barY(data, {
        x: "name",
        y: "count",
        fill: (d: LabelDatum) => d.color,
      }),
    ],
    x: { scale: scaleBand },
    y: { scale: scaleLinear, nice: true, grid: true },
    animate: false,
  });
  return <Chart definition={definition} height={200} ariaLabel="ラベル別件数" />;
}
