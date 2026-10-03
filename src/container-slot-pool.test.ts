import { describe, expect, it } from 'vitest';

import { ContainerSlotPool, SlotPoolClosedError } from './container-slot-pool.js';

describe('ContainerSlotPool', () => {
  it('admits only the configured number of active containers', async () => {
    const pool = new ContainerSlotPool(2);
    const release1 = await pool.acquire('session-1');
    const release2 = await pool.acquire('session-2');
    let thirdStarted = false;
    const third = pool.acquire('session-3').then((release) => {
      thirdStarted = true;
      return release;
    });

    await Promise.resolve();
    expect(pool.snapshot()).toEqual({ limit: 2, active: 2, queued: 1 });
    expect(thirdStarted).toBe(false);

    release1();
    const release3 = await third;
    expect(thirdStarted).toBe(true);
    expect(pool.snapshot()).toEqual({ limit: 2, active: 2, queued: 0 });

    release2();
    release3();
    expect(pool.snapshot()).toEqual({ limit: 2, active: 0, queued: 0 });
  });

  it('releases queued sessions in FIFO order', async () => {
    const pool = new ContainerSlotPool(1);
    const release1 = await pool.acquire('session-1');
    const order: string[] = [];
    const second = pool.acquire('session-2').then((release) => {
      order.push('session-2');
      return release;
    });
    const third = pool.acquire('session-3').then((release) => {
      order.push('session-3');
      return release;
    });

    release1();
    const release2 = await second;
    expect(order).toEqual(['session-2']);
    release2();
    const release3 = await third;
    expect(order).toEqual(['session-2', 'session-3']);
    release3();
  });

  it('makes release idempotent so close and error cannot free two slots', async () => {
    const pool = new ContainerSlotPool(1);
    const release = await pool.acquire('session-1');
    release();
    release();
    expect(pool.snapshot().active).toBe(0);
  });

  it('rejects queued sessions when the host shuts down', async () => {
    const pool = new ContainerSlotPool(1);
    const release = await pool.acquire('session-1');
    const queued = pool.acquire('session-2');

    pool.close();
    await expect(queued).rejects.toBeInstanceOf(SlotPoolClosedError);
    release();
    await expect(pool.acquire('session-3')).rejects.toBeInstanceOf(SlotPoolClosedError);
  });
});
