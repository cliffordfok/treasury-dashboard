import {
  calculateAccruedInterestPer100,
  calculateActiveUnrealizedPnl,
  calculateClosedTradePricePnl,
  calculateMaturedTradePricePnl,
  getDirtyPrice,
  getTradeYTM,
  isCouponTreasury,
} from './treasuryMath.js';

const getPositionSign = (trade) => (trade.side === 'sell' ? -1 : 1);

export const calculatePortfolioMetrics = ({
  activeTrades = [],
  maturedTrades = [],
  closedTrades = [],
  receivedCoupons = [],
  valuationDate,
}) => {
  let totalMarketValue = 0;
  let totalAccruedInterest = 0;
  let totalUnrealizedPnL = 0;
  let annualCouponIncome = 0;
  let signedYieldExposure = 0;
  let grossYieldExposure = 0;

  let totalRealizedPnL = receivedCoupons.reduce((total, coupon) => total + coupon.amount, 0);
  closedTrades.forEach((trade) => { totalRealizedPnL += calculateClosedTradePricePnl(trade) ?? 0; });
  maturedTrades.forEach((trade) => { totalRealizedPnL += calculateMaturedTradePricePnl(trade) ?? 0; });

  activeTrades.forEach((trade) => {
    const cleanPrice = Number(trade.currentMarketPrice);
    if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) return;
    const faceValue = Number(trade.faceValue) || 0;
    const sign = getPositionSign(trade);
    const accruedInterestPer100 = calculateAccruedInterestPer100(trade, valuationDate);

    totalMarketValue += ((cleanPrice * faceValue) / 100) * sign;
    totalAccruedInterest += ((accruedInterestPer100 * faceValue) / 100) * sign;
    totalUnrealizedPnL += calculateActiveUnrealizedPnl(trade, valuationDate) ?? 0;
    if (isCouponTreasury(trade) && trade.couponRate) {
      annualCouponIncome += faceValue * (Number(trade.couponRate) / 100) * sign;
    }

    const ytm = getTradeYTM(trade, valuationDate);
    const dirtyPrice = getDirtyPrice(cleanPrice, accruedInterestPer100);
    if (ytm == null || dirtyPrice == null) return;
    const exposure = (dirtyPrice * faceValue) / 100;
    // A short position pays its yield, so it subtracts carry. Weighting by gross
    // exposure keeps the figure bounded when long and short positions offset.
    signedYieldExposure += ytm * exposure * sign;
    grossYieldExposure += exposure;
  });

  return {
    totalMarketValue,
    totalAccruedInterest,
    totalFullMarketValue: totalMarketValue + totalAccruedInterest,
    totalUnrealizedPnL,
    totalRealizedPnL,
    totalWeightYTM: grossYieldExposure > 0 ? signedYieldExposure / grossYieldExposure : null,
    monthlyAvgIncome: annualCouponIncome / 12,
  };
};
