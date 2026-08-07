import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export class OrdersQueue {
  private constructor(private readonly queue: Queue) {}

  static connect(redis?: Redis): OrdersQueue {
    const connection = redis ?? new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    return new OrdersQueue(new Queue('orders', { connection }));
  }

  async enqueueExecute(orderId: string): Promise<void> {
    await this.queue.add('execute', { action: 'execute', orderId }, { jobId: orderId, attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
  }

  async enqueueCancel(orderId: string): Promise<void> {
    await this.queue.add('cancel', { action: 'cancel', orderId }, { jobId: `cancel-${orderId}`, attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
  }

  async enqueueCloseAll(exchangeAccountId: string): Promise<void> {
    await this.queue.add('close-all', { action: 'close-all', exchangeAccountId }, { jobId: `close-all-${exchangeAccountId}-${Date.now()}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
