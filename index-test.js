const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');
const moment = require('moment-timezone');  // Use moment-timezone for accurate timezone handling
const cors = require('cors');
const { format, parseISO, addDays } = require('date-fns');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');


dotenv.config();

const app = express();
const port = 3020;

// SQL Configuration
const dbConfig = {
    user: 'sa',
    password: 'rmparks@123', // Replace with your actual password
    server: '10.10.112.21', // The server name before the backslash
    port: 1433, // Port specified after the comma in Data Source
    database: 'ONLINE_BANK', // Replace with your actual database name
    options: {
        encrypt: false, // Adjust based on your server setup; typically false for on-prem servers
        trustServerCertificate: true, // Allow self-signed certificates
    },
};

// Set up Winston for logging with daily rotation
const logTransport = new DailyRotateFile({
    filename: 'logs/app-%DATE%.log',  // Creates logs in a 'logs' directory with the current date as part of the filename
    datePattern: 'YYYY-MM-DD',        // Date format for the log filename
    zippedArchive: true,              // Compress archived logs
    maxSize: '20m',                   // Maximum size for each log file before rotation (20MB)
    maxFiles: '14d',                  // Retain log files for the past 14 days
});

const logger = winston.createLogger({
    level: 'info',
    transports: [
        logTransport,                    // Logs to daily rotated files
        new winston.transports.Console({ format: winston.format.simple() })  // Optional: log to console
    ],
    format: winston.format.combine(
        winston.format.timestamp(),      // Add timestamp to each log entry
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
});


let lastCheckedDate = null;  // Keep track of the last checked date to trigger holiday checks only once a day

let cachedHolidays = {
    'LK': {},  // Sri Lanka
    'MV': {},  // Maldives
};

// Helper function to check if today is a new day
function isNewDay() {
    const sriLankaDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
    if (sriLankaDate !== lastCheckedDate) {
        lastCheckedDate = sriLankaDate;
        return true;
    }
    return false;
}

// Function to fetch holiday data from CALENDARIFIC API
async function fetchHolidayData(countryCode, date) {
    try {
        const year = date.year();
        const month = date.month() + 1;
        const day = date.date();

        const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        const response = await axios.get(url);
        
        // Store the holiday data for the country to avoid redundant API calls
        cachedHolidays[countryCode] = response.data.response.holidays.map(holiday => holiday.date.iso);
        console.log(`Fetched holidays for ${countryCode} on ${date.format('YYYY-MM-DD')}`);
        logger.info(`Fetched holidays for ${countryCode} on ${date.format('YYYY-MM-DD')}`);
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode}:`, error);
        logger.error(`Error fetching holidays for ${countryCode}: ${error.message}`);
    }
}

// Function to check if a given date is a holiday for a country
function isHoliday(date, countryCode) {
    const dateString = date.format('YYYY-MM-DD');
    if (!cachedHolidays[countryCode]) {
        return false;  // Return false if holidays have not been fetched for this country yet
    }
    return cachedHolidays[countryCode].includes(dateString);
}

// Store transactions depending on system holiday status
async function storeTransactions(transactionData) {
    if (!Array.isArray(transactionData) || transactionData.length === 0) {
        console.error("No transactions to process.");
        return;
    }

    for (const transaction of transactionData) {
        const transactionDataItems = transaction.items;  // Transaction details are in 'items'

        const transCode = generateTransCode();
        const collectionAcc = 'hsbc';
        const bankCode = 'HSBC';
        const branchCode = '7092001';
        const custAcc = transactionDataItems.transactionInformation.split('/')[2].slice(0, 6);  // Extract first 6 digits
        const payCca = 'R001';
        const cOrD = transactionDataItems.creditDebitIndicator;
        const bankTransRef = transactionDataItems.transactionReference;
        const bankDate = transactionDataItems.valueDateTime;
        const amount = transactionDataItems.transactionAmount.amount;
        const dipstrName = null;

        // Check if it's a system holiday in either LK or MV
        const systemHoliday = await isSystemHoliday(bankDate);

        if (systemHoliday) {
            // If it's a system holiday, get the next system working date
            const nextSystemWorkingDate = await getNextSystemWorkingDate(moment(bankDate));
            
            // Insert into Transactions_NonBusinessDates table with the next system working date
            await insertTransactionNonBusinessDate({
                transCode,
                collectionAcc,
                bankCode,
                branchCode,
                custAcc,
                payCca,
                cOrD,
                bankTransRef,
                bankDate,
                amount,
                dipstrName,
                nextSystemWorkingDate,
                reasonForNonBusinessDate: 'System Holiday'
            });
            logger.info(`Inserted transaction into Transactions_NonBusinessDates for ${transCode}`);
        } else {
            // Insert into Transactions_TMP table with the bankDate
            await insertTransaction({
                transCode,
                collectionAcc,
                bankCode,
                branchCode,
                custAcc,
                payCca,
                cOrD,
                bankTransRef,
                bankDate,
                amount,
                dipstrName
            });
            logger.info(`Inserted transaction into Transactions_TMP for ${transCode}`);
        }
    }
}










// Load PGP keys from specified file paths
async function loadPGPKey(filePath) {
    try {
        const fullPath = `./encryption/${filePath}`;
        const key = await fs.readFile(fullPath, 'utf8');
        return key;
    } catch (error) {
        console.error(`Error loading PGP key from ${filePath}:`, error);
        throw error;
    }
}

// Sign and encrypt the payload with OpenPGP
async function signAndEncryptData(data, clientPrivateKeyArmored, hsbcPublicKeyArmored, passphrase) {
    const privateKey = await openpgp.decryptKey({
        privateKey: await openpgp.readPrivateKey({ armoredKey: clientPrivateKeyArmored }),
        passphrase,
    });
    const publicKey = await openpgp.readKey({ armoredKey: hsbcPublicKeyArmored });

    const message = await openpgp.createMessage({ text: data });
    const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: publicKey,
        signingKeys: privateKey,
    });

    // Return the encrypted data as a base64 encoded string
    return Buffer.from(encrypted).toString('base64');
}

// Use Flask server to decrypt data
async function decryptWithPython(encryptedData) {
    try {
        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf-8');
        const response = await axios.post('http://localhost:5000/decrypt', {
            data: decodedData
        });

        console.log('Decrypted Response:', JSON.stringify(response.data, null, 2)); // Log the full decrypted data
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}


// Fetch transactions from HSBC with signing and encryption
// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    const clientPrivateKey = await loadPGPKey('client-private.pem');
    const hsbcPublicKey = await loadPGPKey('hsbc-public.pem');
    const passphrase = '1password';

    const requestData = JSON.stringify({
        transactionDate,
        accountNumber: "339200000005",
        accountCountry: "GB",
    });

    const encryptedRequestData = await signAndEncryptData(requestData, clientPrivateKey, hsbcPublicKey, passphrase);

    const response = await axios.post(
        `${process.env.BANK_API_URL}/transactions`,
        { transactionsRequestBase64: encryptedRequestData },
        {
            headers: {
                'Content-Type': 'application/json',
                'x-hsbc-client-id': process.env.CLIENT_ID,
                'x-hsbc-client-secret': process.env.CLIENT_SECRET,
                'x-hsbc-profile-id': process.env.PROFILE_ID,
                'x-report-type': 'JSON',
                'x-sort-order': 'DESC',
            },
        }
    );

    // Decrypt and log the response to check its structure
    const transactions = await decryptWithPython(response.data.reportBase64);
    console.log('Decrypted Transactions:', transactions); // Log the structure
    logger.info(`Fetched transactions for ${transactionDate}: ${transactions.length} transactions`);

    // Access the transaction data
    const transactionData = transactions.transactions.transaction || []; // Fallback to empty array if no transactions

    // Check if the result is an array
    if (!Array.isArray(transactionData)) {
        throw new Error('Decrypted data is not an array or is missing');
    }

    return transactionData; // Return the array of transactions
}


function generateTransCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        code += chars[randomIndex];
    }
    return code;
}


// Function to insert transaction into Transactions_TMP table
async function insertTransaction(transaction) {
    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('TRANS_CODE', sql.NVarChar, transaction.transCode)
            .input('COLLECTION_AC', sql.NVarChar, transaction.collectionAcc)
            .input('BANK_CODE', sql.NVarChar, transaction.bankCode)
            .input('BRANCH_CODE', sql.NVarChar, transaction.branchCode)
            .input('CUST_AC', sql.NVarChar, transaction.custAcc)
            .input('PAY_CCA', sql.NVarChar, transaction.payCca)
            .input('C_OR_D', sql.NVarChar, transaction.cOrD)
            .input('BANK_TRANS_REF', sql.NVarChar, transaction.bankTransRef)
            .input('BANK_DATE', sql.DateTime, transaction.bankDate)
            .input('AMOUNT', sql.Decimal(18, 2), transaction.amount)
            .input('DIPSTR_NAME', sql.NVarChar, transaction.dipstrName)
            .query('INSERT INTO Transactions_TMP (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME) VALUES (@TRANS_CODE, @COLLECTION_AC, @BANK_CODE, @BRANCH_CODE, @CUST_AC, @PAY_CCA, @C_OR_D, @BANK_TRANS_REF, @BANK_DATE, @AMOUNT, @DIPSTR_NAME)');
    } catch (error) {
        console.error('Error inserting transaction into Transactions_TMP:', error);
    }
}

// Function to insert transaction into Transactions_NonBusinessDates table
async function insertTransactionNonBusinessDate(transaction) {
    try {
        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('TRANS_CODE', sql.NVarChar, transaction.transCode)
            .input('COLLECTION_AC', sql.NVarChar, transaction.collectionAcc)
            .input('BANK_CODE', sql.NVarChar, transaction.bankCode)
            .input('BRANCH_CODE', sql.NVarChar, transaction.branchCode)
            .input('CUST_AC', sql.NVarChar, transaction.custAcc)
            .input('PAY_CCA', sql.NVarChar, transaction.payCca)
            .input('C_OR_D', sql.NVarChar, transaction.cOrD)
            .input('BANK_TRANS_REF', sql.NVarChar, transaction.bankTransRef)
            .input('BANK_DATE', sql.DateTime, transaction.bankDate)
            .input('AMOUNT', sql.Decimal(18, 2), transaction.amount)
            .input('DIPSTR_NAME', sql.NVarChar, transaction.dipstrName)
            .input('NEXT_SYSTEM_WORKING_DATE', sql.Date, transaction.nextSystemWorkingDate)
            .input('REASON_FOR_NON_BUSINESS_DATE', sql.NVarChar, transaction.reasonForNonBusinessDate)
            .query('INSERT INTO Transactions_NonBusinessDates (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME, NEXT_SYSTEM_WORKING_DATE, REASON_FOR_NON_BUSINESS_DATE) VALUES (@TRANS_CODE, @COLLECTION_AC, @BANK_CODE, @BRANCH_CODE, @CUST_AC, @PAY_CCA, @C_OR_D, @BANK_TRANS_REF, @BANK_DATE, @AMOUNT, @DIPSTR_NAME, @NEXT_SYSTEM_WORKING_DATE, @REASON_FOR_NON_BUSINESS_DATE)');
    } catch (error) {
        console.error('Error inserting transaction into Transactions_NonBusinessDates:', error);
    }
}


// Check if today is a holiday for both Sri Lanka (LK) and Maldives (MV)
async function isSystemHoliday(date) {
    // Ensure date is a moment object
    const momentDate = moment(date);  // Convert to moment if not already

    const sriLankaDate = momentDate.tz('Asia/Colombo').format('YYYY-MM-DD');
    const maldivesDate = momentDate.tz('Indian/Maldives').format('YYYY-MM-DD');

    const isSriLankaHoliday = cachedHolidays['LK'].includes(sriLankaDate);
    const isMaldivesHoliday = cachedHolidays['MV'].includes(maldivesDate);

    // Log the holiday status for Sri Lanka and Maldives
    logger.info(`Holiday check for ${momentDate.format('YYYY-MM-DD')}: Sri Lanka holiday = ${isSriLankaHoliday}, Maldives holiday = ${isMaldivesHoliday}`);

    // Determine and log whether it is a system holiday
    if (isSriLankaHoliday || isMaldivesHoliday) {
        logger.info(`System holiday on ${momentDate.format('YYYY-MM-DD')} due to ${isSriLankaHoliday ? 'Sri Lanka' : 'Maldives'} holiday.`);
        return true;
    } else {
        logger.info(`No system holiday on ${momentDate.format('YYYY-MM-DD')}`);
        return false;
    }
}







// Helper function to check if the bank is working on a given day
function isBankWorking(date, holidays, weekendDays) {
    const day = date.day();
    const isWeekend = weekendDays.includes(day);
    const isHoliday = holidays.includes(date.format('YYYY-MM-DD'));
    return !isWeekend && !isHoliday;
}


// Function to get the next system working date
async function getNextSystemWorkingDate(date) {
    let nextWorkingDate = moment(date).add(1, 'days');

    while (await isSystemHoliday(nextWorkingDate)) {
        nextWorkingDate = nextWorkingDate.add(1, 'days');
    }

    return nextWorkingDate.format('YYYY-MM-DD');
}


// Fetch the holiday list from Calendarific API for the given country
async function getHolidayList(countryCode, date) {
    try {
        const year = date.year();
        const month = date.month() + 1;
        const day = date.date();

        const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        const response = await axios.get(url);
        return response.data.response.holidays.map(holiday => holiday.date.iso);
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode}:`, error);
        return [];
    }
}




