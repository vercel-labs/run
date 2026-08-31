import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
  orders: Order[];
  refunds: Record<string, { refundId: string }>;
  reads: number;
  refundAttempts: number;
}

const createState = (): StoreState => ({
  orders: [
    {
      id: 'order_123',
      tenantId: 'tenant_demo',
      total: 125,
      refunded: 0,
    },
    {
      id: 'order_456',
      tenantId: 'tenant_demo',
      total: 80,
      refunded: 0,
    },
  ],
  refunds: {},
  reads: 0,
  refundAttempts: 0,
});

const getStorePath = (): string =>
  process.env.ORDER_STORE_PATH ??
  resolve(process.cwd(), '.workflow-data', 'order-store.json');

const readState = async (): Promise<StoreState> => {
  try {
    return JSON.parse(await readFile(getStorePath(), 'utf8')) as StoreState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return createState();
    throw error;
  }
};

const writeState = async (state: StoreState): Promise<void> => {
  const path = getStorePath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify(state, null, 2));
  await rename(temporaryPath, path);
};

let pendingOperation = Promise.resolve();
const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = pendingOperation.then(operation, operation);
  pendingOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export const orderStore = {
  async getForTenant(tenantId: string, orderId: string): Promise<Order> {
    return await exclusive(async () => {
      const state = await readState();
      const order = state.orders.find(candidate => candidate.id === orderId);
      if (!order || order.tenantId !== tenantId) {
        throw new Error(`Order "${orderId}" was not found.`);
      }
      state.reads += 1;
      await writeState(state);
      console.log(`[orders.get] ${orderId}`);
      return { ...order };
    });
  },

  async refundOnce(input: RefundInput) {
    return await exclusive(async () => {
      const state = await readState();
      state.refundAttempts += 1;
      const existing = state.refunds[input.idempotencyKey];
      if (existing) {
        await writeState(state);
        return { approved: true, refunded: true, ...existing };
      }

      const order = state.orders.find(
        candidate => candidate.id === input.orderId,
      );
      if (!order || order.tenantId !== input.tenantId) {
        throw new Error(`Order "${input.orderId}" was not found.`);
      }
      if (input.amount > order.total - order.refunded) {
        throw new Error('Refund amount is invalid.');
      }

      const refund = {
        refundId: `refund_${Object.keys(state.refunds).length + 1}`,
      };
      order.refunded += input.amount;
      state.refunds[input.idempotencyKey] = refund;

      // The demo's side effect and idempotency key commit in one atomic rename.
      // A production adapter should use one database transaction instead.
      await writeState(state);
      console.log(`[orders.refund] ${input.orderId} $${input.amount}`);
      return { approved: true, refunded: true, ...refund };
    });
  },

  async stats() {
    const state = await exclusive(readState);
    return {
      reads: state.reads,
      refundAttempts: state.refundAttempts,
      refunds: Object.keys(state.refunds).length,
      orders: state.orders.map(order => ({ ...order })),
    };
  },

  async reset(): Promise<void> {
    await exclusive(async () => await writeState(createState()));
  },
};
