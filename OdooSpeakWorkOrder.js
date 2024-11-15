/* Function triggered by Work Order Completed Webhook. Obtains Work Order labour costs and posts to Odoo Accounting  */

/* global fetch */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const SECRET_ID = 'odooSpeak/credentials';
const secretsManager = new SecretsManagerClient({ region: 'eu-west-2' });
const client = new DynamoDBClient({ region: "eu-west-2" });
const dynamoDb = DynamoDBDocumentClient.from(client);
const tableName = "odooSpeakWebhook";

// Odoo hardcoded data
const accountJournalId = 16; // Journal name: Inventory Valuation
const accountIdSalaries = 182; // Account name: Inventories Code 13100

let secretsCache = null;

// Get secrets and cache 
const getSecrets = async () => {
    if (!secretsCache) {
        const command = new GetSecretValueCommand({ SecretId: SECRET_ID });
        const response = await secretsManager.send(command);
        secretsCache = JSON.parse(response.SecretString); 
    }
    return secretsCache;
};

let secretsInitialized = false;
let INFRASPEAK_API_KEY, INFRASPEAK_EMAIL, ODOO_API_KEY, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, ODOO_ACCOUNT;

// Initialise secrets globally
const initializeSecrets = async () => {
    if (!secretsInitialized) {
        const secrets = await getSecrets();
        INFRASPEAK_API_KEY = secrets.INFRASPEAK_API_KEY;
        INFRASPEAK_EMAIL = secrets.INFRASPEAK_EMAIL;
        ODOO_API_KEY = secrets.ODOO_API_KEY;
        ODOO_DB = secrets.ODOO_DB;
        ODOO_LOGIN = secrets.ODOO_LOGIN;
        ODOO_PASSWORD = secrets.ODOO_PASSWORD;
        ODOO_ACCOUNT = secrets.ODOO_ACCOUNT;
        secretsInitialized = true;
    }
};

const snsClient = new SNSClient({ region: 'eu-west-2' });

const notifyError = async (errorMessage) => {
    const params = {
        Message: errorMessage,
        Subject: "Odoo Integration Error",
        TopicArn: "arn:aws:sns:eu-west-2:891377393286:OdooSpeakNotification",
    };
    try {
        await snsClient.send(new PublishCommand(params));
        console.log('Error notification sent.');
    } catch (err) {
        console.error('Error sending SNS notification:', err);
    }
};

let completedBy;
let completedDate;

// Event handler
export const handler = async (event) => {
    await initializeSecrets();

    const parsedBody = JSON.parse(event.body);    
    const { id: orderId, type } = parsedBody.data;

    const isWorkOrder = type === "failures";
    const orderType = isWorkOrder ? "Work Order" : "Planned Order";

    // const orderType = "Work Order"
    // const orderId = 686577 //9875096 // 

    try {
        // Step 1: fetch Infraspeak data from work/planned order number, Odoo Cost Center and Stock data
        const [infraspeakData, costCenters] = await Promise.all([
            getInfraspeakData(orderId, orderType),
            getCostCentersInfraspeak()
        ]);

        const { completed_by_id: completed_by, completed_date } = infraspeakData.data.attributes;
        completedBy = completed_by;
        completedDate = completed_date;

        // Step 2: Check if order has been posted to Dynamo
        const isOnDynamo = await checkOrderInDynamo(orderId);

        if (isOnDynamo){
            console.log(`Order ${orderId} has been posted to Odoo already with account.move id ${isOnDynamo}`);
            throw new Error(`Order ${orderId} has been posted to Odoo already with account move id ${isOnDynamo}`);
        }
 
        // Step 3: Process Infraspeak data - create list of material
        const processedWorkOrder = await processWorkOrder(infraspeakData, costCenters, orderId);
        
        // Step 4: Post Inventory and Accounting data to Odoo
        const odooResponse = await postToOdoo(processedWorkOrder, orderType, orderId);

        if (odooResponse){
            console.log(`Successfully posted ${orderType} Id ${orderId} to Odoo.`);
            return createResponse(`Successfully posted ${orderType} Id ${orderId} to Odoo.`, 200);
        }
        else{
            console.log(`Posting to Odoo unsuccessful. Odoo API Response: ${odooResponse}`);
            throw new Error(`Posting to Odoo unsuccessful. Odoo API Response: ${odooResponse}`);
        }

    } catch (error) {
        const userDetails = await getUserDetails(completedBy);
        console.error('Error handling webhook event:', error);
        const emailContent = `Error: ${error.message}\n\nUser name: ${userDetails.name}\nUser email: ${userDetails.email}\nCompleted date: ${completedDate}`;
        await notifyError(emailContent);
        return createResponse(`Error handling webhook event: ${error.message}`, 500);
    }
};


