declare module 'dynalite' {
  interface DynaliteOptions {
    createTableMs?: number;
    path?: string;
  }

  interface DynaliteServer {
    listen(port: number, callback: (err?: Error) => void): void;
    close(callback: (err?: Error) => void): void;
    address(): { port: number };
  }

  function dynalite(options?: DynaliteOptions): DynaliteServer;

  export { DynaliteServer, DynaliteOptions };
  export default dynalite;
}
