export interface Order {
  id: string;
  tenantId: string;
  total: number;
  refunded: number;
}

interface RefundInput {
  tenantId: string;
  orderId: string;
  amount: number;
  idempotencyKey: string;
}

interface StoreState {
  orders: Map<string, Order>;
  refunds: Map<string, { refundId: string }>;
  reads: number;
  refundAttempts: number;
}

const createState = (): StoreState => ({
  orders: new Map([
    [
      'order_123',
      {
        id: 'order_123',
        tenantId: 'tenant_demo',
        total: 125,
        refunded: 0,
      },
    ],
    [
      'order_456',
      {
        id: 'order_456',
        tenantId: 'tenant_demo',
        total: 80,
        refunded: 0,
      },
    ],
  ]),
  refunds: new Map(),
  reads: 0,
  refundAttempts: 0,
});

const stateKey = Symbol.for('run.example.order-store');
const globals = globalThis as typeof globalThis & {
  [stateKey]?: StoreState;
};

const getState = (): StoreState => {
  globals[stateKey] ??= createState();
  return globals[stateKey];
};

export const orderStore = {
  async getForTenant(tenantId: string, orderId: string): Promise<Order> {
    const state = getState();
    const order = state.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) {
      throw new Error(`Order "${orderId}" was not found.`);
    }
    state.reads += 1;
    console.log(`[orders.get] ${orderId}`);
    return { ...order };
  },

  async refundOnce(input: RefundInput) {
    const state = getState();
    state.refundAttempts += 1;
    const existing = state.refunds.get(input.idempotencyKey);
    if (existing) {
      return { approved: true, refunded: true, ...existing };
    }

    const order = state.orders.get(input.orderId);
    if (!order || order.tenantId !== input.tenantId) {
      throw new Error(`Order "${input.orderId}" was not found.`);
    }
    if (input.amount <= 0 || input.amount > order.total - order.refunded) {
      throw new Error('Refund amount is invalid.');
    }

    const refund = { refundId: `refund_${state.refunds.size + 1}` };
    order.refunded += input.amount;
    state.refunds.set(input.idempotencyKey, refund);
    console.log(`[orders.refund] ${input.orderId} $${input.amount}`);
    return { approved: true, refunded: true, ...refund };
  },

  stats() {
    const state = getState();
    return {
      reads: state.reads,
      refundAttempts: state.refundAttempts,
      refunds: state.refunds.size,
      orders: [...state.orders.values()].map(order => ({ ...order })),
    };
  },

  reset(): void {
    globals[stateKey] = createState();
  },
};
