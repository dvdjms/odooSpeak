/* global fetch */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_ID = 'odooSpeak/credentials';
const secretsManager = new SecretsManagerClient({ region: 'eu-west-2' });

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
let INFRASPEAK_API_KEY, ODOO_API_KEY, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, ODOO_ACCOUNT;

// Initialise secrets globally
const initializeSecrets = async () => {
    if (!secretsInitialized) {
        try {
            const secrets = await getSecrets();
            ODOO_API_KEY = secrets.ODOO_API_KEY;
            INFRASPEAK_API_KEY = secrets.INFRASPEAK_API_KEY;
            ODOO_DB = secrets.ODOO_DB;
            ODOO_LOGIN = secrets.ODOO_LOGIN;
            ODOO_PASSWORD = secrets.ODOO_PASSWORD;
            ODOO_ACCOUNT = secrets.ODOO_ACCOUNT;
            secretsInitialized = true;
        } catch (error) {
            throw new Error(`Failed to initialize secrets: ${error.message}`);
        }
    }
};


export const handler = async (event) => {
    try {
        await initializeSecrets();
        
        //Step 1: Fetch data from Odoo and Infraspeak
        const [stockOdoo, productsOdoo, materialInfraspeak, warehouseInfraspeak, warehouseQtyInfraspeak] = await Promise.all([
            fetchStockOdoo(),
            fetchProductsOdoo(),
            fetchMaterialInfraspeak(),
            fetchWarehouseInfraspeak(),
            fetchWarehouseQuantitiesInfraspeak()
        ]);
        //const [stockOdoo, productsOdoo, materialInfraspeak, warehouseInfraspeak, warehouseQtyInfraspeak] = await fetchSequentially();

        // Step 2: Process Odoo data
        const processedOdooData = await processOdooData(stockOdoo, productsOdoo, materialInfraspeak, warehouseInfraspeak);

        // Step 3: Check quantities and post accordingly
        const postedStock = await postStockToInfraspeak(processedOdooData, warehouseQtyInfraspeak);
        
        // Step 4: get a list of stock-movement Ids
        const stockMovementIds = postedStock.map(item => item.data.attributes.stock_movement_id);

        // Step 5: return status and message
        if (!stockMovementIds.length) {
            return createResponse('No stock quantity differences. Nothing to post', 200);
        }
        console.log('stockMovementIds', stockMovementIds)
        return createResponse(`Success! Stock-Movement Id(s): ${stockMovementIds}`, 200);
        
    } catch (error) {
        console.error('Error handling webhook event:', error);
        return createResponse('Error handling webhook event', 500);
    }
};


// Prepare Odoo data by combining stock and product data 
const processOdooData = async (stockOdoo, productsOdoo, materialInfraspeak, warehouseInfraspeak) => {

    if (!stockOdoo.length || !productsOdoo.length || !materialInfraspeak.length || !warehouseInfraspeak.length) {
        throw new Error('One or more input datasets are empty, unable to process Odoo data');
    }
    
    let result = [];
    
    // Create a Map for product stock_quants
    const productMap = new Map();
    for (let product of productsOdoo) {
        product.stock_quant_ids.forEach(stock_id => productMap.set(stock_id, product));
    }

    // Create a Map for materials using their product reference code (fast lookup)
    const materialMap = new Map(materialInfraspeak.map(material => [material.attributes?.code, material.id]));
    
    // Iterate through stockOdoo and retrieve product, material, and warehouse details
    for (let stock of stockOdoo) {
        const product = productMap.get(stock.id);
        if (!product) continue;

        const productReferenceString = stock.product_id[1];
        const productReferenceCode = productReferenceString.match(/\[(.*?)\]/)[1];

        const materialId = materialMap.get(productReferenceCode);
        if (!materialId) continue;

        // Perform partial matching for warehouse full_code using .includes()
        const warehouseCode = stock.warehouse_id ? stock.warehouse_id[1].toLowerCase() : null;
        const warehouseDetails = warehouseInfraspeak.find(warehouse => 
            warehouse.attributes.full_code.toLowerCase().includes(warehouseCode)
        );
        if (!warehouseDetails) continue;
  
        result.push({
            MaterialId: parseInt(materialId, 10),
            StandardCost: product.standard_price,
            AverageCost: product.avg_cost,
            WarehouseId: warehouseDetails.attributes.warehouse_id,
            AvailableQty: stock.quantity
        });
        
    }
    return result;
};


