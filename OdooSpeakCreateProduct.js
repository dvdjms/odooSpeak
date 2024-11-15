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
let INFRASPEAK_API_KEY, INFRASPEAK_EMAIL, ODOO_API_KEY, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, ODOO_ACCOUNT;

// Initialise secrets globally
const initializeSecrets = async () => {
    if (!secretsInitialized) {
        try {
            const secrets = await getSecrets();
            INFRASPEAK_API_KEY = secrets.INFRASPEAK_API_KEY;
            INFRASPEAK_EMAIL = ""
            ODOO_API_KEY = secrets.ODOO_API_KEY;
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
        
        // Step 1: Fetch data from both platforms
        const [stockOdoo, productsInfraspeak, warehousesInfraspeak] = await Promise.all([
            fetchStockOdoo(),
            fetchProductsInfraspeak(),
            fetchWarehousesInfraspeak()
        ]);

        // Step 2: Retrieve unmatched product codes
        const unmatchedProductCodes = await matchProductsBetweenPlatforms(stockOdoo, productsInfraspeak);
        
        // Step 3: Check if there are any unmatched product codes
        if (!unmatchedProductCodes || unmatchedProductCodes.length === 0) {
            return createResponse('No unmatched products to process.');
        }

        // Step 4: Retrieve product information from Odoo
        const productDetails = await getProductDetailsOdoo(stockOdoo, unmatchedProductCodes, warehousesInfraspeak);

        // Step 5: Retrieve folder id or create and retrieve new folder id
        const folderId = await createOrGetFolder(productDetails, productsInfraspeak);
        
        // Step 6: Create material
        const createdMaterial = await createMaterial(productDetails, folderId);

        // Step 7: Create stock movement
        const createStockResponse = await createStockMovement(createdMaterial.data.id, productDetails.quantity, productDetails.warehouseId);

        return createResponse(`Success! Product with code ${productDetails.productCode} has been added to Infraspeak`);
        
    } catch (error) {
        console.error('Error handling webhook event:', error);
        return createResponse('Error handling webhook event', 500);

    }
};


// Match products between platforms and return a list of unmatched products
// const matchProductsBetweenPlatforms = async (odooData, infraspeakData) => {
//     const normalizeCode = code => (typeof code === 'string' && code.trim() !== '') ? code.trim().toUpperCase() : '';
//     const odooDataList = [...new Set(odooData.map(product => normalizeCode(product.product_reference_code)))];
//     const infraspeakSet = new Set(
//         infraspeakData
//             .filter(product => product.attributes?.is_real === true)
//             .map(product => normalizeCode(product.attributes.code))
//     );
//     return odooDataList.filter(code => !infraspeakSet.has(code));
// };


const matchProductsBetweenPlatforms = async (odooData, infraspeakData) => {
    // Function to normalize codes, ensuring the input is a string before trimming
    const normalizeCode = code => {
        if (typeof code === 'string' && code.trim() !== '') {
            return code.trim().toUpperCase();
        } else {
            console.warn("normalizeCode: Invalid code encountered", code);
            return null;
        }
    };

    // Extract and normalize codes from odooData
    const odooDataList = [...new Set(
        odooData.map(product => {
            // Ensure product.product_id is defined and has a valid reference string
            if (product.product_id && product.product_id[1]) {
                const productReferenceString = product.product_id[1];
                const productReferenceCodeMatch = productReferenceString.match(/\[(.*?)\]/);
                const productReferenceCode = productReferenceCodeMatch ? productReferenceCodeMatch[1] : null;

                return normalizeCode(productReferenceCode);
            } else {
                console.warn("odooData: Missing product_id or reference string for product", product);
                return null;
            }
        }).filter(Boolean) // Filter out any null or undefined values
    )];

    // Create a Set of normalized codes from infraspeakData for fast lookup
    const infraspeakSet = new Set(
        infraspeakData
            .filter(product => product.attributes?.is_real === true)
            .map(product => {
                if (product.attributes && product.attributes.code) {
                    return normalizeCode(product.attributes.code);
                } else {
                    console.warn("infraspeakData: Missing or invalid attributes code for product", product);
                    return null;
                }
            })
            .filter(Boolean) // Filter out any null or undefined values
    );

    // Find products in odooData that are not present in infraspeakData
    return odooDataList.filter(code => code && !infraspeakSet.has(code));
};


// Function to get details of the first unmatched product
const getProductDetailsOdoo = async (odooData, productCodes, warehousesInfraspeak) => {
    if (!Array.isArray(productCodes) || productCodes.length === 0) {
        throw new Error("No product codes provided.");
    }
    if (!Array.isArray(odooData) || !warehousesInfraspeak) {
        throw new Error("Invalid Odoo data or Infraspeak warehouse data.");
    }
    
    let productDetails;
    let categoryCode;
    let stockDetails;
    let productCode = null;

    // Loop through productCodes to find the first valid product with necessary fields
    for (let code of productCodes) {
        // Find matching stock item by extracting the reference code from product_id
        stockDetails = odooData.find(stock => {
            const productReferenceString = stock.product_id && stock.product_id[1];
            const productReferenceCodeMatch = productReferenceString ? productReferenceString.match(/\[(.*?)\]/) : null;
            const productReferenceCode = productReferenceCodeMatch ? productReferenceCodeMatch[1] : null;
            return productReferenceCode && productReferenceCode.trim().toUpperCase() === code.trim().toUpperCase();
        });

        // If stockDetails exist, proceed to get further details
        if (stockDetails) {
            const productId = Array.isArray(stockDetails.product_id) ? stockDetails.product_id[0] : stockDetails.product_id;
            const categoryId = Array.isArray(stockDetails.product_categ_id) ? stockDetails.product_categ_id[0] : stockDetails.product_categ_id;

            try {
                productDetails = await fetchProductsOdoo(productId);
                categoryCode = await fetchCategoryOdoo(categoryId);
                
                if (!productDetails || !categoryCode) {
                    console.warn(`Skipping product with code ${code}. Missing product details or category code.`);
                    continue;
                }
                productCode = code;
                break;
            } catch (error) {
                console.warn(`Error fetching details for product code ${code}:`, error.message);
                continue;
            }
        } else {
            console.warn(`No stock details found for product code: ${code}`);
        }
    }

    // If no valid product found, throw an error
    if (!stockDetails || !productCode) {
        throw new Error('No valid product found with the necessary details.');
    }
    // Get the warehouse details for the selected product
    const warehouseCode = stockDetails.warehouse_id ? stockDetails.warehouse_id[1] : null;
    const warehouseDetails = warehousesInfraspeak.find(warehouse => 
        warehouse.attributes.full_code.toLowerCase().includes(warehouseCode.toLowerCase())
    );

    if (!warehouseDetails) {
        throw new Error(`No matching warehouse found for warehouseCode: ${warehouseCode}`);
    }

    // Return the product and warehouse details
    return {
        productCode: productCode.trim(),
        productName: productDetails.name.trim(),
        averageCost: productDetails.avg_cost,
        categoryName: productDetails.categ_id[1].trim(),
        categoryCode: categoryCode.trim().toUpperCase(),
        warehouseId: warehouseDetails.attributes.warehouse_id,
        quantity: stockDetails.quantity
    };
};


// Function to provide 'POST' parameter
const postToInfraspeak = async (endpoint, payload) => {
    return await fetchRequestInfraspeak(endpoint, "POST", payload);
};


// Function to create or retrieve a folder id from Infraspeak
const createOrGetFolder = async (productDetails, foldersInfraspeak) => {
    const folder = foldersInfraspeak.find(
        folder => folder.attributes?.is_real === false && folder.attributes.code === productDetails.categoryCode
    );
    if (folder) {
        return folder.id;
    }
    const infraspeakFolderResponse = await postToInfraspeak('materials', createFolderPayload(productDetails));
    return infraspeakFolderResponse.data.id;
};

        
// Function to create mateial in Infraspeak
const createMaterial = async (productDetails, folderId, warehouseId) => {
    const infraspeakMaterialResponse = await postToInfraspeak('materials', createMaterialPayload(productDetails, folderId, warehouseId));
    return infraspeakMaterialResponse;
};


// Function to create stock-movement in Infraspeak
const createStockMovement = async (materialid, quantity, warehouseId) => {
    const infraspeakMaterialResponse = await postToInfraspeak('stock-movements', createStockMovementPayload(materialid, quantity, warehouseId));
    return infraspeakMaterialResponse;
};


// Payload for Infraspeak folder
const createFolderPayload = (productDetails) => ({
    "_type": "FOLDER",
    "name": productDetails.categoryName,
    "code": productDetails.categoryCode,
    "observation": "",
    "mean_price": 0,
    "units": "",
    "material_warehouse": [{
        "warehouse_id": productDetails.warehouseId,
        "min_stock": 1,
        "mean_price": 0,
        "observation": "string"
    }],
    "default_sell_price": 0,
    "default_sell_vat": 0
});


// Payload for Infraspeak material
const createMaterialPayload = (productDetails, folderId, warehouseIds) => ({
    "_type": "MATERIAL",
    "name": productDetails.productName,
    "code": productDetails.productCode,
    "observation": "",
    "mean_price": productDetails.averageCost,
    "units": "un",
    "material_warehouse": [{
        "warehouse_id": productDetails.warehouseId,
        "min_stock": 1,
        "mean_price": productDetails.averageCost,
        "observation": "string"
    }],
    "parent_id": folderId,
    "default_sell_price": 0,
    "default_sell_vat": 0
});


// Payload for Infraspeak stock-movement
const createStockMovementPayload = (materialId, quantity, warehouseId) => ({
    "_type": "stock-movement",
    "action": "ADD",
    "warehouse_id": warehouseId,
    "observation": "string",
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


// Fetch warehouses from Infraspeak
const fetchWarehousesInfraspeak = async () => {
    try {
        const endpoint = `warehouses?s_is_real=true`;
        const response = await fetchRequestInfraspeak(endpoint, 'GET');
        return response.data;
    } catch (error) {
        console.error(`Error fetching warehouses`, error);
        return [];
    }
};


// Fetch product codes from Infraspeak
const fetchProductsInfraspeak = async () => {
    let pageNumber = 1;
    let allProducts = [];

    try {
        let hasNextPage = true;
        while (hasNextPage) {
            const endpoint = `materials/all?limit=1000&page=${pageNumber}`;
            const data = await fetchRequestInfraspeak(endpoint, 'GET');
            allProducts = allProducts.concat(data.data);
            hasNextPage = data.links?.next;
            pageNumber++;
        }
        return allProducts;
    } catch (error) {
        console.error(`Error fetching products from Infraspeak on page ${pageNumber}: ${error.message}`);
        throw error;
    }
};


// Function to fetch data from Infraspeak
const fetchRequestInfraspeak = async (endpoint, method, body = null) => {
    //const url = `https://api.sandbox.infraspeak.com/v3/${endpoint}`;
    const url = `https://api.infraspeak.com/v3/${endpoint}`;
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


// Fetch locations from Odoo
const fetchStockOdoo = async () => {
    const endpoint = '/web/dataset/call_kw/stock.quant/search_read';
    const params = {
        model: "stock.quant",
        method: "search_read",
        args: [],
        kwargs: {
            fields: ["product_id", "product_categ_id", "location_id", "warehouse_id", "quantity"],
            domain: [["warehouse_id", "!=", false]],
        }
    };
    const response = await fetchRequestOdooPage(endpoint, params);
    const validStock = response.filter(stock => stock.warehouse_id !== false);
    return validStock;
};


// Fetch products from Odoo.
const fetchProductsOdoo = async (productId) => {
    try {
        const endpoint = '/web/dataset/call_kw/product.product/search_read';
        const params = {
            model: "product.product",
            method: "search_read",
            args: [],
            kwargs: {
                domain: [["id", "=", productId]],
                fields: ["code", "name", "avg_cost", "free_qty", "stock_quant_ids", "categ_id"],
            }
        };
        const response = await fetchRequestPaginateOdoo(endpoint, params);
        if (!response.length) {
            throw new Error(`No product details found for product ID: ${productId}`);
        }
        return response[0];
    } catch (error) {
        console.error(`Failed to fetch product details for ID ${productId}: ${error.message}`);
        throw error;
    }
};


// Fetch category from Odoo.
const fetchCategoryOdoo = async (categoryId) => {
    const endpoint = '/web/dataset/call_kw/product.category/search_read';
    const params = {
        model: "product.category",
        method: "search_read",
        args: [],
        kwargs: {
            domain: [["id", "=", categoryId]],
            fields: ["x_studio_char_field_49j_1ibhepvhj"],
        }
    };
    const response = await fetchRequestPaginateOdoo(endpoint, params);
    return response[0].x_studio_char_field_49j_1ibhepvhj;
};


// Fetch request to Odoo - Pagination
const fetchRequestPaginateOdoo = async (endpoint, params) => {
    let allResults = [];
    let limit = 100;
    let offset = 0;
    let moreProducts = true;

    while (moreProducts) {
        const response = await fetchRequestOdooPage(endpoint, params, limit, offset);
        if (response && response.length > 0) {
            allResults = allResults.concat(response);
            offset += limit;
        } else {
            moreProducts = false;
        }
    }
    return allResults;
};


// Fetch request to Odoo - One page
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
            console.log('No product data found.');
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