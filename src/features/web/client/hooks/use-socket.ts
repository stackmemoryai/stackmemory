'use client';

import { useSocketContext } from '@/components/socket-provider';

export function useSocket() {
  return useSocketContext();
}
