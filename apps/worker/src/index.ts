/**
 * Run worker entry point. Queue consumers (BullMQ) are added once the
 * shared run contract and Redis connection are in place.
 */
export function describeWorker(): string {
  return "agentledger-worker: idle (no queues registered)";
}

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  console.log(describeWorker());
}
