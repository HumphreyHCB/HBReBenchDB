BEGIN;
-- create temporary table
CREATE TABLE tempmeasurement(
    runid smallint NOT NULL,
    trialid smallint NOT NULL,
    criterion smallint NOT NULL,
    invocation smallint NOT NULL,
    value real[] NOT NULL,
    PRIMARY KEY(runid,trialid,criterion,invocation)
);
-- order the measurement table by primary key, then insert into the new temporary table the aggregate of value for iteration
INSERT INTO tempmeasurement(runid,trialid,criterion,invocation,value)
WITH iterations AS(SELECT runid,trialid,criterion,invocation,iteration, value FROM measurement ORDER BY runid,trialid,criterion,invocation,iteration ASC)
SELECT runid,trialid,criterion,invocation, array_agg(value) as aggValue FROM iterations GROUP BY runid,trialid,criterion,invocation ;

-- drop the old measurement table
DROP TABLE measurement;

-- rename temporary table to be measurement table
ALTER TABLE tempmeasurement
  RENAME TO measurement;
COMMIT;