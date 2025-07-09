const { AthenaClient, StartQueryExecutionCommand, GetQueryResultsCommand, GetQueryExecutionCommand } = require("@aws-sdk/client-athena");
const { DateTime } = require("luxon");

const ATHENA_DB = "data-lake-database-0";
const ATHENA_OUTPUT = "s3://s3-data-lake-athena-sql-results/athena-query-results-aggregations/";

const athenaClient = new AthenaClient({ region: "eu-central-1" });

exports.handler = async (event) => {
    try {
        console.log("🚀 Event eingetroffen:", JSON.stringify(event));

        const params = event.queryStringParameters || {};
        const nodeId = params['node-id'];
        const metricType = params['type'];
        const timeframe = (params['timeframe'] || '').toUpperCase();

        if (!nodeId) return respond(400, { error: "'node-id' fehlt" });
        if (!metricType) return respond(400, { error: "'type' fehlt" });
        if (!['DAYS', 'MONTHS', 'YEARS'].includes(timeframe)) return respond(400, { error: "'timeframe' muss DAYS, MONTHS oder YEARS sein" });

        const latestPartition = await getLatestPartition(timeframe, nodeId);
        if (!latestPartition) return respond(404, { error: "Keine Partitionen gefunden" });

        console.log("📆 Letzte Partition:", latestPartition);

        const periods = calculatePeriods(timeframe, latestPartition);
        console.log("📆 Generierte Perioden:", periods);

        const sql = buildDataQuery(timeframe, nodeId, metricType, periods);
        console.log("📄 Finale SQL Query:", sql);

        const queryExecutionId = await startQuery(sql);
        console.log("🆔 QueryExecutionId:", queryExecutionId);

        await waitForQueryToComplete(queryExecutionId);

        const data = await getQueryResults(queryExecutionId);
        console.log("📊 Abfrageergebnis (gekürzt):", JSON.stringify(data.slice(0, 3))); // optional kürzen

        return respond(200, { data });

    } catch (error) {
        console.error("❌ Fehler im Handler:", error);
        return respond(500, { error: error.message || "Interner Serverfehler" });
    }
};

async function getLatestPartition(timeframe, nodeId) {
    let tableName, dateCols;
    if (timeframe === 'DAYS') {
        tableName = 'sensordata_daily_aggregates';
        dateCols = ['year', 'month', 'day'];
    } else if (timeframe === 'MONTHS') {
        tableName = 'sensordata_monthly_aggregates';
        dateCols = ['year', 'month'];
    } else if (timeframe === 'YEARS') {
        tableName = 'sensordata_yearly_agg';
        dateCols = ['year'];
    }

    const maxCols = dateCols.map(c => `MAX(${c}) AS max_${c}`).join(", ");

    const sql = `SELECT ${maxCols} FROM "${ATHENA_DB}".${tableName} WHERE hydronode = '${nodeId}'`;

    console.log("📄 Partition SQL:", sql);

    const queryExecutionId = await startQuery(sql);
    await waitForQueryToComplete(queryExecutionId);
    const results = await getQueryResults(queryExecutionId);

    console.log("📄 Partitionsergebnisse:", results);

    if (results.length === 0) return null;

    return results[0];
}

function calculatePeriods(timeframe, latest) {
    if (timeframe === 'DAYS') {
        // Verwende das heutige Datum, um die letzten 12 Tage zu berechnen
        //const latestDate = DateTime.local();  // Aktuelles Datum
        const latestDate = DateTime.fromObject({
            year: 2021,
            month: 4,
            day: 30
        });

        const result = Array.from({ length: 12 }, (_, i) => {
            const d = latestDate.minus({ days: i });
            return {
                year: d.year.toString(),
                month: d.month.toString().padStart(2, '0'),
                day: d.day.toString().padStart(2, '0')
            };
        });

        console.log('📅 Generierte Tagesdaten:', result);
        return result;
    } else if (timeframe === 'MONTHS') {
        //const latestDate = DateTime.local();  // Aktuelles Datum

        const latestMonthDate = DateTime.fromObject({
            year: 2024,
            month: 12,
            day: 1
        });

        const result = Array.from({ length: 6 }, (_, i) => {
            const d = latestMonthDate.minus({ months: i });
            return {
                year: d.year.toString(),
                month: d.month.toString().padStart(2, '0')
            };
        });

        console.log(result);
        return result;  // Generiert die letzten 6 Monate

    } else if (timeframe === 'YEARS') {
        const latestYear = parseInt(latest.max_year);
        return Array.from({ length: 4 }, (_, i) => ({
            year: (latestYear - i).toString()
        }));
    }
}

