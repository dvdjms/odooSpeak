/*
    This Lambda function polls new Requests in Infraspeak. Updates or inserts to DynamoDB. Then updates 
    or inserts material costs in Odoo Accounts and stock levels in Odoo Inventory. 
    It also intends to reverse postings when Requests are cancelled on Infraspeak
*/

/* global fetch */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const SECRET_ID = 'odooSpeak/credentials';
const secretsManager = new SecretsManagerClient({ region: 'eu-west-2' });

const client = new DynamoDBClient({ region: "eu-west-2" });
const dynamoDb = DynamoDBDocumentClient.from(client);
const tableName = "odooSpeakRequests";

const accountJournalId = 16; // Journal name: Inventory Valuation
const accountIdInventories = 482; // Account name: 5013100 Inventories
const locationDestId = 16;  // Virtual Locations/Scrap

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
        INFRASPEAK_EMAIL = secrets.INFRASPEAK_EMAIL
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

let approvedBy;
let completedDate;

// Event handler
export const handler = async () => {
    await initializeSecrets();

    // const reversals = ['10419472'];
    // await processStockReversal('10419472');
    // await processJournalReversal('10419472');
  
    try {
        // Step 1: fetch Closed Requests from Infraspeak
        const payloadRequest = await getInfraspeakRequests();

        //Step 2: check payload request with DynamoDb. Insert, update, or ignore
        const checkedWithDynamo = await checkAndUpsertRequests(payloadRequest)

        if (!checkedWithDynamo) {
            return createResponse(`Okay. No new Requests to process.`, 200);
        }

        // Step 3: fetch Infraspeak Cost Centers and Odoo Stock data
        const [costCenters, odooStock] = await Promise.all([
            getCostCentersInfraspeak(),
            getOdooStockQuant()
        ]);

        // Step 4: loop through each newly created and newly updated items
        for(let item of checkedWithDynamo){
            let infraspeakData;
            let odooResponse;
            let orderType = item.related_to_type === "FAILURE" ? "Work Order" : "Planned Order";

            // Step 4.1: if state COMPLETED process results
            if (item.state === "COMPLETED"){
                infraspeakData =  await getInfraspeakData(item.related_to_id, orderType)
                
                // Step 4.1.1: obtain user information
                const { approved_by_id: approved_By, completed_date } = infraspeakData.data.attributes;
                approvedBy = approved_By;
                completedDate = completed_date;
 
                // Step 4.1.2: Process Infraspeak data - create list of material
                const processedWorkOrder = await processWorkOrder(infraspeakData, costCenters, item.related_to_id, orderType, item.upserted, item.request_id);
 
                // Step 4.1.3: Prepare Inventory data for posting 
                const preparedInventoryPosting = await prepareInventoryPosting(processedWorkOrder.material, odooStock);
            
                // Step 4.1.4: Post Inventory and Accounting data to Odoo
                odooResponse = await postToOdoo(preparedInventoryPosting, processedWorkOrder, orderType, item.state, item.request_id);
            }
            // Step 4.2.0: If state REVERSED process results // (item.state === "REVERSED")
            else {
                // Step: 4.2.1: fetch stock_move_ids and account_move_id from Dynamo
                const resultIds = await fetchOdooIdsFromDynamo(item.request_id);

                // Step: 4.2.2: prepared data for reversing
                const preparedStock =  await processStockReversal(item.related_to_id, item.request_id, resultIds.stock_move_ids)
                const preparedJournal =  await processJournalReversal(item.related_to_id, resultIds.account_move_id, resultIds.cost_center_odoo)

                // Step 4.2.4: Post Inventory and Accounting data to Odoo
                odooResponse = await postToOdoo(preparedStock, preparedJournal, orderType, item.state, item.request_id);
            }

            if (odooResponse){
                return createResponse(`Successfully posted ${orderType} Id ${item.related_to_id} to Odoo.`, 200);
            }
            else{
                console.log(`Posting to Odoo unsuccessful. Odoo API Response: ${odooResponse}`);
                throw new Error(`Posting to Odoo unsuccessful. Odoo API Response: ${odooResponse}`);
            }
        }

    } catch (error) {
        const userDetails = await getUserDetails(approvedBy);
        console.error('Error handling requests:', error);
        const emailContent = `Error: ${error.message}\n\nUser name: ${userDetails.name}\nUser email: ${userDetails.email}\nCompleted date: ${completedDate}`;
        //await notifyError(emailContent);
        return createResponse(`Error processing Requests: ${error.message}`, 500);
    }
};


