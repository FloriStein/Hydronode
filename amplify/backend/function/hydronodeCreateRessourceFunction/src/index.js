const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.REGION;
const DB_SECRET_NAME = process.env.DB_SECRET_NAME;
const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME;

const secretsClient = new SecretsManagerClient({ region: REGION });
let pool;

async function getPool() {
    if (pool) return pool;

    const secretRes = await secretsClient.send(new GetSecretValueCommand({ SecretId: DB_SECRET_NAME }));
    const creds = JSON.parse(secretRes.SecretString);

    pool = mysql.createPool({
        host: DB_HOST,
        user: creds.username,
        password: creds.password,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
    });

    return pool;
}

// Helper für Auto-Increment Abfrage
async function getNextAutoIncrement(pool, dbName, tableName) {
    console.log(`🔎 Ermittle AUTO_INCREMENT für Tabelle ${tableName} im Schema ${dbName}...`);
    const [rows] = await pool.query(`
        SELECT AUTO_INCREMENT
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
    `, [dbName, tableName]);

    if (rows.length === 0) {
        throw new Error(`Tabelle ${tableName} in Schema ${dbName} nicht gefunden!`);
    }

    const nextId = rows[0].AUTO_INCREMENT;
    console.log(`✅ AUTO_INCREMENT-Wert: ${nextId}`);
    return nextId;
}

const RESOURCE_META = {
    vessel: { table: 'Vessel', primaryKey: 'Vessel_ID' },
    sensor: { table: 'Sensor', primaryKey: 'Sensor_ID' },
    measuring_station: { table: 'Measuring_station', primaryKey: 'Measuring_station_ID' }
};

module.exports.handler = async (event) => {
    const { httpMethod, pathParameters, body } = event;

    if (httpMethod === 'OPTIONS') {
        return respond(200, {});
    }

    const resourceType = pathParameters?.['resource-type'];
    const resourceId = pathParameters?.['resource-id'] || null;

    if (!resourceType) {
        return respond(400, { error: 'Missing resource-type in path' });
    }

    const resource = RESOURCE_META[resourceType];
    if (!resource) {
        return respond(400, { error: `Unknown resource-type: ${resourceType}` });
    }

    try {
        const pool = await getPool();

        // --- CREATE ---
        if (httpMethod === 'POST' && !resourceId) {
            const data = JSON.parse(body);
            let query = '';
            let values = [];

            if (resourceType === 'vessel') {
                query = `INSERT INTO Vessel (Vessel_location, Vessel_longitude, Vessel_latitude, Vessel_capacity, Vessel_height) VALUES (?, ?, ?, ?, ?)`;
                values = [
                    data.Vessel_location,
                    data.Vessel_longitude,
                    data.Vessel_latitude,
                    data.Vessel_capacity,
                    data.Vessel_height
                ];
                const [result] = await pool.execute(query, values);
                return respond(201, { message: 'Vessel created', id: result.insertId });
            }

            if (resourceType === 'sensor') {
                query = `INSERT INTO Sensor (Sensor_type, Sensor_location, Measuring_station_ID, Sensor_unit, sensor_manufacturer, Sensor_model) VALUES (?, ?, ?, ?, ?, ?)`;
                values = [
                    data.Sensor_type,
                    data.Sensor_location,
                    data.Measuring_station_ID,
                    data.Sensor_unit,
                    data.sensor_manufacturer,
                    data.Sensor_model
                ];
                const [result] = await pool.execute(query, values);
                return respond(201, { message: 'Sensor created', id: result.insertId });
            }

            if (resourceType === 'measuring_station') {
                // Vorab nächstes internal_id ermitteln
                const nextInternalId = await getNextAutoIncrement(pool, DB_NAME, 'Measuring_station');
                const measuringStationId = `hydronode-${nextInternalId}`;

                const insertQuery = `
                    INSERT INTO Measuring_station
                    (Measuring_station_ID, Microcontroller, Station_location, Station_longitude, Station_latitude, Battery_capacity, Vessel_ID)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `;
                values = [
                    measuringStationId,
                    data.Microcontroller,
                    data.Station_location,
                    data.Station_longitude,
                    data.Station_latitude,
                    data.Battery_capacity,
                    data.Vessel_ID
                ];

                const [result] = await pool.execute(insertQuery, values);
                return respond(201, { message: 'Measuring_station created', id: measuringStationId });
            }
        }

        // --- READ ---
        if (httpMethod === 'GET' && resourceId) {
            const selectQuery = `SELECT * FROM ${resource.table} WHERE ${resource.primaryKey} = ?`;
            const [rows] = await pool.execute(selectQuery, [resourceId]);

            if (rows.length === 0) {
                return respond(404, { error: 'Resource not found' });
            }

            return respond(200, { data: rows[0] });
        }

        // --- UPDATE ---
        if (httpMethod === 'PUT' && resourceId) {
            const data = JSON.parse(body);
            const fields = Object.keys(data);
            if (fields.length === 0) {
                return respond(400, { error: 'No fields to update' });
            }

            const setClause = fields.map(field => `${field} = ?`).join(', ');
            const values = [...fields.map(field => data[field]), resourceId];

            const updateQuery = `UPDATE ${resource.table} SET ${setClause} WHERE ${resource.primaryKey} = ?`;
            const [result] = await pool.execute(updateQuery, values);
            return respond(200, { message: 'Resource updated', affectedRows: result.affectedRows });
        }

        // --- DELETE ---
        if (httpMethod === 'DELETE' && resourceId) {
            const deleteQuery = `DELETE FROM ${resource.table} WHERE ${resource.primaryKey} = ?`;
            const [result] = await pool.execute(deleteQuery, [resourceId]);
            return respond(200, { message: 'Resource deleted', affectedRows: result.affectedRows });
        }

        return respond(405, { error: 'Method not allowed or missing parameters' });

    } catch (err) {
        console.error('❌ Fehler:', err);
        return respond(500, { error: 'Internal server error', details: err.message });
    }
};

function respond(statusCode, body) {
    return {
        statusCode,
        body: JSON.stringify(body),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS'
        }
    };
}