function buildDataQuery(timeframe, nodeId, metricType, periods) {
    let tableName, wherePartitions = [];

    if (timeframe === 'DAYS') {
        tableName = 'sensordata_daily_aggregates';
        wherePartitions = periods.map(p => `(year='${p.year}' AND month='${p.month}' AND day='${p.day}')`);
    } else if (timeframe === 'MONTHS') {
        tableName = 'sensordata_monthly_aggregates';
        wherePartitions = periods.map(p => `(year='${p.year}' AND month='${p.month}')`);
    } else if (timeframe === 'YEARS') {
        tableName = 'sensordata_yearly_agg';
        wherePartitions = periods.map(p => `(year='${p.year}')`);
    }

    const partitionFilter = wherePartitions.join(" OR ");

    console.log("📄 Partition Filter:", partitionFilter);  // Debugging Ausgabe

    const query = `
        SELECT hydronode, ${timeframe === 'DAYS' ? 'year, month, day,' : timeframe === 'MONTHS' ? 'year, month,' : 'year,'} avg_value AS value
        FROM "${ATHENA_DB}".${tableName}
        WHERE hydronode = '${nodeId}'
          AND "sensor-id" = '${metricType}'
          AND (${partitionFilter})
        ORDER BY year, month, day ASC  -- Sortiere die Ergebnisse
    `;

    console.log("📄 SQL Query:", query);  // Debugging Ausgabe
    return query;
}


async function startQuery(sql) {
    console.log("📡 Starte Athena Query:", sql);

    const params = {
        QueryString: sql,
        QueryExecutionContext: { Database: ATHENA_DB },
        ResultConfiguration: { OutputLocation: ATHENA_OUTPUT }
    };
    const command = new StartQueryExecutionCommand(params);
    const response = await athenaClient.send(command);
    return response.QueryExecutionId;
}

async function waitForQueryToComplete(queryExecutionId) {
    let status = 'RUNNING';
    while (status === 'RUNNING' || status === 'QUEUED') {
        await new Promise(r => setTimeout(r, 1000));
        const res = await athenaClient.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
        status = res.QueryExecution.Status.State;
        console.log(`⌛ Status für ${queryExecutionId}: ${status}`);
        if (status === 'FAILED' || status === 'CANCELLED') {
            console.error("🛑 Athena Query fehlgeschlagen:", JSON.stringify(res.QueryExecution.Status));
            throw new Error(`Athena Query failed: ${res.QueryExecution.Status.StateChangeReason}`);
        }
    }
}

async function getQueryResults(queryExecutionId) {
    const results = [];
    let nextToken;
    do {
        const params = { QueryExecutionId: queryExecutionId, NextToken: nextToken };
        const command = new GetQueryResultsCommand(params);
        const data = await athenaClient.send(command);
        nextToken = data.NextToken;

        const rows = data.ResultSet.Rows;
        const headers = rows[0].Data.map(d => d.VarCharValue);

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            let item = {};
            row.Data.forEach((col, idx) => {
                item[headers[idx]] = col.VarCharValue;
            });
            results.push(item);
        }
    } while (nextToken);

    return results;
}

function respond(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            'Access-Control-Allow-Methods': 'GET,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: JSON.stringify(body)
    };
}
