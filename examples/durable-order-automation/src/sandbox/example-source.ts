export const exampleSource = `
  const order = await orders.get("order_123");

  if (order.total > 100) {
    const refund = await orders.refund(order.id, 25);

    if (!refund.approved) {
      return { status: "refund_rejected", orderId: order.id };
    }
  }

  return { status: "complete", orderId: order.id };
`;
