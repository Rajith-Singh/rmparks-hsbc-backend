const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { exec } = require('child_process');
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');

dotenv.config();

const app = express();
const port = 3020;

// Calendarific API for holidays
const CALENDARIFIC_API_KEY = process.env.CALENDARIFIC_API_KEY;

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

// Function to initialize SQL database connection
async function connectToDatabase() {
    try {
        // Ensure a valid database connection is made before querying
        await sql.connect(dbConfig);
        console.log("Database connected successfully.");
    } catch (error) {
        console.error("Error connecting to the database:", error);
        throw error; // Propagate error if connection fails
    }
}

// Helper function to check if a date is a weekend in Maldives
function isWeekendInMaldives(date) {
    const day = new Date(date).getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    return day === 5 || day === 6; // Friday and Saturday are weekends in Maldives
}

// Helper function to check if a date is a weekend in Sri Lanka
function isWeekendInSriLanka(date) {
    const day = new Date(date).getDay();
    return day === 6 || day === 0; // Saturday and Sunday are weekends in Sri Lanka
}

// Helper function to validate if a date is in 'YYYY-MM-DD' format
function isValidDateFormat(dateString) {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    return regex.test(dateString);
}

// Helper function to fetch holidays from Calendarific API
async function fetchHolidays(countryCode, transactionDate) {
    try {
        // Validate the date format before proceeding
        if (!isValidDateFormat(transactionDate)) {
            console.error("Invalid date format provided.....:", transactionDate);
            return []; // Return an empty array if the date is invalid
        }

        // Ensure the date is in the correct format before extracting year, month, day
        const date = new Date(transactionDate); // This will parse "2024-11-16"

        // Check if date parsing failed
        if (isNaN(date.getTime())) {
            console.error("Invalid date format provided......:", transactionDate);
            return []; // Return an empty array if the date is invalid
        }

        // Extract year, month, and day from the date
        const year = date.getFullYear();
        const month = date.getMonth() + 1; // Calendar months start from 1
        const day = date.getDate();

        console.log(`Fetching holidays for ${countryCode} on ${year}-${month}-${day}`);

        // Construct the URL for the API request with extracted year, month, and day
        const url = `https://calendarific.com/api/v2/holidays?&api_key=${CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        
        const response = await axios.get(url);
        
        // Log the API response for debugging
        console.log(`Response from Calendarific API:`, response.data);
        
        return response.data.response.holidays;
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode} on ${transactionDate}:`, error.response ? error.response.data : error.message);
        return [];
    }
}

// Function to determine if the date is a system holiday
async function isSystemHoliday(date) {
    // Extract year, month, and day correctly from the date
    const year = new Date(date).getFullYear();
    const month = new Date(date).getMonth() + 1; // Calendar month (1-12)
    const day = new Date(date).getDate();

    console.log(`Checking holidays for ${year}-${month}-${day}`);

    // Fetch holidays for Maldives and Sri Lanka
    const maldivesHolidays = await fetchHolidays('MV', date);
    const sriLankaHolidays = await fetchHolidays('LK', date);

    // Check if it's a weekend or holiday in either country
    const maldivesWeekend = isWeekendInMaldives(date);
    const sriLankaWeekend = isWeekendInSriLanka(date);

    // If both countries have a holiday or it's a common weekend (Saturday), it's a system holiday
    if ((maldivesHolidays.length > 0 || maldivesWeekend) && (sriLankaHolidays.length > 0 || sriLankaWeekend)) {
        return true; // System holiday
    }

    return false; // Not a system holiday
}

// Function to get the next working day (excluding weekends and holidays)
async function getNextWorkingDay(date) {
    let nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    // Keep incrementing the day until a working day is found
    while (await isSystemHoliday(nextDay)) {
        nextDay.setDate(nextDay.getDate() + 1);
    }

    return nextDay;
}

