const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const PLOT_HEIGHT = 132;

const formatCompact = (value) => {
  const absolute = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (absolute >= 1000) return `${sign}${Number((absolute / 1000).toFixed(absolute >= 10000 ? 0 : 1))}K`;
  return `${sign}${Math.round(absolute)}`;
};

const formatFull = (value) => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

export default function CouponCalendar({ monthlyTotals, currentMonth }) {
  const maxPositive = Math.max(0, ...monthlyTotals);
  const maxNegative = Math.max(0, ...monthlyTotals.map((value) => -value));
  const range = maxPositive + maxNegative || 1;
  const baseline = PLOT_HEIGHT * (maxPositive / range);

  return (
    <ol className={`coupon-columns ${maxNegative > 0 ? 'has-negative' : ''}`} style={{ '--plot-height': `${PLOT_HEIGHT}px`, '--baseline': `${baseline}px` }}>
      {monthlyTotals.map((total, month) => {
        const status = month < currentMonth ? '已收' : month === currentMonth ? '本月' : '預計';
        const height = total === 0 ? 0 : Math.max(3, (Math.abs(total) / range) * PLOT_HEIGHT);
        const description = `${MONTH_LABELS[month]}：${total === 0 ? '沒有派息' : formatFull(total)}（${status}）`;
        return (
          <li
            key={MONTH_LABELS[month]}
            className={`coupon-column ${month > currentMonth ? 'is-expected' : ''} ${month === currentMonth ? 'is-current' : ''}`}
            title={description}
            aria-label={description}
          >
            <div className="coupon-plot">
              {total !== 0 && (
                <>
                  <span
                    className={`coupon-bar ${total < 0 ? 'is-negative' : ''}`}
                    style={total < 0 ? { top: 'var(--baseline)', height } : { bottom: `calc(var(--plot-height) - var(--baseline))`, height }}
                  />
                  <span
                    className="coupon-value"
                    style={total < 0
                      ? { top: `calc(var(--baseline) + ${height + 4}px)` }
                      : { bottom: `calc(var(--plot-height) - var(--baseline) + ${height + 4}px)` }}
                  >
                    {formatCompact(total)}
                  </span>
                </>
              )}
            </div>
            <span className="coupon-month">{MONTH_LABELS[month]}</span>
          </li>
        );
      })}
    </ol>
  );
}