app.use(cors());

//Fetch transaction information from the tra table
app.get('/transactions', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig); // Connect to the database using `dbConfig`

        // Query to fetch transactions
        const result = await pool.request().query(`
            SELECT 
                TRANS_CODE AS id,
                BANK_TRANS_REF AS transactionReference,
                CUST_AC AS transactionInformation,
                AMOUNT AS amount,
                C_OR_D AS creditDebitIndicator,
                BANK_DATE AS valueDateTime
            FROM Transactions_TMP
        `);

        // Respond with the fetched data
        res.json({ transactions: result.recordset });
        await pool.close(); // Close the database connection
    } catch (error) {
        console.error('Error fetching transactions for the frontend:', error);
        res.status(500).json({ error: 'Failed to fetch transactions from the database.' });
    }
});



// Fetch transaction information from the Transactions_NonBusinessDates table
app.get('/holiday-transactions', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig); // Connect to the database using `dbConfig`

        // Query to fetch transactions from the Transactions_NonBusinessDates table
        const result = await pool.request().query(`
            SELECT 
                TRANS_CODE AS id,
                BANK_TRANS_REF AS transactionReference,
                CUST_AC AS transactionInformation,
                AMOUNT AS amount,
                C_OR_D AS creditDebitIndicator,
                BANK_DATE AS valueDateTime,
                NEXT_SYSTEM_WORKING_DATE As nextSystemWorkingDate
            FROM Transactions_NonBusinessDates
        `);

        // Respond with the fetched data
        res.json({ transactions: result.recordset });
        await pool.close(); // Close the database connection
    } catch (error) {
        console.error('Error fetching non-business date transactions for the frontend:', error);
        res.status(500).json({ error: 'Failed to fetch non-business date transactions from the database.' });
    }
});


