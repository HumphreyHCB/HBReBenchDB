import { readFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { execFile, ChildProcessPromise } from 'promisify-child-process';
import { Database, DatabaseConfig, Source } from './db.js';
import { startRequest, completeRequest } from './perf-tracker.js';
import { BenchmarkCompletion } from './api.js';
import { GitHub } from './github.js';
import { robustPath, siteConfig } from './util.js';
import { getDirname } from './util.js';

const __dirname = getDirname(import.meta.url);

const reportOutputFolder = robustPath(`../resources/reports/`);

/**
 * SELECT exp.id, exp.startTime, m.iteration, m.value FROM Source s
JOIN Experiment exp ON exp.sourceId = s.id
JOIN Measurement m ON  m.expId = exp.id
WHERE repoURL = 'https://github.com/smarr/ReBenchDB'
 */

export async function dashProjects(db: Database): Promise<{ projects: any[] }> {
  const result = await db.query(`SELECT * from Project`);
  return { projects: result.rows };
}

export async function dashResults(
  projectId: number,
  db: Database
): Promise<{ timeSeries: Record<string, number[]> }> {
  const result = await db.query(
    `WITH explodedValueMeasurement AS(
      WITH orderedMeasurement AS(SELECT runid,trialid,criterion,invocation, value FROM measurement ORDER BY runid,trialid,criterion,invocation ASC)
      SELECT m.runid,m.trialid,m.criterion,m.invocation,a.value, a.iteration FROM orderedMeasurement as m
      LEFT   JOIN LATERAL unnest(m.value)
                          WITH ORDINALITY AS a(value, iteration) ON true 
      )
      SELECT rank_filter.* FROM (
            SELECT t.startTime, m.iteration, value, b.name as benchmark,
              rank() OVER (
                PARTITION BY b.id
                ORDER BY t.startTime DESC, m.iteration DESC
              )
              FROM explodedValueMeasurement m
                JOIN Trial t ON  m.trialId = t.id
                JOIN Experiment e ON t.expId = e.id
                JOIN Run r ON m.runId = r.id
                JOIN Benchmark b ON r.benchmarkId = b.id
              WHERE projectId = $1
              ORDER BY t.startTime, m.iteration
            ) rank_filter WHERE RANK <= 101`,
    [projectId]
  );
  // dropped to avoid getting too much data:
  //           trialId, iteration, c.unit,
  //           JOIN Criterion c ON criterion = c.id
  const timeSeries: Record<string, number[]> = {};
  for (const r of result.rows) {
    if (!(r.benchmark in timeSeries)) {
      timeSeries[r.benchmark] = [];
    }
    timeSeries[r.benchmark].push(r.value);
  }
  return { timeSeries };
}

export async function dashProfile(
  runId: number,
  trialId: number,
  db: Database
): Promise<any> {
  const result = await db.query(
    ` SELECT substring(commitId, 1, 6) as commitid,
        benchmark.name as bench, executor.name as exe, suite.name as suite,
        cmdline, varValue, cores, inputSize, extraArgs,
        invocation, numIterations, warmup, value as profile
      FROM ProfileData
        JOIN Trial ON trialId = Trial.id
        JOIN Experiment ON expId = Experiment.id
        JOIN Source ON source.id = sourceId
        JOIN Run ON runId = run.id
        JOIN Suite ON suiteId = suite.id
        JOIN Benchmark ON benchmarkId = benchmark.id
        JOIN Executor ON execId = executor.id
      WHERE runId = $1 AND trialId = $2`,
    [runId, trialId]
  );

  const data = result.rows[0];
  try {
    data.profile = JSON.parse(data.profile);
  } catch (e) {
    /* let's just leave it a string */
  }
  return data;
}

export async function dashStatistics(db: Database): Promise<{ stats: any[] }> {
  const result = await db.query(`
    SELECT * FROM (
      SELECT 'Experiments' as table, count(*) as cnt FROM experiment
      UNION ALL
      SELECT 'Trials' as table, count(*) as cnt FROM trial
      UNION ALL
      SELECT 'Executors' as table, count(*) as cnt FROM executor
      UNION ALL
      SELECT 'Benchmarks' as table, count(*) as cnt FROM benchmark
      UNION ALL
      SELECT 'Projects' as table, count(*) as cnt FROM project
      UNION ALL
      SELECT 'Suites' as table, count(*) as cnt FROM suite
      UNION ALL
      SELECT 'Environments' as table, count(*) as cnt FROM environment
      UNION ALL
      SELECT 'Runs' as table, count(*) as cnt FROM run
      UNION ALL
      SELECT 'Measurements' as table, count(*) as cnt FROM measurement
    ) as counts
    ORDER BY counts.table`);
  return { stats: result.rows };
}

export async function dashChanges(
  projectId: number,
  db: Database
): Promise<{ changes: any[] }> {
  const result = await db.query(
    ` SELECT commitId, branchOrTag, projectId, repoURL, commitMessage,
             max(startTime) as experimentTime
      FROM experiment
        JOIN Trial ON expId = experiment.id
        JOIN Source ON sourceId = source.id
        JOIN Project ON projectId = project.id
      WHERE project.id = $1
      GROUP BY commitId, branchOrTag, projectId, repoURL, commitMessage
      ORDER BY max(startTime) DESC`,
    [projectId]
  );
  return { changes: result.rows };
}

export async function dashDataOverview(
  projectId: number,
  db: Database
): Promise<{ data: any[] }> {
  const result = await db.query(
    `
      SELECT
        exp.id as expId, exp.name, exp.description,
        min(t.startTime) as minStartTime,
        max(t.endTime) as maxEndTime,
        ARRAY_TO_STRING(ARRAY_AGG(DISTINCT t.username), ', ') as users,
        ARRAY_TO_STRING(ARRAY_AGG(DISTINCT src.commitId), ' ') as commitIds,
        ARRAY_TO_STRING(ARRAY_AGG(DISTINCT src.commitMessage), '\n\n')
          as commitMsgs,
        ARRAY_TO_STRING(ARRAY_AGG(DISTINCT env.hostName), ', ') as hostNames,

        -- Accessing measurements and timeline should give the same results,
        -- but the counting in measurements is of course a lot slower
        --	count(m.*) as measurements,
        --	count(DISTINCT m.runId) as runs
        SUM(tl.numSamples) as measurements,
        count(DISTINCT tl.runId) as runs
      FROM experiment exp
      JOIN Trial t         ON exp.id = t.expId
      JOIN Source src      ON t.sourceId = src.id
      JOIN Environment env ON env.id = t.envId

      --JOIN Measurement m   ON m.trialId = t.id
      JOIN Timeline tl     ON tl.trialId = t.id

      WHERE exp.projectId = $1

      GROUP BY exp.name, exp.description, exp.id
      ORDER BY minStartTime DESC;`,
    [projectId]
  );
  return { data: result.rows };
}

const reportGeneration = new Map();

export function startReportGeneration(
  base: string,
  change: string,
  outputFile: string,
  dbConfig: DatabaseConfig,
  extraCmd = ''
): ChildProcessPromise {
  const args = [
    robustPath(`views/somns.R`),
    outputFile,
    getOutputImageFolder(outputFile),
    // R ReBenchDB library directory
    robustPath(`views/`),
    siteConfig.reportsUrl,
    base,
    change,
    dbConfig.database,
    dbConfig.user,
    dbConfig.password,
    extraCmd
  ];

  const cmd = 'Rscript';
  console.log(`Generate Report: ${cmd} '${args.join(`' '`)}'`);

  return execFile(cmd, args, { cwd: reportOutputFolder });
}

export function getSummaryPlotFileName(outputFile: string): string {
  return getOutputImageFolder(outputFile) + '/overview.png';
}

export function getOutputImageFolder(outputFile: string): string {
  return outputFile.replace('.html', '_files');
}

export function getReportId(
  project: string,
  base: string,
  change: string
): string {
  const baselineHash6 = base.substr(0, 6);
  const changeHash6 = change.substr(0, 6);
  return `${project}-${baselineHash6}-${changeHash6}`;
}

export function getReportFilename(reportId: string): string {
  return `${reportOutputFolder}/${reportId}.html`;
}

export function dashDeleteOldReport(
  project: string,
  base: string,
  change: string
): void {
  const reportId = getReportId(project, base, change);
  const reportFilename = getReportFilename(reportId);
  if (existsSync(reportFilename)) {
    unlinkSync(reportFilename);
    rmSync(getOutputImageFolder(reportFilename), {
      recursive: true,
      force: true
    });
    reportGeneration.delete(reportId);
  }
}

export async function dashCompare(
  base: string,
  change: string,
  project: string,
  dbConfig: DatabaseConfig,
  db: Database
): Promise<any> {
  const baselineHash6 = base.substr(0, 6);
  const changeHash6 = change.substr(0, 6);

  const reportId = getReportId(project, base, change);

  const data: any = {
    project,
    baselineHash: base,
    changeHash: change,
    baselineHash6,
    changeHash6,
    reportId,
    completionPromise: Promise.resolve()
  };

  const revDetails = await db.revisionsExistInProject(project, base, change);
  if (!revDetails.dataFound) {
    data.generationFailed = true;
    data.stdout =
      `The requested project ${project} does not have data ` +
      `on the revisions ${base} and ${change}.`;
    data.stderr = '';
    data.generatingReport = false;
    return data;
  }

  Object.assign(data, revDetails);
  data.revDetails = revDetails.dataFound;

  const reportFile = getReportFilename(reportId);
  if (existsSync(reportFile)) {
    data.report = readFileSync(reportFile);
    data.generatingReport = false;
  } else {
    data.report = undefined;
    data.currentTime = new Date().toISOString();

    const prevGenerationDetails = reportGeneration.get(reportId);

    // no previous attempt to generate
    if (!prevGenerationDetails) {
      const start = startRequest();

      data.generatingReport = true;

      // we are going to set of the report generation
      // let's indicate that, before we do it
      reportGeneration.set(reportId, {
        inProgress: true
      });

      const p = startReportGeneration(
        base,
        change,
        `${reportId}.html`,
        dbConfig
      );
      const pp = p
        .then(async (result) => {
          reportGeneration.set(reportId, {
            stdout: result.stdout,
            stderr: result.stderr,
            inProgress: false
          });
          await completeRequest(start, db, 'generate-report');
        })
        .catch(async (e) => {
          const { stdout, stderr } = e;
          console.error(`Report generation error: ${e}`);
          reportGeneration.set(reportId, {
            e,
            stdout,
            stderr,
            inProgress: false
          });
          await completeRequest(start, db, 'generate-report');
        });
      data.completionPromise = pp;
    } else if (prevGenerationDetails.error) {
      // if previous attempt failed
      data.generationFailed = true;
      data.stdout = prevGenerationDetails.stdout;
      data.stderr = prevGenerationDetails.stderr;
      data.generatingReport = false;
    } else {
      data.generatingReport = true;
    }
  }

  return data;
}

const expDataPreparation = new Map();

export async function dashGetExpData(
  expId: number,
  dbConfig: DatabaseConfig,
  db: Database
): Promise<any> {
  const result = await db.query(
    `
      SELECT
        exp.name as expName,
        exp.description as expDesc,
        p.id as pId,
        p.name as pName,
        p.description as pDesc
      FROM
        Experiment exp
      JOIN Project p ON exp.projectId = p.id

      WHERE exp.id = $1`,
    [expId]
  );

  let data: any;
  if (!result || result.rows.length !== 1) {
    data = {
      project: '',
      generationFailed: true,
      stdout: 'Experiment was not found'
    };
  } else {
    data = {
      project: result.rows[0].pname,
      expName: result.rows[0].expname,
      expDesc: result.rows[0].expDesc,
      projectId: result.rows[0].pid,
      projectDesc: result.rows[0].pdesc
    };
  }

  const expDataId = `${data.project}-${expId}`;
  const expDataFile = `${__dirname}/../../resources/exp-data/${expDataId}.qs`;

  if (existsSync(expDataFile)) {
    data.preparingData = false;
    data.downloadUrl = `${siteConfig.staticUrl}/exp-data/${expDataId}.qs`;
  } else {
    data.currentTime = new Date().toISOString();

    const prevPrepDetails = expDataPreparation.get(expDataId);

    // no previous attempt to prepare data
    if (!prevPrepDetails) {
      const start = startRequest();

      data.preparingData = true;
      // start preparing data
      const args: string[] = [
        expId.toString(),
        `${__dirname}/../../src/views/`, // R ReBenchDB library directory
        dbConfig.user,
        dbConfig.password,
        dbConfig.database,
        expDataFile
      ];

      console.log(
        `Prepare Data for Download:` +
          `${__dirname}/../../src/stats/get-exp-data.R ${args.join(' ')}`
      );

      expDataPreparation.set(expDataId, {
        inProgress: true
      });

      execFile(`${__dirname}/../../src/stats/get-exp-data.R`, args)
        .then(async (output) => {
          expDataPreparation.set(expDataId, {
            stdout: output.stdout,
            stderr: output.stderr,
            inProgress: false
          });
          await completeRequest(start, db, 'prep-exp-data');
        })
        .catch(async (error) => {
          console.error(`Data preparation failed: ${error}`);
          expDataPreparation.set(expDataId, {
            error,
            stdout: error.stdout,
            stderr: error.stderr,
            inProgress: false
          });
        })
        .finally(async () => await completeRequest(start, db, 'prep-exp-data'));
    } else if (prevPrepDetails.error) {
      // if previous attempt failed
      data.generationFailed = true;
      data.stdout = prevPrepDetails.stdout;
      data.stderr = prevPrepDetails.stderr;
      data.preparingData = false;
    } else {
      data.preparingData = true;
    }
  }

  return data;
}

export async function dashBenchmarksForProject(
  db: Database,
  projectId: number
): Promise<{ benchmarks }> {
  const result = await db.query(
    `
    SELECT DISTINCT p.name, env.hostname, r.cmdline, b.name as benchmark,
        b.id as benchId, s.name as suiteName, s.id as suiteId,
        exe.name as execName, exe.id as execId
      FROM Project p
      JOIN Experiment exp    ON exp.projectId = p.id
      JOIN Trial t           ON t.expId = exp.id
      JOIN Source src        ON t.sourceId = src.id
      JOIN Environment env   ON t.envId = env.id
      JOIN Timeline tl       ON tl.trialId = t.id
      JOIN Run r             ON tl.runId = r.id
      JOIN Benchmark b       ON r.benchmarkId = b.id
      JOIN Suite s           ON r.suiteId = s.id
      JOIN Executor exe      ON r.execId = exe.id
      WHERE p.id = $1
    ORDER BY suiteName, execName, benchmark, hostname`,
    [projectId]
  );
  return { benchmarks: result.rows };
}

export async function dashTimelineForProject(
  db: Database,
  projectId: number
): Promise<{ timeline; details }> {
  const timelineP = db.query(
    `
  SELECT tl.*, src.id as sourceId, b.id as benchmarkId, exe.id as execId,
      s.id as suiteId, hostname
    FROM Timeline tl
    JOIN Run r          ON tl.runId = r.id
    JOIN Benchmark b    ON r.benchmarkId = b.id
    JOIN Suite s        ON r.suiteId = s.id
    JOIN Executor exe   ON r.execId = exe.id
    JOIN Trial t        ON trialId = t.id
    JOIN Environment env ON t.envId = env.id
    JOIN Experiment exp ON expId = exp.id
      JOIN Source src     ON sourceId = src.id
      JOIN Criterion      ON criterion = criterion.id
      JOIN Project p      ON exp.projectId = p.id

    WHERE
      criterion.name = 'total' AND
      p.id = $1
    ORDER BY
      s.name, exe.name, b.name, hostname, startTime`,
    [projectId]
  );

  const timelineDetailsP = db.query(
    `
      SELECT DISTINCT src.*, t.id as trialId, t.manualRun, t.startTime,
        t.userName, exp.name as expName, exp.description as expDesc
      FROM Timeline tl
      JOIN Run r          ON tl.runId = r.id
      JOIN Benchmark b    ON r.benchmarkId = b.id
      JOIN Suite s        ON r.suiteId = s.id
      JOIN Executor exe   ON r.execId = exe.id
      JOIN Trial t        ON trialId = t.id
      JOIN Experiment exp ON expId = exp.id
        JOIN Source src     ON sourceId = src.id
        JOIN Criterion      ON criterion = criterion.id
        JOIN Project p      ON exp.projectId = p.id

      WHERE
        criterion.name = 'total' AND
        p.id = $1`,
    [projectId]
  );
  return {
    timeline: (await timelineP).rows,
    details: (await timelineDetailsP).rows
  };
}

export async function reportCompletion(
  dbConfig: DatabaseConfig,
  db: Database,
  github: GitHub | null,
  data: BenchmarkCompletion
): Promise<void> {
  await db.reportCompletion(data);

  const change = await db.getSourceByNames(
    data.projectName,
    data.experimentName
  );
  const changeSha = change?.commitid;

  if (!changeSha) {
    throw new Error(
      `ReBenchDB failed to identify the change commit that's to be used for the
       comparison. There's likely an issue with
       project (${data.projectName}) or
       experiment (${data.experimentName}) name.`
    );
  }

  const baseline = await db.getBaselineCommit(data.projectName, changeSha);
  const baselineSha = baseline?.commitid;

  if (!baselineSha) {
    throw new Error(
      `ReBenchDB failed to identify the baseline commit that's to be used for
       the comparison. There may be an issue with
       project (${data.projectName}) or
       experiment (${data.experimentName}) name.
       The identified change commit is is ${changeSha}.`
    );
  }

  const { reportId, completionPromise } = await dashCompare(
    baselineSha,
    changeSha,
    data.projectName,
    dbConfig,
    db
  );

  if (github !== null) {
    reportCompletionToGitHub(
      github,
      reportId,
      completionPromise,
      change,
      baselineSha,
      changeSha,
      data.projectName
    );
  }
}

function reportCompletionToGitHub(
  github: GitHub,
  reportId,
  completionPromise,
  change: Source | undefined,
  baselineSha: string,
  changeSha: string,
  projectName: string
) {
  const details = github.getOwnerRepoFromUrl(change?.repourl);
  if (!details) {
    throw new Error(
      `The repository URL does not seem to be for GitHub.
       Result notifications are currently only supported for GitHub.
       Repo URL: ${change?.repourl}`
    );
  }

  const reportUrl =
    siteConfig.publicUrl +
    `/compare/${projectName}/${baselineSha}/${changeSha}`;

  completionPromise
    .then(() => {
      const plotFile = getSummaryPlotFileName(reportId + '.html');
      const summaryPlot = siteConfig.staticUrl + `/reports/${plotFile}`;
      const msg = `#### Performance changes for ${baselineSha}...${changeSha}

![Summary Over All Benchmarks](${siteConfig.publicUrl}/${summaryPlot})
Summary Over All Benchmarks

[Full Report](${reportUrl})`;

      // - post comment
      github.postCommitComment(details.owner, details.repo, changeSha, msg);
    })
    .catch((e: any) => {
      const msg = `ReBench execution completed.

      See [full report](${reportUrl}) for results.

      <!-- Error occurred: ${e} -->
      `;
      github.postCommitComment(details.owner, details.repo, changeSha, msg);
    });
}