// Main function: Process requests and upsert as necessary
const checkAndUpsertRequests = async (payloadRequest) => {
    const results = [];
    
    // Extract request_ids from the payload for comparison
    const payloadRequestIds = new Set(payloadRequest.map(request => String(request.attributes.request_id)));

    // Retrieve existing items from DynamoDB
    const existingItems = await getAllRequestsFromDynamo();

    // Process each request in the payload
    for (const request of payloadRequest) {
        const { 
            request_id, 
            type, 
            related_to_type, 
            related_to_id, 
            date_created, 
            date_updated: newDateUpdated, 
            operator_id,
            cost_center_odoo = '',
            journal_move_id = '',
            stock_move_ids = [],
        } = request.attributes;

        const requestId = String(request_id);
        const existingItem = existingItems.find(item => item.request_id === requestId);
        
        if (!existingItem) {
            // Insert if item does not exist
            await insertRequestToDynamo(request.attributes);
            results.push({
                cost_center_odoo: cost_center_odoo,
                journal_move_id: journal_move_id,
                request_id: requestId,
                related_to_id: related_to_id,
                related_to_type: related_to_type,
                stock_move_ids: [],
                state: "COMPLETED",
                upserted: "INSERTED"
            });
            console.log(`Inserted new request: ${requestId}, related_to_id: ${related_to_id}, status: INSERTED`);
        } else {
            // Reset `reversed` to false for items in the payload
            if (existingItem.reversed) {
                await resetReversedFlag(requestId);
            }

            // Check for date updates
            const oldDateUpdated = existingItem.date_updated;
            if (oldDateUpdated !== newDateUpdated) {
                await updateRequestInDynamo(requestId, request.attributes);

                results.push({
                    cost_center_odoo: cost_center_odoo || '',
                    journal_move_id: journal_move_id || '',
                    request_id: requestId,
                    related_to_id: related_to_id,
                    related_to_type: related_to_type,
                    stock_move_ids: existingItem.stock_move_ids || [],
                    state: "COMPLETED",
                    upserted: "UPDATED"
                });
                console.log(`Updated request: ${requestId}, related_to_id: ${related_to_id}, status: COMPLETED`);
            }
        }
    }

    // Mark items not in the payload as reversed
    for (const item of existingItems) {
        if (!payloadRequestIds.has(item.request_id) && !item.reversed) {
            // Mark the item as reversed
            await markAsReversed(item.request_id);
            
            results.push({
                request_id: item.request_id,
                related_to_id: item.related_to_id,
                related_to_type: item.related_to_type,
                state: "REVERSED"
            });
            console.log(`Reversed request: ${item.request_id}, related_to_id: ${item.related_to_id}`);
        }
    }
    return results.length > 0 ? results : null;
};


// Helper: Get all items from DynamoDB
const getAllRequestsFromDynamo = async () => {
    const scanParams = {
        TableName: tableName,
    };
    const { Items } = await dynamoDb.send(new ScanCommand(scanParams));
    return Items;
};


// Helper: Insert a new item into DynamoDB
const insertRequestToDynamo = async (attributes) => {
    const { request_id, type, related_to_type, related_to_id, date_created, date_updated, operator_id } = attributes;
    const putParams = {
        TableName: tableName,
        Item: {
            request_id: String(request_id),
            type,
            related_to_type,
            related_to_id: String(related_to_id),
            state: "COMPLETED",
            date_created,
            date_updated,
            operator_id: String(operator_id),
            reversed: false,
        }
    };
    await dynamoDb.send(new PutCommand(putParams));
};


// Helper: Update an existing item in DynamoDB
const updateRequestInDynamo = async (requestId, attributes) => {
    const { type, related_to_type, related_to_id, date_created, date_updated, operator_id } = attributes;
    const updateParams = {
        TableName: tableName,
        Key: { request_id: requestId },
        UpdateExpression: "SET #type = :type, #related_to_type = :related_to_type, #related_to_id = :related_to_id, #state = :state, #date_created = :date_created, #date_updated = :date_updated, #operator_id = :operator_id, #reversed = :reversed",
        ExpressionAttributeNames: {
            "#type": "type",
            "#related_to_type": "related_to_type",
            "#related_to_id": "related_to_id",
            "#state": "state",
            "#date_created": "date_created",
            "#date_updated": "date_updated",
            "#operator_id": "operator_id",
            "#reversed": "reversed"
        },
        ExpressionAttributeValues: {
            ":type": type,
            ":related_to_type": related_to_type,
            ":related_to_id": String(related_to_id),
            ":state": "COMPLETED",
            ":date_created": date_created,
            ":date_updated": date_updated,
            ":operator_id": String(operator_id),
            ":reversed": false
        }
    };
    await dynamoDb.send(new UpdateCommand(updateParams));
};


