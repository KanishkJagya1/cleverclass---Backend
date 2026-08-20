import prisma from './prisma.js';
import { ApiError } from '../middleware/error.js';
import { refundPayment } from './razorpay.js';
import { logger } from './logger.js';

const PAID = ['PAID', 'BYPASSED'];

/**
 * Change an order's fulfilment status with the shared business rules:
 *   - A CANCELLED order is terminal: its status can no longer change
 *     (re-cancelling is a harmless no-op, anything else is rejected).
 *   - Cancelling a paid order automatically *starts* a refund (status
 *     INITIATED). An admin later marks it COMPLETED from the Refunds page,
 *     which is when the payment flips to REFUNDED.
 * @returns the updated order (with the given `include`).
 */
export async function changeOrderStatus({ order, status, include }) {
  if (order.status === 'CANCELLED') {
    if (status === 'CANCELLED') {
      return prisma.order.findUnique({ where: { id: order.id }, include });
    }
    throw new ApiError(409, 'This order is cancelled and its status can no longer be changed.');
  }

  // A PURCHASE is a digital buy — it has no fulfilment stages, only cancellation.
  if (order.type === 'PURCHASE' && status !== 'CANCELLED') {
    throw new ApiError(409, 'A bought paper is a digital order with no fulfilment steps.');
  }

  const data = { status };

  if (status === 'CANCELLED' && PAID.includes(order.paymentStatus) && order.refundStatus === 'NONE') {
    const refund = await refundPayment({ paymentId: order.razorpayPaymentId, amount: order.total });
    data.refundStatus = 'INITIATED';
    data.refundAmount = order.total;
    data.refundId = refund?.id || null;
    data.refundInitiatedAt = new Date();
    logger.event('order.refund.initiated', {
      orderId: order.id,
      amount: Number(order.total),
      refundId: refund?.id || null,
      bypass: refund?.bypass ?? true,
    });
  }

  const updated = await prisma.order.update({ where: { id: order.id }, data, include });
  if (status === 'CANCELLED') logger.event('order.cancelled', { orderId: order.id });
  return updated;
}

/**
 * Advance an in-progress refund. INITIATED -> COMPLETED (payment => REFUNDED)
 * or INITIATED -> FAILED. Only an INITIATED refund can be resolved.
 */
export async function resolveRefund({ orderId, action, include }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ApiError(404, 'Order not found');
  if (order.refundStatus !== 'INITIATED') throw new ApiError(409, 'No refund is in progress for this order.');

  const data = {};
  if (action === 'complete') {
    data.refundStatus = 'COMPLETED';
    data.refundCompletedAt = new Date();
    data.paymentStatus = 'REFUNDED';
    logger.event('order.refund.completed', { orderId });
  } else if (action === 'fail') {
    data.refundStatus = 'FAILED';
    logger.event('order.refund.failed', { orderId });
  } else {
    throw new ApiError(400, 'Invalid refund action');
  }

  return prisma.order.update({ where: { id: orderId }, data, include });
}
