import {
  TestDatabase,
  createAndInitializeDB,
  closeMainDb
} from './db-testing.js';
import { BenchmarkData } from '../src/api.js';
import { readFileSync } from 'fs';
import { getDirname } from '../src/util.js';

const __dirname = getDirname(import.meta.url);

describe('Timeline-plot Queries', () => {
  let db: TestDatabase;
  let projectName: string;
  let baseBranch: string;
  let changeBranch: string;

  let earlierBaseCommitId: string;
  let baseCommitId: string;
  let changeCommitId: string;

  beforeAll(async () => {
    db = await createAndInitializeDB('db_ts_basic');

    const data = readFileSync(`${__dirname}/small-payload.json`).toString();
    const basicTestData: BenchmarkData = JSON.parse(data);
    projectName = basicTestData.projectName;

    baseBranch = basicTestData.source.branchOrTag = 'base-branch';
    db.setProjectBaseBranch(projectName, basicTestData.source.branchOrTag);
    earlierBaseCommitId = basicTestData.source.commitId;

    await db.recordMetaDataAndRuns(basicTestData);
    await db.recordAllData(basicTestData);

    // have a second experiment in the database
    basicTestData.experimentName += ' 2';
    basicTestData.startTime = '2019-12-14T22:49:56';
    changeBranch = basicTestData.source.branchOrTag = 'change-branch';
    changeCommitId = basicTestData.source.commitId =
      '2222222222222222222222222222222222222222';

    await db.recordMetaDataAndRuns(basicTestData);
    await db.recordAllData(basicTestData);

    // have a merge in the database
    basicTestData.experimentName += ' 3';
    basicTestData.startTime = '2019-12-15T22:49:56';
    basicTestData.source.branchOrTag = baseBranch;
    baseCommitId = basicTestData.source.commitId =
      '3333333333333333333333333333333333333333';

    await db.recordMetaDataAndRuns(basicTestData);
    await db.recordAllData(basicTestData);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('Retrieving branch names based on commit ids', () => {
    it.todo('should return `null` if there is an error');

    it.todo('should handle both commit ids being on the same branch');

    it.todo('should attribute branch names correctly to base and change');
  });

  describe('Retrieving timeline data', () => {
    it.todo('should return `null` if there is an error');

    it.todo('should return median and BCIs for each branch');

    it.todo('should identify the current data points per branch');
  });
});

afterAll(() => {
  closeMainDb();
});