// Helper: Mark an item as reversed
const markAsReversed = async (requestId) => {
    const updateParams = {
        TableName: tableName,
        Key: { request_id: requestId },
        UpdateExpression: "SET #reversed = :reversed",
        ExpressionAttributeNames: {
            "#reversed": "reversed"
        },
        ExpressionAttributeValues: {
            ":reversed": true
        }
    };
    await dynamoDb.send(new UpdateCommand(updateParams));
};


// Helper: Reset the reversed flag
const resetReversedFlag = async (requestId) => {
    const updateParams = {
        TableName: tableName,
        Key: { request_id: requestId },
        UpdateExpression: "SET #reversed = :reversed",
        ExpressionAttributeNames: {
            "#reversed": "reversed"
        },
        ExpressionAttributeValues: {
            ":reversed": false
        }
    };
    await dynamoDb.send(new UpdateCommand(updateParams));
};


// Process stock reversal, fetching result IDs and then calling fetchStockMovementOdoo
const processStockReversal = async (orderId, requestId, resultIds) => {
    try {
        const stockResponse = await fetchStockMovementOdoo(orderId, resultIds);
 
        // Process the response to create stock reversals
        const stockReversals = stockResponse?.result?.map(item => ({
            product_id: item.product_id?.[0] || null,
            location_id: item.location_id?.[0] || null,
            location_dest_id: item.location_dest_id?.[0] || null,
            quantity: item.quantity || 0,
            work_order_id: item.x_work_order_id || 0
        })) || [];
        
        return stockReversals;

    } catch (error) {
        console.error('Error processing stock reversal:', error);
        throw new Error(`Failed to process stock reversal for order ${orderId}`);
    }
};


// Function to fetch result IDs from DynamoDB based on workOrderId
const fetchOdooIdsFromDynamo = async (requestId) => {
    const params = {
        TableName: tableName,
        Key: { request_id: requestId },
        ProjectionExpression: 'stock_move_ids, account_move_id, cost_center_odoo'
    };

    try {
        const data = await dynamoDb.send(new GetCommand(params));
        return {
            stock_move_ids: data.Item?.stock_move_ids || [],
            account_move_id: data.Item?.account_move_id || null,
            cost_center_odoo: data.Item?.cost_center_odoo || null
        };
    } catch (error) {
        console.error('Error fetching result IDs from DynamoDB:', error);
        throw new Error(`Failed to fetch result IDs from Dynamo for requestId: ${requestId}`);
    }
};


// Fetch required data from Odoo Accounting for reversal
const processJournalReversal = async (orderId, accountMoveId, costCenterOdoo) => {
    try {
        const accountResponse = await fetchAccountMovementOdoo(orderId, accountMoveId);
        let materials = [];

        materials.push({
            workOrderId: orderId,
            meanPrice: accountResponse.amount_total
        });
        
        const result = {
            workOrderId: orderId,
            costCenter: costCenterOdoo,
            material: materials.slice(0, 1)
        };

        return result;
    }catch (error){
        console.error('Error processing journal reversal:', error);
        throw new Error(`Failed to process journal reversal for order ${orderId}`);
    }
};


