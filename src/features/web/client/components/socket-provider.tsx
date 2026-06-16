"use client";

import * as React from "react";
import { io, Socket } from "socket.io-client";

interface SocketProviderProps {
  children: React.ReactNode;
}

const SocketContext = React.createContext<Socket | null>(null);

export function SocketProvider({ children }: SocketProviderProps) {
  const [socket] = React.useState<Socket | null>(() => {
    if (typeof window === "undefined") return null;
    const url = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:8080";
    return io(url, { transports: ["websocket", "polling"] });
  });

  return (
    <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
  );
}

export function useSocketContext(): Socket | null {
  return React.useContext(SocketContext);
}
