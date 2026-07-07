declare module "socket.io-client-v2" {
  interface SocketV2 {
    connected: boolean;
    disconnected: boolean;
    on(event: string, callback: (...args: any[]) => void): SocketV2;
    once(event: string, callback: (...args: any[]) => void): SocketV2;
    emit(event: string, ...args: any[]): SocketV2;
    disconnect(): SocketV2;
    close(): SocketV2;
  }

  interface SocketV2Options {
    transports?: string[];
    reconnection?: boolean;
    reconnectionAttempts?: number;
    reconnectionDelay?: number;
    timeout?: number;
    forceNew?: boolean;
  }

  const io: (url: string, options?: SocketV2Options) => SocketV2;
  export default io;
}
