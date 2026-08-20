import crypto from 'crypto';
import env from '../config/env.js';

let _client = null;

async function getClient() {
  if (_client) return _client;
  if (!env.payment.enabled) return null;
  const Razorpay = (await import('razorpay')).default;
  _client = new Razorpay({
    key_id: env.payment.razorpayKeyId,
    key_secret: env.payment.razorpayKeySecret,
  });
  return _client;
}

/**
 * Create a payment order. In bypass mode (or when keys are missing) we return a
 * synthetic order so the whole flow stays testable without real credentials.
 * @returns {Promise<{id:string, amount:number, currency:string, bypass:boolean, keyId:string}>}
 */
export async function createPaymentOrder({ amount, currency = 'INR', receipt, notes }) {
  const amountPaise = Math.round(Number(amount) * 100);

  if (env.payment.bypass || !env.payment.enabled) {
    return {
      id: `bypass_${receipt || Date.now()}`,
      amount: amountPaise,
      currency,
      bypass: true,
      keyId: env.payment.razorpayKeyId || '',
    };
  }

  const client = await getClient();
  const order = await client.orders.create({
    amount: amountPaise,
    currency,
    receipt,
    notes,
  });
  return { ...order, bypass: false, keyId: env.payment.razorpayKeyId };
}

/**
 * Verify Razorpay payment signature. In bypass mode always returns true.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (env.payment.bypass || !env.payment.enabled) return true;
  const expected = crypto
    .createHmac('sha256', env.payment.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

/**
 * Refund a captured payment. In bypass mode (or when keys/paymentId are
 * missing) we return a synthetic refund so cancellation flows work without real
 * credentials. When live and a razorpayPaymentId exists, a real refund is
 * issued via the Razorpay API.
 * @returns {Promise<{id:string, bypass:boolean}>}
 */
export async function refundPayment({ paymentId, amount, notes } = {}) {
  if (env.payment.bypass || !env.payment.enabled || !paymentId) {
    return { id: `bypass_refund_${paymentId || Date.now()}`, bypass: true };
  }
  const client = await getClient();
  const refund = await client.payments.refund(paymentId, {
    amount: amount != null ? Math.round(Number(amount) * 100) : undefined,
    notes,
  });
  return { ...refund, bypass: false };
}

export const paymentMeta = () => ({
  bypass: env.payment.bypass || !env.payment.enabled,
  enabled: env.payment.enabled,
  keyId: env.payment.razorpayKeyId || '',
});
