#!/usr/bin/env tsx

import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

async function checkRedis() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  const keys = await client.keys('trace:*');
  console.log('Redis trace keys:', keys.length);

  if (keys.length > 0) {
    console.log('Sample keys:', keys.slice(0, 3));
    // Using hGetAll since we store as hash
    const sample = await client.hGetAll(keys[0]);
    console.log('Sample trace fields:', Object.keys(sample));
    console.log('Sample trace data size:', sample.data?.length || 0, 'bytes');
    console.log(
      'Sample trace compressed:',
      sample.compressed === 'true' ? 'yes' : 'no'
    );
  }

  const scoreIndex = await client.zCard('traces:by_score');
  const timeIndex = await client.zCard('traces:by_time');
  console.log('Score index entries:', scoreIndex);
  console.log('Time index entries:', timeIndex);

  await client.quit();
}

checkRedis().catch(console.error);
