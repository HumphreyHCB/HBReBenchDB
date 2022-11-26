import { BatchingTimelineUpdater, ComputeRequest } from '../timeline-calc.js';
import { RebenchDbBenchmark } from './rebenchdb-benchmark.js';

export default class ComputeTimeline extends RebenchDbBenchmark {
  private updater: BatchingTimelineUpdater | null = null;
  private jobs: ComputeRequest[] | null = null;

  public async oneTimeSetup(problemSize: string): Promise<void> {
    this.enableTimeline = true;
    await super.oneTimeSetup(problemSize);

    if (!this.db) {
      throw new Error('Database is not initialized');
    }

    if (problemSize === 'full') {
      // just use the testData as is
    } else if (problemSize === 'large') {
      this.testData.data.length = 50;
    } else if (problemSize === 'medium') {
      this.testData.data.length = 20;
      for (const run of this.testData.data) {
        if (run.d) {
          run.d.length = 200;
        }
      }
    } else if (problemSize === 'small') {
      this.testData.data.length = 10;
      for (const run of this.testData.data) {
        if (run.d) {
          run.d.length = 15;
        }
      }
    } else {
      throw new Error('Unsupported problem size given: ' + problemSize);
    }

    this.testData.experimentName = 'Benchmark 1';
    this.testData.source.commitId = 'commit-1';
    await this.db.recordAllData(this.testData, true);

    this.testData.experimentName = 'Benchmark 2';
    this.testData.source.commitId = 'commit-2';
    await this.db.recordAllData(this.testData, true);

    this.updater = this.db.getTimelineUpdater();
    this.jobs = <ComputeRequest[]>this.updater?.getUpdateJobs();
  }

  public async benchmark(): Promise<any> {
    if (!this.updater || !this.jobs) {
      throw new Error('Timeline updater not initialized');
    }
    if (!this.db) {
      throw new Error('Database is not initialized');
    }

    const numJobs = await this.updater.processUpdateJobs(this.jobs);

    const result = await this.db.query({
      text: `SELECT count(*) FROM Timeline`
    });

    await this.db.query({ text: `TRUNCATE Timeline` });

    return {
      timelineEntries: result?.rows[0],
      numJobs: numJobs
    };
  }

  public verifyResult(result: any): boolean {
    if (this.problemSize === 'small') {
      return result.numJobs === 24 && result.timelineEntries.count === '24';
    }

    if (this.problemSize === 'medium') {
      return result.numJobs === 52 && result.timelineEntries.count === '52';
    }

    if (this.problemSize === 'large') {
      return result.numJobs === 152 && result.timelineEntries.count === '152';
    }

    if (this.problemSize === 'full') {
      return result.numJobs === 920 && result.timelineEntries.count === '920';
    }

    throw new Error('not yet supported problem size ' + this.problemSize);
  }
}
