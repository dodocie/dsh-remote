import { startMockBackend } from './mock-backend.mjs';

const backend = await startMockBackend(Number(process.env.MOCK_PORT || 3444));
console.log(`mock backend listening on 127.0.0.1:${backend.port}`);

const shutdown = async () => {
  await backend.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
