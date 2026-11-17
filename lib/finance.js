'use strict';
function calculateCommission(gross, ratePercent) {
  const amount = Number(gross), rate = Number(ratePercent);
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError('gross must be a non-negative finite number');
  if (!Number.isFinite(rate) || rate < 0 || rate > 50) throw new RangeError('commission rate must be between 0 and 50');
  const grossCents = Math.round(amount * 100);
  const commissionCents = Math.round(grossCents * rate / 100);
  return { gross: grossCents / 100, commission: commissionCents / 100, net: (grossCents - commissionCents) / 100 };
}
function canRequestSettlement(balance, held, requested) {
  const b=Number(balance), h=Number(held), r=Number(requested);
  if (![b,h,r].every(Number.isFinite) || b < 0 || h < 0 || r <= 0) return false;
  return Math.round((b-h)*100) >= Math.round(r*100);
}
function canRequestRefund(paymentStatus, orderStatus, existingRequest) {
  return paymentStatus === 'paid' && ['new','processing','shipped','completed'].includes(orderStatus) && !existingRequest;
}
module.exports = { calculateCommission, canRequestSettlement, canRequestRefund };