// Function to process Infraspeak data and return list of stock movement
const processWorkOrder = async (infraspeakData, costCenters, workOrderId, orderType, upserted, requestId) => {

    if (!infraspeakData || !infraspeakData.data || !infraspeakData.included) {
        throw new Error('Invalid response structure from Infraspeak API.');
    }

    const { cost_center_id: costCenterId = null, cost_center_name: costCenterName = null } = infraspeakData.data.attributes;
    let costCenterCode;

    if (costCenterId) {
        const result = costCenters.find(costCenter => costCenter.id === costCenterId.toString());
        costCenterCode = result?.code;
    }

    if (costCenterName && !costCenterCode) {
        const result = costCenters.find(costCenter => costCenter.name === costCenterName);
        costCenterCode = result?.code;
    }

    const costCenter = await getOdooCostCenterId(costCenterCode);
    const costCenterResponse = await saveCostCenterToDynamo(requestId, costCenter);

    // Separate materials and aggregate stock quantities by material_id
    const materials = infraspeakData.included.filter(({ type }) => type === 'material');
    
    // Create a map to aggregate stocks by material_id
    const stockMap = infraspeakData.included
        .filter(({ type }) => type === 'stock')
        .reduce((acc, stock) => {
            const materialId = stock.attributes.material_id;
            const quantity = stock.attributes.quantity || 0;

            if (!acc[materialId]) {
                acc[materialId] = { totalQuantity: 0, meanPrice: stock.attributes.mean_price };
            }
            acc[materialId].totalQuantity += quantity;
            return acc;
        }, {});

    try {
        const materialData = materials.map((material) => {
       
            const materialId = material?.attributes?.material_id;
            if (!materialId) {
                console.warn(`Material ID missing or invalid for work order ${workOrderId}`);
                return null;  // Skip this material if ID is invalid
            }

            const stock = stockMap[materialId] || { totalQuantity: 0, meanPrice: material.attributes.mean_price };

            const materialCode = material?.attributes?.code;
            if (!materialCode) {
                throw new Error('Material code is missing or invalid');
            }

            const fullCode = material?.attributes?.full_code;
            if (!fullCode) {
                throw new Error('Full code is missing or invalid');
            }

            const folderCode = fullCode.split('.')[0];
            if (!folderCode) {
                throw new Error('Folder code is missing or invalid');
            }

            return {
                workOrderId,
                materialId,
                materialCode,
                folderCode,
                quantity: stock.totalQuantity,
                meanPrice: stock.meanPrice
            };
        }).filter(Boolean);  // Filter out any null entries

        return {
            workOrderId,
            costCenter,
            material: materialData
        };
    } catch (error) {
        console.error(`Error preparing material data for order ${workOrderId}, ${error}`);
        throw new Error(`Error preparing material data for order ${workOrderId}, ${error}`);
    }
};


// save cost center id from odoo to dynamo
const saveCostCenterToDynamo = async (requestId, costCenter) => {
    const params = {
        TableName: tableName,
        Key: {
            request_id: requestId
        },
        UpdateExpression: 'SET cost_center_odoo = :costCenter',
        ExpressionAttributeValues: {
            ':costCenter': costCenter
        }
    };
    try {
        await dynamoDb.send(new UpdateCommand(params));
        console.log(`Successfully saved cost center to DynamoDB for request ID: ${requestId}`);
    } catch (error) {
        console.error('Error saving cost center to DynamoDB:', error);
    }
};


// Prepare data for posting - need stock id and quantity
const prepareInventoryPosting = async (processedWorkOrder, odooStock) => {
    try {
        let results = [];
        processedWorkOrder.forEach(workOrderItem => {
            let stock_id_odoo;
            let product_id_odoo;
            let location_id_odoo;
            let quantity_odoo;

            // Check if materialCode is valid
            if (!workOrderItem.materialCode) {
                throw new Error(`Material code is missing item: ${JSON.stringify(workOrderItem)}`);
            }

            const matchingProduct = odooStock.find(product => {
                const productReferenceString = product.product_id[1];
                const productReferenceCode = productReferenceString.match(/\[(.*?)\]/)[1];
  
                // Validate productReferenceCode
                if (!productReferenceCode) {
                    throw new Error(`Missing product_reference_code for product: ${JSON.stringify(product)}`);
                }

                // Match the product by reference code
                return productReferenceCode.trim().toUpperCase() === workOrderItem.materialCode.trim().toUpperCase();
            });
            
            // Check, if matching product was found
            if (matchingProduct) {
                stock_id_odoo = matchingProduct.id;
                product_id_odoo = matchingProduct.product_id[0];
                location_id_odoo = matchingProduct.location_id[0];
                quantity_odoo = matchingProduct.quantity;

                // Validate quantity
                const newQuantity = quantity_odoo - workOrderItem.quantity;
                if (newQuantity < 0) {
                    throw new Error(`Cannot post ${workOrderItem.quantity} for stock ID ${stock_id_odoo}. Odoo has ${quantity_odoo}.`);
                }

                results.push({
                    product_id: product_id_odoo,
                    location_id: location_id_odoo,
                    quantity: workOrderItem.quantity,
                    work_order_id: processedWorkOrder[0].workOrderId
                });
            } else {
                throw new Error(`No matching product found in Odoo for materialCode: ${workOrderItem.materialCode}`);
            }
        });
        if (results.length === 0) {
            throw new Error('No valid inventory data to post.');
        }
        return results;
        
    } catch (error) {
        console.error('Error preparing Inventory:', error);
        throw new Error(`Error preparing Inventory: ${error.message}`);
    }
};


