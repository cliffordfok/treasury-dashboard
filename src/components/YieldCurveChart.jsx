import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const YieldCurveTooltip = ({ active, label, payload }) => {
  const years = Number(label ?? payload?.[0]?.payload?.years);
  const yieldValue = Number(payload?.[0]?.value ?? payload?.[0]?.payload?.yield);
  if (!active || !Number.isFinite(years) || !Number.isFinite(yieldValue)) return null;

  return (
    <div className="yield-tooltip" role="tooltip">
      <div className="yield-tooltip-row"><span>年期</span><strong>{years.toFixed(2)} 年</strong></div>
      <div className="yield-tooltip-row"><span>收益率</span><strong>{yieldValue.toFixed(3)}%</strong></div>
    </div>
  );
};

export default function YieldCurveChart({ curvePoints, spreadPoints, bondDots }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={curvePoints} margin={{ top: 22, right: 16, bottom: 0, left: -14 }}>
        <defs>
          <linearGradient id="yieldLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#4F8DF7" />
            <stop offset="52%" stopColor="#E8B84B" />
            <stop offset="100%" stopColor="#F4D477" />
          </linearGradient>
          <linearGradient id="yieldArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#E8B84B" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#4F8DF7" stopOpacity={0.01} />
          </linearGradient>
          <filter id="yieldGlow" x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 5" stroke="rgba(148, 163, 184, 0.12)" />
        <XAxis dataKey="years" type="number" tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false} unit="年" domain={[0, 30]} />
        <YAxis tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false} tickCount={5} domain={['auto', 'auto']} unit="%" />
        <Tooltip cursor={{ stroke: 'rgba(232, 184, 75, 0.3)', strokeWidth: 1 }} content={<YieldCurveTooltip />} />
        <Area type="monotone" dataKey="yield" stroke="url(#yieldLine)" strokeWidth={2.5} fill="url(#yieldArea)" filter="url(#yieldGlow)" dot={false} activeDot={{ r: 5, fill: '#E8B84B', stroke: '#0A0E17', strokeWidth: 2 }} />
        {spreadPoints.map(point => (
          <ReferenceDot key={`spread-${point.years}`} x={point.years} y={point.yield} r={5} fill="#E8B84B" stroke="#0A0E17" strokeWidth={2} label={{ value: `${point.years}Y`, position: 'top', fontSize: 9, fill: '#E8B84B', fontWeight: 700 }} />
        ))}
        {bondDots.map(dot => (
          <ReferenceDot key={dot.id} x={dot.x} y={dot.y} r={6} fill={dot.side === 'sell' ? '#F87171' : '#34D399'} stroke="#101624" strokeWidth={2.5} label={{ value: dot.cusip, position: 'top', fontSize: 9, fill: '#CBD5E1', fontWeight: 600 }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
