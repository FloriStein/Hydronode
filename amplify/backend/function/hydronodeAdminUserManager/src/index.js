const {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminCreateUserCommand,
    AdminDeleteUserCommand,
    AdminAddUserToGroupCommand,
    AdminGetUserCommand
} = require('@aws-sdk/client-cognito-identity-provider');

const {
    SNSClient,
    SubscribeCommand,
    ListSubscriptionsByTopicCommand,
    UnsubscribeCommand
} = require('@aws-sdk/client-sns');

const {
    SESClient,
    SendEmailCommand
} = require('@aws-sdk/client-ses');

const client = new CognitoIdentityProviderClient({ region: 'eu-central-1' });
const USER_POOL_ID = process.env.USER_POOL_ID;
const snsClient = new SNSClient({ region: 'eu-central-1' });
const SNS_TOPIC_ARN = 'arn:aws:sns:eu-central-1:717279707507:distance-alert-topic';
const sesClient = new SESClient({ region: 'eu-central-1' });

exports.handler = async (event) => {
    console.log('📥 Eingehendes Event:', JSON.stringify(event));

    const claims = event.requestContext?.authorizer?.claims || {};
    const groups = claims['cognito:groups'] || [];
    const isAdmin = Array.isArray(groups) ? groups.includes('Admin') : groups === 'Admin';

    console.log('👤 Auth Claims:', claims);
    console.log('🔒 Ist Admin:', isAdmin);

    if (!isAdmin) {
        console.warn('⛔ Zugriff verweigert: Kein Admin');
        return respond(403, { error: 'Nur Admins erlaubt' });
    }

    const { httpMethod, pathParameters, body } = event;
    console.log('➡️ HTTP-Methode:', httpMethod);
    console.log('🛣️ Path-Parameter:', pathParameters);
    console.log('📝 Body:', body);

    try {
        if (httpMethod === 'GET') {
            console.log('📄 Liste aller Benutzer wird abgerufen...');
            const users = await client.send(new ListUsersCommand({
                UserPoolId: USER_POOL_ID
            }));
            console.log(`✅ ${users.Users.length} Benutzer gefunden`);

            return respond(200, users.Users.map(u => ({
                username: u.Username,
                email: u.Attributes.find(attr => attr.Name === 'email')?.Value || '',
                status: u.UserStatus
            })));
        }

        if (httpMethod === 'POST' && body) {
            const { email } = JSON.parse(body);
            console.log('➕ Neuer Benutzer wird erstellt:', email);

            await client.send(new AdminCreateUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: email,
                UserAttributes: [
                    { Name: 'email', Value: email },
                    { Name: 'email_verified', Value: 'true' }
                ]
            }));
            console.log('✅ Benutzer in Cognito erstellt');

            await client.send(new AdminAddUserToGroupCommand({
                UserPoolId: USER_POOL_ID,
                Username: email,
                GroupName: 'User'
            }));
            console.log('✅ Benutzer zur Gruppe "User" hinzugefügt');

            await snsClient.send(new SubscribeCommand({
                TopicArn: SNS_TOPIC_ARN,
                Protocol: 'email',
                Endpoint: email
            }));
            console.log('✅ SNS Subscription für E-Mail hinzugefügt:', email);

            return respond(200, { message: 'Benutzer erstellt, Gruppe zugewiesen, SNS subscription hinzugefügt' });
        }

        if (httpMethod === 'DELETE' && pathParameters?.username) {
            const username = pathParameters.username;
            console.log('🗑️ Benutzer wird gelöscht:', username);

            // 1. E-Mail vom Benutzer holen
            const user = await client.send(new AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: username
            }));
            console.log('✅ Benutzerinformationen abgerufen');

            const emailAttr = user.UserAttributes.find(attr => attr.Name === 'email');
            const email = emailAttr?.Value;
            console.log('📧 Benutzer-E-Mail:', email);

            // 2. SNS Subscription löschen
            if (email) {
                try {
                    console.log('🔍 SNS Subscriptions werden überprüft...');
                    const subs = await snsClient.send(new ListSubscriptionsByTopicCommand({
                        TopicArn: SNS_TOPIC_ARN
                    }));

                    const matching = subs.Subscriptions.find(sub =>
                        sub?.Endpoint === email && sub?.SubscriptionArn && sub?.SubscriptionArn !== 'PendingConfirmation'
                    );

                    if (matching) {
                        console.log('🗑️ SNS Subscription wird entfernt:', matching.SubscriptionArn);
                        await snsClient.send(new UnsubscribeCommand({
                            SubscriptionArn: matching.SubscriptionArn
                        }));
                        console.log('✅ SNS Subscription entfernt');
                    } else {
                        console.log('ℹ️ Keine passende SNS Subscription gefunden');
                    }
                } catch (snsError) {
                    console.warn(`⚠️ Fehler beim Entfernen der SNS Subscription für ${email}:`, snsError);
                }

                // 3. Abschiedsmail senden
                try {
                    console.log('📧 Abschiedsmail wird gesendet an:', email);
                    await sesClient.send(new SendEmailCommand({
                        Destination: { ToAddresses: [email] },
                        Message: {
                            Subject: { Data: 'Dein Benutzerkonto wurde gelöscht' },
                            Body: {
                                Text: { Data: `Hallo,\n\ndein Benutzerkonto wurde vom Administrator gelöscht und ist nicht mehr verfügbar.` }
                            }
                        },
                        Source: 'noreply@grafana-proxy.com'
                    }));
                    console.log('✅ E-Mail erfolgreich gesendet');
                } catch (sesError) {
                    console.warn(`⚠️ Fehler beim Senden der E-Mail an ${email}:`, sesError);
                }
            }

            // 4. Benutzer aus Cognito löschen
            console.log('🗑️ Benutzer wird endgültig aus Cognito gelöscht');
            await client.send(new AdminDeleteUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: username
            }));
            console.log('✅ Benutzer gelöscht');

            return respond(200, { message: 'Benutzer gelöscht (inkl. optionaler SNS und E-Mail)' });
        }

        console.warn('❓ Nicht unterstützte Methode oder Route:', httpMethod);
        return respond(405, { error: 'Methode nicht erlaubt oder Route ungültig' });

    } catch (error) {
        console.error('🔥 Unerwarteter Fehler:', error);
        return respond(500, { error: 'Interner Serverfehler' });
    }
};

function respond(code, body) {
    return {
        statusCode: code,
        body: JSON.stringify(body),
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*'
        }
    };
}