// Post to Odoo Inventory and Odoo Accounting
const postToOdoo = async (inventoryData, accountingData, orderType, state, requestId) => {
    try {
        // Post to Odoo Inventory
        const responseInventory = await Promise.all(
            inventoryData.map(async (data) => {
                return await postOdooInventory(data, orderType, state);
            })
        );

        // Collect result IDs and log responses
        const inventoryResultIds = responseInventory.map((response, index) => {
            console.log(`Inventory response for item ${index + 1}:`, response);
            return response.result;
        });

        // Post to Odoo Accounting
        let responseAccounting = await postOdooAccounting(accountingData, accountingData.costCenter, orderType, state);
        console.log('responseAccounting', responseAccounting);

        // Save collected stock.move IDs and account.move ids to DynamoDB
        if (requestId && inventoryResultIds && responseAccounting.result) {
            await saveInventoryResponseToDynamo(requestId, inventoryResultIds, responseAccounting.result);
            await updateJournalFromDraftToDone(responseAccounting.result);
        } else {
            console.warn('Missing required data:', {requestId, inventoryResultIds, accountResultId});
        }

        return {
            inventory: responseInventory.map(response => response ? response.result : null),
            accounting: responseAccounting ? responseAccounting.result : null
        };
    } catch (error) {
        console.error('Error posting data to Odoo:', error);
        throw new Error(`Error posting data to Odoo: ${error.message}`);
    }
};


// Save list of odoo stock move ids to dynamo
const saveInventoryResponseToDynamo = async (requestId, inventoryResultIds, accountResultId) => {
    const params = {
        TableName: tableName,
        Key: {
            request_id: requestId
        },
        UpdateExpression: 'SET stock_move_ids = :newJournalResult, account_move_id = :newAccountResult',
        ExpressionAttributeValues: {
            ':newJournalResult': inventoryResultIds,
            ':newAccountResult': accountResultId
        }
    };
    try {
        await dynamoDb.send(new UpdateCommand(params));
        console.log(`Successfully saved result IDs to DynamoDB for: ${requestId}`);
    } catch (error) {
        console.error('Error saving result IDs to DynamoDB:', error);
    }
};


// Check if journal already posted
const fetchAccountMovementOdoo = async (orderId, moveId) => {
    const endpoint = '/web/dataset/call_kw/account.move/search_read';
    const params = {
        model: "account.move",
        method: "search_read",
        args: [],
        kwargs: {
            domain: [["id", "=", moveId]],
            fields: ["amount_total"]
        }
    };
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        
        if (response && response.result && response.result.length > 0) {
            return response.result[0];
        } else {
            console.error(`No account movement found for order ${orderId} and move id: ${moveId}`, error);
            throw new Error(`No account movement found for order ${orderId} and move id: ${moveId}`, error);
        }
    } catch (error) {
        console.error(`Error fetching account movement from Odoo for orderId ${orderId} and moveId ${moveId}`, error);
        throw new Error(`Error fetching account movement from Odoo for orderId ${orderId} and moveId ${moveId}`, error);
    }
};


// Update journal from draft to done
const updateJournalFromDraftToDone = async (moveId) => {
    const endpoint = '/web/dataset/call_kw/account.move/action_post';
    const params = {
        model: "account.move",
        method: "action_post",
        args: [[moveId]],
        kwargs: {}
    };
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        return response.result;
    } catch (error) {
        console.error(`Error updating journal to done: ${error}`);
        throw new Error(`Error updating journal to done: ${error.message}`);
    }
};


// Fetch stock movements by x_work_order_id and list of result IDs
const fetchStockMovementOdoo = async (orderId, resultIds) => {
    const endpoint = '/web/dataset/call_kw/stock.move/search_read';
    const params = {
        model: "stock.move",
        method: "search_read",
        args: [],
        kwargs: {
            domain: [
                ["x_work_order_id", "=", orderId],
                ["id", "in", resultIds]
            ],
            fields: ["x_work_order_id", "product_id", "quantity", "location_id", "location_dest_id"]
        }
    };
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        return response;
    }catch (error){
        console.error(`Error fetching stock movement from Odoo for orderId ${orderId}`, error);
        throw new Error(`Error fetching account movement from Odoo for orderId ${orderId}`, error);
    }
};


