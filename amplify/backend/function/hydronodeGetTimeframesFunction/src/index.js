const mysql = require('mysql2/promise');
const {
    SecretsManagerClient,
    GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({ region: process.env.REGION });
const DB_SECRET_NAME = process.env.DB_SECRET_NAME;

let pool;

async function getPool() {
    if (pool) return pool;

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
        queueLimit: 0,
    });

    return pool;
}

exports.handler = async (event) => {
    const { httpMethod, path } = event;

    // CORS preflight
    if (httpMethod === 'OPTIONS') {
        return respond(200, {});
    }

    if (httpMethod !== 'GET' || path !== '/meta/app/timeframe') {
        return respond(404, { error: 'Not Found' });
    }

    try {
        const pool = await getPool();

        const [rows] = await pool.execute(
            `SELECT ConfigValue FROM AppConfig WHERE ConfigKey = 'Timeframe'`
        );

        if (rows.length === 0) {
            return respond(404, { error: 'No Timeframe config found' });
        }

        const value = rows[0].ConfigValue;
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;

        return respond(200, { timeframes: parsed });

    } catch (err) {
        console.error('❌ Fehler:', err);
        return respond(500, {
            error: 'Internal server error',
            details: err.message,
        });
    }
};

function respond(code, body) {
    return {
        statusCode: code,
        body: JSON.stringify(body),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
    };
}