// Check if already posted, return id number if yes.
const checkOrderInDynamo = async (orderId) => {
    try {
        const params = {
            TableName: tableName,
            Key: { order_id: String(orderId) }
        };
  
        const data = await dynamoDb.send(new GetCommand(params));

        if (data.Item && data.Item.posted_to_odoo) {
            return data.Item.posted_to_odoo;
        } else {
            return null;
        }
    } catch (error) {
        console.error("Error checking order in DynamoDB:", error);
        throw new Error(`Error checking order in DynamoDB: ${error.message}`);
    }
};


// Function to process Infraspeak data and return list of stock movement
const processWorkOrder = async (infraspeakData, costCenters, workOrderId) => {
    if (!infraspeakData || !infraspeakData.data) {
        throw new Error('Invalid response structure from Infraspeak API.');
    }
    try {
        // Extract relevant attributes from infraspeakData
        const {
            manpower_cost: manpowerCostRaw = 0,
            cost_center_id: costCenterId = null,
            cost_center_name: costCenterName = null,
        } = infraspeakData.data.attributes;

        const manpowerCost = parseFloat(manpowerCostRaw);
        let costCenterCode;
        
        if (costCenterId) {
            const result = costCenters.find(costCenter => costCenter.id === costCenterId.toString());
            costCenterCode = result.code;
        }
        if (costCenterName) {
            const result = costCenters.find(costCenter => costCenter.name === costCenterName);
            costCenterCode = result.code;
        }
        const costCenter = await getOdooCostCenterId(costCenterCode);

        return {
            workOrderId,
            manpowerCost,
            costCenter,
        };
    } catch (error) {
        console.error('Error preparing material data:', error);
        throw new Error('Error preparing material data:', error);
    }
};


// Post to Odoo Accounting
const postToOdoo = async (accountingData, orderType, orderId) => {
    try {
        // Post work order to Odoo Accounting journal
        const responseAccounting = await postOdooAccounting(accountingData, accountingData.costCenter, orderType);

        if (!responseAccounting || !responseAccounting.result) {
            throw new Error("Failed to post data to Odoo Accounting.");
        }

        // Update DynamoDB with Odoo response
        const responseDynamo = await addedToDynamo(orderId, responseAccounting.result);

        if (!responseDynamo) {
            throw new Error("Failed to update DynamoDB with Odoo response.");
        }

        return {
            accounting: responseAccounting.result
        };
    } catch (error) {
        console.error('Error posting data to Odoo:', error);
        throw new Error(`Error posting data to Odoo: ${error.message}`);
    }
};


// Update Dynamo with work order after successfully posting to odoo
const addedToDynamo = async (orderId, moveId) => {
    const params = {
        TableName: tableName,
        Key: { order_id: String(orderId) },
        UpdateExpression: "SET #posted_to_odoo = :posted_to_odoo, #completed_by = :completed_by, #completed_date = :completed_date",
        ExpressionAttributeNames: {
            "#posted_to_odoo": "posted_to_odoo",
            "#completed_by": "completed_by",
            "#completed_date": "completed_date",
        },
        ExpressionAttributeValues: {
            ":posted_to_odoo": String(moveId),
            ":completed_by": completedBy,
            ":completed_date": completedDate,
        }
    };
    return await dynamoDb.send(new UpdateCommand(params));
};


// Post journal entry to Odoo Accounting               
const postOdooAccounting = async (accountingData, costCenterId, orderType) => {
    const endpoint = '/web/dataset/call_kw/account.move/create';
    const lineItems = [];
    let name;

    // Conditionally add manpower cost lines if manpowerCost is greater than 0
    if (parseFloat(accountingData.manpowerCost) > 0) {
        name = `${orderType} ${accountingData.workOrderId} - Labour cost`
        lineItems.push(
            [0, 0, {  // Debit for manpower costs
                account_id: costCenterId,  // Cost center or expense account
                name: name,
                debit: parseFloat(accountingData.manpowerCost),
            }],
            [0, 0, {  // Credit for manpower costs
                account_id: accountIdSalaries,
                name: name,
                credit: parseFloat(accountingData.manpowerCost)
            }]
        );
    }
    const params = {
            model: "account.move",
            method: "create",
            args: [{
                ref: name,
                move_type: "entry",
                journal_id: accountJournalId,
                line_ids: lineItems,
            }],
        kwargs: {}
    };
    const response = await fetchRequestOdoo(endpoint, params);
    return response;
};


// Get user details if an error is thrown
const getUserDetails = async (userId) => {
    const endpoint = `users`;
    try {
        const response = await fetchRequestInfraspeak(endpoint, 'GET');
        const { full_name, email } = response.data.operator;
        return {name: full_name, email: email};
    } catch (error) {
        console.error('Error fetching user details Infraspeak:', error);
        throw new Error('Error fetching user details Infraspeak', error);
    }
};


// Create a return response
const createResponse = (message, statusCode = 200) => {
    return {
        statusCode: statusCode,
        body: JSON.stringify({
            message: message,
        }),
    };
};


