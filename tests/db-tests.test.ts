import { BenchmarkData, Criterion, DataPoint } from '../src/api.js';
import { loadScheme } from '../src/db.js';
import { readFileSync } from 'fs';
import {
  TestDatabase,
  createAndInitializeDB,
  createDB,
  closeMainDb
} from './db-testing.js';
import { getDirname } from '../src/util.js';

import { jest } from '@jest/globals';

const __dirname = getDirname(import.meta.url);

const numTxStatements = 3;

const timeoutForLargeDataTest = 200 * 1000;
jest.setTimeout(timeoutForLargeDataTest);

function expectIdsToBeUnique(ids) {
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toEqual(ids.length);
}

describe('Test Setup', () => {
  it('should execute tests in the right folder', () => {
    expect(__dirname).toMatch(/tests$/);
  });
});

describe('Setup of PostgreSQL DB', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createDB('db_setup_init', 1000, false, false);
  });

  afterAll(async () => {
    await db.close();
  });

  it('should load the database scheme without error', async () => {
    const createTablesSql = loadScheme();
    await db.connectClient();

    const testSql =
      createTablesSql +
      `
        SELECT * FROM Measurement;`;

    const result = await db.query(testSql);
    const len = (<any>result).length;
    expect(len).toBeGreaterThan(numTxStatements);

    const selectCommand = result[len - 1];
    expect(selectCommand.command).toEqual('SELECT');
    expect(selectCommand.rowCount).toEqual(0);
  });
});

describe('Recording a ReBench execution from payload files', () => {
  let db: TestDatabase;
  let smallTestData: BenchmarkData;


  beforeAll(async () => {
    // the test database and we
    // we do not use transactions in these tests, because we need to be able
    // to access the database from R
    db = await createAndInitializeDB('db_setup_timeline', 25, true, false);

    smallTestData = JSON.parse(
      readFileSync(`${__dirname}/small-payload.json`).toString()
    );
  });

   afterAll(async () => {
    await db.close();
  }); 

  it(`should accept all data (small-payload),
      and have the measurements persisted`, async () => {
        //let measurements = await db.query('SELECT * from Measurement'); 
        //console.log(measurements) ;
        //await db.query('INSERT INTO Measurement (runId, trialId, invocation, criterion, value) VALUES (1, 1, 2, 1, ARRAY[432.783])       ON CONFLICT DO NOTHING');
        //measurements = await db.query('SELECT * from Measurement'); 
        //console.log(measurements) ;
    await db.recordMetaDataAndRuns(smallTestData);
    const [recMs, recPs] = await db.recordAllData(smallTestData);

    const measurements = await db.query('SELECT * from Measurement');
    expect(recMs).toEqual(3);
    expect(recPs).toEqual(0);
    expect(measurements.rowCount).toEqual(3);
    await db.awaitQuiescentTimelineUpdater();

    //const timeline = await db.query('SELECT * from Timeline');
    //expect(timeline.rowCount).toEqual(1);
  });
});


afterAll(() => {
  closeMainDb();
});
