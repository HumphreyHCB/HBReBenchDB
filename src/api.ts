export interface Executor {
  name: string;
  desc: string | null;
}

export interface Suite {
  name: string;
  desc: string | null;
  executor: Executor;
}

export interface RunDetails {
  max_invocation_time: number;
  min_iteration_time: number;
  warmup: number | null;
}

export interface Benchmark {
  name: string;
  suite: Suite;
  run_details: RunDetails;
  desc: string;
}

export interface RunId {
  benchmark: Benchmark;
  cmdline: string;
  location: string;

  var_value: number | string | null;
  cores: number | string | null;
  input_size: number | string | null;
}

export interface Run {
  d: DataPoint[];
  run_id: RunId;
}

export interface Measure {
  /** Criterion id. */
  c: number;

  /** Value */
  v: number;
}

export interface DataPoint {
  /** Invocation */
  in: number;

  /** Iteration */
  it: number;

  m: Measure[];
}

export interface Source {
  repoURL: string;
  branchOrTag: string;
  commitId: string;
  commitMsg: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

export interface Environment {
  hostName: string;
  cpu: string;
  memory: string;
  osType: string;
  software: VersionInfo[];

  userName: string;

  /**
   * Is set true when the data was gathered by a manual run,
   * possibly on a developer machine, instead of the usual benchmark server.
   */
  manualRun: boolean;
}

export interface BenchmarkData {
  data: Run[];
  criteria: Criterion[];
  env: Environment;
  source: Source;

  startTime: string;
  endTime: string | null;
  projectName: string | null; // TODO: remove the null support and make it mandatory
}

export interface Criterion {
  /** Id used to identify a criterion tuple. */
  i: number;

  /** Name of the criterion. */
  c: string;

  /** Unit of the criterion. */
  u: string;
}

export interface Unit {
  name: string;
  desc: string;
  lessIsBetter: boolean;
}


export interface VersionInfo {
  name: string;
  version: string;
}
