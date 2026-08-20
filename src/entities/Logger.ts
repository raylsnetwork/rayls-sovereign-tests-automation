export class Logger {
  public BOLD = `\x1b[1m`;
  public BLINK = `\x1b[5m`;
  public RED = `\x1b[31m`;
  public GREEN = `\x1b[32m`;
  public YELLOW = `\x1b[33m`;
  public CYAN = `\x1b[36m`;
  public GRAY = `\x1b[90m`;
  public RESET = `\x1b[0m`;
  public INFO = this.GRAY;
  public ERROR = this.RED;
  public DATA = this.CYAN;
  public SUCCESS = this.GREEN;

  /** Tracks active loading operations by ID for parallel-safe spinners */
  private activeLoads = new Map<number, { message: string; startTime: number }>();
  private nextLoadId = 0;

  constructor() {}

  private date() {
    return `${this.INFO}${new Date().toISOString()} -> ${this.RESET}`;
  }

  log(message: string, mode: string = '') {
    console.log(`${this.date()}${mode}${message}${this.RESET}`);
  }

  info(message: string) {
    this.log(message, this.INFO);
  }

  /** Tag for log lines that explain a test scenario in plain language. */
  scenario(message: string) {
    this.log(`scenario: ${message}`, this.INFO);
  }

  data(message: string) {
    this.log(message, this.DATA);
  }

  success(message: string) {
    this.log(message, this.SUCCESS);
  }

  error(message: string) {
    this.log(message, this.ERROR);
  }

  /**
   * Starts a loading operation and returns an ID to finish it later.
   * Parallel-safe: each call gets its own isolated state.
   */
  load(message: string): number {
    const loadId = this.nextLoadId++;
    this.activeLoads.set(loadId, { message, startTime: performance.now() });
    console.log(`${this.date()}${message} ...`);
    return loadId;
  }

  finishLoad(loadId: number, status: string) {
    const entry = this.activeLoads.get(loadId);
    if (!entry) return;

    const duration = Math.round(performance.now() - entry.startTime) / 1000;
    console.log(`${this.date()}${entry.message} — ${status} [${duration} s]`);
    this.activeLoads.delete(loadId);
  }

  loadSuccess(loadId?: number) {
    if (loadId !== undefined) {
      this.finishLoad(loadId, `${this.GREEN}${this.BOLD}SUCCESS${this.RESET}`);
    }
  }

  loadError(loadId?: number) {
    if (loadId !== undefined) {
      this.finishLoad(loadId, `${this.RED}${this.BOLD}ERROR${this.RESET}`);
    }
  }

  optionalLog(message: string) {
    const shouldLog = process.env[`LOG_VERBOSE`] as string;
    if (shouldLog === 'true') {
      console.log(`${new Date().toISOString()} ~>  ${message}`);
    }
  }
}
