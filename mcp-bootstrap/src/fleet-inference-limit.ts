import { SampleInvalidated, type PhoneInferenceProvider } from './phone-inference-provider.js';

/** FIFO model slots; cancellation and phone deadlines remain authoritative while waiting. */
export class FleetInferenceLimit {
  private active = 0;
  private queue: object[] = [];
  constructor(private limit: number) {}
  wrap(provider: PhoneInferenceProvider): PhoneInferenceProvider {
    return { id: provider.id, cancel: id => provider.cancel(id), sample: async (request, cwd, state, isCurrent) => {
      const ticket = {}; this.queue.push(ticket); let acquired = false;
      try {
        while (true) {
          if (!(await isCurrent())) throw new SampleInvalidated('Phone request invalidated while queued');
          if ((request.deadlineAtMs ?? Infinity) <= Date.now() + 1000) throw new Error('Phone inference deadline expired while queued');
          if (this.queue[0] === ticket && this.active < this.limit) {
            this.queue.shift(); this.active++; acquired = true; break;
          }
          await new Promise(r => setTimeout(r, 100));
        }
        return await provider.sample(request, cwd, state, isCurrent);
      } finally {
        const index = this.queue.indexOf(ticket); if (index >= 0) this.queue.splice(index, 1);
        if (acquired) this.active--;
      }
    } };
  }
}
