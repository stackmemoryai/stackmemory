import { create } from 'zustand';

export interface Session {
  id: string;
  startTime: number;
  state?: string;
}

interface SessionStore {
  sessions: Session[];
  setSessions: (sessions: Session[]) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
}));