// Function to fetch data from Infraspeak based on workOrderId
const getInfraspeakData = async (workOrderId, orderType) => {
    let endpoint;
    if(orderType === "Work Order"){
        endpoint = `failures/${workOrderId}?expanded=stock.material,stockTasks.material`;
    }
    else{
        endpoint = `works/scheduled/${workOrderId}?expanded=stock.material,stockTasks.material`;
    }
    try {
        const response = await fetchRequestInfraspeak(endpoint, 'GET');
        return response;
    } catch (error) {
        console.error(`Error fetching Infraspeak ${orderType} data:`, error);
        throw new Error(`Error fetching Infraspeak ${orderType} data: ${error.message}`);
    }
};


// Retrieve cost centers from Infraspeak
const getCostCentersInfraspeak = async (orderType) => {
    const endpoint = `cost-centers`;
    try {
        const response = await fetchRequestInfraspeak(endpoint, 'GET');
        const result = response.data.map(item => ({
            id: item.id,
            name: item.attributes.name,
            code: item.attributes.code
        }));
        return result;
    } catch (error) {
        console.error('Error fetching cost center Infraspeak:', error);
        throw new Error(`Error fetching cost center Infraspeak. Ensure to select a cost center in the ${orderType}: ${error.message}`);
    }
};


// Function to perform fetch request to Infraspeak
const fetchRequestInfraspeak = async (endpoint, method) => {
    const url = `https://api.infraspeak.com/v3/${endpoint}`;
    //const url = `https://api.sandbox.infraspeak.com/v3/${endpoint}`;

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${INFRASPEAK_API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': `OdooSpeak (${INFRASPEAK_EMAIL})`
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status} - ${response.statusText}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error with Infraspeak API request:', error);
        throw new Error(`Error with Infraspeak API request: ${error.message}`);
    }
};


// Fetch Cost Center Id from Odoo
const getOdooCostCenterId = async (costCenter) => {
    try{
        const odooAccounts = await getOdooAccounts();
        const odooAcccount_Id = odooAccounts.filter(({ code }) => code === costCenter);
        const odooAccountId = odooAcccount_Id[0].id;
        return odooAccountId;
    }catch (error){
        console.error("error fetching cost center id from Odoo");
        throw new Error(`Error fetching cost center id from Odoo: ${error.message}`);
    }
};


// Fetch all Odoo accounts
const getOdooAccounts = async () => {
    const endpoint = '/web/dataset/call_kw/account.account/search_read';
    const params = {
        model: "account.account",
        method: "search_read",
        args: [],
        kwargs: {
            fields: ["id", "code","name"]
        }
    };
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        return response.result;
    } catch (error) {
        console.error('Error fetching Odoo Accounts:', error);
        throw new Error(`Error fetching Odoo Acounts:: ${error.message}`);
    }
};


// Function to handle pagination and fetch all items
const fetchRequestPaginateOdoo = async (endpoint, params) => {
    let allResults = [];
    let limit = 100;
    let offset = 0;
    let moreProducts = true;

    while (moreProducts) {
        const currentBatch = await fetchRequestOdooPage(endpoint, params, limit, offset);
        if (currentBatch && currentBatch.length > 0) {
            allResults = allResults.concat(currentBatch);
            offset += limit;
        } else {
            moreProducts = false;
        }
    }
    return allResults;
};


// Function to handle one page
const fetchRequestOdooPage = async (endpoint, params, limit, offset) => {
    params.kwargs.limit = limit;
    params.kwargs.offset = offset;
    
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        
        if (response && response.result && response.result.length > 0) {
            return response.result;
        } else {
            return [];
        }
    } catch (error) {
        console.error('Error with fetchRequestOdooPage):', error);
        throw new Error(`Error with fetchRqeustOdooPage : ${error.message}`);
    }
};


// Fetch request to Odoo
const fetchRequestOdoo = async (endpoint, params) => {
    try {
        const baseUrl = `https://${ODOO_ACCOUNT}.odoo.com`;
        const sessionId = await authenticateOdoo(baseUrl);
        
        const response = await fetch(`${baseUrl}${endpoint}`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'cookie': `session_id=${sessionId}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "call",
                params: params,
                id: Math.floor(Math.random() * 1000)
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('HTTP Error:', response.status, errorText);
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error with FetchRequestOdoo:', error);
        throw new Error(`Error with FetchRequestOdoo: ${error.message}`);
    }
};


// Function to authenicate Odoo account
const authenticateOdoo = async (baseUrl) => {
    const endpoint = '/web/session/authenticate';
    
    const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ODOO_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "call",
            params: {
                db: ODOO_DB,
                login: ODOO_LOGIN,
                password: ODOO_PASSWORD
            },
            id: Math.floor(Math.random() * 1000)
        })
    });

    if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`Authentication error: ${data.error.message}`);
    }
    
    // Extract session ID from the Set-Cookie header if available
    const cookies = response.headers.get('Set-Cookie');
    const sessionIdMatch = cookies && cookies.match(/session_id=([^;]*)/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1] : null;

    return sessionId;
};

