const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const REGION = process.env.REGION;
const DB_SECRET_NAME = process.env.DB_SECRET_NAME;
const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME;

const secretsClient = new SecretsManagerClient({ region: REGION });
let pool;

// Erzeuge oder liefere bestehenden Connection-Pool
async function getPool() {
    if (pool) return pool;

    const secretRes = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: DB_SECRET_NAME })
    );
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

// Antwort-Helfer
function respond(statusCode, body) {
    return {
        statusCode,
        body: JSON.stringify(body),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
    };
}

// Hauptfunktion
module.exports.handler = async (event) => {
    const { httpMethod, path, queryStringParameters } = event;

    // CORS Preflight
    if (httpMethod === 'OPTIONS') {
        return respond(200, {});
    }

    // Robuste Pfadprüfung
    if (httpMethod !== 'GET' || !path.includes('/meta/schema')) {
        return respond(404, { error: 'Not Found' });
    }

    const resourceType = queryStringParameters?.resource_type;
    if (!resourceType) {
        return respond(400, { error: 'resource_type query parameter is required' });
    }

    try {
        const pool = await getPool();

        console.log('🔎 Suche Schema für Resource Type:', resourceType);

        const [schemas] = await pool.execute(
            `SELECT * FROM meta_schemas WHERE resource_type = ?`,
            [resourceType]
        );

        if (schemas.length === 0) {
            return respond(404, { error: `No schema found for resource type ${resourceType}` });
        }

        const schemaId = schemas[0].schema_id;

        const [fields] = await pool.execute(
            `SELECT * FROM meta_fields WHERE schema_id = ?`,
            [schemaId]
        );

        const formattedFields = fields.map(field => ({
            field_name: field.field_name,
            field_type: field.field_type,
            validation_rule: field.validation_rule,
            is_required: field.is_required,
        }));

        console.log(`✅ ${formattedFields.length} Felder für ${resourceType} geladen`);

        return respond(200, {
            schema: {
                resource_type: resourceType,
                fields: formattedFields
            }
        });
    } catch (err) {
        console.error('❌ Fehler beim Abruf des Schemas:', err);
        return respond(500, {
            error: 'Internal server error',
            details: err.message,
        });
    }
};
