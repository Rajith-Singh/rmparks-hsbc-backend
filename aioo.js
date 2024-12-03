const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');
const moment = require('moment');
const cors = require('cors');
const { format, parseISO, addDays } = require('date-fns');

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

// Store transactions depending on system holiday status
async function storeTransactions(response) {
    // Ensure the response contains a valid array of transactions
    if (!Array.isArray(response) || response.length === 0) {
        console.error("No transactions to process.");
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

        // Check if the bankDate is a system holiday
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
        } else {
            // If it's a system working date, insert into Transactions_TMP table with the bankDate
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
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}

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

    // System holiday if both banks are not working
    return !(maldivesWorking || sriLankaWorking);
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
    let nextWorkingDate = moment(date).add(1, 'days'); // Start with the next day

    // Iterate until a system working date is found
    while (await isSystemHoliday(nextWorkingDate)) {
        nextWorkingDate = nextWorkingDate.add(1, 'days');
    }

    return nextWorkingDate.format('YYYY-MM-DD');
}


// Fetch holiday list for the specified country and year
async function getHolidayList(countryCode, date) {
    try {
        const year = date.year();  // Use moment to get the year
        const month = date.month() + 1;  // Use moment to get the month (1-based)
        const day = date.date();  // Use moment to get the day
        
        const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        const response = await axios.get(url);

        // Extract and return holiday dates as an array
        return response.data.response.holidays.map(holiday => holiday.date.iso);
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode}:`, error);
        return []; // Return an empty array if API fails
    }
}


// // Get holiday data from the Calendarific API
// async function getHoliday(countryCode, date) {
//     const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${date.year()}&month=${date.month() + 1}&day=${date.date()}`;
//     const response = await axios.get(url);
//     return response.data.response.holidays.length > 0;
// }

// // Function to get the next system working date
// async function getNextSystemWorkingDate(date) {
//     let nextWorkingDate = date.add(1, 'days');
    
//     while (await isSystemHoliday(nextWorkingDate)) {
//         nextWorkingDate = nextWorkingDate.add(1, 'days');
//     }
    
//     return nextWorkingDate.format('YYYY-MM-DD');
// }

// Enable CORS with default settings
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
});