// Function to insert a transaction into the correct table
async function insertTransaction(transaction, isSystemHoliday, CUST_AC) {
    const { BANK_TRANS_REF, BANK_DATE } = transaction;
    console.log(`BANK_DATE ${BANK_DATE}`);

    // Ensure BANK_DATE is valid
    if (!isValidDateFormat(BANK_DATE)) {
        console.error(`Invalid date format for transaction ${BANK_TRANS_REF}: ${BANK_DATE}`);
        return; // Skip transaction if date is invalid
    }

    // Check if the transaction already exists in Transactions_TMP table
    const result = await sql.query`SELECT * FROM Transactions_TMP WHERE BANK_TRANS_REF = ${BANK_TRANS_REF}`;
    if (result.recordset.length > 0) {
        console.log(`Transaction with reference ${BANK_TRANS_REF} already exists, skipping insert.`);
        return; // Skip insertion if already exists
    }

    // Determine the table to insert into
    if (isSystemHoliday) {
        // Insert into Transactions_NonBusinessDates
        const nextWorkingDate = await getNextWorkingDay(BANK_DATE);
        await sql.query`INSERT INTO Transactions_NonBusinessDates
            (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME, NEXT_SYSTEM_WORKING_DATE, REASON_FOR_NON_BUSINESS_DATE)
            VALUES
            (${transaction.TRANS_CODE}, 'hsbc', 'HSBC', '7092001', ${CUST_AC}, ${transaction.PAY_CCA}, ${transaction.C_OR_D}, ${BANK_TRANS_REF}, ${BANK_DATE}, ${transaction.AMOUNT}, ${transaction.DIPSTR_NAME}, ${nextWorkingDate}, 'System Holiday')`;
    } else {
        // Insert into Transactions_TMP
        await sql.query`INSERT INTO Transactions_TMP
            (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME)
            VALUES
            (${transaction.TRANS_CODE}, 'hsbc', 'HSBC', '7092001', ${CUST_AC}, ${transaction.PAY_CCA}, ${transaction.C_OR_D}, ${BANK_TRANS_REF}, ${BANK_DATE}, ${transaction.AMOUNT}, ${transaction.DIPSTR_NAME})`;
    }
}



function generateTransCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // You can modify this to your needs
    let result = '0';  // Start with '0' as in the example, you can customize the starting character
    const length = 7; // The remaining length of the code after the initial '0'

    // Generate 7 random characters for the rest of the code
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        result += characters[randomIndex];
    }

    return result;
}

function extractCustomerAccount(transactionInformation) {
    const regex = /\/VA\/(\d{6})/; // Matches the first 6 digits after /VA/
    const match = transactionInformation.match(regex);

    if (match && match[1]) {
        return match[1]; // Return the matched customer account (CUST_AC)
    } else {
        console.error("CUST_AC not found in transactionInformation:", transactionInformation);
        return null; // Return null if no match is found
    }
}

async function storeTransactions(transactions) {
    for (const transaction of transactions) {
        // Extract the valueDateTime and transactionInformation from the transaction
        const valueDate = transaction.items.valueDateTime; 
        const transactionInformation = transaction.transactionInformation; 
        
        console.log("Extracted valueDateTime:", valueDate);
        console.log("Extracted transactionInformation:", transactionInformation);

        // Extract CUST_AC from transactionInformation
        const CUST_AC = extractCustomerAccount(transactionInformation);

        if (!CUST_AC) {
            console.error("CUST_AC is missing, skipping this transaction");
            continue; // Skip this transaction if CUST_AC is invalid
        }

        // Ensure valueDateTime is valid before passing it to the holiday checking function
        if (!isValidDateFormat(valueDate)) {
            console.error("Invalid valueDateTime:", valueDate);
            continue;  // Skip this transaction if the date is invalid
        }

        // Pass the extracted valueDateTime to the holiday checking function
        const isHoliday = await isSystemHoliday(valueDate); // Check for holidays using the valueDateTime

        // Insert the transaction into the database with the extracted CUST_AC
        await insertTransaction(transaction, isHoliday, CUST_AC);
    }
}



// Load PGP key
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

// Sign and encrypt data
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

    return Buffer.from(encrypted).toString('base64');
}

// Decrypt data with Python server
async function decryptWithPython(encryptedData) {
    try {
        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf-8');
        const response = await axios.post('http://localhost:5000/decrypt', { data: decodedData });
        return response.data;
    } catch (error) {
        console.error('Error decrypting data with Flask server:', error);
        throw error;
    }
}

// Function to fetch and process transactions
async function fetchTransactions(transactionDate) {
    if (!isValidDateFormat(transactionDate)) {
        throw new Error("Invalid date format provided.");
    }

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

    const decryptedData = await decryptWithPython(response.data.reportBase64);

    // Log the decrypted data to inspect its structure
    console.log('Decrypted transactions:', decryptedData);

    const transactions = decryptedData.transactions.transaction;
    return transactions;
}

// Endpoint to fetch and store transactions
app.get('/get-all-transactions', async (req, res) => {
    const transactionDate = req.query.date;
    if (!transactionDate) {
        return res.status(400).json({ error: "Missing 'date' query parameter in YYYY-MM-DD format." });
    }

    try {
        await connectToDatabase(); // Ensure the DB connection is established before querying

        const transactionsData = await fetchTransactions(transactionDate);
        await storeTransactions(transactionsData);
        res.json({ message: 'Transactions successfully processed and stored.' });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to retrieve and process transactions due to server error.' });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the transaction fetch API with a date filter at: http://localhost:${port}/get-all-transactions?date=YYYY-MM-DD`);
});