// API Endpoint to Fetch Transactions
app.get('/get-all-transactions', async (req, res) => {
    const transactionDate = req.query.date;
    if (!transactionDate) {
        return res.status(400).json({ error: "Missing 'date' query parameter in YYYY-MM-DD format." });
    }

    try {
        // Fetch transactions from HSBC for the specified date
        logger.info(`Fetching transactions for date: ${transactionDate}`);
        const transactionsData = await fetchTransactions(transactionDate);

        // Check for system holiday date and insert accordingly
        const systemHolidayDate = await getNextSystemWorkingDate(moment(transactionDate));
        await storeTransactions(transactionsData, systemHolidayDate);

        // Return the transactions data to the client
        res.json(transactionsData);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to retrieve transactions due to server error.' });
    }
});

// Set an interval to check if it's a new day and call the API for transactions
setInterval(async () => {
    const today = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
    logger.info(`Checking transactions for ${today}`);

    // Always call get-all-transactions every minute
    try {
        const response = await axios.get(`http://localhost:3020/get-all-transactions?date=${today}`);
        console.log(`Transactions for ${today}:`, response.data);  // Handle the response as needed
        logger.info(`Transactions for ${today}: ${response.data.length} transactions`);
    } catch (error) {
        console.error('Error calling get-all-transactions API:', error);
    }

    // If it's a new day, optimize by calling the CALENDARIFIC API
    if (isNewDay()) {
        try {
            // Fetch holiday data for Sri Lanka and Maldives
            logger.info("New day detected, fetching holiday data...");
            await fetchHolidayData('LK', moment());
            await fetchHolidayData('MV', moment());
        } catch (error) {
            console.error('Error fetching holiday data:', error);
        }
    }
}, 1 * 60 * 1000); // Check every minute (60000 ms)

// Start Express server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    logger.info(`Server running on http://localhost:${port}`);
});