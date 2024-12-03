const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const { exec } = require('child_process');
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');
const { format, parseISO, addDays } = require('date-fns');
const cors = require('cors');


dotenv.config();

const app = express();
const port = 3005;


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
        const response = await axios.post('http://localhost:5000/decrypt', { data: decodedData });
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}

// Function to determine if a date is a weekend or holiday
async function isHolidayOrWeekend(date, country) {
    const weekendDays = country === 'MV' ? [5, 6] : [6, 0];
    if (weekendDays.includes(date.getDay())) return true;

    const formattedDate = format(date, 'yyyy-MM-dd');
    const response = await axios.get(`https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${country}&year=${date.getFullYear()}&month=${date.getMonth() + 1}&day=${date.getDate()}`);
    return response.data.response.holidays.length > 0;
}

// Calculate the next business day, considering holidays and weekends
async function getNextBusinessDay(date) {
    let currentDate = date;
    do {
        currentDate = addDays(currentDate, 1);
    } while (await isHolidayOrWeekend(currentDate, 'LK') || await isHolidayOrWeekend(currentDate, 'MV'));
    return currentDate;
}

// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    const date = parseISO(transactionDate);
    const isHolidayLK = await isHolidayOrWeekend(date, 'LK');
    const isHolidayMV = await isHolidayOrWeekend(date, 'MV');
    const effectiveDate = isHolidayLK || isHolidayMV ? await getNextBusinessDay(date) : date;
    const formattedDate = format(effectiveDate, 'yyyy-MM-dd');

    const clientPrivateKey = await loadPGPKey('client-private.pem');
    const hsbcPublicKey = await loadPGPKey('hsbc-public.pem');
    const passphrase = '1password';

    const requestData = JSON.stringify({
        transactionDate: formattedDate,
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

    const transactions = await decryptWithPython(response.data.reportBase64);
    return transactions;
}

// Function to insert transaction data into the database
async function insertTransactionToDB(transactions) {
    try {
        const pool = await sql.connect(dbConfig);

        for (const transaction of transactions) {
            console.log("Processing transaction:", transaction);

            const transactionInfo = transaction.transactionInformation; // Adjusted for structure
            if (!transactionInfo) {
                console.error("Missing transactionInformation:", transaction);
                continue; // Skip if transactionInformation is missing
            }

            const custAcMatch = transactionInfo.match(/\/VA\/(\d{10})/);
            if (!custAcMatch) {
                console.error("CUST_AC cannot be extracted:", transactionInfo);
                continue; // Skip if CUST_AC cannot be extracted
            }

            const custAc = custAcMatch[1].substring(0, 6);
            const transCode = Math.random().toString(36).substring(2, 10).toUpperCase();
            const bankDate = new Date(transaction.valueDateTime).toISOString();
            const amount = parseFloat(transaction.transactionAmount.amount);

            const checkQuery = `
                SELECT COUNT(*) AS count 
                FROM Transactions_TMP 
                WHERE BANK_TRANS_REF = @transactionReference;
            `;
            const checkResult = await pool.request()
                .input('transactionReference', sql.VarChar, transaction.transactionReference)
                .query(checkQuery);

            if (checkResult.recordset[0].count > 0) {
                console.log(`TransactionReference ${transaction.transactionReference} already exists. Skipping.`);
                continue;
            }

            const insertQuery = `
                INSERT INTO Transactions_TMP (
                    TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, 
                    PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME
                ) VALUES (
                    @transCode, @collectionAc, @bankCode, @branchCode, @custAc, 
                    @payCca, @cOrD, @bankTransRef, @bankDate, @amount, @dipStrName
                );
            `;
            try {
                await pool.request()
                    .input('transCode', sql.VarChar, transCode)
                    .input('collectionAc', sql.VarChar, 'hsbc')
                    .input('bankCode', sql.VarChar, 'HSBC')
                    .input('branchCode', sql.VarChar, '7092001')
                    .input('custAc', sql.VarChar, custAc)
                    .input('payCca', sql.VarChar, 'R001')
                    .input('cOrD', sql.VarChar, transaction.creditDebitIndicator)
                    .input('bankTransRef', sql.VarChar, transaction.transactionReference)
                    .input('bankDate', sql.DateTime, bankDate)
                    .input('amount', sql.Decimal, amount)
                    .input('dipStrName', sql.VarChar, null)
                    .query(insertQuery);

                console.log(`Transaction ${transaction.transactionReference} inserted successfully.`);
            } catch (queryError) {
                console.error(`Error inserting transaction ${transaction.transactionReference}:`, queryError);
            }
        }

        await pool.close();
    } catch (error) {
        console.error('Error inserting transactions into database:', error);
        throw error;
    }
}



// Function to process transactions
async function processTransactions(transactions) {
    if (transactions && transactions.transaction) {
        const transactionItems = transactions.transaction.map(t => t.items);
        await insertTransactionToDB(transactionItems);
    }
}

// Enable CORS with default settings
app.use(cors());

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


// Fetch transactions and process them
app.get('/get-all-transactions', async (req, res) => {
    const transactionDate = req.query.date;
    if (!transactionDate) {
        return res.status(400).json({ error: "Missing 'date' query parameter in YYYY-MM-DD format." });
    }

    try {
        const transactionsData = await fetchTransactions(transactionDate);
        await processTransactions(transactionsData.transactions);
        res.json({ message: 'Transactions processed and inserted into the database.' });
    } catch (error) {
        console.error('Error processing transactions:', error);
        res.status(500).json({ error: 'Failed to process transactions due to server error.' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the transaction fetch API with a date filter at: http://localhost:${port}/get-all-transactions?date=YYYY-MM-DD`);
});