// Post stock quantities to Infraspeak
const postStockToInfraspeak = async (stockToPost, warehouseQtyInfraspeak) => {

    const postedResults = await Promise.all(stockToPost.map(async (warehouse) => {
        const materialId = warehouse.MaterialId;
        const averageCost = warehouse.AverageCost;
        //const standardCost = warehouse.StandardCost;
        const warehouseId = warehouse.WarehouseId;
        const quantityOdoo = warehouse.AvailableQty;
        
        try {
            if (materialId) {
                let quantityInfraspeak = await getMaterialQuantitiesFromInfraspeak(warehouseQtyInfraspeak, materialId, warehouseId);
                
                if (quantityInfraspeak){
                    if (quantityOdoo > quantityInfraspeak) {
                        const quantityToAdd = quantityOdoo - quantityInfraspeak;
                        console.log(`Adding ${quantityToAdd} of material ${materialId} to warehouse ${warehouseId}`);
                        return await fetchRequestInfraspeak("stock-movements", "POST", stockMovementPayloadAdd(materialId, quantityToAdd, warehouseId, averageCost));
                    } else if (quantityOdoo < quantityInfraspeak) {
                        const quantityToConsume = quantityInfraspeak - quantityOdoo;
                        console.log(`Consuming ${quantityToConsume} of material ${materialId} from warehouse ${warehouseId}`);
                        return await fetchRequestInfraspeak("stock-movements", "POST", stockMovementPayloadConsume(materialId, quantityToConsume, warehouseId, averageCost));
                    } else {
                        //console.log(`No stock movement needed for product code: ${materialId} in warehouse: ${warehouseId}`);
                        return null;
                    }
                }
                if (quantityInfraspeak === null || quantityInfraspeak === 0) {
                    console.log(`Adding ${quantityOdoo} of material ${materialId} to warehouse ${warehouseId}`);
                    return await fetchRequestInfraspeak("stock-movements", "POST", stockMovementPayloadAdd(materialId, quantityOdoo, warehouseId, averageCost));
                }
            } else {
                console.warn(`Material ID not found for product code: ${materialId}`);
                return null;
            }
        } catch (error) {
            console.error(`Failed to post stock for product code: ${materialId} in warehouse: ${warehouseId}`, error);
            return null;
        }
    }));
    return postedResults.filter(result => result !== null);
};


// Get material quantities from Infraspeak
const getMaterialQuantitiesFromInfraspeak = async (warehouseQuantitiesInfraspeak, materialId, warehouseId) => {
    let quantity = 0;

    try {
        if (!warehouseQuantitiesInfraspeak) {
            throw new Error('Invalid response from Infraspeak API');
        }
        // Iterate over quantities to check if the material exists in the warehouse
        for (let qty of warehouseQuantitiesInfraspeak) {
            if (qty.attributes?.material_id === materialId && qty.attributes?.warehouse_id === warehouseId) {
                quantity = parseInt(qty.attributes?.stock_quantity, 10);
                //console.log(`Found stock: ${quantity} for material ${materialId} in warehouse ${warehouseId}`);
                return quantity;
            }
        }
        //console.log(`Material ${materialId} not found in warehouse ${warehouseId}. Returning null.`);
        return null;
    } catch (error) {
        console.error("Error fetching material quantities from Infraspeak:", error);
        throw error;
    }
};


// Fetch all material-quantities from Infraspeak warehouses
const fetchWarehouseQuantitiesInfraspeak = async () => {
    let pageNumber = 1;
    let warehouseQuantities = [];
    
    while (true) {
        const endpoint = `warehouses/material-quantities?limit=1000&page=${pageNumber}`;
        const response = await fetchRequestInfraspeak(endpoint, 'GET');
        if (Array.isArray(response.data)) {
            warehouseQuantities = warehouseQuantities.concat(response.data);
        }
        
        if (!response.links?.next) {
            break;
        }
        pageNumber++;
    }
    //console.log('warehouseQuantities', warehouseQuantities);
    return warehouseQuantities;
};

// Fetch all warehouses from Infraspeak where is_real equals true
const fetchWarehouseInfraspeak = async () => {
    const endpoint = `warehouses?s_is_real=true`;
    
    try {
        const response = await fetchRequestInfraspeak(endpoint, "GET");

        if (!response || !response.data) {
            throw new Error("Invalid response from API");
        }
        //console.log("response Infraspeak", response)
        return response.data;
    } catch (error) {
        console.error("Error fetching warehouses:", error);
        throw error;
    }
};


