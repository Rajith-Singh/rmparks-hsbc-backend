const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');
const moment = require('moment');
const cors = require('cors');
const path = require('path');
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

let isTodayHoliday = false;  // Flag to store holiday status

const holidayCache = {};  // Store cached holiday info (by date)
const nextWorkingDateCache = {};  // Cache next working date (by date)

// Set up Winston logger with daily rotation
const transport = new DailyRotateFile({
    filename: path.join(__dirname, 'logs', '%DATE%-app.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d'
});

// Create a logger instance
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
    ),
    transports: [
        transport,
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'error.log'), level: 'error' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ],
});


// Store transactions depending on system holiday status
async function storeTransactions(response) {
    // Ensure the response contains a valid array of transactions
    if (!Array.isArray(response) || response.length === 0) {
        console.error("No transactions to process.");
        logger.warn("No transactions to process.");
        return;
    }

    for (const transaction of response) {
        const transactionData = transaction.items;  // Transaction details are in 'items'

        // Extract the relevant fields from the transactionData
        const transCode = generateTransCode();  // Assuming you have a function that generates the trans code
        const collectionAcc = 'hsbc';
        const bankCode = 'HSBC';
        const branchCode = '7092001';
        const custAcc = transactionData.transactionInformation.split('/')[2].slice(0, 6);  // Extract first 6 digits from transactionInformation
        const payCca = 'R001';
        const cOrD = transactionData.creditDebitIndicator;  // 'C' or 'D'
        const bankTransRef = transactionData.transactionReference;
        const bankDate = transactionData.valueDateTime;  // Date in YYYY-MM-DD format
        const amount = transactionData.transactionAmount.amount;  // Transaction amount
        const dipstrName = null;  // Set to null as required

        // If today is a system holiday, get the next system working date
        const systemHoliday = isTodayHoliday;
        
        try {
            // Check if the transaction reference already exists in the database
            const existingTransaction = await checkTransactionExists(bankTransRef);
            
            if (existingTransaction) {
                // Log the duplicate reference and skip inserting the transaction
                logger.warn(`Transaction with reference ${bankTransRef} already exists. Skipping insertion.`);
                continue; // Skip to the next transaction
            }

            const systemHoliday = isTodayHoliday;
            
            if (systemHoliday) {
                logger.info(`Today is a system holiday. Storing transaction for non-business date.`);
                const nextSystemWorkingDate = await getNextSystemWorkingDate(moment(bankDate));

                // Log the transaction insertion for non-business date
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

                logger.info(`Transaction for ${bankTransRef} stored for non-business date with next working date: ${nextSystemWorkingDate}`);
            } else {
                logger.info(`Today is a working day. Storing transaction for business date.`);
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

                logger.info(`Transaction for ${bankTransRef} stored successfully.`);
            }
        } catch (error) {
            // Check if the error is a duplicate key violation
            if (error.originalError && error.originalError.message.includes("Violation of UNIQUE KEY constraint")) {
                logger.error(`Duplicate transaction reference found: ${bankTransRef}. Skipping insertion.`);
            } else {
                // Handle other errors
                logger.error(`Error storing transaction for ${transactionData.transactionReference}: ${error.message}`);
            }
        }
    }
}

// Function to check if a transaction reference exists in the database
async function checkTransactionExists(transactionReference) {
    try {
        // Assuming you're using mssql to query the database
        const pool = await sql.connect(config);  // Ensure you have your SQL config
        const result = await pool.request()
            .input('transactionReference', sql.NVarChar, transactionReference)  // Assuming the type of the reference is NVarChar
            .query('SELECT COUNT(*) AS count FROM Transactions_TMP WHERE transactionReference = @transactionReference');
        
        if (result.recordset[0].count > 0) {
            return true;  // Transaction already exists
        }
        return false;  // Transaction does not exist
    } catch (error) {
        logger.error(`Error checking if transaction reference ${transactionReference} exists: ${error.message}`);
        return false;  // In case of error, assume the transaction does not exist
    }
}


// Initial holiday check on server startup
async function initialHolidayCheck() {
    try {
        const today = moment().format('YYYY-MM-DD');
        isTodayHoliday = await isSystemHoliday(today);  // Check if today is a holiday
        console.log(isTodayHoliday ? `Today is a system holiday: ${today}` : `Today is a working day: ${today}`);
        
        // Start handling transactions after the holiday check
        startTransactionHandling();
    } catch (error) {
        console.error('Error during initial holiday check:', error);
    }
}

// Function to fetch transactions for the current date
async function fetchTransactionsForToday() {
    try {
        const today = moment().format('YYYY-MM-DD');  // Get today's date in 'YYYY-MM-DD' format
        const apiUrl = `http://localhost:3020/get-all-transactions?date=${today}`;

        // Call the API
        const response = await axios.get(apiUrl);

        console.log('Transactions fetched successfully:', response.data);
    } catch (error) {
        console.error('Error fetching transactions for today:', error);
    }
}


// Start the periodic transaction handling
async function startTransactionHandling() {
    // Call fetchTransactionsForToday immediately to start handling transactions
    fetchTransactionsForToday();

    // Set interval to call fetchTransactionsForToday every 5 minutes (300,000 milliseconds)
    setInterval(fetchTransactionsForToday, 5 * 60 * 1000);
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
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}

// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    logger.info(`Started fetching transactions for ${transactionDate}`);
    const clientPrivateKey = await loadPGPKey('client-private.pem');
    const hsbcPublicKey = await loadPGPKey('hsbc-public.pem');
    const passphrase = '1password';

    const requestData = JSON.stringify({
        transactionDate,
        accountNumber: "339200000005",
        accountCountry: "GB",
    });

    const encryptedRequestData = await signAndEncryptData(requestData, clientPrivateKey, hsbcPublicKey, passphrase);
    logger.info(`Successfully encrypted request data for ${transactionDate}`);

    
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

    // Log response details
    logger.info(`Received response from HSBC for ${transactionDate}`);

    // Decrypt and log the response to check its structure
    const transactions = await decryptWithPython(response.data.reportBase64);
    console.log('Decrypted Transactions:', transactions); // Log the structure
    logger.info(`Decrypted transactions successfully for ${transactionDate}`);

    // Ensure we're accessing the correct array (transactions.transaction)
    const transactionData = transactions.transactions.transaction || []; // Fallback to empty array if no transactions

    // Check if the result is an array
    if (!Array.isArray(transactionData)) {
        throw new Error('Decrypted data is not an array or is missing');
    }

    return transactionData;
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
            .input('NEXT_SYSTEM_WORKING_DATE', sql.DateTime, transaction.nextSystemWorkingDate)
            .input('REASON_FOR_NON_BUSINESS_DATE', sql.NVarChar, transaction.reasonForNonBusinessDate)
            .query('INSERT INTO Transactions_NonBusinessDates (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME, NEXT_SYSTEM_WORKING_DATE, REASON_FOR_NON_BUSINESS_DATE) VALUES (@TRANS_CODE, @COLLECTION_AC, @BANK_CODE, @BRANCH_CODE, @CUST_AC, @PAY_CCA, @C_OR_D, @BANK_TRANS_REF, @BANK_DATE, @AMOUNT, @DIPSTR_NAME, @NEXT_SYSTEM_WORKING_DATE, @REASON_FOR_NON_BUSINESS_DATE)');
    } catch (error) {
        console.error('Error inserting transaction into Transactions_NonBusinessDates:', error);
    }
}


// Function to check if the date is a system holiday
async function isSystemHoliday(date) {
    logger.info(`Checking if ${date} is a system holiday...`);
    // Ensure that `date` is a moment object
    if (!moment.isMoment(date)) {
        date = moment(date);  // Convert to moment if it's not already
    }

    // Fetch Maldives and Sri Lanka holidays from the API
    const maldivesHolidays = await getHolidayList('MV', date);
    const sriLankaHolidays = await getHolidayList('LK', date);

    // Maldives weekend is Friday (5) and Saturday (6)
    const maldivesWeekend = [5, 6];
    // Sri Lanka weekend is Saturday (6) and Sunday (0)
    const sriLankaWeekend = [6, 0];

    // Check if each bank is working
    const maldivesWorking = isBankWorking(date, maldivesHolidays, maldivesWeekend);
    const sriLankaWorking = isBankWorking(date, sriLankaHolidays, sriLankaWeekend);

    // Log whether either bank is working
    logger.info(`Maldives bank working: ${maldivesWorking}`);
    logger.info(`Sri Lanka bank working: ${sriLankaWorking}`);

    // System holiday if both banks are not working
    return !(maldivesWorking || sriLankaWorking);
    logger.info(`Date ${date} is ${holidayStatus ? 'a system holiday' : 'a working day'}`);
}


// Function to check if a bank is working (not a holiday or weekend)
function isBankWorking(date, holidays, weekendDays) {
    const day = date.day(); // Get the day of the week (0=Sunday, 6=Saturday)
    const isWeekend = weekendDays.includes(day);
    const isHoliday = holidays.includes(date.format("YYYY-MM-DD"));
    return !isWeekend && !isHoliday;
}



// Function to get the next system working date
async function getNextSystemWorkingDate(date) {
    logger.info(`Fetching the next system working date from ${date}`);
    let nextWorkingDate = moment(date).add(1, 'days'); // Start with the next day

    try {
        // Iterate until a system working date is found
        while (await isSystemHoliday(nextWorkingDate)) {
            logger.info(`Skipping ${nextWorkingDate.format('YYYY-MM-DD')}: It's a system holiday`);
            nextWorkingDate = nextWorkingDate.add(1, 'days');
        }

        logger.info(`Next system working date is: ${nextWorkingDate.format('YYYY-MM-DD')}`);
        return nextWorkingDate.format('YYYY-MM-DD');
    } catch (error) {
        logger.error(`Error fetching next system working date from ${date}: ${error.message}`);
        throw error;
    }
}


// Fetch holiday list for the specified country and year
async function getHolidayList(countryCode, date) {
    try {
        const year = date.year();  // Use moment to get the year
        const month = date.month() + 1;  // Use moment to get the month (1-based)
        const day = date.date();  // Use moment to get the day
        
        const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        const response = await axios.get(url);

        // Log the holidays data retrieved
        logger.info(`Received holidays data for ${countryCode}:`, response.data);

        // Extract and return holiday dates as an array
        return response.data.response.holidays.map(holiday => holiday.date.iso);
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode}:`, error);
        return []; // Return an empty array if API fails
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

// Listen on port 3020
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the transaction fetch API with a date filter at: http://localhost:${port}/get-all-transactions?date=YYYY-MM-DD`);

    // Perform initial holiday check after the server starts
    initialHolidayCheck();
});
