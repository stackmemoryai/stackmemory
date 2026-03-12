// Daemon service with timer leak bug
interface ServiceConfig {
  enabled: boolean;
  interval: number; // minutes
}

interface ServiceState {
  isRunning: boolean;
  intervalMs: number;
  lastRunTime: number;
  errorCount: number;
}

class MonitorService {
  private config: ServiceConfig;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private lastRunTime = 0;
  private errorCount = 0;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  // BUG: No guard against double-start — calling start() twice
  // creates two intervals but only stores the second one.
  // The first interval leaks and keeps running forever.
  start(): void {
    this.isRunning = true;
    const intervalMs = this.config.interval * 60 * 1000;

    this.doWork(); // initial run

    this.intervalId = setInterval(() => {
      this.doWork();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
  }

  // BUG: Calls stop() then start() but start() doesn't check
  // if already running, so if stop() fails to clear the interval
  // (e.g., intervalId is undefined), we leak.
  updateConfig(config: Partial<ServiceConfig>): void {
    const wasRunning = this.isRunning;
    if (wasRunning) this.stop();
    this.config = { ...this.config, ...config };
    if (wasRunning && this.config.enabled) this.start();
  }

  // TODO: Add getState() method returning ServiceState

  private doWork(): void {
    try {
      // Simulate work
      console.log('Running monitor check...');
      this.lastRunTime = Date.now();
    } catch {
      this.errorCount++;
    }
  }
}

export { MonitorService, ServiceConfig, ServiceState };