// Post stock adjustment to Odoo Inventory
const postOdooInventory = async (data, orderType, state) => {
    const status = state === "REVERSED" ? "Stock Move REVERSED": "Stock move"
    const locactionId = state === "REVERSED" ? locationDestId : data.location_id;
    const destinationId = state === "REVERSED" ? data.location_id : locationDestId;

    const endpoint = '/web/dataset/call_kw/stock.move/create';
    const params = {
        model: "stock.move",
        method: "create",
        args: [{
            product_id: data.product_id,
            location_id: locactionId,
            location_dest_id: destinationId,
            quantity: data.quantity,
            x_work_order_id: data.work_order_id,
            name: `${orderType} ${data.work_order_id} - ${status}`,
            state: 'done',
        }],
        kwargs: {}
    };
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        return response;
    }catch (error){
        console.error(`Error posting stock to Odoo for order ${data.work_order_id}`, error);
        throw new Error(`Error posting stock to Odoo for order ${data.work_order_id}`, error);
    }
};


// Post journal entry to Odoo Accounting               
const postOdooAccounting = async (accountingData, costCenterId, orderType, state) => {
    const endpoint = '/web/dataset/call_kw/account.move/create';
    const debitAccount = state === "REVERSED" ? costCenterId : accountIdInventories;
    const creditAccount = state === "REVERSED" ? accountIdInventories : costCenterId;
    let name;
    const materialLines = accountingData.material.map(material => {
        name = state === "REVERSED" 
        ? `${orderType} ${accountingData.workOrderId} REVERSED`
        : `${orderType} ${accountingData.workOrderId} - Ref: ${material.materialCode} (Qty: ${material.quantity})`;
        
        const amount = state === "REVERSED" ? material.meanPrice : material.meanPrice * material.quantity;

        return [
            [0, 0, { 
                account_id: debitAccount,
                name: name,
                debit: amount
            }],
            [0, 0, {
                account_id: creditAccount,
                name: name,                
                credit: amount
            }]
        ]
    }).flat();
    
    const params = {
            model: "account.move",
            method: "create",
            args: [{
                ref: name,
                move_type: "entry",
                journal_id: accountJournalId,
                line_ids: materialLines,
                x_work_order_id: accountingData.workOrderId,
            }],
        kwargs: {}
    };
    try {
        const response = await fetchRequestOdoo(endpoint, params);
        return response;
    }catch (error){
        console.error(`Error posting journal to Odoo for order ${accountingData.workOrderId}`, error);
        throw new Error(`Error posting stock to Odoo for order ${accountingData.workOrderId}`, error);
    }
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


// Fetch all Infraspeak Requests using pagination
const getInfraspeakRequests = async () => {
    let pageNumber = 1;
    let allRequests = [];
    
    try {
        while (true) {
            const endpoint = `requests?s_state_in=COMPLETED&s_related_to_type_in=FAILURE,SCHEDULE_WORK&s_type=MATERIAL_REQUEST&s_stock_consumed=true&limit=300&page=${pageNumber}`;
            const response = await fetchRequestInfraspeak(endpoint, 'GET');
            
            if (Array.isArray(response.data)){
                allRequests = allRequests.concat(response.data);
            }
        
            if (!response.links?.next) {
                break;
            }
            pageNumber++;
        }
        return allRequests;
    } catch (error) {
        console.error(`Error fetching Requests Infraspeak: ${error.message}`);
        throw new Error(`Error fetching Requests Infraspeak: ${error.message}`);
    }
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
const getCostCentersInfraspeak = async () => {
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
        throw new Error(`Error fetching cost center Infraspeak: ${error.message}`);
    }
};


// Function to perform fetch request to Infraspeak
const fetchRequestInfraspeak = async (endpoint, method) => {
    const url = `https://api.infraspeak.com/v3/${endpoint}`;
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
        fields: ["id", "code", "name"]
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


// Fetch stock quant IDs from Odoo for a specific product and location
const getOdooStockQuant = async (productId, locationId) => {
    const endpoint = '/web/dataset/call_kw/stock.quant/search_read';
    const params = {
        model: "stock.quant",
        method: "search_read",
        args: [],
        kwargs: {
            domain: [[ "warehouse_id", "!=", false]],
            //fields: ["quantity", "product_reference_code"]
            fields: []
        },
    };
    
    try {
        const response = await fetchRequestPaginateOdoo(endpoint, params);

        if (response && response.length > 0) {
            return response;
        } else {
            return [];
        }
    } catch (error) {
        console.error('Error fetching stock quant Id from Odoo:', error);
        throw new Error(`Error fetching stock Id from Odoo: ${error.message}`);
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