// Fetch all material from Infraspeak
const fetchMaterialInfraspeak = async () => {
    let pageNumber = 1;
    let materialAll = [];
    
    while (true) {
        const endpoint = `materials/all?s_is_real=true&limit=1000&page=${pageNumber}`;

        const response = await fetchRequestInfraspeak(endpoint, "GET");
        if (Array.isArray(response.data)) {
            materialAll = materialAll.concat(response.data);
        }
        
        if (!response.links?.next) {
            break;
        }
        pageNumber++;
    }
    return materialAll;
};


// Payload for stock-movements (add) endpoint
const stockMovementPayloadAdd = (materialId, quantity, warehouseId, averageCost) => ({
    "_type": "stock-movement",
    "action": "ADD",
    "warehouse_id": warehouseId,
    "mean_price": averageCost,
    "stocks": [
        {
           "material_id": materialId,
           "quantity": quantity
        }
    ]
});


// Payload for stock-movements (abate) endpoint
const stockMovementPayloadConsume = (materialId, quantity, warehouseId, averageCost) => ({
    "_type": "stock-movement",
    "action": "ABATE",
    "warehouse_id": warehouseId,
    "mean_price": averageCost,
    "stocks": [
        {
           "material_id": materialId,
           "quantity": quantity
        }
    ]
});


// Create a return response
const createResponse = (message, statusCode = 200) => {
    return {
        statusCode: statusCode,
        body: JSON.stringify({
            message: message,
        }),
    };
};


// Fetch stock data from Odoo, and filter out entries where warehouse_id is false
const fetchStockOdoo = async () => {
    const endpoint = '/web/dataset/call_kw/stock.quant/search_read';
    const params = {
        model: "stock.quant",
        method: "search_read",
        args: [],
        kwargs: {
            fields: ["id", "product_id", "warehouse_id", "quantity"],
            domain: [["warehouse_id", "!=", false]],
        }
    };
    const response = await fetchRequestOdooPage(endpoint, params);
    console.log('Fetch stock odoo response', response)
    return response;
};


// Fetch and create list od product codes.
const fetchProductsOdoo = async () => {
    const endpoint = '/web/dataset/call_kw/product.product/search_read';
    const params = {
        model: "product.product",
        method: "search_read",
        args: [],
        kwargs: {
            fields: ["code", "name", "standard_price", "avg_cost", "free_qty", "stock_quant_ids"],
            domain: [["stock_quant_ids", "!=", false]],
        }
    };
    const response = await fetchRequestPaginateOdoo(endpoint, params);
    return response;
};


// Function to fetch all products from Infraspeak
const fetchRequestInfraspeak = async (endpoint, method, body = null) => {
    const url = `https://api.infraspeak.com/v3/${endpoint}`;
    //const url = `https://api.sandbox.infraspeak.com/v3/${endpoint}`;

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${INFRASPEAK_API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': 'InfraspeakToUnleashedStockLevels (splk.sandbox@infraspeak.com)'
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }catch (error) {
        console.error(`Error ${method}ing to Infraspeak:`, error);
        throw error;
    }
};


// Function to handle pagination and fetch all items
const fetchRequestPaginateOdoo = async (endpoint, params) => {
    let allResults = [];
    let limit = 500;
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
    
    const body = {
        jsonrpc: "2.0",
        method: "call",
        params: params,
        id: Math.floor(Math.random() * 1000)
    };
    
    try {
        const response = await fetchRequestOdoo(endpoint, body);

        if (response && response.result && response.result.length > 0) {
            return response.result;
        } else {
            return [];
        }
    } catch (error) {
        console.error('Error fetching products:', error);
    }
};


// Fetch request to Odoo
const fetchRequestOdoo = async (endpoint, body) => {
    try {
        const baseUrl = `https://${ODOO_ACCOUNT}.odoo.com`;
        const sessionId = await authenticateOdoo(baseUrl);

        const response = await fetch(`${baseUrl}${endpoint}`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'cookie': `session_id=${sessionId}`,
            },
            body: JSON.stringify(body) 
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('HTTP Error:', response.status, errorText);
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error:', error);
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
