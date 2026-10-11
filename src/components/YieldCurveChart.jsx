import {
  Area,
  ComposedChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// Validated together on the dark surface (all pairs); mirrored by --series-* in index.css.
const CURVE_COLOR = '#c98500';
const POSITION_COLORS = { buy: '#3987e5', sell: '#d55181' };
const SURFACE = '#111a2a';
const GRID = 'rgba(148, 163, 184, 0.12)';
const TEXT_MUTED = '#9aa9be';
const TENOR_TICKS = [1, 2, 3, 5, 7, 10, 20, 30];
// Positions within this distance on the square-root tenor axis share a tooltip.
const NEARBY_SQRT_DISTANCE = 0.16;

const formatPercent = (value) => `${Number(value.toFixed(2))}%`;

const getYieldAxis = (points) => {
  const yields = points.map((point) => point.yield);
  const min = Math.min(...yields);
  const max = Math.max(...yields);
  const step = max - min > 1.2 ? 0.5 : 0.25;
  const low = Math.floor((min - 0.05) / step) * step;
  const high = Math.ceil((max + 0.05) / step) * step;
  const ticks = [];
  for (let tick = low; tick <= high + 1e-9; tick += step) ticks.push(Number(tick.toFixed(2)));
  return { domain: [low, high], ticks };
};

const YieldCurveTooltip = ({ active, label, payload, bondDots }) => {
  const years = Number(label ?? payload?.[0]?.payload?.years);
  const yieldValue = Number(payload?.[0]?.value ?? payload?.[0]?.payload?.yield);
  if (!active || !Number.isFinite(years) || !Number.isFinite(yieldValue)) return null;
  const nearby = bondDots.filter((dot) => Math.abs(Math.sqrt(dot.x) - Math.sqrt(years)) < NEARBY_SQRT_DISTANCE);

  return (
    <div className="yield-tooltip" role="tooltip">
      <div className="yield-tooltip-head">{years < 1 ? `${Math.round(years * 12)} 個月` : `${years.toFixed(2)} 年`}</div>
      <div className="yield-tooltip-row">
        <span className="yield-tooltip-key" style={{ background: CURVE_COLOR }} />
        <strong>{yieldValue.toFixed(3)}%</strong>
        <span>曲線收益率</span>
      </div>
      {nearby.map((dot) => (
        <div key={dot.id} className="yield-tooltip-row">
          <span className="yield-tooltip-key yield-tooltip-key--dot" style={{ background: POSITION_COLORS[dot.side] ?? POSITION_COLORS.buy }} />
          <strong>{dot.y.toFixed(3)}%</strong>
          <span>{dot.cusip} · {dot.side === 'sell' ? '賣空' : '買入'}</span>
        </div>
      ))}
    </div>
  );
};

export default function YieldCurveChart({ curvePoints, bondDots }) {
  const { domain, ticks } = getYieldAxis(curvePoints);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={curvePoints} margin={{ top: 18, right: 12, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id="yieldArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CURVE_COLOR} stopOpacity={0.16} />
            <stop offset="100%" stopColor={CURVE_COLOR} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="years"
          type="number"
          scale="sqrt"
          domain={[0, 30]}
          ticks={TENOR_TICKS}
          tickFormatter={(value) => `${value}年`}
          tick={{ fontSize: 11, fill: TEXT_MUTED }}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          tickMargin={8}
          minTickGap={14}
        />
        <YAxis
          domain={domain}
          ticks={ticks}
          tickFormatter={formatPercent}
          tick={{ fontSize: 11, fill: TEXT_MUTED }}
          tickLine={false}
          axisLine={false}
          width={52}
        />
        <Tooltip
          cursor={{ stroke: 'rgba(203, 213, 225, 0.35)', strokeWidth: 1 }}
          content={<YieldCurveTooltip bondDots={bondDots} />}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="yield"
          stroke={CURVE_COLOR}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="url(#yieldArea)"
          dot={false}
          activeDot={{ r: 5, fill: CURVE_COLOR, stroke: SURFACE, strokeWidth: 2 }}
          isAnimationActive={false}
        />
        {bondDots.map((dot) => (
          <ReferenceDot
            key={dot.id}
            x={dot.x}
            y={dot.y}
            r={5.5}
            fill={POSITION_COLORS[dot.side] ?? POSITION_COLORS.buy}
            stroke={SURFACE}
            strokeWidth={2}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
