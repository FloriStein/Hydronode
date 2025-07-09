const mysql = require('mysql2/promise');
const {
    SecretsManagerClient,
    GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({ region: process.env.REGION });
const DB_SECRET_NAME = process.env.DB_SECRET_NAME;

const RESOURCE_META = {
    vessel: {
        table: 'Vessel',
        primaryKey: 'Vessel_ID',
        orderBy: 'Vessel_location'
    },
    station: {
        table: 'Measuring_station',
        primaryKey: 'Measuring_station_ID',
        orderBy: 'Measuring_station_ID'
    },
    sensor: {
        table: 'Sensor',
        primaryKey: 'Sensor_ID',
        orderBy: 'Sensor_model'
    }
};

let pool;

async function getPool() {
    if (pool) return pool;

    console.log('🔐 Lade Datenbank-Zugangsdaten...');
    const cmd = new GetSecretValueCommand({ SecretId: DB_SECRET_NAME });
    const res = await secretsClient.send(cmd);
    const creds = JSON.parse(res.SecretString);

    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: creds.username,
        password: creds.password,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    console.log('✅ Verbindungspool zur Datenbank erstellt.');
    return pool;
}

exports.handler = async (event) => {
    const { httpMethod, path, queryStringParameters } = event;

    if (httpMethod === 'OPTIONS') {
        return respond(200, {});
    }

    const pathParts = path.split('/').filter(Boolean);
    const pool = await getPool();
    console.log(`📥 ${httpMethod} ${path}`);

    try {
        if (
            httpMethod === 'GET' &&
            pathParts.length === 3 &&
            pathParts[0] === 'meta' &&
            pathParts[2] === 'all'
        ) {
            const resource = pathParts[1];
            const meta = RESOURCE_META[resource];
            if (!meta) return respond(400, { error: 'Ungültige Ressource' });

            const [rows] = await pool.execute(`SELECT * FROM \`${meta.table}\` ORDER BY \`${meta.orderBy}\``);
            return respond(200, { data: rows });
        }

        return respond(404, { error: 'Pfad nicht gefunden oder Methode nicht unterstützt' });

    } catch (err) {
        console.error('❌ Fehler:', err);
        return respond(500, {
            error: 'Interner Serverfehler',
            details: err.message
        });
    }
};

function respond(code, body) {
    return {
        statusCode: code,
        body: JSON.stringify(body),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token'
        }
    };
}
